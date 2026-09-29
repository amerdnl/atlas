import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflow } from '../engine.js';
import { DEMO_TASK, demoSteps, runDemo } from '../demo.js';

const run = (qaFailures) => {
  let t = 0;
  const wf = createWorkflow({ now: () => ++t });
  const types = [];
  wf.on((e) => types.push(e.type));
  const id = runDemo(wf, { qaFailures });
  return { wf, task: wf.getTask(id), types };
};

test('demo: "Add authentication" fails QA once, is reworked, passes and is delivered', () => {
  const { wf, task, types } = run(1);
  assert.equal(task.title, DEMO_TASK.title);
  assert.deepEqual(task.acceptanceCriteria, DEMO_TASK.acceptanceCriteria);
  assert.equal(task.stage, 'completed');
  assert.deepEqual(task.qaResults.map((r) => r.passed), [false, true]);
  assert.deepEqual(wf.handoffs(task.id).map((h) => `${h.fromRole}→${h.toRole}`), [
    'operations→research', 'research→developer', 'developer→qa', 'qa→developer', 'developer→qa', 'qa→operations',
  ]);
  assert.ok(types.includes('agent_waiting'), 'the demo exercises a waiting agent');
  assert.ok(types.includes('agent_blocked'), 'the demo exercises a blocked agent');
  assert.equal(types.at(-1), 'task_completed');
  assert.ok(wf.listAgents().every((a) => a.status === 'idle'));
});

test('demo: deterministic, and the happy path works with no QA failures', () => {
  assert.deepEqual(run(1).types, run(1).types);
  const { task, wf } = run(0);
  assert.equal(task.stage, 'completed');
  assert.equal(wf.handoffs(task.id).length, 4);
  assert.equal(run(2).task.qaResults.length, 3);
});

test('demo steps name the acting role and the kind of command they issue', () => {
  const roles = new Set(demoSteps().map((s) => s.role));
  assert.deepEqual([...roles].sort(), ['developer', 'operations', 'qa', 'research']);
  const KINDS = ['create', 'start', 'wait', 'block', 'handoff', 'qaFail', 'qaPass', 'close'];
  for (const s of demoSteps()) {
    assert.equal(typeof s.label, 'string');
    assert.ok(KINDS.includes(s.kind), s.kind);
  }
  assert.deepEqual(demoSteps({ qaFailures: 0 }).map((s) => s.kind).filter((k) => k !== 'start'), ['create', 'handoff', 'wait', 'handoff', 'handoff', 'qaPass', 'close']);
});
