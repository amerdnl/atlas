import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, RuntimeError } from '../runtime.js';
import { createFakeBackend } from '../backends/fake.js';
import { PreflightError } from '../project.js';
import { classifySessions } from '../sessions.js';
import { ROLE_POLICY } from '../prompts.js';
import { EVENT_TYPES } from '../../workflow/events.js';
import { createWorkflowVisuals } from '../../scene/src/workflow-visuals.js';

const CWD = '/projects/fixture';
const R = {
  planning: { status: 'complete', summary: 'scoped', goal: 'Add multiply(a, b) with tests', acceptanceCriteria: ['multiply(2, 3) returns 6', 'tests cover multiply'], notes: [] },
  research: { status: 'complete', summary: 'follow add()', findings: ['add() is in src/math.js'], relevantFiles: ['src/math.js', 'test/math.test.js'], decisions: ['export multiply from src/math.js'], risks: [] },
  development: { status: 'complete', summary: 'added multiply and tests', changedFiles: ['src/math.js', 'test/math.test.js'], testsRun: ['npm test — 4 passed'], caveats: [] },
  rework: { status: 'complete', summary: 'fixed sign handling', changedFiles: ['src/math.js'], testsRun: ['npm test — 5 passed'], caveats: [] },
  finalizing: { status: 'complete', summary: 'multiply delivered', finalChecks: ['change set matches the goal'] },
};
const PASS = { status: 'pass', summary: 'all criteria met', checks: ['multiply(2,3)=6'], evidence: ['npm test: 5 passed'], failures: [], recommendedRework: [] };
const FAIL = { status: 'fail', summary: 'negative numbers wrong', checks: ['multiply(-2,3)'], evidence: ['expected -6, got 6'], failures: ['multiply(-2, 3) returned 6'], recommendedRework: ['do not take absolute values'] };

/** Scripted role results; QA verdicts are consumed in order. */
function script(qa = ['pass'], overrides = {}) {
  let q = 0;
  return (call) => {
    if (overrides[call.stage]) return overrides[call.stage](call);
    if (call.stage === 'testing') return { ok: true, structured: qa[Math.min(q++, qa.length - 1)] === 'pass' ? PASS : FAIL };
    return { ok: true, structured: R[call.stage] };
  };
}

function rig({ respond = script(), maxQaAttempts, preflight, progressThrottleMs = 0 } = {}) {
  const backend = createFakeBackend({ respond });
  const logs = [];
  let n = 0;
  const rt = createRuntime({
    backend, log: (m) => logs.push(m), maxQaAttempts, progressThrottleMs,
    preflight: preflight ?? (async (cwd) => ({ cwd, root: cwd, branch: 'main', head: 'abc1234', dirtyAtStart: [] })),
    changesSince: async () => ({ status: [' M src/math.js', ' M test/math.test.js'], diffStat: '2 files changed, 12 insertions(+)' }),
    newTaskId: () => `task-${++n}`,
    newSessionId: (() => { let s = 0; return () => `s-${++s}`; })(),
  });
  const events = [];
  rt.subscribe((e) => events.push(e));
  const roles = () => backend.calls.map((c) => `${c.role}/${c.stage}${c.resume ? '(repair)' : ''}`);
  return { rt, backend, logs, events, roles };
}
const waitFor = async (cond, ms = 2000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 2)); } };
const submit = (rt, extra = {}) => rt.submitTask({ request: 'Add a multiply(a, b) function and tests.', cwd: CWD, ...extra });

test('happy path: each stage runs once as an explicitly assigned role, in the task cwd, and the task completes', async () => {
  const { rt, backend, events, roles } = rig();
  const { taskId } = await submit(rt);
  await rt.whenDone(taskId);
  assert.deepEqual(roles(), ['operations/planning', 'research/research', 'developer/development', 'qa/testing', 'operations/finalizing']);
  for (const c of backend.calls) {
    assert.equal(c.cwd, CWD, `${c.role} runs in the task cwd`);
    assert.equal(c.policy, ROLE_POLICY[c.role], `${c.role} gets its own tool policy`);
    assert.match(c.system, new RegExp(`ATLAS ${({ operations: 'Operations', research: 'Research', developer: 'Developer', qa: 'QA' })[c.role]} agent`));
    assert.match(c.backendSessionId, /^[0-9a-f-]{36}$/, 'backend session id assigned before launch');
  }
  const d = rt.getTask(taskId);
  assert.deepEqual([d.task.stage, d.task.status], ['completed', 'completed']);
  assert.deepEqual(d.sessions.map((s) => [s.role, s.stage, s.status]), [
    ['operations', 'planning', 'completed'], ['research', 'research', 'completed'], ['developer', 'development', 'completed'],
    ['qa', 'testing', 'completed'], ['operations', 'finalizing', 'completed'],
  ]);
  assert.deepEqual(d.sessions.map((s) => s.backendSessionId), backend.calls.map((c) => c.backendSessionId));
  assert.ok(d.sessions.every((s) => s.pid && s.startedAt && s.completedAt && s.exitCode === 0));
  assert.deepEqual(events.filter((e) => e.type === 'handoff_started').map((e) => `${e.payload.handoff.fromRole}→${e.payload.handoff.toRole}`),
    ['operations→research', 'research→developer', 'developer→qa', 'qa→operations']);
  assert.equal(events.at(-1).type, 'task_completed');
  assert.equal(d.artifact.finalSummary, 'multiply delivered');
  assert.deepEqual(d.changes.status, [' M src/math.js', ' M test/math.test.js']);
});

test('handoff artifact: Research → Developer and Developer → QA context reach the next role; git changes reach finalizing', async () => {
  const { rt, backend } = rig();
  const { taskId } = await submit(rt, { acceptanceCriteria: ['multiply(2, 3) returns 6'] });
  await rt.whenDone(taskId);
  const prompt = (stage) => backend.calls.find((c) => c.stage === stage).prompt;
  assert.match(prompt('development'), /add\(\) is in src\/math\.js/);
  assert.match(prompt('development'), /export multiply from src\/math\.js/);
  assert.match(prompt('development'), /multiply\(2, 3\) returns 6/);
  assert.match(prompt('testing'), /added multiply and tests/);
  assert.match(prompt('testing'), /npm test — 4 passed/);
  assert.match(prompt('finalizing'), / M src\/math\.js/);
  assert.match(prompt('finalizing'), /all criteria met/);
  const a = rt.getTask(taskId).artifact;
  assert.deepEqual(a.history.map((h) => `${h.role}:${h.status}`), ['operations:complete', 'research:complete', 'developer:complete', 'qa:pass', 'operations:complete']);
});

test('QA fail → Developer rework with the exact failures → QA retest → pass', async () => {
  const { rt, backend, events, roles } = rig({ respond: script(['fail', 'pass']) });
  const { taskId } = await submit(rt);
  await rt.whenDone(taskId);
  assert.deepEqual(roles(), ['operations/planning', 'research/research', 'developer/development', 'qa/testing', 'developer/rework', 'qa/testing', 'operations/finalizing']);
  const rework = backend.calls.find((c) => c.stage === 'rework');
  assert.match(rework.prompt, /multiply\(-2, 3\) returned 6/);
  assert.match(rework.prompt, /do not take absolute values/);
  assert.match(rework.prompt, /attempt 2/);
  assert.match(backend.calls[5].prompt, /previousQa/, 'the retest sees what failed before');
  const d = rt.getTask(taskId);
  assert.deepEqual([d.task.stage, d.task.attempt, d.task.qaResults.map((r) => r.passed)], ['completed', 2, [false, true]]);
  assert.deepEqual(events.filter((e) => e.type === 'handoff_started').map((e) => `${e.payload.handoff.fromRole}→${e.payload.handoff.toRole}`),
    ['operations→research', 'research→developer', 'developer→qa', 'qa→developer', 'developer→qa', 'qa→operations']);
});

test('max QA cycles: automatic looping stops and the task fails with the reason', async () => {
  const { rt, roles } = rig({ respond: script(['fail']), maxQaAttempts: 2 });
  const { taskId } = await submit(rt);
  await rt.whenDone(taskId);
  assert.deepEqual(roles(), ['operations/planning', 'research/research', 'developer/development', 'qa/testing', 'developer/rework', 'qa/testing']);
  const d = rt.getTask(taskId);
  assert.equal(d.task.stage, 'failed');
  assert.match(d.task.failure.reason, /QA failed 2 times \(limit 2\)/);
});

test('launch failure and a throwing backend fail the task safely with the reason', async () => {
  const one = rig({ respond: script(['pass'], { research: () => ({ ok: false, reason: 'could not launch claude (ENOENT)', exitCode: null }) }) });
  const a = await submit(one.rt);
  await one.rt.whenDone(a.taskId);
  const d = one.rt.getTask(a.taskId);
  assert.equal(d.task.stage, 'failed');
  assert.match(d.task.failure.reason, /Research \(research\) could not launch claude/);
  assert.deepEqual(d.sessions.map((s) => s.status), ['completed', 'failed']);
  assert.equal(one.backend.calls.length, 2, 'nothing runs after a failure');

  const two = rig();
  two.backend.start = () => { throw new Error('spawn EACCES'); };
  const b = await submit(two.rt);
  await two.rt.whenDone(b.taskId);
  assert.match(two.rt.getTask(b.taskId).task.failure.reason, /launch failed: spawn EACCES/);
});

test('an invalid structured result gets exactly one repair attempt in the same backend session', async () => {
  let research = 0;
  const { rt, backend, roles } = rig({ respond: script(['pass'], {
    research: (call) => (research++ === 0 ? { ok: true, structured: { status: 'complete' } } : { ok: true, structured: R.research }),
  }) });
  const { taskId } = await submit(rt);
  await rt.whenDone(taskId);
  assert.deepEqual(roles().slice(0, 3), ['operations/planning', 'research/research', 'research/research(repair)']);
  assert.equal(backend.calls[2].resume, backend.calls[1].backendSessionId);
  assert.match(backend.calls[2].prompt, /summary is required/);
  assert.equal(rt.getTask(taskId).task.stage, 'completed');

  const bad = rig({ respond: script(['pass'], { research: () => ({ ok: true, structured: { status: 'complete' } }) }) });
  const b = await submit(bad.rt);
  await bad.rt.whenDone(b.taskId);
  assert.match(bad.rt.getTask(b.taskId).task.failure.reason, /invalid research result \(summary is required\)/);
});

test('a role reporting "blocked" fails the task with its reason instead of guessing', async () => {
  const { rt, roles } = rig({ respond: script(['pass'], { research: () => ({ ok: true, structured: { ...R.research, status: 'blocked', summary: 'repository has no tests to follow' } }) }) });
  const { taskId } = await submit(rt);
  await rt.whenDone(taskId);
  assert.deepEqual(roles(), ['operations/planning', 'research/research']);
  assert.match(rt.getTask(taskId).task.failure.reason, /Research is blocked: repository has no tests to follow/);
});

test('cancellation terminates the running session, fails the task, and is idempotent', async () => {
  const { rt, backend, events } = rig({ respond: script(['pass'], { research: () => 'hang' }) });
  const { taskId } = await submit(rt);
  await waitFor(() => backend.calls.length === 2);
  const first = rt.cancelTask(taskId);
  assert.equal(backend.calls[1].cancelled, true, 'the backend process was told to stop');
  assert.equal(first.task.stage, 'failed');
  assert.match(first.task.failure.reason, /Cancelled by user/);
  await rt.whenDone(taskId);
  const again = rt.cancelTask(taskId);
  assert.equal(again.task.stage, 'failed');
  assert.deepEqual(rt.getTask(taskId).sessions.map((s) => s.status), ['completed', 'cancelled']);
  assert.equal(backend.calls.length, 2, 'nothing runs after cancellation');
  assert.equal(events.filter((e) => e.type === 'task_failed').length, 1);
  assert.throws(() => rt.cancelTask('nope'), (e) => e instanceof RuntimeError && e.code === 'unknown_task');
});

test('no duplicate execution: one task per project at a time, however many subscribers', async () => {
  const { rt, backend } = rig({ respond: script(['pass'], { research: () => 'hang' }) });
  for (let i = 0; i < 5; i++) rt.subscribe(() => {}); // e.g. five wallpaper displays
  const { taskId } = await submit(rt);
  await assert.rejects(submit(rt), (e) => e instanceof RuntimeError && e.code === 'busy_project');
  const [a, b] = await Promise.allSettled([submit(rt), submit(rt)]);
  assert.equal(a.status, 'rejected');
  assert.equal(b.status, 'rejected');
  await waitFor(() => backend.calls.length === 2);
  assert.deepEqual(backend.calls.map((c) => c.stage), ['planning', 'research'], 'each stage launched exactly once');
  rt.cancelTask(taskId);
  await rt.whenDone(taskId);
  const next = await submit(rt); // allowed once the first is finished
  assert.ok(next.taskId);
  rt.cancelTask(next.taskId);
});

test('preflight failures and bad input stop before anything is created or launched', async () => {
  const { rt, backend, events } = rig({ preflight: async () => { throw new PreflightError('dirty', 'has uncommitted changes'); } });
  await assert.rejects(submit(rt), (e) => e instanceof PreflightError && e.code === 'dirty');
  await assert.rejects(rt.submitTask({ request: '  ', cwd: CWD }), (e) => e.code === 'invalid_input');
  await assert.rejects(rt.submitTask({ request: 'x', cwd: CWD, acceptanceCriteria: [''] }), (e) => e.code === 'invalid_input');
  assert.deepEqual([backend.calls.length, events.length, rt.listTasks().length], [0, 0, 0]);
});

test('workflow events: consecutive seq, known types, JSON-safe; a late subscriber rebuilds the identical city state', async () => {
  const { rt, events } = rig({ respond: script(['fail', 'pass']) });
  const { taskId } = await submit(rt);
  await rt.whenDone(taskId);
  events.forEach((e, i) => {
    assert.equal(e.seq, i + 1);
    assert.ok(EVENT_TYPES.includes(e.type), e.type);
    assert.deepEqual(JSON.parse(JSON.stringify(e)), e);
  });
  const live = createWorkflowVisuals();
  for (const e of events) live.apply(e);
  const late = createWorkflowVisuals(); // a display that connects afterwards
  const { snapshot, events: replay } = JSON.parse(JSON.stringify(rt.sync()));
  late.reset(); late.seed(snapshot); for (const e of replay) late.apply(e);
  const t = events.at(-1).at + 1;
  assert.deepEqual(late.sample(t), live.sample(t));
  assert.equal(snapshot.seq, events.length);
});

test('backend progress becomes throttled agent_progress events for the working role', async () => {
  const { rt, events } = rig({ progressThrottleMs: 60_000, respond: script(['pass'], {
    research: (call) => { call.onProgress('reading math.js'); call.onProgress('searching the code'); return { ok: true, structured: R.research }; },
  }) });
  const { taskId } = await submit(rt);
  await rt.whenDone(taskId);
  const prog = events.filter((e) => e.type === 'agent_progress');
  assert.deepEqual(prog.map((e) => [e.payload.agent.role, e.payload.agent.action]), [['research', 'reading math.js']], 'throttled');
});

test('managed sessions are identifiable by backend session id; other Claude activity stays unmanaged', async () => {
  const { rt } = rig();
  const { taskId } = await submit(rt);
  await rt.whenDone(taskId);
  const managed = rt.managedSessions();
  const active = [{ key: '-projects-fixture', session: managed[2].backendSessionId }, { key: '-projects-fixture', session: 'external-session' }];
  assert.deepEqual(classifySessions(active, managed).map((r) => [r.managed, r.role]), [[true, 'developer'], [false, null]]);
});

test('shutdown cancels running sessions and fails their tasks', async () => {
  const { rt, backend } = rig({ respond: script(['pass'], { research: () => 'hang' }) });
  const { taskId } = await submit(rt);
  await waitFor(() => backend.calls.length === 2);
  await rt.shutdown('ATLAS stopped');
  assert.equal(backend.calls[1].cancelled, true);
  assert.match(rt.getTask(taskId).task.failure.reason, /ATLAS stopped/);
  await assert.rejects(submit(rt), (e) => e.code === 'stopped');
});
