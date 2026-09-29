import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflow } from '../../workflow/engine.js';
import { ROLES, ROLE_IDS } from '../../workflow/roles.js';
import { createWorkflowVisuals, createSample, STATUS_VISUALS, TIMING } from '../src/workflow-visuals.js';
import { createDemoDriver, demoSchedule } from '../src/workflow-demo.js';
import { ATLAS_AREAS } from '../src/atlas-areas.js';
import { LAYOUTS } from '../src/layouts.js';

const SETTLE = Math.max(TIMING.riseMs, TIMING.fallMs) + 1;
const T0 = 1_000_000;

/** A real Phase 3 engine on a hand-driven clock, feeding the visual adapter. */
function rig(opts) {
  let clock = T0;
  const wf = createWorkflow({ now: () => clock, ...opts });
  const v = createWorkflowVisuals();
  wf.on(v.apply);
  return { wf, v, set: (t) => { clock = t; }, role: (id, t) => v.sample(t).roles[id], paths: (t) => { const s = v.sample(t); return s.paths.slice(0, s.pathCount); } };
}
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const colorOf = (role) => parseInt(ROLES[role].color.slice(1), 16);

test('every role maps to one landmark in every layout, using the canonical role color', () => {
  for (const name of Object.keys(LAYOUTS)) assert.deepEqual(LAYOUTS[name].areas.map((a) => a.key), ROLE_IDS);
  for (const id of ROLE_IDS) assert.equal(ATLAS_AREAS[id].color, colorOf(id));
  assert.deepEqual(Object.keys(createSample().roles), ROLE_IDS);
});

test('status targets: idle fully off, rising through assigned to working; waiting softer; blocked warns', () => {
  const S = STATUS_VISUALS;
  assert.deepEqual(Object.keys(S), ['idle', 'assigned', 'working', 'waiting', 'blocked'], 'exactly the Phase 3 agent statuses');
  assert.deepEqual({ ...S.idle }, { level: 0, flow: 0, wait: 0, warn: 0 }, 'idle: role light fully off');
  assert.ok(S.idle.level < S.assigned.level && S.assigned.level < S.working.level);
  assert.ok(S.waiting.level > S.assigned.level && S.waiting.level < S.working.level);
  assert.ok(S.blocked.level > S.idle.level && S.blocked.level < S.working.level);
  for (const [status, v] of Object.entries(S)) {
    assert.equal(v.flow, status === 'working' ? 1 : 0, `${status} flow`);
    assert.equal(v.wait, status === 'waiting' ? 1 : 0, `${status} wait pulse`);
    assert.equal(v.warn, status === 'blocked' ? 1 : 0, `${status} warning`);
  }
  assert.ok(TIMING.riseMs >= 500 && TIMING.riseMs <= 800, 'turn-on 500–800 ms');
  assert.ok(TIMING.fallMs >= 700 && TIMING.fallMs <= 1100, 'turn-off 700–1100 ms');
});

test('idle → assigned → working eases smoothly, with no jumps', () => {
  const r = rig();
  assert.equal(r.role('operations', T0 - 1).level, STATUS_VISUALS.idle.level);
  const { id } = r.wf.createTask({ title: 'x' });
  assert.equal(r.role('operations', T0 + SETTLE).status, 'assigned');
  assert.ok(close(r.role('operations', T0 + SETTLE).level, STATUS_VISUALS.assigned.level));
  const t1 = T0 + 5000;
  r.set(t1);
  r.wf.startWork(id, { action: 'scoping' });
  const mid = r.role('operations', t1 + TIMING.riseMs / 2).level;
  assert.ok(mid > STATUS_VISUALS.assigned.level && mid < STATUS_VISUALS.working.level, `mid-transition ${mid}`);
  const done = r.role('operations', t1 + SETTLE);
  assert.ok(close(done.level, STATUS_VISUALS.working.level) && done.flow === 1);
  assert.equal(done.text, 'planning', 'a short stage word, not the tool action');
  let prev = r.role('operations', t1 - 16).level;
  for (let t = t1; t <= t1 + SETTLE; t += 16) {
    const v = r.role('operations', t).level;
    assert.ok(v >= prev - 1e-9 && v - prev < 0.05, `step ${v - prev} at +${t - t1}ms`);
    prev = v;
  }
});

test('working → idle eases down to fully off', () => {
  const r = rig();
  const { id } = r.wf.createTask({ title: 'x' });
  r.wf.startWork(id);
  const t1 = T0 + 5000;
  r.set(t1);
  r.wf.failTask(id, { reason: 'cancelled' });
  const mid = r.role('operations', t1 + TIMING.fallMs / 2);
  assert.ok(mid.level < STATUS_VISUALS.working.level && mid.level > STATUS_VISUALS.idle.level);
  const end = r.role('operations', t1 + SETTLE);
  assert.ok(end.level === 0 && end.flow === 0 && end.label === 0);
  assert.equal(r.v.sample(t1 + SETTLE).busy, false);
});

test('waiting and blocked map to their own restrained targets', () => {
  const r = rig();
  const { id } = r.wf.createTask({ title: 'x' });
  r.wf.startWork(id);
  r.set(T0 + 3000);
  r.wf.wait(id, { reason: 'awaiting answer' });
  const waiting = r.role('operations', T0 + 3000 + SETTLE);
  assert.deepEqual([waiting.status, waiting.wait, waiting.flow, waiting.text], ['waiting', 1, 0, 'waiting']);
  r.set(T0 + 6000);
  r.wf.block(id, { reason: 'repo unavailable' });
  const blocked = r.role('operations', T0 + 6000 + SETTLE);
  assert.deepEqual([blocked.status, blocked.warn, blocked.text], ['blocked', 1, 'blocked']);
  assert.ok(close(blocked.level, STATUS_VISUALS.blocked.level), 'role light kept at a moderate level, not a red building');
});

test('a handoff: path in the source color, source lit until the point arrives, then the destination powers up', () => {
  const r = rig();
  const { id } = r.wf.createTask({ title: 'x' });
  r.wf.startWork(id);
  const tH = T0 + 4000;
  r.set(tH);
  r.wf.completeStage(id, { reason: 'scoped' });

  const travelling = r.paths(tH + TIMING.travelMs / 2);
  assert.equal(travelling.length, 1);
  assert.deepEqual([travelling[0].from, travelling[0].to, travelling[0].color], ['operations', 'research', ATLAS_AREAS.operations.color]);
  assert.ok(travelling[0].progress > 0 && travelling[0].progress < 1 && travelling[0].opacity > 0.9);
  assert.equal(r.role('operations', tH + TIMING.travelMs / 2).status, 'working', 'source stays active while the point travels');
  assert.equal(r.role('research', tH + TIMING.travelMs / 2).status, 'idle', 'destination waits for the point');

  const arrived = tH + TIMING.travelMs;
  assert.equal(r.paths(arrived)[0].progress, 1);
  assert.ok(close(r.role('research', arrived + SETTLE).level, STATUS_VISUALS.assigned.level), 'destination powers up on arrival');
  assert.ok(close(r.role('operations', arrived + SETTLE).level, STATUS_VISUALS.idle.level), 'source powers down on arrival');
  assert.equal(r.paths(arrived + TIMING.pathFadeOutMs + 1).length, 0, 'the line fades out');
  const fading = r.paths(arrived + TIMING.pathFadeOutMs / 2)[0].opacity;
  assert.ok(fading > 0 && fading < 1, 'fade-out is gradual');
  assert.ok(r.paths(tH + TIMING.pathFadeInMs / 3)[0].opacity < 0.5, 'fade-in is gradual');

  // The receiver starting before the point arrives takes effect at arrival, not earlier.
  r.set(tH + 500);
  r.wf.startWork(id);
  assert.equal(r.role('research', tH + 1000).status, 'idle');
  assert.equal(r.role('research', arrived + 1).status, 'working');
});

test('QA fail → purple QA→Developer; rework → green Developer→QA; QA pass → purple QA→Operations; finalizing lights Operations', () => {
  const r = rig();
  let t = T0;
  const step = (fn) => { t += 5000; r.set(t); fn(); };
  const { id } = r.wf.createTask({ title: 'x' });
  for (let i = 0; i < 3; i++) { step(() => r.wf.startWork(id)); step(() => r.wf.completeStage(id)); }
  step(() => r.wf.startWork(id));

  step(() => r.wf.qaFail(id, { reason: 'bug' }));
  let [p] = r.paths(t + 100);
  assert.deepEqual([p.from, p.to, p.color], ['qa', 'developer', ATLAS_AREAS.qa.color]);
  assert.equal(r.role('developer', t + TIMING.travelMs + SETTLE).status, 'assigned', 'developer active again');

  step(() => r.wf.startWork(id));
  step(() => r.wf.completeStage(id));
  [p] = r.paths(t + 100);
  assert.deepEqual([p.from, p.to, p.color], ['developer', 'qa', ATLAS_AREAS.developer.color]);

  step(() => r.wf.startWork(id));
  step(() => r.wf.qaPass(id));
  [p] = r.paths(t + 100);
  assert.deepEqual([p.from, p.to, p.color], ['qa', 'operations', ATLAS_AREAS.qa.color]);
  step(() => r.wf.startWork(id, { action: 'finalizing delivery' }));
  const ops = r.role('operations', t + SETTLE);
  assert.deepEqual([ops.status, ops.flow, ops.text], ['working', 1, 'finalizing'], 'Operations visibly finalizing');

  step(() => r.wf.completeStage(id));
  const end = r.v.sample(t + SETTLE);
  assert.equal(end.pathCount, 0, 'completion leaves no active path');
  for (const id2 of ROLE_IDS) assert.ok(close(end.roles[id2].level, STATUS_VISUALS.idle.level), `${id2} settles to idle`);
  assert.equal(end.busy, false);
});

test('a busy receiver: the point waits at the destination until the real handoff_completed', () => {
  const r = rig();
  let t = T0;
  const at = (fn) => { t += 5000; r.set(t); fn(); };
  const a = r.wf.createTask({ title: 'a' }).id;
  for (let i = 0; i < 3; i++) { at(() => r.wf.startWork(a)); at(() => r.wf.completeStage(a)); }
  at(() => r.wf.startWork(a)); // QA busy with a
  const b = r.wf.createTask({ title: 'b' }).id;
  for (let i = 0; i < 3; i++) { at(() => r.wf.startWork(b)); at(() => r.wf.completeStage(b)); }
  const sent = t;
  const waiting = r.paths(sent + TIMING.travelMs + 3000).find((p) => p.to === 'qa');
  assert.ok(waiting && waiting.progress === 1 && waiting.opacity === 1, 'point parked at QA');
  at(() => r.wf.qaPass(a)); // QA frees up and picks up b
  const parked = r.paths(t - 1).find((p) => p.from === 'developer' && p.to === 'qa');
  assert.ok(parked && parked.opacity === 1);
  assert.equal(r.paths(t + TIMING.pathFadeOutMs + 1).filter((p) => p.from === 'developer').length, 0, 'fades once picked up');
});

test('events are applied in seq order; repeats are ignored; sampling never mutates', () => {
  const r = rig();
  const events = [];
  r.wf.on((e) => events.push(e));
  const { id } = r.wf.createTask({ title: 'x' });
  r.wf.startWork(id);
  const before = JSON.stringify(r.v.timeline());
  for (const e of events) r.v.apply(e); // redelivered
  assert.equal(JSON.stringify(r.v.timeline()), before);
  const early = r.role('operations', T0 + 300).level;
  r.v.sample(T0 + 60_000);
  assert.equal(r.role('operations', T0 + 300).level, early);
});

test('the sample is reused, not reallocated', () => {
  const r = rig();
  const out = createSample();
  const rolesRef = out.roles.operations, pathsRef = out.paths;
  r.wf.createTask({ title: 'x' });
  assert.equal(r.v.sample(T0 + 10, out), out);
  assert.equal(out.roles.operations, rolesRef);
  assert.equal(out.paths, pathsRef);
});

// ---- demo driver ----

function playDemo(stepMs = 100) {
  const v = createWorkflowVisuals();
  const d = createDemoDriver(v);
  const start = d.periodMs * 20_000; // some loop boundary on the wall clock
  const handoffs = [];
  const seen = new Set();
  for (let t = start; t < start + d.periodMs - 1; t += stepMs) {
    d.update(t);
    for (const p of v.timeline().paths) if (!seen.has(p.id)) { seen.add(p.id); handoffs.push(p); }
  }
  return { v, d, start, handoffs };
}

test('demo: the Phase 3 engine drives the full visible sequence', () => {
  const { v, start, d, handoffs } = playDemo();
  assert.deepEqual(handoffs.map((p) => `${p.from}→${p.to}`), [
    'operations→research', 'research→developer', 'developer→qa', 'qa→developer', 'developer→qa', 'qa→operations',
  ]);
  assert.deepEqual(handoffs.map((p) => p.color), ['operations', 'research', 'developer', 'qa', 'developer', 'qa'].map((r) => ATLAS_AREAS[r].color));
  const statuses = v.timeline().changes;
  for (const role of ROLE_IDS) assert.ok(statuses.some((c) => c.role === role && c.status === 'working'), `${role} works`);
  assert.ok(statuses.some((c) => c.role === 'research' && c.status === 'waiting'));
  assert.ok(statuses.some((c) => c.role === 'developer' && c.status === 'blocked'));
  assert.ok(statuses.some((c) => c.role === 'operations' && c.text === 'finalizing'), 'finalizing is visible');
  const end = v.sample(start + d.periodMs - 1);
  assert.equal(end.pathCount, 0);
  assert.equal(end.busy, false, 'the city settles to idle before the story repeats');
  for (const id of ROLE_IDS) assert.ok(close(end.roles[id].level, STATUS_VISUALS.idle.level));
});

test('demo: loop pacing leaves time for each point to arrive before the receiver starts', () => {
  const { steps, times, periodMs } = demoSchedule();
  assert.ok(periodMs > 60_000 && periodMs < 120_000, `period ${periodMs}`);
  steps.forEach((s, i) => {
    if (s.kind === 'start' && ['handoff', 'qaFail', 'qaPass'].includes(steps[i - 1]?.kind)) {
      assert.ok(times[i] - times[i - 1] > TIMING.travelMs + TIMING.riseMs, `step ${i} starts after the point arrives`);
    }
  });
});

test('demo: every display computes the identical frame, however late it loaded (multi-monitor sync)', () => {
  const vA = createWorkflowVisuals(), dA = createDemoDriver(vA);
  const loop = dA.periodMs * 31_337;
  for (let t = loop; t < loop + 40_000; t += 16) dA.update(t); // display A: running since the loop began
  for (const at of [loop + 40_000, loop + 40_000 + TIMING.travelMs / 3, loop + 52_345]) {
    dA.update(at);
    const vB = createWorkflowVisuals(), dB = createDemoDriver(vB); // display B: loaded just now
    dB.update(at);
    assert.deepEqual(vB.sample(at), vA.sample(at), `frames differ at +${at - loop}ms`);
  }
});
