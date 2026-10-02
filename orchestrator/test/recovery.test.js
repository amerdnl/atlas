import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime, RuntimeError } from '../runtime.js';
import { createFakeBackend } from '../backends/fake.js';
import { readJsonl } from '../store.js';
import { WorkflowError } from '../../workflow/engine.js';

const CWD = '/projects/fixture';
const R = {
  planning: { status: 'complete', summary: 'scoped', goal: 'Add multiply', acceptanceCriteria: ['multiply(2,3) is 6'] },
  research: { status: 'complete', summary: 'follow add()', findings: ['add() in src/math.js'], relevantFiles: ['src/math.js'] },
  development: { status: 'complete', summary: 'added multiply', changedFiles: ['src/math.js'], testsRun: ['npm test — 3 passed'] },
  rework: { status: 'complete', summary: 'fixed signs', changedFiles: ['src/math.js'], testsRun: ['npm test — 4 passed'] },
  testing: { status: 'pass', summary: 'all good', checks: ['multiply(2,3)=6'], evidence: ['npm test: pass'] },
  finalizing: { status: 'complete', summary: 'delivered', finalChecks: ['diff reviewed'] },
};
const FAIL = { status: 'fail', summary: 'signs wrong', checks: ['multiply(-2,3)'], evidence: ['got 6'], failures: ['multiply(-2,3) returned 6'] };
const BLOCKED = { status: 'blocked', summary: 'the agreed phrase is not in the repo', goal: '', acceptanceCriteria: [], question: 'Which greeting phrase was agreed?', suggestedActions: ['provide the phrase'] };

const tmpState = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-state-'));
const waitFor = async (cond, ms = 2000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 2)); } };
let ids = 0;

/** A runtime on a real state directory with a scripted backend. `hangAt` keeps that stage running forever. */
function rig({ stateDir = tmpState(), respond, hangAt = null, overrides = {}, processes } = {}) {
  let qa = 0;
  const backend = createFakeBackend({
    respond: respond ?? ((call) => {
      if (overrides[call.stage]) return overrides[call.stage](call);
      if (call.stage === hangAt && !call.resume) return 'hang';
      if (call.stage === 'testing') return { ok: true, structured: overrides.qa?.[qa++] ?? R.testing };
      return { ok: true, structured: R[call.stage] };
    }),
  });
  const logs = [];
  const rt = createRuntime({
    backend, stateDir, log: (m) => logs.push(m), progressThrottleMs: 0,
    preflight: async (cwd) => ({ cwd, root: cwd, branch: 'main', head: 'abc1234', dirtyAtStart: [] }),
    changesSince: async () => ({ status: [' M src/math.js'], diffStat: '1 file changed' }),
    newTaskId: () => `task-${++ids}`,
    processes: processes ?? { isManagedSession: () => false, terminateGroup: () => { throw new Error('must not kill an unverified process'); } },
  });
  const events = [];
  rt.subscribe((e) => events.push(e));
  return { rt, backend, stateDir, logs, events, calls: () => backend.calls.map((c) => `${c.role}/${c.stage}${c.resume ? '(continue)' : ''}`) };
}
const submit = (rt, extra = {}) => rt.submitTask({ request: 'Add multiply(a, b) with tests.', cwd: CWD, ...extra });

// ---- human intervention ----

test('blocked → respond → resume: the same conversation continues with the answer, then the task completes', async () => {
  const { rt, backend, calls, events } = rig({ overrides: { planning: (c) => ({ ok: true, structured: c.resume ? R.planning : BLOCKED }) } });
  const { taskId } = await submit(rt);
  await rt.whenDone(taskId);
  let d = rt.getTask(taskId);
  assert.deepEqual([d.task.status, d.task.stage, d.task.pause.question, d.active], ['blocked', 'planning', 'Which greeting phrase was agreed?', false]);
  assert.throws(() => rt.respond(taskId, ' '), (e) => e.code === 'invalid_input');
  d = rt.respond(taskId, 'Welcome to ATLAS');
  assert.deepEqual([d.task.status, d.task.pause.response], ['blocked', 'Welcome to ATLAS'], 'answering alone does not resume');
  rt.resumeTask(taskId);
  await rt.whenDone(taskId);
  assert.deepEqual(calls(), ['operations/planning', 'operations/planning(continue)', 'research/research', 'developer/development', 'qa/testing', 'operations/finalizing']);
  const cont = backend.calls[1];
  assert.equal(cont.resume, backend.calls[0].backendSessionId, 'continues the blocked session’s own conversation');
  assert.match(cont.prompt, /Which greeting phrase was agreed\?/);
  assert.match(cont.prompt, /Their answer: Welcome to ATLAS/);
  assert.match(backend.calls[2].prompt, /"humanGuidance":\[\{"role":"operations","stage":"planning","question":"Which greeting phrase was agreed\?","answer":"Welcome to ATLAS"\}\]/, 'later roles see the answer');
  d = rt.getTask(taskId);
  assert.equal(d.task.stage, 'completed');
  assert.deepEqual(d.task.pauses.map((p) => [p.kind, p.outcome, p.mode, p.response]), [['blocked', 'resumed', 'resume', 'Welcome to ATLAS']]);
  assert.deepEqual(events.filter((e) => ['agent_blocked', 'intervention_responded', 'task_resumed'].includes(e.type)).map((e) => e.type), ['agent_blocked', 'intervention_responded', 'task_resumed']);
});

test('blocked → retry: a fresh session for the same stage, with the answer as guidance', async () => {
  let n = 0;
  const { rt, backend, calls } = rig({ overrides: { research: () => ({ ok: true, structured: n++ === 0 ? { ...R.research, status: 'blocked', summary: 'which runner?', question: 'Which test runner?' } : R.research }) } });
  const { taskId } = await submit(rt);
  await rt.whenDone(taskId);
  rt.respond(taskId, 'Use node --test');
  rt.resumeTask(taskId, { mode: 'retry', note: 'start clean' });
  await rt.whenDone(taskId);
  assert.deepEqual(calls().slice(0, 3), ['operations/planning', 'research/research', 'research/research']);
  assert.equal(backend.calls[2].resume ?? null, null, 'fresh session');
  assert.match(backend.calls[2].prompt, /^This stage is being retried in a fresh session \(blocked: which runner\?; start clean\)/);
  assert.match(backend.calls[2].prompt, /"answer":"Use node --test"/);
  assert.equal(rt.getTask(taskId).task.stage, 'completed');
});

test('a blocked task can be cancelled or abandoned explicitly; a running one cannot be abandoned', async () => {
  const one = rig({ overrides: { planning: () => ({ ok: true, structured: BLOCKED }) } });
  const a = await submit(one.rt);
  await one.rt.whenDone(a.taskId);
  const c = one.rt.cancelTask(a.taskId, 'Not needed any more');
  assert.deepEqual([c.task.stage, c.task.status, c.task.cancellation.reason, c.task.pauses[0].outcome], ['cancelled', 'cancelled', 'Not needed any more', 'cancelled']);

  const two = rig({ overrides: { planning: () => ({ ok: true, structured: BLOCKED }) } });
  const b = await submit(two.rt);
  await two.rt.whenDone(b.taskId);
  assert.throws(() => two.rt.abandonTask(b.taskId, ''), (e) => e.code === 'invalid_input');
  const f = two.rt.abandonTask(b.taskId, 'requirement withdrawn');
  assert.deepEqual([f.task.stage, f.task.failure.reason], ['failed', 'Abandoned: requirement withdrawn']);
  assert.throws(() => two.rt.resumeTask(b.taskId), (e) => e.code === 'task_closed');

  const three = rig({ hangAt: 'research' });
  const r = await submit(three.rt);
  await waitFor(() => three.backend.calls.length === 2);
  assert.throws(() => three.rt.abandonTask(r.taskId, 'x'), (e) => e.code === 'running');
  assert.throws(() => three.rt.resumeTask(r.taskId), (e) => e.code === 'not_resumable');
  three.rt.cancelTask(r.taskId);
});

// ---- crash recovery ----

for (const stage of ['research', 'development', 'testing']) {
  test(`crash with ${stage} running: restart interrupts it, launches nothing, and resume runs exactly one session from ${stage}`, async () => {
    const A = rig({ hangAt: stage, overrides: stage === 'testing' ? { qa: [FAIL, R.testing] } : {} });
    const { taskId } = await submit(A.rt);
    const atStage = () => A.backend.calls.some((c) => c.stage === stage);
    await waitFor(atStage);
    if (stage === 'testing') { /* first QA run failed → rework → QA again (hangs) */ }
    const before = A.rt.getTask(taskId);
    // Crash: A is never shut down. B starts on the same state directory.
    const B = rig({ stateDir: A.stateDir, overrides: stage === 'testing' ? { qa: [R.testing] } : {} });
    assert.equal(B.backend.calls.length, 0, 'no session is launched automatically on restart');
    assert.deepEqual(B.rt.recovery.interrupted, [taskId]);
    let d = B.rt.getTask(taskId);
    assert.deepEqual([d.task.stage, d.task.status, d.task.pause.kind, d.task.pause.reason], [stage, 'interrupted', 'interrupted', 'ATLAS runtime stopped unexpectedly']);
    assert.equal(d.sessions.at(-1).status, 'interrupted');
    assert.deepEqual(d.task.history, before.task.history, 'completed handoffs preserved');
    assert.deepEqual(d.task.qaResults, before.task.qaResults, 'QA attempts preserved');
    assert.deepEqual(d.artifact, before.artifact, 'handoff artifact preserved');
    B.rt.resumeTask(taskId);
    assert.throws(() => B.rt.resumeTask(taskId), (e) => e.code === 'not_resumable', 'a repeated resume cannot start a second driver');
    await B.rt.whenDone(taskId);
    const first = B.backend.calls[0];
    assert.equal(first.stage, stage, 'resumes at the interrupted stage, not earlier');
    assert.equal(first.resume, before.sessions.at(-1).backendSessionId, 'continues the interrupted conversation');
    assert.match(first.prompt, /ATLAS stopped while you were working on the/);
    assert.equal(B.backend.calls.filter((c) => c.stage === stage).length, 1, 'exactly one new session for that stage');
    d = B.rt.getTask(taskId);
    assert.equal(d.task.stage, 'completed');
    assert.equal(d.task.qaResults.length, before.task.qaResults.length + 1);
  });
}

test('retry after a crash: a fresh session for the same stage, never a replay of earlier stages', async () => {
  const A = rig({ hangAt: 'development' });
  const { taskId } = await submit(A.rt);
  await waitFor(() => A.backend.calls.length === 3);
  const B = rig({ stateDir: A.stateDir });
  B.rt.resumeTask(taskId, { mode: 'retry' });
  await B.rt.whenDone(taskId);
  assert.deepEqual(B.calls(), ['developer/development', 'qa/testing', 'operations/finalizing']);
  assert.equal(B.backend.calls[0].resume ?? null, null);
  assert.match(B.backend.calls[0].prompt, /^This stage is being retried in a fresh session \(interrupted: ATLAS runtime stopped unexpectedly\)/);
});

test('a leftover process is terminated only when its identity is proven by the recorded session id', async () => {
  const A = rig({ hangAt: 'research' });
  const { taskId } = await submit(A.rt);
  await waitFor(() => A.backend.calls.length === 2);
  const live = A.rt.getTask(taskId).sessions.at(-1);
  const killed = [];
  const checked = [];
  const B = rig({ stateDir: A.stateDir, processes: {
    isManagedSession: (pid, sid) => { checked.push([pid, sid]); return pid === live.pid && sid === live.backendSessionId; },
    terminateGroup: (pid) => killed.push(pid),
  } });
  assert.deepEqual(checked, [[live.pid, live.backendSessionId]]);
  assert.deepEqual(killed, [live.pid]);
  assert.deepEqual(B.rt.recovery.orphansTerminated.map((o) => o.sessionId), [live.id]);
  assert.match(B.rt.getTask(taskId).sessions.at(-1).failure, /verified by session id\) and was terminated/);
  // A PID that is alive but belongs to something else (reuse) is left alone.
  const C = rig({ stateDir: A.stateDir, processes: { isManagedSession: () => false, terminateGroup: () => assert.fail('must not kill') } });
  assert.equal(C.backend.calls.length, 0);
});

test('normal shutdown vs crash: the recorded reason says which; blocked tasks stay blocked; restarts never relaunch', async () => {
  const A = rig({ hangAt: 'research' });
  const t1 = (await submit(A.rt)).taskId;
  await waitFor(() => A.backend.calls.length === 2);
  const t2 = (await A.rt.submitTask({ request: 'Blocked one', cwd: '/projects/other' })).taskId;
  await waitFor(() => A.rt.getTask(t2).task.stage === "research"); // t2 planned; now waiting for Research
  await A.rt.shutdown('ATLAS stopped (normal shutdown)');
  const B = rig({ stateDir: A.stateDir, overrides: { planning: () => ({ ok: true, structured: BLOCKED }) } });
  assert.match(B.rt.getTask(t1).task.pause.reason, /ATLAS stopped \(normal shutdown\)/);
  assert.equal(B.backend.calls.length, 0);
  const t3 = (await B.rt.submitTask({ request: 'Needs a human', cwd: '/projects/third' })).taskId;
  await B.rt.whenDone(t3);
  const C = rig({ stateDir: A.stateDir });
  assert.deepEqual(C.rt.recovery.stillBlocked, [t3]);
  assert.ok(C.rt.recovery.interrupted.includes(t1) && C.rt.recovery.interrupted.includes(t2));
  assert.equal(C.rt.getTask(t3).task.status, 'blocked');
  const D = rig({ stateDir: A.stateDir });
  assert.equal(D.backend.calls.length + C.backend.calls.length, 0, 'repeated restarts launch nothing');
  assert.equal(D.rt.getTask(t1).task.pause.reason, C.rt.getTask(t1).task.pause.reason, 'the first recorded cause is kept');
});

test('workflow seq continues across restarts; the event log holds workflow and runtime records', async () => {
  const A = rig({ hangAt: 'research' });
  const { taskId } = await submit(A.rt);
  await waitFor(() => A.backend.calls.length === 2);
  const lastA = A.events.at(-1).seq;
  const B = rig({ stateDir: A.stateDir });
  B.rt.resumeTask(taskId);
  await B.rt.whenDone(taskId);
  assert.ok(B.events[0].seq > lastA, 'no seq reuse after restart');
  const { records } = readJsonl(path.join(A.stateDir, 'runs', taskId, 'events.jsonl'));
  const workflow = records.filter((r) => r.source !== 'runtime');
  assert.deepEqual(workflow.map((r) => r.seq), [...workflow.map((r) => r.seq)].sort((a, b) => a - b), 'ordered');
  assert.equal(new Set(workflow.map((r) => r.seq)).size, workflow.length, 'unique');
  const runtime = records.filter((r) => r.source === 'runtime').map((r) => r.type);
  for (const t of ['submitted', 'session_started', 'session_finished', 'recovered', 'decision']) assert.ok(runtime.includes(t), t);
  assert.ok(!records.some((r) => JSON.stringify(r).length > 20_000), 'no raw streams in the event log');
});

// ---- duplicate protection ----

test('idempotent submission: the same requestId returns the same task — repeated, concurrent, or after a restart', async () => {
  const A = rig({ hangAt: 'research' });
  const requestId = 'req-0123456789';
  const [x, y] = await Promise.all([submit(A.rt, { requestId }), submit(A.rt, { requestId })]);
  const z = await submit(A.rt, { requestId });
  assert.equal(x.taskId, y.taskId);
  assert.equal(x.taskId, z.taskId);
  assert.equal(z.duplicate, true);
  await waitFor(() => A.backend.calls.length === 2);
  assert.equal(A.backend.calls.filter((c) => c.stage === 'planning').length, 1, 'planned once');
  const B = rig({ stateDir: A.stateDir });
  const again = await submit(B.rt, { requestId });
  assert.deepEqual([again.taskId, again.duplicate, B.backend.calls.length], [x.taskId, true, 0]);
  await assert.rejects(submit(B.rt, { requestId: 'bad id!' }), (e) => e.code === 'invalid_input');
  await assert.rejects(submit(B.rt), (e) => e.code === 'busy_project' && /interrupted/.test(e.message), 'an interrupted task still owns its project');
});

// ---- history, cost, malformed state ----

test('history and show survive restarts, with per-session, per-role and total cost', async () => {
  const A = rig();
  const { taskId } = await submit(A.rt);
  await A.rt.whenDone(taskId);
  const saved = JSON.parse(fs.readFileSync(path.join(A.stateDir, 'runs', taskId, 'run.json'), 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.cost.totalUsd, 0.05);
  assert.deepEqual(saved.cost.byRole, { operations: 0.02, research: 0.01, developer: 0.01, qa: 0.01 });
  assert.equal((fs.statSync(path.join(A.stateDir, 'runs', taskId, 'run.json')).mode & 0o777).toString(8), '600');
  const B = rig({ stateDir: A.stateDir });
  const [h] = B.rt.history({ limit: 5 });
  assert.deepEqual([h.taskId, h.status, h.stage, h.qaAttempts, h.costUsd, h.project], [taskId, 'completed', 'completed', 1, 0.05, CWD]);
  const shown = B.rt.getTask(taskId);
  assert.deepEqual([shown.task.stage, shown.active, shown.artifact.finalSummary], ['completed', false, 'delivered']);
  assert.throws(() => B.rt.resumeTask(taskId), (e) => e instanceof RuntimeError && e.code === 'task_closed');
  assert.equal(B.rt.cancelTask(taskId).task.stage, 'completed', 'cancelling a finished task is a no-op');
});

test('malformed, torn and legacy state: skipped or upgraded, never fatal', async () => {
  const A = rig({ hangAt: 'research' });
  const { taskId } = await submit(A.rt);
  await waitFor(() => A.backend.calls.length === 2);
  const dir = A.stateDir;
  fs.mkdirSync(path.join(dir, 'runs', 'task-garbage'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'runs', 'task-garbage', 'run.json'), '{"version": 2, "task": {'); // torn write
  fs.writeFileSync(path.join(dir, 'runs', 'task-garbage', '.run.json.123.tmp'), '{}'); // abandoned temp file
  fs.appendFileSync(path.join(dir, 'runs', taskId, 'events.jsonl'), '{"seq": 999, "type": "agent_'); // torn event line
  // A Phase 5 record (no version) that was running when its runtime died.
  const legacy = JSON.parse(fs.readFileSync(path.join(dir, 'runs', taskId, 'run.json'), 'utf8'));
  const old = { task: { ...legacy.task, id: 'task-legacy', pause: undefined, pauses: undefined, cancellation: undefined, assignee: null, status: 'queued' }, project: { ...legacy.project, cwd: '/projects/legacy', root: '/projects/legacy' }, artifact: legacy.artifact, sessions: [{ ...legacy.sessions.at(-1), id: 's-legacy', taskId: 'task-legacy', status: 'running' }], changes: null, active: true };
  fs.mkdirSync(path.join(dir, 'runs', 'task-legacy'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'runs', 'task-legacy', 'run.json'), JSON.stringify(old));
  fs.writeFileSync(path.join(dir, 'state', 'runtime-state.json'), '{ nope'); // unreadable runtime state
  const B = rig({ stateDir: dir });
  assert.deepEqual(B.rt.recovery.problems.map((p) => path.basename(path.dirname(p.file))), ['task-garbage']);
  assert.deepEqual(B.rt.recovery.interrupted.sort(), [taskId, 'task-legacy'].sort());
  assert.equal(B.rt.getTask('task-legacy').sessions[0].status, 'interrupted');
  assert.equal(B.rt.getTask(taskId).task.status, 'interrupted');
  assert.equal(B.backend.calls.length, 0);
});

test('a continuation that cannot be resumed falls back once to a fresh session', async () => {
  const A = rig({ hangAt: 'research' });
  const { taskId } = await submit(A.rt);
  await waitFor(() => A.backend.calls.length === 2);
  const B = rig({ stateDir: A.stateDir, overrides: { research: (c) => (c.resume ? { ok: false, reason: 'No conversation found' } : { ok: true, structured: R.research }) } });
  B.rt.resumeTask(taskId);
  await B.rt.whenDone(taskId);
  assert.deepEqual(B.calls().slice(0, 2), ['research/research(continue)', 'research/research']);
  assert.match(B.backend.calls[1].prompt, /continuing the previous conversation failed: No conversation found/);
  assert.equal(B.rt.getTask(taskId).task.stage, 'completed');
});

test('engine errors surface as clear codes (respond to a task that is not blocked)', async () => {
  const A = rig({ hangAt: 'research' });
  const { taskId } = await submit(A.rt);
  await waitFor(() => A.backend.calls.length === 2);
  assert.throws(() => A.rt.respond(taskId, 'x'), (e) => e instanceof WorkflowError && e.code === 'not_blocked');
  A.rt.cancelTask(taskId);
});

// ---- added on resume after Phase 6C: quarantine and decision idempotency ----

test('a record the engine cannot restore is quarantined: the runtime starts, other tasks recover, the file is untouched', async () => {
  const A = rig({ hangAt: 'research' });
  const good = await submit(A.rt);
  await waitFor(() => A.backend.calls.length === 2);
  const badDir = path.join(A.stateDir, 'runs', 'task-bad');
  fs.mkdirSync(badDir, { recursive: true });
  const bad = JSON.parse(fs.readFileSync(path.join(A.stateDir, 'runs', good.taskId, 'run.json'), 'utf8'));
  bad.taskId = 'task-bad'; bad.task = { ...bad.task, id: 'task-bad', stage: 'teleporting' }; bad.requestId = null;
  fs.writeFileSync(path.join(badDir, 'run.json'), JSON.stringify(bad));
  const before = fs.readFileSync(path.join(badDir, 'run.json'), 'utf8');
  const B = rig({ stateDir: A.stateDir });
  assert.deepEqual(B.rt.recovery.interrupted, [good.taskId], 'the good task still recovers');
  assert.ok(B.rt.recovery.problems.some((p) => p.quarantined && /teleporting/.test(p.error)), 'the bad one is reported');
  assert.throws(() => B.rt.resumeTask('task-bad'), (e) => e.code === 'task_unreadable');
  assert.equal(fs.readFileSync(path.join(badDir, 'run.json'), 'utf8'), before, 'never rewritten');
  assert.equal(B.backend.calls.length, 0);
});

test('decisions are idempotent: a repeated resume/retry/respond/cancel/fail request acts once — also after a restart', async () => {
  const A = rig({ hangAt: 'development' });
  const { taskId } = await submit(A.rt);
  await waitFor(() => A.backend.calls.length === 3);
  const B = rig({ stateDir: A.stateDir, overrides: { development: () => ({ ok: true, structured: { status: 'blocked', summary: 'need the API key name', question: 'Which env var?' } }) } });
  // Resume twice with the same id: the second is a no-op, not a refusal and not a second session.
  B.rt.resumeTask(taskId, { requestId: 'resume-0001' });
  const again = B.rt.resumeTask(taskId, { requestId: 'resume-0001' });
  assert.equal(again.duplicate, true);
  await B.rt.whenDone(taskId);
  assert.equal(B.backend.calls.filter((c) => c.stage === 'development').length, 1, 'one session, however often the request arrives');
  assert.equal(B.rt.getTask(taskId).task.status, 'blocked', 'paused again: a stale repeat of the old resume must not restart it');
  assert.equal(B.rt.resumeTask(taskId, { requestId: 'resume-0001' }).duplicate, true);
  assert.equal(B.backend.calls.length, 1);
  // A reused id for a different decision is refused rather than silently ignored.
  assert.throws(() => B.rt.cancelTask(taskId, 'x', { requestId: 'resume-0001' }), (e) => e.code === 'invalid_input');
  B.rt.cancelTask(taskId, 'stop', { requestId: 'cancel-0001' });
  // After a restart, the same ids are still recognised.
  const C = rig({ stateDir: A.stateDir });
  assert.equal(C.rt.cancelTask(taskId, 'stop', { requestId: 'cancel-0001' }).duplicate, true);
  assert.equal(C.backend.calls.length, 0);
  assert.equal(C.rt.getTask(taskId).task.stage, 'cancelled');
});

test('respond and fail are idempotent by request id; a blocked task is answered once', async () => {
  const A = rig({ overrides: { planning: () => ({ ok: true, structured: BLOCKED }) } });
  const { taskId } = await submit(A.rt);
  await A.rt.whenDone(taskId);
  A.rt.respond(taskId, 'Hello, ATLAS', { requestId: 'respond-0001' });
  assert.equal(A.rt.respond(taskId, 'Hello, ATLAS', { requestId: 'respond-0001' }).duplicate, true);
  assert.equal(A.rt.getTask(taskId).artifact.interventions.length, 1);
  A.rt.abandonTask(taskId, 'withdrawn', { requestId: 'fail-00001' });
  assert.equal(A.rt.abandonTask(taskId, 'withdrawn', { requestId: 'fail-00001' }).duplicate, true);
  assert.equal(A.rt.getTask(taskId).task.stage, 'failed');
});
