import crypto from 'node:crypto';
import { createWorkflow, WorkflowError } from '../workflow/engine.js';
import { isTerminal } from '../workflow/stages.js';
import { ROLES } from '../workflow/roles.js';
import { contractFor, schemaFor, normalizeResult } from './contracts.js';
import { createArtifact, applyResult, routeArtifact, recordIntervention } from './artifact.js';
import { ROLE_POLICY, systemPrompt, stagePrompt, repairPrompt, continuePrompt, retryPreamble } from './prompts.js';
import { createSession, advanceSession, isFinished } from './sessions.js';
import { preflight as realPreflight, changesSince as realChangesSince } from './project.js';
import { createStore, costOf, summarize, RECORD_VERSION } from './store.js';
import { isManagedSession, terminateGroup } from './procs.js';

export class RuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
  }
}

const STAGE_ACTION = { planning: 'shaping the request', research: 'researching', development: 'implementing', rework: 'reworking', testing: 'testing', finalizing: 'finalizing' };
const short = (s, n = 120) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');
const pad = (n) => String(n).padStart(2, '0');
function defaultTaskId() {
  const d = new Date();
  return `t-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}
const publicProject = (p) => ({ cwd: p.cwd, root: p.root, branch: p.branch, head: p.head, dirtyAtStart: Array.isArray(p.dirtyAtStart) ? p.dirtyAtStart.length : p.dirtyAtStart ?? 0 });
const REQUEST_ID = /^[\w-]{8,100}$/;

/**
 * The single authoritative ATLAS runtime: one Phase 3 workflow engine, and for each task a driver
 * that runs the workflow stage by stage through managed backend sessions.
 *
 *   task → workflow engine → session for the current owner role (explicit, assigned before launch)
 *        → normalized structured result → workflow transition / handoff → events → subscribers
 *
 * Persistence and recovery wrap that loop (no second engine, task model or state machine):
 *  - every workflow event is appended to the task's event log and its run.json snapshot rewritten
 *    atomically; the engine's seq and agents go to state/runtime-state.json;
 *  - on creation, open tasks from disk are restored into the engine. Anything that was running is
 *    paused as `interrupted` (normal shutdown vs. crash is recorded); a still-running process is
 *    terminated only if it is provably the recorded session. Nothing is launched automatically;
 *  - a role reporting `blocked` pauses its task for a person (respond / resume / cancel / fail).
 *
 * A task runs only while its driver is active; resume/retry start a driver, and at most one
 * driver per task exists at any time. Callers must hold the state directory's runtime lock.
 */
export function createRuntime({
  backend,
  now = Date.now,
  stateDir = null,
  log = () => {},
  maxQaAttempts = 3,
  atlasRoot = null,
  preflight = realPreflight,
  changesSince = realChangesSince,
  progressThrottleMs = 4000,
  maxEvents = 5000,
  newTaskId = defaultTaskId,
  newSessionId = () => `s-${crypto.randomBytes(4).toString('hex')}`,
  processes = { isManagedSession, terminateGroup },
}) {
  const store = stateDir ? createStore(stateDir) : null;
  const events = [];
  const subscribers = new Set();
  const runs = new Map(); // tasks this runtime owns: every open task, plus those finished while it ran
  const requests = new Map(); // requestId → taskId (persisted in run records, so it survives restarts)
  const pending = new Map(); // requestId → in-flight submission
  const decisions = new Map(); // decision requestId → { taskId, decision } (persisted in run records)
  const quarantined = new Set(); // task ids whose records could not be restored safely
  const startedAt = now();
  let stopped = false;

  // ---- 1. load persisted state (tolerating malformed files) ----
  const loaded = store ? store.loadAll() : { records: [], problems: [] };
  const previous = store?.readState() ?? null;
  for (const r of loaded.records) {
    if (r.requestId) requests.set(r.requestId, r.taskId);
    for (const d of r.decisions ?? []) decisions.set(d.requestId, { taskId: r.taskId, decision: d.decision });
  }
  const open = loaded.records.filter((r) => !isTerminal(r.task.stage));
  const recovery = {
    previousRuntime: previous ? { pid: previous.pid ?? null, cleanShutdownAt: previous.cleanShutdownAt ?? null } : null,
    interrupted: [], stillBlocked: [], orphansTerminated: [], problems: loaded.problems,
  };

  // ---- 2. sessions that were live when the previous runtime stopped ----
  // Terminate a leftover process only when it provably is that session (its command line carries
  // the session's own id); a reused or unverifiable PID is never touched.
  for (const r of open) {
    r.sessions = r.sessions.map((s) => {
      if (isFinished(s)) return s;
      let failure = 'ATLAS stopped before this session finished';
      if (s.pid && s.backendSessionId && processes.isManagedSession(s.pid, s.backendSessionId)) {
        processes.terminateGroup(s.pid);
        failure = 'ATLAS stopped; the session was still running (verified by session id) and was terminated';
        recovery.orphansTerminated.push({ taskId: r.taskId, sessionId: s.id, pid: s.pid });
      }
      return advanceSession(s, 'interrupted', now(), { failure });
    });
  }

  // ---- 3. rebuild the one engine from the open tasks ----
  // Each record must restore on its own first: a record the engine rejects (unknown stage or
  // status, inconsistent owner) is quarantined as a problem — left untouched on disk, never guessed
  // at — so one bad record can't keep the runtime from starting.
  for (let i = open.length - 1; i >= 0; i--) {
    try { createWorkflow({ now, maxQaAttempts, restore: { seq: 0, tasks: [open[i].task], agents: [] } }); } catch (e) {
      recovery.problems.push({ file: `runs/${open[i].taskId}/run.json`, error: e.message, quarantined: true });
      if (open[i].requestId) requests.delete(open[i].requestId);
      quarantined.add(open[i].taskId);
      open.splice(i, 1);
    }
  }
  const seq = Math.max(previous?.seq ?? 0, ...open.map((r) => store.lastSeq(r.taskId)), 0);
  let wf;
  try {
    wf = createWorkflow({ now, maxQaAttempts, restore: { seq, tasks: open.map((r) => r.task), agents: previous?.agents ?? [] } });
  } catch (e) {
    // Agents state unusable: restore tasks alone (the engine releases anything it can't reconcile).
    recovery.problems.push({ file: 'state/runtime-state.json', error: e.message });
    wf = createWorkflow({ now, maxQaAttempts, restore: { seq, tasks: open.map((r) => r.task), agents: [] } });
  }
  for (const r of open) {
    runs.set(r.taskId, {
      id: r.taskId, requestId: r.requestId, request: r.request, project: r.project, artifact: r.artifact ?? createArtifact({ taskId: r.taskId, goal: r.request }),
      sessions: r.sessions, changes: r.changes, decisions: r.decisions ?? [], driving: false, stop: null, handle: null, wake: null, lastProgress: 0, lastAction: null, done: Promise.resolve(),
    });
  }

  // ---- event fan-out, persistence and attributable logging ----
  const record = (run) => {
    const task = wf.getTask(run.id);
    return {
      version: RECORD_VERSION, taskId: run.id, requestId: run.requestId, request: run.request,
      createdAt: task.createdAt, updatedAt: task.updatedAt, completedAt: isTerminal(task.stage) ? task.updatedAt : null,
      task, project: publicProject(run.project), artifact: run.artifact, sessions: run.sessions, changes: run.changes ?? null, cost: costOf(run.sessions),
      decisions: run.decisions,
    };
  };
  function save(run) {
    if (!store) return;
    try { store.saveRecord(record(run)); } catch (e) { log(`task=${run.id} could not save run.json: ${e.message}`); }
  }
  function saveState(extra = {}) {
    if (!store) return;
    try { store.writeState({ version: 1, seq: wf.snapshot().seq, agents: wf.listAgents(), pid: process.pid, startedAt, cleanShutdownAt: null, ...extra }); } catch (e) { log(`could not save runtime state: ${e.message}`); }
  }
  /** Orchestration lifecycle (not workflow) facts, in the task's own event log. */
  function note(taskId, type, data = {}) {
    if (!store) return;
    try { store.appendEvent(taskId, { source: 'runtime', type, at: now(), taskId, ...data }); } catch { /* best effort */ }
  }

  function describe(e) {
    const p = e.payload;
    switch (e.type) {
      case 'task_created': return `task created: "${p.task.title}"`;
      case 'stage_changed': return `stage ${p.from} → ${p.to} (owner ${p.owner ?? '—'}, attempt ${p.attempt})`;
      case 'agent_assigned': return `role ${p.agent.role} assigned`;
      case 'agent_started': return `role ${p.agent.role} working (${p.agent.action ?? ''})`;
      case 'agent_waiting': return `role ${p.agent.role} waiting: ${p.reason}`;
      case 'agent_blocked': return `role ${p.agent.role} BLOCKED — paused for a person: ${short(p.pause?.question ?? p.reason)}`;
      case 'agent_interrupted': return `role ${p.agent.role} interrupted`;
      case 'intervention_responded': return `response recorded: ${short(p.pause.response)}`;
      case 'task_interrupted': return `task interrupted at ${p.stage}: ${p.reason}`;
      case 'task_resumed': return `task resumed (${p.mode}) from ${p.from} at ${p.stage}`;
      case 'handoff_started': return `handoff ${p.handoff.fromRole} → ${p.handoff.toRole} (${p.handoff.fromStage} → ${p.handoff.toStage})`;
      case 'qa_passed': return `QA passed attempt ${p.attempt}`;
      case 'qa_failed': return `QA failed attempt ${p.attempt} (${p.failures}/${p.maxQaAttempts}): ${short(p.reason)}`;
      case 'task_completed': return `task completed (attempts ${p.attempts}, QA cycles ${p.qaCycles})`;
      case 'task_failed': return `task failed at ${p.stage}: ${short(p.reason)}`;
      case 'task_cancelled': return `task cancelled at ${p.stage}: ${short(p.reason)}`;
      default: return null; // agent_idle, agent_progress, handoff_completed: in the event log, not the console
    }
  }
  wf.on((e) => {
    events.push(e);
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
    if (store) {
      try { store.appendEvent(e.taskId, e); } catch (err) { log(`task=${e.taskId} could not append event: ${err.message}`); }
      const run = runs.get(e.taskId);
      if (run) save(run);
      saveState();
    }
    const line = describe(e);
    if (line) log(`task=${e.taskId} ${line}`);
    for (const fn of subscribers) {
      try { fn(e); } catch (err) { log(`subscriber failed: ${err.message}`); }
    }
  });

  // ---- 4. recovery decisions: pause what was running; never launch anything ----
  const cause = !previous ? 'ATLAS stopped (no shutdown record)'
    : previous.cleanShutdownAt ? `ATLAS stopped (normal shutdown at ${new Date(previous.cleanShutdownAt).toISOString()})`
      : 'ATLAS runtime stopped unexpectedly';
  for (const run of runs.values()) {
    const t = wf.getTask(run.id);
    if (t.pause?.kind === 'blocked') recovery.stillBlocked.push(run.id);
    else {
      if (!t.pause) wf.interrupt(run.id, { reason: cause });
      recovery.interrupted.push(run.id);
    }
    note(run.id, 'recovered', { pause: wf.getTask(run.id).pause?.kind, sessions: run.sessions.filter((s) => s.status === 'interrupted').map((s) => s.id) });
    save(run);
  }
  saveState();
  if (store) {
    store.logRuntime({ type: 'runtime_started', at: startedAt, pid: process.pid, recovery });
    if (recovery.interrupted.length || recovery.stillBlocked.length || recovery.problems.length) {
      log(`recovery: ${recovery.interrupted.length} interrupted, ${recovery.stillBlocked.length} blocked, ${recovery.orphansTerminated.length} leftover session(s) terminated, ${recovery.problems.length} unreadable record(s) — nothing was relaunched; use \`atlas status\``);
    }
  }

  // ---- driving ----
  function fail(run, reason) {
    try { wf.failTask(run.id, { reason }); } catch (e) { if (!(e instanceof WorkflowError)) throw e; }
  }
  /** Record a blocked role's question (and answer, if any) once per pause; a newer answer replaces the older one. */
  function withIntervention(artifact, pause) {
    const others = { ...artifact, interventions: (artifact.interventions ?? []).filter((i) => i.askedAt !== pause.at) };
    return recordIntervention(others, pause);
  }

  function upsert(run, session) {
    const i = run.sessions.findIndex((s) => s.id === session.id);
    if (i < 0) run.sessions.push(session); else run.sessions[i] = session;
  }
  function progress(run, action) {
    const t = now();
    if (!action || action === run.lastAction || t - run.lastProgress < progressThrottleMs) return;
    run.lastProgress = t;
    run.lastAction = action;
    try { wf.reportProgress(run.id, { action }); } catch { /* the agent is no longer working; drop it */ }
  }

  /** Resolves once the task's owner agent has picked it up, the task ended, or the driver is being stopped. */
  function waitForAssignment(run) {
    return new Promise((resolve) => {
      const done = () => { off(); run.wake = null; resolve(); };
      const off = wf.on((e) => {
        if (e.taskId === run.id && ['agent_assigned', 'task_failed', 'task_completed', 'task_cancelled', 'task_interrupted'].includes(e.type)) done();
      });
      run.wake = done;
      const t = wf.getTask(run.id);
      if (t.assignee || isTerminal(t.stage) || t.pause || run.stop) done();
    });
  }

  async function launch(run, opts, onStarted) {
    let handle;
    try { handle = backend.start(opts); } catch (e) { return { ok: false, reason: `launch failed: ${e.message}` }; }
    run.handle = handle;
    onStarted?.(handle);
    if (run.stop) handle.cancel(run.stop.reason);
    try { return await handle.done; } finally { run.handle = null; }
  }

  /**
   * One stage, one managed session: launch (continuing a previous conversation if asked), wait,
   * validate (one repair attempt), record. A continuation that can't be resumed falls back once to
   * a fresh session for the same stage.
   */
  async function runStage(run, task, role, stage, first = null) {
    const contract = contractFor(stage);
    let session = createSession({
      id: newSessionId(), taskId: run.id, role, stage, backend: backend.name, cwd: run.project.cwd,
      handoffId: task.history.at(-1)?.id ?? null, attempt: task.attempt, at: now(),
    });
    const put = (to, patch) => { session = advanceSession(session, to, now(), patch); upsert(run, session); save(run); };
    upsert(run, session);
    const tag = `task=${run.id} role=${role} session=${session.id}`;
    const stoppedOutcome = (outcome = {}) => {
      const shutdown = run.stop?.kind === 'shutdown';
      put(shutdown ? 'interrupted' : 'cancelled', { failure: run.stop?.reason ?? 'cancelled', exitCode: outcome.exitCode ?? null, costUsd: outcome.costUsd ?? null });
      log(`${tag} ${shutdown ? 'interrupted (shutdown)' : 'cancelled'}`);
      note(run.id, 'session_finished', { sessionId: session.id, status: session.status });
      return { ok: false, stopped: true };
    };

    const changes = stage === 'finalizing' ? await changesSince(run.project) : null;
    if (changes) run.changes = changes;
    if (run.stop) return stoppedOutcome();

    const continuation = first?.continuation && backend.canResume ? first.continuation : null;
    const backendSessionId = continuation?.backendSessionId ?? crypto.randomUUID();
    const base = {
      sessionId: session.id, taskId: run.id, role, stage, cwd: run.project.cwd,
      system: systemPrompt(role, run.project.cwd), schema: schemaFor(contract), policy: ROLE_POLICY[role],
      rawLogPath: store ? store.sessionLogPath(run.id, session.id) : null, onProgress: (action) => progress(run, action),
    };
    const prompt = continuation?.prompt ?? stagePrompt({ role, stage, task, artifact: run.artifact, project: run.project, changes, preamble: first?.preamble ?? null });
    put('starting', { backendSessionId, continues: continuation?.fromSessionId ?? null });
    log(`${tag} stage=${stage}: ${continuation ? `continuing ${backend.name} session ${backendSessionId}` : `launching ${backend.name} session ${backendSessionId}`} in ${run.project.cwd}`);
    note(run.id, 'session_started', { sessionId: session.id, role, stage, backendSessionId, continues: continuation?.fromSessionId ?? null });
    let outcome = await launch(run, { ...base, backendSessionId: continuation ? null : backendSessionId, resume: continuation ? backendSessionId : null, prompt }, (h) => {
      put('running', { pid: h.pid ?? null });
      log(`${tag} running (pid ${h.pid ?? '—'})`);
    });
    let cost = outcome.costUsd ?? 0;
    if (outcome.cancelled || run.stop) return stoppedOutcome({ ...outcome, costUsd: cost || null });

    if (continuation && !outcome.ok) {
      put('failed', { failure: `could not continue the previous conversation: ${outcome.reason}`, exitCode: outcome.exitCode ?? null, costUsd: cost || null });
      log(`${tag} could not continue the previous conversation (${outcome.reason}); retrying the stage in a fresh session`);
      note(run.id, 'session_finished', { sessionId: session.id, status: 'failed' });
      return runStage(run, wf.getTask(run.id), role, stage, { preamble: retryPreamble(`continuing the previous conversation failed: ${short(outcome.reason, 160)}`) });
    }
    if (!outcome.ok) {
      put('failed', { failure: outcome.reason, exitCode: outcome.exitCode ?? null, costUsd: cost || null });
      log(`${tag} failed: ${outcome.reason}`);
      note(run.id, 'session_finished', { sessionId: session.id, status: 'failed' });
      return { ok: false, reason: outcome.reason };
    }

    let norm = normalizeResult(contract, outcome.structured);
    if (!norm.ok && backend.canResume) {
      log(`${tag} result did not match the ${contract} contract (${norm.error}); asking the same session to repair it`);
      const repaired = await launch(run, { ...base, backendSessionId: null, resume: outcome.backendSessionId ?? backendSessionId, prompt: repairPrompt(norm.error) });
      cost += repaired.costUsd ?? 0;
      outcome = { ...repaired, exitCode: repaired.exitCode ?? outcome.exitCode };
      if (repaired.cancelled || run.stop) return stoppedOutcome({ ...outcome, costUsd: cost || null });
      norm = repaired.ok ? normalizeResult(contract, repaired.structured) : { ok: false, error: repaired.reason };
    }
    if (!norm.ok) {
      const reason = `returned an invalid ${contract} result (${norm.error})`;
      put('failed', { failure: reason, exitCode: outcome.exitCode ?? null, costUsd: cost || null });
      log(`${tag} failed: ${reason}`);
      note(run.id, 'session_finished', { sessionId: session.id, status: 'failed' });
      return { ok: false, reason };
    }
    put('completed', { exitCode: outcome.exitCode ?? 0, result: norm.value, costUsd: cost || null });
    log(`${tag} completed: ${norm.value.status} — ${short(norm.value.summary)}${cost ? ` ($${cost.toFixed(2)})` : ''}`);
    note(run.id, 'session_finished', { sessionId: session.id, status: 'completed', result: norm.value.status, costUsd: cost || null });
    return { ok: true, contract, result: norm.value, sessionId: session.id };
  }

  /** Turn a role's validated result into exactly one workflow command. */
  function advance(run, role, stage, { contract, result, sessionId }) {
    run.artifact = applyResult(run.artifact, { role, stage, contract, sessionId, result, at: now() });
    const meta = { sessionId };
    if (result.status === 'blocked') {
      // Pause for a person; no process keeps running (the session has finished).
      wf.block(run.id, { reason: result.summary, question: result.question || null, suggestedActions: result.suggestedActions });
      save(run);
      return;
    }
    if (stage === 'testing') {
      if (result.status === 'pass') wf.qaPass(run.id, { notes: result.summary, meta });
      else wf.qaFail(run.id, { reason: short(`${result.summary} — ${result.failures.join('; ')}`, 600), meta });
    } else {
      wf.completeStage(run.id, { reason: short(result.summary, 600), meta });
    }
    const t = wf.getTask(run.id);
    run.artifact = routeArtifact(run.artifact, { stage: t.stage, fromRole: role, toRole: t.owner });
    save(run);
  }

  /** When a driver stops for shutdown, its task is paused as interrupted — never marked cancelled. */
  function onStopped(run) {
    if (run.stop?.kind !== 'shutdown') return;
    const t = wf.getTask(run.id);
    if (!isTerminal(t.stage) && !t.pause) wf.interrupt(run.id, { reason: run.stop.reason });
  }

  async function drive(run, first = null) {
    run.driving = true;
    try {
      while (true) {
        if (run.stop) return onStopped(run);
        const task = wf.getTask(run.id);
        if (isTerminal(task.stage) || task.pause) return; // finished, or paused for a person
        if (!task.assignee) { await waitForAssignment(run); continue; }
        const role = task.owner, stage = task.stage;
        wf.startWork(run.id, { action: STAGE_ACTION[stage] });
        run.lastAction = STAGE_ACTION[stage];
        const outcome = await runStage(run, wf.getTask(run.id), role, stage, first);
        first = null;
        if (run.stop) return onStopped(run);
        if (isTerminal(wf.getTask(run.id).stage)) return;
        if (!outcome.ok) { fail(run, `${ROLES[role].name} (${stage}) ${outcome.reason}`); return; }
        advance(run, role, stage, outcome);
      }
    } finally {
      run.driving = false;
      run.handle = null;
      save(run);
    }
  }

  function startDriver(run, first) {
    run.stop = null;
    run.done = drive(run, first)
      .catch((err) => { log(`task=${run.id} orchestration error: ${err.stack || err.message}`); fail(run, `orchestration error: ${err.message}`); });
    return run.done;
  }

  // ---- queries ----
  function runOf(id) {
    const run = runs.get(id);
    if (!run) {
      if (quarantined.has(id)) throw new RuntimeError('task_unreadable', `task ${id}'s record could not be restored safely (see atlas runtime); it was left untouched`);
      if (store?.loadRecord(id)) throw new RuntimeError('task_closed', `task ${id} is finished; start a new task instead`);
      throw new RuntimeError('unknown_task', `unknown task: ${id}`);
    }
    return run;
  }
  function detail(id) {
    const run = runs.get(id);
    if (run) return { ...record(run), active: run.driving, runDir: store ? store.runDir(id) : null };
    const stored = store?.loadRecord(id);
    if (stored) return { ...stored, active: false, runDir: store.runDir(id) };
    throw new RuntimeError('unknown_task', `unknown task: ${id}`);
  }

  // ---- commands ----
  async function submit({ request, cwd, acceptanceCriteria = [], allowDirty = false, allowSelf = false, requestId = null }) {
    if (typeof request !== 'string' || !request.trim()) throw new RuntimeError('invalid_input', 'request is required');
    if (!Array.isArray(acceptanceCriteria) || !acceptanceCriteria.every((c) => typeof c === 'string' && c.trim())) {
      throw new RuntimeError('invalid_input', 'acceptanceCriteria must be a list of non-empty strings');
    }
    const project = await preflight(cwd, { allowDirty, allowSelf, atlasRoot });
    if (stopped) throw new RuntimeError('stopped', 'the ATLAS runtime is shutting down');
    // From here on everything is synchronous, so two submissions can't both pass this check.
    for (const r of runs.values()) {
      const t = wf.getTask(r.id);
      if (!isTerminal(t.stage) && r.project.root === project.root) {
        throw new RuntimeError('busy_project', `task ${r.id} is ${t.pause ? t.pause.kind : 'running'} in ${project.root}; resolve it first (atlas status ${r.id})`);
      }
    }
    const id = newTaskId();
    const text = request.trim();
    const run = {
      id, requestId, request: text, project, sessions: [], changes: null, decisions: [], driving: false, stop: null, handle: null, wake: null, lastProgress: 0, lastAction: null,
      artifact: createArtifact({ taskId: id, goal: text, acceptanceCriteria, project: publicProject(project) }), done: Promise.resolve(),
    };
    runs.set(id, run);
    if (requestId) requests.set(requestId, id);
    log(`task=${id} target ${project.cwd} (branch ${project.branch ?? 'detached'}, HEAD ${project.head?.slice(0, 8) ?? 'none'})${project.dirtyAtStart.length ? `; dirty tree acknowledged (${project.dirtyAtStart.length} paths)` : ''}`);
    wf.createTask({ id, title: text.split('\n')[0].slice(0, 80), description: text, acceptanceCriteria });
    note(id, 'submitted', { requestId, cwd: project.cwd });
    startDriver(run, null);
    return { taskId: id, project: publicProject(project) };
  }

  /**
   * Idempotency for decisions (respond, resume, retry, cancel, fail): a `requestId` already seen —
   * by this runtime or a previous one (it is persisted in the task's record) — returns the task as
   * it is now without acting again, so a repeated or retried request can never launch a second
   * session. Reusing one id for a different task or decision is refused.
   */
  function once(id, decision, requestId, act) {
    if (requestId === null || requestId === undefined) return act();
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new RuntimeError('invalid_input', 'requestId must be 8–100 letters, digits, - or _');
    const seen = decisions.get(requestId);
    if (seen) {
      if (seen.taskId !== id || seen.decision !== decision) throw new RuntimeError('invalid_input', `requestId ${requestId} was already used for ${seen.decision} on ${seen.taskId}`);
      return { ...detail(id), duplicate: true };
    }
    const out = act();
    decisions.set(requestId, { taskId: id, decision });
    const run = runs.get(id);
    if (run) { run.decisions.push({ requestId, decision, at: now() }); save(run); }
    return out;
  }

  function cancelTask(id, reason = 'Cancelled by user') {
    const run = runs.get(id);
    if (!run) return detail(id); // finished before this runtime started: nothing to cancel
    const t = wf.getTask(id);
    if (isTerminal(t.stage)) return detail(id); // idempotent
    run.stop = { kind: 'cancel', reason };
    log(`task=${id} cancellation requested: ${reason}`);
    wf.cancelTask(id, { reason });
    note(id, 'decision', { decision: 'cancel', reason });
    run.handle?.cancel(reason);
    run.wake?.();
    return detail(id);
  }

  function respond(id, response) {
    const run = runOf(id);
    if (typeof response !== 'string' || !response.trim()) throw new RuntimeError('invalid_input', 'response is required');
    const t = wf.respond(id, { response });
    run.artifact = withIntervention(run.artifact, t.pause);
    note(id, 'decision', { decision: 'respond' });
    save(run);
    return detail(id);
  }

  function resumeTask(id, { mode = 'resume', note: why = null } = {}) {
    if (!['resume', 'retry'].includes(mode)) throw new RuntimeError('invalid_input', 'mode must be "resume" or "retry"');
    if (stopped) throw new RuntimeError('stopped', 'the ATLAS runtime is shutting down');
    const run = runOf(id);
    const task = wf.getTask(id);
    if (isTerminal(task.stage)) throw new RuntimeError('task_closed', `task ${id} is ${task.stage}`);
    if (run.driving) throw new RuntimeError('not_resumable', `task ${id} is already running`);
    if (!task.pause) throw new RuntimeError('not_resumable', `task ${id} is not paused`);
    const pause = task.pause;
    // `resume` continues the paused stage's own conversation when there is one to continue;
    // `retry` (or no usable transcript) starts the stage in a fresh session.
    const last = [...run.sessions].reverse().find((s) => s.stage === task.stage && s.role === task.owner && s.backendSessionId);
    const canContinue = mode === 'resume' && backend.canResume && last && (pause.kind === 'blocked' ? last.status === 'completed' : last.status === 'interrupted' && last.startedAt);
    const first = canContinue
      ? { continuation: { backendSessionId: last.backendSessionId, fromSessionId: last.id, prompt: continuePrompt({ kind: pause.kind, stage: task.stage, pause, note: why }) } }
      : { preamble: pause.kind === 'blocked' && mode === 'resume'
        ? `A person responded to the earlier blocker (${short(pause.reason, 200)}); see humanGuidance.${why ? ` Note: ${why}` : ''}`
        : retryPreamble(`${pause.kind}: ${short(pause.reason, 200)}${why ? `; ${why}` : ''}`) };
    if (pause.kind === 'blocked') run.artifact = withIntervention(run.artifact, pause);
    wf.resume(id, { mode, note: why });
    note(id, 'decision', { decision: mode, from: pause.kind, continues: canContinue ? last.id : null, note: why });
    log(`task=${id} ${mode === 'retry' ? 'retrying' : 'resuming'} ${task.stage} (was ${pause.kind})${canContinue ? `, continuing session ${last.id}` : ' in a fresh session'}`);
    startDriver(run, first); // sets run.driving synchronously, so a second resume is refused
    return detail(id);
  }

  function abandon(id, reason) {
    if (typeof reason !== 'string' || !reason.trim()) throw new RuntimeError('invalid_input', 'a reason is required');
    const run = runOf(id);
    const t = wf.getTask(id);
    if (isTerminal(t.stage)) throw new RuntimeError('task_closed', `task ${id} is ${t.stage}`);
    if (run.driving) throw new RuntimeError('running', `task ${id} is running; cancel it instead`);
    wf.failTask(id, { reason: `Abandoned: ${reason.trim()}` });
    note(id, 'decision', { decision: 'fail', reason });
    return detail(id);
  }

  return {
    /** Validate the target, create the task, and start driving it. A repeated `requestId` returns the original task. */
    async submitTask(input = {}) {
      if (stopped) throw new RuntimeError('stopped', 'the ATLAS runtime is shutting down');
      const { requestId = null } = input;
      if (requestId !== null && (typeof requestId !== 'string' || !REQUEST_ID.test(requestId))) throw new RuntimeError('invalid_input', 'requestId must be 8–100 letters, digits, - or _');
      if (requestId && requests.has(requestId)) return { ...detailSummary(requests.get(requestId)), duplicate: true };
      if (requestId && pending.has(requestId)) return { ...(await pending.get(requestId)), duplicate: true };
      const p = submit({ ...input, requestId });
      if (requestId) pending.set(requestId, p);
      try { return await p; } finally { if (requestId) pending.delete(requestId); }
    },
    cancelTask: (id, reason, { requestId = null } = {}) => once(id, 'cancel', requestId, () => cancelTask(id, reason)),
    respond: (id, response, { requestId = null } = {}) => once(id, 'respond', requestId, () => respond(id, response)),
    resumeTask: (id, { mode = 'resume', note = null, requestId = null } = {}) => once(id, mode, requestId, () => resumeTask(id, { mode, note })),
    abandonTask: (id, reason, { requestId = null } = {}) => once(id, 'fail', requestId, () => abandon(id, reason)),

    /** Stop accepting work; running tasks are paused as interrupted (not cancelled); final state saved. */
    async shutdown(reason = 'ATLAS stopped (normal shutdown)') {
      if (stopped) return;
      stopped = true;
      const driving = [...runs.values()].filter((r) => r.driving);
      for (const r of driving) { r.stop = { kind: 'shutdown', reason }; r.handle?.cancel(reason); r.wake?.(); }
      await Promise.race([Promise.allSettled(driving.map((r) => r.done)), new Promise((r) => setTimeout(r, 8000).unref?.())]);
      for (const r of runs.values()) {
        const t = wf.getTask(r.id);
        if (!isTerminal(t.stage) && !t.pause) wf.interrupt(r.id, { reason });
      }
      const at = now();
      saveState({ cleanShutdownAt: at });
      store?.logRuntime({ type: 'runtime_stopped', at, pid: process.pid, reason });
    },

    getTask: detail,
    listTasks: () => [...runs.keys()].map((id) => detailSummary(id)),
    /** Every task on record (this runtime's and earlier ones), newest first. */
    history({ limit = 20 } = {}) {
      const byId = new Map((store ? store.loadAll().records : []).map((r) => [r.taskId, r]));
      for (const run of runs.values()) byId.set(run.id, record(run));
      return [...byId.values()].map(summarize).sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(1, Math.min(500, limit)));
    },
    /** Snapshot plus this runtime's recent events: enough for a late or reconnecting subscriber to rebuild everything. */
    sync: () => ({ snapshot: wf.snapshot(), events: events.slice() }),
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    managedSessions: () => [...runs.values()].flatMap((r) => r.sessions),
    recovery,
    /** Resolves when the task's current driver has stopped (finished, paused or interrupted). */
    whenDone: (id) => runs.get(id)?.done ?? Promise.resolve(),
  };

  function detailSummary(id) {
    const d = detail(id);
    return { taskId: id, id, title: d.task.title, stage: d.task.stage, status: d.task.status, owner: d.task.owner, attempt: d.task.attempt, active: d.active, cwd: d.project?.cwd ?? null, project: d.project };
  }
}
