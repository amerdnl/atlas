import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createWorkflow, WorkflowError } from '../workflow/engine.js';
import { isTerminal } from '../workflow/stages.js';
import { ROLES } from '../workflow/roles.js';
import { contractFor, schemaFor, normalizeResult } from './contracts.js';
import { createArtifact, applyResult, routeArtifact } from './artifact.js';
import { ROLE_POLICY, systemPrompt, stagePrompt, repairPrompt } from './prompts.js';
import { createSession, advanceSession } from './sessions.js';
import { preflight as realPreflight, changesSince as realChangesSince } from './project.js';

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
const publicProject = (p) => ({ cwd: p.cwd, root: p.root, branch: p.branch, head: p.head, dirtyAtStart: p.dirtyAtStart.length });

/**
 * The single authoritative ATLAS runtime: one Phase 3 workflow engine, and for each submitted task a
 * driver that runs the workflow stage by stage through managed backend sessions.
 *
 *   task → workflow engine → session for the current owner role (explicit, assigned before launch)
 *        → normalized structured result → workflow transition / handoff → events → subscribers
 *
 * It lives in exactly one process (the collector), so however many wallpaper displays subscribe,
 * each task is executed once. Subscribers get a `sync()` (snapshot + recent events) and then live
 * events in `seq` order. The engine never sees a process; the backend never decides a transition.
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
}) {
  const wf = createWorkflow({ now, maxQaAttempts });
  const events = [];
  const subscribers = new Set();
  const runs = new Map();
  let stopped = false;

  // ---- persistence (optional): <stateDir>/runs/<taskId>/{run.json, events.jsonl, sessions/*.jsonl} ----
  const runDir = (id) => (stateDir ? path.join(stateDir, 'runs', id) : null);
  function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  function appendLine(id, file, line) {
    const dir = runDir(id);
    if (!dir) return;
    try { ensureDir(dir); fs.appendFileSync(path.join(dir, file), `${line}\n`, { mode: 0o600 }); } catch (e) { log(`task=${id} could not write ${file}: ${e.message}`); }
  }
  function saveRun(run) {
    const dir = runDir(run.id);
    if (!dir) return;
    try {
      ensureDir(dir);
      const tmp = path.join(dir, 'run.json.tmp');
      fs.writeFileSync(tmp, JSON.stringify(detail(run.id), null, 2), { mode: 0o600 });
      fs.renameSync(tmp, path.join(dir, 'run.json'));
    } catch (e) { log(`task=${run.id} could not save run.json: ${e.message}`); }
  }
  function sessionLogPath(run, sessionId) {
    const dir = runDir(run.id);
    if (!dir) return null;
    ensureDir(path.join(dir, 'sessions'));
    return path.join(dir, 'sessions', `${sessionId}.jsonl`);
  }

  // ---- event fan-out and attributable logging ----
  function describe(e) {
    const p = e.payload;
    switch (e.type) {
      case 'task_created': return `task created: "${p.task.title}"`;
      case 'stage_changed': return `stage ${p.from} → ${p.to} (owner ${p.owner ?? '—'}, attempt ${p.attempt})`;
      case 'agent_assigned': return `role ${p.agent.role} assigned`;
      case 'agent_started': return `role ${p.agent.role} working (${p.agent.action ?? ''})`;
      case 'agent_waiting': case 'agent_blocked': return `role ${p.agent.role} ${p.agent.status}: ${p.reason}`;
      case 'handoff_started': return `handoff ${p.handoff.fromRole} → ${p.handoff.toRole} (${p.handoff.fromStage} → ${p.handoff.toStage})`;
      case 'qa_passed': return `QA passed attempt ${p.attempt}`;
      case 'qa_failed': return `QA failed attempt ${p.attempt} (${p.failures}/${p.maxQaAttempts}): ${short(p.reason)}`;
      case 'task_completed': return `task completed (attempts ${p.attempts}, QA cycles ${p.qaCycles})`;
      case 'task_failed': return `task failed at ${p.stage}: ${short(p.reason)}`;
      default: return null; // agent_idle, agent_progress, handoff_completed: in the event log, not the console
    }
  }
  wf.on((e) => {
    events.push(e);
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
    appendLine(e.taskId, 'events.jsonl', JSON.stringify(e));
    const line = describe(e);
    if (line) log(`task=${e.taskId} ${line}`);
    for (const fn of subscribers) {
      try { fn(e); } catch (err) { log(`subscriber failed: ${err.message}`); }
    }
  });

  function fail(run, reason) {
    try { wf.failTask(run.id, { reason }); } catch (e) { if (!(e instanceof WorkflowError)) throw e; }
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

  /** Resolves once the task's owner agent has picked it up, or the task ended / was cancelled. */
  function waitForAssignment(run) {
    return new Promise((resolve) => {
      const done = () => { off(); run.wake = null; resolve(); };
      const off = wf.on((e) => {
        if (e.taskId === run.id && (e.type === 'agent_assigned' || e.type === 'task_failed' || e.type === 'task_completed')) done();
      });
      run.wake = done;
      const t = wf.getTask(run.id);
      if (t.assignee || isTerminal(t.stage) || run.cancelled) done();
    });
  }

  async function launch(run, opts, onStarted) {
    let handle;
    try { handle = backend.start(opts); } catch (e) { return { ok: false, reason: `launch failed: ${e.message}` }; }
    run.handle = handle;
    onStarted?.(handle);
    if (run.cancelled) handle.cancel('cancelled');
    try { return await handle.done; } finally { run.handle = null; }
  }

  /** One stage, one managed session: launch, wait, validate (one repair attempt), record. */
  async function runStage(run, task, role, stage) {
    const contract = contractFor(stage);
    let session = createSession({
      id: newSessionId(), taskId: run.id, role, stage, backend: backend.name, cwd: run.project.cwd,
      handoffId: task.history.at(-1)?.id ?? null, attempt: task.attempt, at: now(),
    });
    const put = (to, patch) => { session = advanceSession(session, to, now(), patch); upsert(run, session); saveRun(run); };
    upsert(run, session);
    const tag = `task=${run.id} role=${role} session=${session.id}`;

    const changes = stage === 'finalizing' ? await changesSince(run.project) : null;
    if (changes) run.changes = changes;
    if (run.cancelled) { put('cancelled', { failure: 'cancelled before launch' }); return { ok: false, cancelled: true }; }

    const backendSessionId = crypto.randomUUID();
    const base = {
      sessionId: session.id, backendSessionId, taskId: run.id, role, stage, cwd: run.project.cwd,
      system: systemPrompt(role, run.project.cwd), schema: schemaFor(contract), policy: ROLE_POLICY[role],
      rawLogPath: sessionLogPath(run, session.id), onProgress: (action) => progress(run, action),
    };
    put('starting', { backendSessionId });
    log(`${tag} stage=${stage}: launching ${backend.name} session ${backendSessionId} in ${run.project.cwd}`);
    let outcome = await launch(run, { ...base, prompt: stagePrompt({ role, stage, task, artifact: run.artifact, project: run.project, changes }) }, (h) => {
      put('running', { pid: h.pid ?? null });
      log(`${tag} running (pid ${h.pid ?? '—'})`);
    });
    let cost = outcome.costUsd ?? 0;

    const cancelled = () => {
      put('cancelled', { failure: 'cancelled', exitCode: outcome.exitCode ?? null, costUsd: cost || null });
      log(`${tag} cancelled`);
      return { ok: false, cancelled: true };
    };
    if (outcome.cancelled || run.cancelled) return cancelled();
    if (!outcome.ok) {
      put('failed', { failure: outcome.reason, exitCode: outcome.exitCode ?? null, costUsd: cost || null });
      log(`${tag} failed: ${outcome.reason}`);
      return { ok: false, reason: outcome.reason };
    }

    let norm = normalizeResult(contract, outcome.structured);
    if (!norm.ok && backend.canResume) {
      log(`${tag} result did not match the ${contract} contract (${norm.error}); asking the same session to repair it`);
      const repaired = await launch(run, { ...base, resume: outcome.backendSessionId ?? backendSessionId, prompt: repairPrompt(norm.error) });
      cost += repaired.costUsd ?? 0;
      outcome = { ...repaired, exitCode: repaired.exitCode ?? outcome.exitCode };
      if (repaired.cancelled || run.cancelled) return cancelled();
      norm = repaired.ok ? normalizeResult(contract, repaired.structured) : { ok: false, error: repaired.reason };
    }
    if (!norm.ok) {
      const reason = `returned an invalid ${contract} result (${norm.error})`;
      put('failed', { failure: reason, exitCode: outcome.exitCode ?? null, costUsd: cost || null });
      log(`${tag} failed: ${reason}`);
      return { ok: false, reason };
    }
    put('completed', { exitCode: outcome.exitCode ?? 0, result: norm.value, costUsd: cost || null });
    log(`${tag} completed: ${norm.value.status} — ${short(norm.value.summary)}${cost ? ` ($${cost.toFixed(2)})` : ''}`);
    return { ok: true, contract, result: norm.value, sessionId: session.id };
  }

  /** Turn a role's validated result into exactly one workflow command. */
  function advance(run, role, stage, { contract, result, sessionId }) {
    run.artifact = applyResult(run.artifact, { role, stage, contract, sessionId, result, at: now() });
    const meta = { sessionId };
    if (result.status === 'blocked') {
      fail(run, `${ROLES[role].name} is blocked: ${result.summary}`);
    } else if (stage === 'testing') {
      if (result.status === 'pass') wf.qaPass(run.id, { notes: result.summary, meta });
      else wf.qaFail(run.id, { reason: short(`${result.summary} — ${result.failures.join('; ')}`, 600), meta });
    } else {
      wf.completeStage(run.id, { reason: short(result.summary, 600), meta });
    }
    const t = wf.getTask(run.id);
    run.artifact = routeArtifact(run.artifact, { stage: t.stage, fromRole: role, toRole: t.owner });
    saveRun(run);
  }

  async function drive(run) {
    while (!run.cancelled) {
      const task = wf.getTask(run.id);
      if (isTerminal(task.stage)) return;
      if (!task.assignee) { await waitForAssignment(run); continue; }
      const role = task.owner, stage = task.stage;
      wf.startWork(run.id, { action: STAGE_ACTION[stage] });
      run.lastAction = STAGE_ACTION[stage];
      const outcome = await runStage(run, wf.getTask(run.id), role, stage);
      if (run.cancelled || isTerminal(wf.getTask(run.id).stage)) return;
      if (!outcome.ok) { fail(run, `${ROLES[role].name} (${stage}) ${outcome.reason}`); return; }
      advance(run, role, stage, outcome);
    }
  }

  function detail(id) {
    const run = runs.get(id);
    if (!run) throw new RuntimeError('unknown_task', `unknown task: ${id}`);
    return {
      task: wf.getTask(id), project: publicProject(run.project), artifact: run.artifact,
      sessions: run.sessions, changes: run.changes ?? null, active: run.active, runDir: runDir(id),
    };
  }

  /** Stop a task: the workflow records it as failed ("Cancelled…"), its running session is terminated. Idempotent. */
  function cancelTask(id, reason = 'Cancelled by user') {
    const run = runs.get(id);
    if (!run) throw new RuntimeError('unknown_task', `unknown task: ${id}`);
    if (run.cancelled || isTerminal(wf.getTask(id).stage)) return detail(id);
    run.cancelled = true;
    log(`task=${id} cancellation requested: ${reason}`);
    fail(run, reason);
    run.handle?.cancel(reason);
    run.wake?.();
    return detail(id);
  }

  return {
    /** Validate the target, create the task in the workflow engine, and start driving it. */
    async submitTask({ request, cwd, acceptanceCriteria = [], allowDirty = false, allowSelf = false } = {}) {
      if (stopped) throw new RuntimeError('stopped', 'the ATLAS runtime is shutting down');
      if (typeof request !== 'string' || !request.trim()) throw new RuntimeError('invalid_input', 'request is required');
      if (!Array.isArray(acceptanceCriteria) || !acceptanceCriteria.every((c) => typeof c === 'string' && c.trim())) {
        throw new RuntimeError('invalid_input', 'acceptanceCriteria must be a list of non-empty strings');
      }
      const project = await preflight(cwd, { allowDirty, allowSelf, atlasRoot });
      // From here on everything is synchronous, so two submissions can't both pass this check.
      for (const r of runs.values()) {
        if (r.active && r.project.root === project.root) throw new RuntimeError('busy_project', `task ${r.id} is already running in ${project.root}`);
      }
      const id = newTaskId();
      const text = request.trim();
      const run = {
        id, project, active: true, cancelled: false, handle: null, wake: null, sessions: [], changes: null, lastProgress: 0, lastAction: null,
        artifact: createArtifact({ taskId: id, goal: text, acceptanceCriteria, project: publicProject(project) }),
      };
      runs.set(id, run);
      log(`task=${id} target ${project.cwd} (branch ${project.branch ?? 'detached'}, HEAD ${project.head?.slice(0, 8) ?? 'none'})${project.dirtyAtStart.length ? `; dirty tree acknowledged (${project.dirtyAtStart.length} paths)` : ''}`);
      wf.createTask({ id, title: text.split('\n')[0].slice(0, 80), description: text, acceptanceCriteria });
      saveRun(run);
      run.done = drive(run)
        .catch((err) => { log(`task=${id} orchestration error: ${err.stack || err.message}`); fail(run, `orchestration error: ${err.message}`); })
        .finally(() => { run.active = false; run.handle = null; saveRun(run); });
      return { taskId: id, project: publicProject(project) };
    },

    cancelTask,

    /** Cancel everything and wait (bounded) for sessions to exit. */
    async shutdown(reason = 'ATLAS runtime stopped') {
      stopped = true;
      const active = [...runs.values()].filter((r) => r.active);
      for (const r of active) cancelTask(r.id, reason);
      await Promise.race([Promise.allSettled(active.map((r) => r.done)), new Promise((r) => setTimeout(r, 8000).unref?.())]);
    },

    getTask: detail,
    listTasks: () => [...runs.keys()].map((id) => { const d = detail(id); return { id, title: d.task.title, stage: d.task.stage, status: d.task.status, owner: d.task.owner, attempt: d.task.attempt, active: d.active, cwd: d.project.cwd }; }),
    /** Snapshot plus the recent event log: enough for a late or reconnecting subscriber to rebuild everything. */
    sync: () => ({ snapshot: wf.snapshot(), events: events.slice() }),
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    managedSessions: () => [...runs.values()].flatMap((r) => r.sessions),
    /** Resolves when the task's driver has finished (tests, CLI). */
    whenDone: (id) => runs.get(id)?.done ?? Promise.resolve(),
  };
}
