import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflow } from '../../workflow/engine.js';
import { ROLE_IDS } from '../../workflow/roles.js';
import { createWorkflowVisuals, createSample, STATUS_VISUALS, TIMING, BREATHE_S, statusWord } from '../src/workflow-visuals.js';
import { connectWorkflow, OFFLINE_GRACE_MS } from '../src/workflow-client.js';
import { createDemoDriver } from '../src/workflow-demo.js';
import { hudValues, formatHud } from '../src/format.js';
import { readParams } from '../src/params.js';

const T0 = 1_000_000;
const SETTLE = Math.max(TIMING.riseMs, TIMING.fallMs) + 1;
const LABEL_GONE = TIMING.labelHoldMs + TIMING.labelOutMs + 1;

/** A real Phase 3 engine on a hand-driven clock, recording its events, feeding a visual adapter. */
function rig() {
  let clock = T0;
  const wf = createWorkflow({ now: () => clock });
  const v = createWorkflowVisuals();
  const events = [];
  wf.on((e) => events.push(e));
  wf.on(v.apply);
  return { wf, v, events, set: (t) => { clock = t; }, role: (id, t) => v.sample(t).roles[id] };
}

/** Everything role-specific is off: no light, no label, no line, nothing to animate. */
function assertAllOff(s, why) {
  for (const id of ROLE_IDS) {
    const r = s.roles[id];
    assert.deepEqual([r.level, r.flow, r.wait, r.warn, r.label], [0, 0, 0, 0, 0], `${id} off (${why})`);
  }
  assert.equal(s.pathCount, 0, `no path (${why})`);
  assert.equal(s.busy, false, `nothing moving (${why})`);
  assert.equal(s.active, false, `nothing lit (${why})`);
}

/** Drive one task to `stage`'s owner working, 5 s per step. Returns the time of the last step. */
function driveTo(r, id, handoffs) {
  let t = T0;
  r.wf.startWork(id);
  for (let i = 0; i < handoffs; i++) {
    t += 5000; r.set(t); r.wf.completeStage(id);
    t += 5000; r.set(t); r.wf.startWork(id);
  }
  return t;
}

/** A minimal EventSource stand-in for the live client. */
class FakeEventSource {
  constructor(url) { this.url = url; this.listeners = {}; FakeEventSource.last = this; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  close() { this.closed = true; }
  sync(data) { this.listeners.sync({ data: JSON.stringify(data) }); }
  message(event) { this.onmessage({ data: JSON.stringify(event) }); }
  fail() { this.onerror(); }
}
const live = (v, now = () => T0) => {
  connectWorkflow(v, { EventSourceImpl: FakeEventSource, now });
  return FakeEventSource.last;
};

test('no task: every role is fully off — no light, no label, no status line', () => {
  const v = createWorkflowVisuals();
  assertAllOff(v.sample(T0), 'fresh');
  const es = live(v);
  es.sync({ snapshot: createWorkflow({ now: () => T0 }).snapshot(), events: [] });
  assertAllOff(v.sample(T0 + 10), 'synced with an empty runtime');
  for (const id of ROLE_IDS) assert.equal(v.sample(T0).roles[id].text, null);
});

test('unmanaged Claude activity counts in the HUD but never lights a role', () => {
  // The collector sees Claude busy elsewhere (VS Code, a terminal, this session)…
  const stats = { working: 3, subagents: 4, projects: 2, tokensToday: 1_204_331 };
  assert.deepEqual(formatHud(hudValues(stats)), { projects: '2', agents: '7', tokens: '1,204,331' });
  // …while the ATLAS runtime has no task: the only input to the landmarks says nothing is active.
  const v = createWorkflowVisuals();
  live(v).sync({ snapshot: createWorkflow({ now: () => T0 }).snapshot(), events: [] });
  assertAllOff(v.sample(T0 + 60_000), 'AGENTS > 0 with no ATLAS task');
});

test('each managed role lights only itself', () => {
  ROLE_IDS.forEach((role, i) => {
    const r = rig();
    const { id } = r.wf.createTask({ title: 'x' });
    const order = ['operations', 'research', 'developer', 'qa'];
    const t = driveTo(r, id, order.indexOf(role));
    const s = r.v.sample(t + TIMING.travelMs + SETTLE);
    assert.equal(s.roles[role].status, 'working', `${role} working (step ${i})`);
    assert.ok(s.roles[role].level > 0.8, `${role} lit`);
    for (const other of ROLE_IDS) if (other !== role) assert.equal(s.roles[other].level, 0, `${other} stays off while ${role} works`);
  });
});

test('working breathes faster (3 s) than waiting; restrained; every period divides the hour', () => {
  assert.ok(BREATHE_S.working >= 2.5 && BREATHE_S.working <= 4, 'working cycle 2.5–4 s');
  assert.ok(BREATHE_S.waiting > BREATHE_S.working, 'waiting stays slower');
  assert.ok(BREATHE_S.blocked >= 3, 'no strobe');
  for (const p of Object.values(BREATHE_S)) assert.equal(3600 % p, 0, `${p} s divides 3600`);
});

test('label: hidden by default, appears on activation, auto-hides, reappears on handoff arrival', () => {
  const r = rig();
  assert.equal(r.role('operations', T0 - 1).label, 0, 'hidden by default');
  const { id } = r.wf.createTask({ title: 'x' });
  assert.ok(r.role('operations', T0 + TIMING.labelInMs / 2).label > 0, 'fading in');
  assert.equal(r.role('operations', T0 + TIMING.labelInMs + 1).label, 1, 'shown on activation');
  assert.equal(r.role('operations', T0 + LABEL_GONE).label, 0, 'auto-hides after a few seconds');
  const t1 = T0 + 5000; r.set(t1); r.wf.startWork(id);
  assert.equal(r.role('operations', t1 + 1000).label, 0, 'starting work on an already-active role does not re-show it');
  const tH = T0 + 10_000; r.set(tH); r.wf.completeStage(id);
  assert.equal(r.role('research', tH + TIMING.travelMs / 2).label, 0, 'destination label waits for the point');
  const arrive = tH + TIMING.travelMs;
  assert.equal(r.role('research', arrive + TIMING.labelInMs + 1).label, 1, 'destination label on arrival');
  assert.equal(r.role('research', arrive + TIMING.labelInMs + 1).text, 'researching');
  assert.equal(r.role('research', arrive + LABEL_GONE).label, 0, 'and it auto-hides');
  assert.equal(r.role('operations', arrive + 10).label, 0, 'the source label does not come back');
  // A held or hidden label never needs the full frame rate.
  assert.equal(r.v.sample(T0 + SETTLE).busy, false, 'assigned + label hold: low rate');
  assert.equal(r.role('operations', T0 + SETTLE).label, 1);
});

test('label: pinned while blocked, reappears briefly on waiting, fades when resolved', () => {
  const r = rig();
  const { id } = r.wf.createTask({ title: 'x' });
  r.wf.startWork(id);
  const tB = T0 + 10_000; r.set(tB); r.wf.block(id, { reason: 'no repo' });
  const blocked = r.role('operations', tB + 60_000);
  assert.deepEqual([blocked.label, blocked.text], [1, 'blocked'], 'blocked keeps its label');
  assert.equal(r.v.sample(tB + 60_000).busy, false, 'a pinned label does not keep the frame rate up');
  const tR = tB + 70_000; r.set(tR); r.wf.startWork(id);
  assert.equal(r.role('operations', tR + TIMING.labelHoldMs / 2).label, 1, 'resumed: held briefly');
  assert.equal(r.role('operations', tR + LABEL_GONE).label, 0, 'then hides');
  const tW = tR + 20_000; r.set(tW); r.wf.wait(id, { reason: 'q' });
  assert.equal(r.role('operations', tW + TIMING.labelInMs + 1).label, 1, 'waiting shows it briefly');
  assert.equal(r.role('operations', tW + LABEL_GONE).label, 0);
});

test('status line: short stage words only, never tool or model text; progress changes nothing', () => {
  assert.deepEqual(['planning', 'research', 'development', 'rework', 'testing', 'finalizing'].map((s) => statusWord('working', s)),
    ['planning', 'researching', 'implementing', 'implementing', 'testing', 'finalizing']);
  assert.equal(statusWord('blocked', 'testing'), 'blocked');
  assert.equal(statusWord('interrupted', 'testing'), 'interrupted');
  assert.equal(statusWord('idle', 'testing'), null);
  const r = rig();
  const { id } = r.wf.createTask({ title: 'x' });
  r.wf.startWork(id, { action: 'Bash: git status --short && npm test -- --watch=false' });
  const before = r.v.timeline().changes.length;
  for (let i = 0; i < 50; i++) r.wf.reportProgress(id, { action: `Read src/file${i}.js` });
  assert.equal(r.v.timeline().changes.length, before, 'progress events add no visual churn');
  assert.equal(r.role('operations', T0 + 100).text, 'planning');
});

test('completed, failed and cancelled each clear every role visual and path', () => {
  for (const end of ['complete', 'fail', 'cancel']) {
    const r = rig();
    const { id } = r.wf.createTask({ title: 'x' });
    let t = driveTo(r, id, 2); // developer working
    if (end === 'complete') {
      for (const step of ['completeStage', 'startWork', 'qaPass', 'startWork', 'completeStage']) { t += 5000; r.set(t); r.wf[step](id); }
    } else {
      t += 5000; r.set(t); r.wf.failTask(id, { reason: end === 'cancel' ? 'cancelled' : 'broken' });
    }
    assertAllOff(r.v.sample(t + TIMING.travelMs + LABEL_GONE + TIMING.pathFadeOutMs), end);
    const fading = r.v.sample(t + TIMING.fallMs / 2);
    assert.ok(fading.active, `${end}: turns off gradually, not abruptly`);
  }
});

test('a task failing while its handoff waits for a busy receiver leaves no stale line', () => {
  const r = rig();
  let t = T0;
  const at = (fn) => { t += 5000; r.set(t); fn(); };
  const a = r.wf.createTask({ title: 'a' }).id;
  for (let i = 0; i < 3; i++) { at(() => r.wf.startWork(a)); at(() => r.wf.completeStage(a)); }
  at(() => r.wf.startWork(a)); // QA busy with a
  const b = r.wf.createTask({ title: 'b' }).id;
  for (let i = 0; i < 3; i++) { at(() => r.wf.startWork(b)); at(() => r.wf.completeStage(b)); } // b queued for QA
  at(() => r.wf.failTask(b, { reason: 'cancelled' }));
  at(() => r.wf.failTask(a, { reason: 'cancelled' }));
  assertAllOff(r.v.sample(t + LABEL_GONE + TIMING.pathFadeOutMs), 'both tasks gone');
});

test('reconnect mid-task: rebuilt from scratch, only the in-flight handoff animates, no old path replays', () => {
  const r = rig();
  const { id } = r.wf.createTask({ title: 'x' });
  const t = driveTo(r, id, 1); // research working; the operations→research path finished long ago
  const tH = t + 5000; r.set(tH); r.wf.completeStage(id); // research → developer, in flight
  for (const at of [tH + 100, tH + TIMING.travelMs / 2, tH + TIMING.travelMs + LABEL_GONE]) {
    const late = createWorkflowVisuals();
    late.apply(r.events[0]); // stale state from before the disconnect…
    live(late).sync({ snapshot: r.wf.snapshot(), events: r.events }); // …is discarded by the sync
    assert.deepEqual(late.sample(at), r.v.sample(at), `a late display matches an open one at +${at - tH}ms`);
    const paths = late.sample(at);
    for (let i = 0; i < paths.pathCount; i++) assert.equal(paths.paths[i].from, 'research', 'only the current handoff');
  }
});

test('reconnect after completion: nothing relights, nothing replays', () => {
  const r = rig();
  const { id } = r.wf.createTask({ title: 'x' });
  let t = driveTo(r, id, 3);
  for (const step of ['qaPass', 'startWork', 'completeStage']) { t += 5000; r.set(t); r.wf[step](id); }
  const later = t + 60_000;
  const v = createWorkflowVisuals();
  live(v).sync({ snapshot: r.wf.snapshot(), events: r.events });
  assertAllOff(v.sample(later), 'reloaded after completion');
});

test('a trimmed event log still converges on the snapshot', () => {
  const r = rig();
  const { id } = r.wf.createTask({ title: 'x' });
  const t = driveTo(r, id, 2); // developer working
  const v = createWorkflowVisuals();
  live(v).sync({ snapshot: r.wf.snapshot(), events: r.events.slice(-2) }); // older history dropped
  const s = v.sample(t + LABEL_GONE);
  assert.equal(s.roles.developer.status, 'working');
  for (const other of ['operations', 'research', 'qa']) assert.equal(s.roles[other].level, 0);
  // And a snapshot saying everyone is idle wins over a log that ends mid-task.
  const idle = createWorkflow({ now: () => T0 }).snapshot();
  const v2 = createWorkflowVisuals();
  live(v2).sync({ snapshot: idle, events: r.events });
  assertAllOff(v2.sample(t + LABEL_GONE + SETTLE), 'snapshot is authoritative');
});

test('runtime lost (collector stopped or restarted): after a short grace everything fades out; the next sync restores', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const r = rig();
    const { id } = r.wf.createTask({ title: 'x' });
    const t = driveTo(r, id, 1);
    let now = t + 20_000;
    const v = createWorkflowVisuals();
    const es = live(v, () => now);
    es.sync({ snapshot: r.wf.snapshot(), events: r.events });
    assert.equal(v.sample(now).roles.research.status, 'working');
    es.fail();
    mock.timers.tick(OFFLINE_GRACE_MS - 1);
    assert.equal(v.sample(now).roles.research.status, 'working', 'a brief blip changes nothing');
    mock.timers.tick(1);
    assertAllOff(v.sample(now + LABEL_GONE), 'offline');
    // A restarted runtime (fresh, empty) is exactly what is shown.
    es.sync({ snapshot: createWorkflow({ now: () => now }).snapshot(), events: [] });
    assertAllOff(v.sample(now + 10), 'restarted runtime');
    // Or the same one again: its current task comes back.
    es.sync({ snapshot: r.wf.snapshot(), events: r.events });
    assert.equal(v.sample(now).roles.research.status, 'working');
  } finally { mock.timers.reset(); }
});

test('demo and live never mix: one source per page, demo state stays in its own adapter', () => {
  assert.equal(readParams('', { w: 1, h: 1 }).workflowDemo, false, 'a normal load is live');
  assert.equal(readParams('?demo=0', { w: 1, h: 1 }).workflowDemo, false, 'the app\'s live URL');
  assert.equal(readParams('?demo=1', { w: 1, h: 1 }).workflowDemo, true);
  const demoV = createWorkflowVisuals(), liveV = createWorkflowVisuals();
  const d = createDemoDriver(demoV);
  const loop = d.periodMs * 40_000;
  for (let t = loop; t < loop + 30_000; t += 100) d.update(t);
  assert.ok(demoV.sample(loop + 30_000).active, 'demo running');
  live(liveV).sync({ snapshot: createWorkflow({ now: () => loop }).snapshot(), events: [] });
  assertAllOff(liveV.sample(loop + 30_000), 'the live page shows none of the demo');
});

test('demo completion settles fully to idle before the story repeats', () => {
  const v = createWorkflowVisuals();
  const d = createDemoDriver(v);
  const loop = d.periodMs * 50_000;
  for (let t = loop; t < loop + d.periodMs - 1; t += 100) d.update(t);
  assertAllOff(v.sample(loop + d.periodMs - 1), 'end of the demo loop');
});

test('idle low-update mode: resting states never ask for the full frame rate', () => {
  const r = rig();
  const s = createSample();
  r.v.sample(T0, s);
  assert.deepEqual([s.busy, s.active], [false, false], 'idle');
  const { id } = r.wf.createTask({ title: 'x' });
  assert.equal(r.v.sample(T0 + 10, s).busy, true, 'turning on');
  assert.equal(r.v.sample(T0 + LABEL_GONE, s).busy, false, 'assigned, label gone: low rate');
  assert.equal(s.active, true);
  const t1 = T0 + 10_000; r.set(t1); r.wf.startWork(id);
  assert.equal(r.v.sample(t1 + LABEL_GONE, s).busy, true, 'working flow moves');
  const t2 = t1 + 10_000; r.set(t2); r.wf.wait(id, { reason: 'q' });
  assert.equal(r.v.sample(t2 + LABEL_GONE, s).busy, false, 'slow waiting pulse: low rate');
  const t3 = t2 + 10_000; r.set(t3); r.wf.failTask(id, { reason: 'cancelled' });
  r.v.sample(t3 + LABEL_GONE, s);
  assert.deepEqual([s.busy, s.active], [false, false], 'back to idle');
  assert.equal(STATUS_VISUALS.idle.level, 0);
});
