import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflow, WorkflowError, isHandoff } from '../engine.js';
import { EVENT_TYPES } from '../events.js';

/** A workflow on a fake clock (+1 per call) that records every event. */
function setup(opts = {}) {
  let t = 1000;
  const wf = createWorkflow({ now: () => ++t, ...opts });
  const events = [];
  wf.on((e) => events.push(e));
  const since = (n) => events.slice(n).map((e) => e.type);
  return { wf, events, since };
}

const TASK = { title: 'Add authentication', description: 'Sign in and out', acceptanceCriteria: ['Sign in works', 'Sign out invalidates the session'] };

/** Drive a task forward through its owner: start, then complete the stage. */
function advance(wf, id, reason) {
  wf.startWork(id);
  return wf.completeStage(id, { reason });
}

/** Planning → research → development → testing, with QA working. */
function toTesting(wf) {
  const { id } = wf.createTask(TASK);
  advance(wf, id, 'scoped');
  advance(wf, id, 'researched');
  advance(wf, id, 'implemented');
  wf.startWork(id);
  return id;
}

const rejects = (fn, code) => assert.throws(fn, (e) => e instanceof WorkflowError && e.code === code, `expected ${code}`);

test('starts with four idle agents and no tasks', () => {
  const { wf } = setup();
  assert.deepEqual(wf.listAgents().map((a) => [a.id, a.role, a.status, a.taskId]), [
    ['operations', 'operations', 'idle', null], ['research', 'research', 'idle', null],
    ['developer', 'developer', 'idle', null], ['qa', 'qa', 'idle', null],
  ]);
  assert.deepEqual(wf.listTasks(), []);
});

test('creating a task: planning, owned by Operations, picked up by the Operations agent', () => {
  const { wf, events } = setup();
  const task = wf.createTask(TASK);
  assert.equal(task.id, 'task-1');
  assert.equal(task.title, 'Add authentication');
  assert.deepEqual(task.acceptanceCriteria, TASK.acceptanceCriteria);
  assert.equal(task.stage, 'planning');
  assert.equal(task.owner, 'operations');
  assert.equal(task.assignee, 'operations');
  assert.equal(task.status, 'in_progress');
  assert.equal(task.attempt, 1);
  assert.deepEqual([task.history, task.qaResults, task.failure], [[], [], null]);
  assert.equal(task.createdAt, task.updatedAt);
  assert.deepEqual(events.map((e) => [e.seq, e.type, e.taskId]), [[1, 'task_created', 'task-1'], [2, 'agent_assigned', 'task-1']]);
  assert.equal(wf.getAgent('operations').status, 'assigned');
});

test('task input is validated and ids are unique', () => {
  const { wf, events } = setup();
  rejects(() => wf.createTask({}), 'invalid_input');
  rejects(() => wf.createTask({ title: '   ' }), 'invalid_input');
  rejects(() => wf.createTask({ title: 'x', acceptanceCriteria: 'not a list' }), 'invalid_input');
  rejects(() => wf.createTask({ title: 'x', acceptanceCriteria: [''] }), 'invalid_input');
  rejects(() => wf.createTask({ title: 'x', description: 42 }), 'invalid_input');
  assert.equal(events.length, 0, 'rejected commands emit nothing');
  wf.createTask({ id: 'task-2', title: 'explicit id' });
  rejects(() => wf.createTask({ id: 'task-2', title: 'again' }), 'duplicate_task');
  assert.equal(wf.createTask({ title: 'auto' }).id, 'task-3', 'auto ids skip ids already taken');
  assert.equal(wf.createTask({ title: 'auto' }).id, 'task-4');
});

test('Operations → Research: a handoff with an exact, deterministic event sequence', () => {
  const { wf, events, since } = setup();
  const { id } = wf.createTask(TASK);
  wf.startWork(id, { action: 'Scoping' });
  assert.equal(wf.getAgent('operations').action, 'Scoping');
  const n = events.length;
  const task = wf.completeStage(id, { reason: 'scoped', meta: { ticket: 7 } });
  assert.deepEqual(since(n), ['stage_changed', 'agent_idle', 'handoff_started', 'agent_assigned', 'handoff_completed']);
  assert.equal(task.stage, 'research');
  assert.equal(task.owner, 'research');
  assert.equal(task.assignee, 'research');
  assert.equal(wf.getAgent('operations').status, 'idle');
  assert.equal(wf.getAgent('research').status, 'assigned');
  const [h] = wf.handoffs(id);
  assert.deepEqual(h, { id: 'task-1#1', taskId: id, fromRole: 'operations', toRole: 'research', fromStage: 'planning', toStage: 'research', at: h.at, reason: 'scoped', meta: { ticket: 7 } });
  const started = events.find((e) => e.type === 'handoff_started');
  const completed = events.find((e) => e.type === 'handoff_completed');
  assert.deepEqual(started.payload.handoff, h);
  assert.deepEqual(completed.payload.handoff, h);
});

test('Research → Developer → QA follow the same handoff pattern', () => {
  const { wf } = setup();
  const { id } = wf.createTask(TASK);
  advance(wf, id, 'scoped');
  assert.equal(advance(wf, id, 'researched').stage, 'development');
  assert.equal(wf.getTask(id).assignee, 'developer');
  assert.equal(advance(wf, id, 'implemented').stage, 'testing');
  assert.equal(wf.getTask(id).assignee, 'qa');
  assert.deepEqual(wf.handoffs(id).map((h) => `${h.fromRole}→${h.toRole}`), ['operations→research', 'research→developer', 'developer→qa']);
});

test('a stage can only be completed by its owner while working', () => {
  const { wf, events } = setup();
  const { id } = wf.createTask(TASK);
  const before = wf.snapshot();
  const n = events.length;
  rejects(() => wf.completeStage(id), 'agent_not_working'); // assigned, not started
  assert.deepEqual(wf.snapshot(), before, 'rejected command changes nothing');
  assert.equal(events.length, n, 'rejected command emits nothing');
  wf.startWork(id);
  wf.wait(id, { reason: 'Waiting for the user' });
  rejects(() => wf.completeStage(id), 'agent_not_working');
});

test('testing ends only with a QA verdict; verdicts only apply in testing', () => {
  const { wf } = setup();
  const id = toTesting(wf);
  rejects(() => wf.completeStage(id), 'wrong_stage');
  const other = setup().wf;
  const { id: early } = other.createTask(TASK);
  other.startWork(early);
  rejects(() => other.qaPass(early), 'wrong_stage');
  rejects(() => other.qaFail(early, { reason: 'x' }), 'wrong_stage');
});

test('QA pass: recorded, handed to Operations, then finalized to completed', () => {
  const { wf, events, since } = setup();
  const id = toTesting(wf);
  let n = events.length;
  const passed = wf.qaPass(id, { notes: 'All criteria met' });
  assert.deepEqual(since(n), ['qa_passed', 'stage_changed', 'agent_idle', 'handoff_started', 'agent_assigned', 'handoff_completed']);
  assert.equal(passed.stage, 'finalizing');
  assert.equal(passed.owner, 'operations');
  assert.deepEqual(passed.qaResults.map((r) => [r.attempt, r.passed, r.reason]), [[1, true, 'All criteria met']]);
  assert.deepEqual(wf.handoffs(id).at(-1).fromRole + '→' + wf.handoffs(id).at(-1).toRole, 'qa→operations');

  wf.startWork(id);
  n = events.length;
  const done = wf.completeStage(id, { reason: 'Delivered' });
  assert.deepEqual(since(n), ['stage_changed', 'agent_idle', 'task_completed']);
  assert.deepEqual([done.stage, done.status, done.owner, done.assignee], ['completed', 'completed', null, null]);
  assert.deepEqual(events.at(-1).payload, { attempts: 1, qaCycles: 1 });
  assert.ok(wf.listAgents().every((a) => a.status === 'idle' && a.taskId === null), 'nobody looks busy on a finished task');
  assert.equal(isHandoff(done.history.at(-1)), false, 'closing is a stage change, not a handoff');
});

test('QA failure: reason required, recorded, and the task returns to the Developer as rework', () => {
  const { wf, events, since } = setup();
  const id = toTesting(wf);
  rejects(() => wf.qaFail(id, {}), 'invalid_input');
  const n = events.length;
  const task = wf.qaFail(id, { reason: 'Sign out keeps the session' });
  assert.deepEqual(since(n), ['qa_failed', 'stage_changed', 'agent_idle', 'handoff_started', 'agent_assigned', 'handoff_completed']);
  assert.deepEqual(events[n].payload, { attempt: 1, reason: 'Sign out keeps the session', failures: 1, maxQaAttempts: 3 });
  assert.deepEqual([task.stage, task.owner, task.assignee, task.attempt], ['rework', 'developer', 'developer', 2]);
  assert.deepEqual(task.qaResults.map((r) => [r.attempt, r.passed, r.reason]), [[1, false, 'Sign out keeps the session']]);
  const h = wf.handoffs(id).at(-1);
  assert.deepEqual([h.fromRole, h.toRole, h.fromStage, h.toStage, h.reason], ['qa', 'developer', 'testing', 'rework', 'Sign out keeps the session']);
});

test('rework loop: Developer fixes, QA retests the new attempt', () => {
  const { wf } = setup();
  const id = toTesting(wf);
  wf.qaFail(id, { reason: 'bug' });
  const retest = advance(wf, id, 'fixed');
  assert.deepEqual([retest.stage, retest.owner, retest.attempt], ['testing', 'qa', 2]);
  const h = wf.handoffs(id).at(-1);
  assert.deepEqual([h.fromRole, h.toRole, h.fromStage, h.toStage], ['developer', 'qa', 'rework', 'testing']);
});

test('repeated QA cycles stay observable in results and history', () => {
  const { wf } = setup();
  const id = toTesting(wf);
  wf.qaFail(id, { reason: 'first' });
  advance(wf, id, 'fix 1');
  wf.startWork(id);
  wf.qaFail(id, { reason: 'second' });
  advance(wf, id, 'fix 2');
  wf.startWork(id);
  wf.qaPass(id);
  wf.startWork(id);
  const done = wf.completeStage(id);
  assert.deepEqual(done.qaResults.map((r) => [r.attempt, r.passed]), [[1, false], [2, false], [3, true]]);
  assert.equal(done.attempt, 3);
  assert.deepEqual(done.history.map((h) => h.toStage), ['research', 'development', 'testing', 'rework', 'testing', 'rework', 'testing', 'finalizing', 'completed']);
  assert.deepEqual(wf.handoffs(id).map((h) => `${h.fromRole}→${h.toRole}`), [
    'operations→research', 'research→developer', 'developer→qa', 'qa→developer', 'developer→qa', 'qa→developer', 'developer→qa', 'qa→operations',
  ]);
  assert.deepEqual(done.history.map((h) => h.id), done.history.map((_, i) => `${id}#${i + 1}`));
});

test('QA attempts are capped: the loop ends in a recorded failure, not forever', () => {
  const { wf, events } = setup({ maxQaAttempts: 2 });
  const id = toTesting(wf);
  wf.qaFail(id, { reason: 'first' });
  advance(wf, id, 'fix');
  wf.startWork(id);
  const failed = wf.qaFail(id, { reason: 'second' });
  assert.deepEqual([failed.stage, failed.status, failed.owner], ['failed', 'failed', null]);
  assert.match(failed.failure.reason, /QA failed 2 times \(limit 2\): second/);
  assert.equal(failed.failure.stage, 'testing');
  assert.deepEqual(events.slice(-3).map((e) => e.type), ['stage_changed', 'agent_idle', 'task_failed']);
  assert.ok(wf.listAgents().every((a) => a.status === 'idle'));
  assert.throws(() => createWorkflow({ maxQaAttempts: 0 }), /maxQaAttempts/);
});

test('completed and failed tasks cannot transition or be worked on', () => {
  const { wf, events } = setup();
  const id = toTesting(wf);
  wf.qaPass(id);
  advance(wf, id);
  const before = wf.snapshot();
  const n = events.length;
  for (const fn of [() => wf.startWork(id), () => wf.completeStage(id), () => wf.qaPass(id), () => wf.qaFail(id, { reason: 'x' }), () => wf.failTask(id, { reason: 'x' }), () => wf.wait(id, { reason: 'x' })]) {
    rejects(fn, 'task_closed');
  }
  assert.deepEqual(wf.snapshot(), before);
  assert.equal(events.length, n);

  const other = setup().wf;
  const { id: gone } = other.createTask(TASK);
  other.failTask(gone, { reason: 'cancelled' });
  rejects(() => other.startWork(gone), 'task_closed');
});

test('failTask aborts from any open stage, needs a reason, and frees the agent', () => {
  const { wf, since, events } = setup();
  const { id } = wf.createTask(TASK);
  advance(wf, id);
  wf.startWork(id);
  rejects(() => wf.failTask(id, {}), 'invalid_input');
  const n = events.length;
  const t = wf.failTask(id, { reason: 'Requirements withdrawn' });
  assert.deepEqual(since(n), ['stage_changed', 'agent_idle', 'task_failed']);
  assert.deepEqual(events.at(-1).payload, { reason: 'Requirements withdrawn', stage: 'research' });
  assert.deepEqual(t.failure, { reason: 'Requirements withdrawn', stage: 'research', at: t.failure.at });
  assert.equal(wf.getAgent('research').status, 'idle');
});

test('agent status: waiting, blocked (with error), and resuming', () => {
  const { wf, since, events } = setup();
  const { id } = wf.createTask(TASK);
  rejects(() => wf.wait(id, { reason: 'x' }), 'invalid_agent_status'); // assigned can't wait
  wf.startWork(id);
  let n = events.length;
  wf.wait(id, { reason: 'Waiting for the user' });
  assert.deepEqual(since(n), ['agent_waiting']);
  assert.deepEqual([wf.getAgent('operations').status, wf.getAgent('operations').action], ['waiting', 'Waiting for the user']);
  rejects(() => wf.block(id, {}), 'invalid_input');
  wf.block(id, { reason: 'Repository not accessible' });
  const blocked = wf.getAgent('operations');
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.error.message, 'Repository not accessible');
  n = events.length;
  wf.startWork(id, { action: 'Retrying' });
  assert.deepEqual(since(n), ['agent_started']);
  assert.equal(events.at(-1).payload.resumedFrom, 'blocked');
  assert.deepEqual([wf.getAgent('operations').status, wf.getAgent('operations').error], ['working', null]);
  rejects(() => wf.startWork(id), 'invalid_agent_status'); // already working
});

test('a busy role queues work first-in first-out; handoff completes only when picked up', () => {
  const { wf, events } = setup();
  const a = toTesting(wf); // QA is now busy with task-1
  const { id: b } = wf.createTask({ title: 'Second task' });
  advance(wf, b);
  advance(wf, b);
  wf.startWork(b);
  const n = events.length;
  const waiting = wf.completeStage(b); // developer → qa, but QA is busy
  assert.deepEqual([waiting.stage, waiting.status, waiting.assignee], ['testing', 'queued', null]);
  assert.deepEqual(events.slice(n).map((e) => e.type), ['stage_changed', 'agent_idle', 'handoff_started'], 'sent, not yet picked up');

  const { id: c } = wf.createTask({ title: 'Third task' });
  advance(wf, c);
  advance(wf, c);
  advance(wf, c); // also queued for QA, behind task-2

  const m = events.length;
  wf.qaPass(a); // QA frees up and takes the oldest waiting task
  const after = events.slice(m).map((e) => `${e.type}:${e.taskId}`);
  assert.deepEqual(after.slice(-2), [`agent_assigned:${b}`, `handoff_completed:${b}`]);
  assert.equal(wf.getTask(b).assignee, 'qa');
  assert.equal(wf.getTask(c).status, 'queued');
});

test('a new task waits while Operations is busy, then gets picked up', () => {
  const { wf } = setup();
  const { id: a } = wf.createTask(TASK);
  const b = wf.createTask({ title: 'Queued' });
  assert.deepEqual([b.status, b.assignee], ['queued', null]);
  advance(wf, a);
  assert.deepEqual([wf.getTask(b.id).status, wf.getTask(b.id).assignee], ['in_progress', 'operations']);
});

test('events: plain JSON, consecutive seq, clock timestamps, known types', () => {
  const { wf, events } = setup();
  const id = toTesting(wf);
  wf.qaFail(id, { reason: 'bug' });
  events.forEach((e, i) => {
    assert.equal(e.seq, i + 1);
    assert.deepEqual(Object.keys(e), ['seq', 'type', 'at', 'taskId', 'payload']);
    assert.ok(EVENT_TYPES.includes(e.type), e.type);
    assert.deepEqual(JSON.parse(JSON.stringify(e)), e);
  });
  for (let i = 1; i < events.length; i++) assert.ok(events[i].at >= events[i - 1].at);
  assert.equal(wf.snapshot().seq, events.length);
  assert.deepEqual(JSON.parse(JSON.stringify(wf.snapshot())), wf.snapshot());
});

test('snapshots are copies: callers cannot mutate engine state', () => {
  const { wf } = setup();
  const t = wf.createTask(TASK);
  t.stage = 'completed';
  t.history.push({});
  wf.getAgent('operations').status = 'working';
  assert.equal(wf.getTask(t.id).stage, 'planning');
  assert.equal(wf.getTask(t.id).history.length, 0);
  assert.equal(wf.getAgent('operations').status, 'assigned');
  rejects(() => wf.getTask('nope'), 'unknown_task');
  rejects(() => wf.getAgent('designer'), 'unknown_agent');
});

test('listeners: a failing listener cannot break the engine; re-entrant commands keep seq order', () => {
  const { wf, events } = setup();
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a);
  try {
    wf.on(() => { throw new Error('bad listener'); });
    // An auto-driver: whenever an agent is assigned, it starts working immediately (re-entrant command).
    wf.on((e) => { if (e.type === 'agent_assigned') wf.startWork(e.taskId, { action: 'auto' }); });
    const { id } = wf.createTask(TASK);
    wf.completeStage(id);
    assert.equal(wf.getAgent('research').status, 'working');
  } finally {
    console.error = original;
  }
  assert.ok(errors.length > 0);
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), 'delivered in seq order');
  assert.deepEqual(events.map((e) => e.type), [
    'task_created', 'agent_assigned', 'agent_started',
    'stage_changed', 'agent_idle', 'handoff_started', 'agent_assigned', 'handoff_completed', 'agent_started',
  ]);
});

test('unsubscribe stops delivery', () => {
  const { wf } = setup();
  const seen = [];
  const off = wf.on((e) => seen.push(e.type));
  wf.createTask(TASK);
  off();
  wf.createTask(TASK);
  assert.deepEqual(seen, ['task_created', 'agent_assigned']);
});
