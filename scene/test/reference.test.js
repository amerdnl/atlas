import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflow } from '../../workflow/engine.js';
import { ROLE_IDS } from '../../workflow/roles.js';
import { createWorkflowVisuals, TIMING } from '../src/workflow-visuals.js';
import { REF, DISTRICTS, ROLE_ORDER, maskValue, isRoleLight, coverView, toCanvas, districtLight, labelPosition, referenceLayout } from '../src/reference-map.js';
import { ATLAS_AREAS } from '../src/atlas-areas.js';
import { LABEL } from '../src/layouts.js';
import { readParams } from '../src/params.js';

// Pixels of each district's own role-colored light in the reference art (sampled from the asset:
// its strongest orange, blue, green and purple light). Masks must cover them — and only them.
const ROLE_LIGHT = {
  operations: [[258, 588], [196, 616], [190, 618], [288, 620], [296, 622], [272, 626], [172, 628], [332, 638], [288, 642], [274, 646], [280, 650]],
  research: [[598, 574], [530, 582], [560, 592], [572, 592], [576, 592], [560, 594], [570, 594], [562, 596], [566, 596]],
  developer: [[1210, 534], [1212, 540], [1208, 608], [1214, 608], [1222, 610], [1220, 612], [1192, 614], [1218, 614], [1190, 620]],
  qa: [[1560, 556], [1494, 612], [1506, 612], [1510, 616], [1518, 618], [1522, 622], [1570, 626], [1528, 630], [1546, 640], [1550, 646], [1518, 650]],
};

test('reference: the role order matches the workflow roles, and every district has a role color', () => {
  assert.deepEqual([...ROLE_ORDER], ROLE_IDS);
  for (const role of ROLE_ORDER) assert.ok(ATLAS_AREAS[role]);
});

test('masks line up with each district\'s light in the art — and with no other district', () => {
  for (const role of ROLE_ORDER) {
    for (const [x, y] of ROLE_LIGHT[role]) {
      assert.ok(maskValue(role, x, y) > 0.85, `${role} mask covers its light at ${x},${y} (${maskValue(role, x, y).toFixed(2)})`);
      for (const other of ROLE_ORDER) if (other !== role) assert.equal(maskValue(other, x, y), 0, `${other} mask stays off ${role}'s light at ${x},${y}`);
    }
  }
});

test('masks never overlap, cover a district (not one tower), have soft edges, and stay off the central skyline', () => {
  const area = Object.fromEntries(ROLE_ORDER.map((r) => [r, 0]));
  const bounds = Object.fromEntries(ROLE_ORDER.map((r) => [r, [Infinity, -Infinity]]));
  let soft = 0;
  for (let y = 0; y < REF.height; y += 3) {
    for (let x = 0; x < REF.width; x += 3) {
      const on = ROLE_ORDER.filter((r) => maskValue(r, x, y) > 0.02);
      assert.ok(on.length <= 1, `masks overlap at ${x},${y}: ${on}`);
      for (const r of on) {
        const m = maskValue(r, x, y);
        if (m > 0.5) { area[r]++; bounds[r][0] = Math.min(bounds[r][0], x); bounds[r][1] = Math.max(bounds[r][1], x); }
        if (m > 0.05 && m < 0.95) soft++;
      }
    }
  }
  for (const r of ROLE_ORDER) {
    assert.ok(bounds[r][1] - bounds[r][0] > 120, `${r}: a district ${bounds[r][1] - bounds[r][0]}px wide, not a single tower`);
    assert.ok(area[r] > 400, `${r}: mask area`);
  }
  assert.ok(soft > 500, 'edges fade softly');
  // The neutral central skyline (the supertall and its cluster) is never part of a role district.
  for (const [x, y] of [[945, 450], [960, 520], [905, 560], [1010, 560]]) {
    for (const r of ROLE_ORDER) assert.equal(maskValue(r, x, y), 0, `${r} mask touches the central skyline at ${x},${y}`);
  }
});

test('the navy sky, mountains and water are never taken for role light', () => {
  for (const rgb of [[10, 20, 36], [19, 37, 60], [39, 51, 78], [28, 38, 62], [13, 21, 40], [30, 25, 36]]) {
    assert.ok(!isRoleLight('research', ...rgb), `research: ${rgb}`);
    assert.ok(!isRoleLight('developer', ...rgb), `developer: ${rgb}`);
  }
  assert.ok(isRoleLight('operations', 231, 140, 70) && isRoleLight('research', 90, 160, 240));
  assert.ok(isRoleLight('developer', 110, 190, 130) && isRoleLight('qa', 160, 90, 230));
});

test('anchors: labels above each district\'s signature tower, paths at its light; left to right', () => {
  let lastX = -Infinity;
  for (const role of ROLE_ORDER) {
    const { label, path } = DISTRICTS[role];
    assert.ok(maskValue(role, ...path) > 0.85, `${role}: path anchor inside its district`);
    assert.ok(label[1] < path[1] - 40, `${role}: label sits above the district`);
    assert.ok(Math.abs(label[0] - path[0]) < 80, `${role}: label over its own district`);
    assert.ok(path[0] > lastX, `${role} is right of the previous district`);
    lastX = path[0];
  }
});

// Canvas shapes with display counts: 16:9, 16:10, ultrawide, two and three displays.
const CANVASES = [[1920, 1080, 1], [1728, 1080, 1], [2520, 1080, 1], [3840, 1080, 2], [3456, 1080, 2], [5760, 1080, 3], [5184, 1080, 3]];
// A label block's realistic width: the name, or the longest status word ("implementing").
const labelW = (role) => {
  const { fontPx, letterSpacingEm, dot, padX } = LABEL.labelPx;
  return Math.max(padX * 2 + dot + 6 + ATLAS_AREAS[role].label.length * fontPx * (0.72 + letterSpacingEm), LABEL.statusPx.padX * 2 + 12 * LABEL.statusPx.fontPx * 0.62);
};

test('crop: one shared cover view — the art fills every canvas, the skyline always in view, nothing stretched', () => {
  for (const [W, H] of CANVASES) {
    const v = coverView(W, H);
    assert.ok(v.ox <= 1e-9 && v.oy <= 1e-9 && v.ox + v.w >= W - 1e-6 && v.oy + v.h >= H - 1e-6, `${W}x${H}: covered`);
    assert.ok(Math.abs(v.w / v.h - REF.width / REF.height) < 1e-9, 'uniform scale');
    const [, spireY] = toCanvas(v, [945, 425]), [, cityY] = toCanvas(v, [945, 640]);
    assert.ok(spireY > 0.02 * H && cityY < H, `${W}x${H}: the skyline from spire to waterline stays in view`);
    if (W / H < 2) assert.ok(Math.abs(v.oy) < 2, `${W}x${H}: a single display keeps the art's full height (sky included)`);
  }
});

test('crop: every display slice maps the same reference point to the same place — seams align', () => {
  for (const [W, H, n] of CANVASES) {
    const v = coverView(W, H);
    // A display at x0 renders canvas px [x0, x0 + W/n); a reference point's canvas position does not
    // depend on which display draws it, so a line crossing a seam is continuous.
    for (const role of ROLE_ORDER) {
      const [x] = toCanvas(v, DISTRICTS[role].path);
      const shown = Array.from({ length: n }, (_, k) => x >= (k * W) / n && x < ((k + 1) * W) / n).filter(Boolean).length;
      assert.equal(shown, 1, `${role} path anchor belongs to exactly one display`);
    }
  }
});

test('labels: on screen with margins, clear of the HUD, never across a seam, never overlapping', () => {
  for (const [W, H, n] of CANVASES) {
    const v = coverView(W, H);
    const boxes = ROLE_ORDER.map((role) => {
      const w = labelW(role), [x, y] = labelPosition(v, role, w, W, W / n);
      assert.ok(Math.abs(x - toCanvas(v, DISTRICTS[role].label)[0]) < 140, `${W}x${H} ${role}: label stays over its district`);
      return { role, x0: x - w / 2, x1: x + w / 2, y0: y - LABEL.labelPx.height - LABEL.statusPx.height, y1: y };
    });
    for (const b of boxes) {
      const where = `${W}x${H} ${b.role}`;
      assert.ok(b.x0 > 12 && b.x1 < W - 12, `${where}: off the side (${b.x0 | 0}..${b.x1 | 0})`);
      assert.ok(b.y0 > 0.2 * H && b.y1 < 0.8 * H, `${where}: vertical position`);
      assert.ok(!(b.x0 < 300 && b.y1 > H - 200), `${where}: collides with the HUD`);
      for (let k = 1; k < n; k++) { const seam = (k * W) / n; assert.ok(b.x1 < seam - 24 || b.x0 > seam + 24, `${where}: crosses the seam at ${seam}`); }
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      assert.ok(!(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1), `${W}x${H}: ${a.role} and ${b.role} labels overlap`);
    }
  }
});

// ---- the live layer: overlay strength comes only from the workflow visual state ----

const T0 = 1_000_000;
const AFTER = TIMING.travelMs + Math.max(TIMING.riseMs, TIMING.fallMs) + TIMING.labelHoldMs + TIMING.labelOutMs + TIMING.pathFadeOutMs + 10;
function rig() {
  let clock = T0;
  const wf = createWorkflow({ now: () => clock });
  const v = createWorkflowVisuals();
  wf.on(v.apply);
  return { wf, v, set: (t) => { clock = t; } };
}
const light = (sample, role, clockS = 0) => districtLight(sample.roles[role], clockS, { lit: 0, glow: 0, warn: 0 });
const allOff = (sample, why) => {
  for (const role of ROLE_ORDER) for (const clockS of [0, 0.75, 1.5, 2.25]) {
    assert.deepEqual(light(sample, role, clockS), { lit: 0, glow: 0, warn: 0 }, `${role} overlay off (${why})`);
  }
};

test('idle: no district overlay at all — the art shows exactly as neutral', () => {
  allOff(createWorkflowVisuals().sample(T0), 'no task');
});

test('only the active role\'s district lights, breathing gently on the ~3 s cycle', () => {
  const r = rig();
  const { id } = r.wf.createTask({ title: 'x' });
  r.wf.startWork(id);
  const s = r.v.sample(T0 + 2000);
  const lits = [0, 0.75, 1.5, 2.25].map((c) => light(s, 'operations', c).lit);
  assert.ok(Math.min(...lits) > 0.8 && Math.max(...lits) <= 1, `restrained breathe: ${lits.map((x) => x.toFixed(2))}`);
  assert.ok(Math.max(...lits) - Math.min(...lits) > 0.05, 'and it does breathe');
  assert.ok(Math.abs(light(s, 'operations', 0.4).lit - light(s, 'operations', 3.4).lit) < 1e-9, 'a 3 s period');
  for (const other of ['research', 'developer', 'qa']) assert.deepEqual(light(s, other, 1), { lit: 0, glow: 0, warn: 0 }, `${other} stays dark`);
});

test('blocked: a restrained warning, no glow; resolving clears it', () => {
  const r = rig();
  const { id } = r.wf.createTask({ title: 'x' });
  r.wf.startWork(id);
  r.set(T0 + 5000); r.wf.block(id, { reason: 'no repo' });
  const b = light(r.v.sample(T0 + 7000), 'operations', 1);
  assert.ok(b.warn > 0.3 && b.warn < 1 && b.glow === 0, `warn ${b.warn}`);
});

test('completion, failure and cancellation each return the art to neutral, with no lingering overlay', () => {
  for (const end of ['complete', 'fail', 'cancel']) {
    const r = rig();
    const { id } = r.wf.createTask({ title: 'x' });
    let t = T0;
    const step = (fn) => { t += 5000; r.set(t); fn(); };
    r.wf.startWork(id);
    for (let i = 0; i < 2; i++) { step(() => r.wf.completeStage(id)); step(() => r.wf.startWork(id)); }
    if (end === 'complete') for (const fn of ['completeStage', 'startWork', 'qaPass', 'startWork', 'completeStage']) step(() => r.wf[fn](id));
    else step(() => r.wf.failTask(id, { reason: end === 'cancel' ? 'cancelled' : 'broken' }));
    const s = r.v.sample(t + AFTER);
    allOff(s, end);
    assert.equal(s.pathCount, 0, `${end}: no path`);
    for (const role of ROLE_ORDER) assert.equal(s.roles[role].label, 0, `${end}: no ${role} label`);
  }
});

test('the reference art is the default scene; the procedural city stays available as a debug mode', () => {
  assert.equal(readParams('', { w: 1, h: 1 }).scene, 'reference');
  assert.equal(readParams('?scene=procedural', { w: 1, h: 1 }).scene, 'procedural');
  assert.equal(readParams('?scene=bogus', { w: 1, h: 1 }).scene, 'reference');
});

// ---- the art always covers the viewport as it is now (regression: a strip at the bottom) ----

const names = Object.fromEntries(ROLE_ORDER.map((r) => [r, ATLAS_AREAS[r].label]));
/** Viewport shapes: MacBook browser windows, 16:9, 16:10, portrait, ultrawide, dual, triple — and odd fractional sizes. */
function viewports() {
  const out = [[1512, 862], [1512, 700], [1512, 900], [1440, 900], [1920, 1080], [1728, 1080], [1280, 800], [900, 1100], [2400, 600], [2560, 1080], [3840, 1080], [5760, 1080], [3456, 1117], [5184, 1080]];
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 300; i++) out.push([300 + rnd() * 6000, 240 + rnd() * 1800]);
  return out;
}

test('the art covers every viewport edge to edge — no strip, no letterbox, no stretch — with sub-pixel overscan', () => {
  for (const [W, H] of viewports()) {
    const { art } = referenceLayout({ fullW: W, fullH: H, w: W }, { LABEL, labels: names });
    const where = `${W.toFixed(1)}x${H.toFixed(1)}`;
    assert.ok(art.x <= -0.49 && art.x + art.w >= W + 0.49, `${where}: horizontal cover (${art.x.toFixed(2)} .. ${(art.x + art.w).toFixed(2)})`);
    assert.ok(art.y <= -0.49 && art.y + art.h >= H + 0.49, `${where}: vertical cover (${art.y.toFixed(2)} .. ${(art.y + art.h).toFixed(2)}) — no bottom strip`);
    assert.ok(Math.abs(art.w / art.h - REF.width / REF.height) < 1e-9, `${where}: never stretched`);
    assert.ok(art.w <= W * 1.01 + 2 || art.h <= H * 1.01 + 2, `${where}: just covers (cover, not overscaled)`);
  }
});

test('a resize lays everything out again for the new size: art, labels and paths move together', () => {
  const before = referenceLayout({ fullW: 1512, fullH: 700, w: 1512 }, { LABEL, labels: names });
  const after = referenceLayout({ fullW: 1512, fullH: 900, w: 1512 }, { LABEL, labels: names });
  assert.ok(before.art.y + before.art.h < 900, 'the load-time layout would leave a strip at the new size (the bug)');
  assert.ok(after.art.y + after.art.h >= 900, 'the recomputed layout covers it');
  for (const r of ROLE_ORDER) {
    assert.deepEqual(after.paths[r], toCanvas(after.view, DISTRICTS[r].path), `${r}: path anchor follows the art`);
    assert.notDeepEqual(after.labels[r], before.labels[r], `${r}: label moved with the art`);
  }
});

test('multi-display slices share one layout: every display computes the same art rect and anchors', () => {
  for (const [W, H, n] of [[3840, 1080, 2], [5760, 1080, 3], [3456, 1117, 2]]) {
    const layouts = Array.from({ length: n }, (_, k) => referenceLayout({ fullW: W, fullH: H, x: (k * W) / n, w: W / n }, { LABEL, labels: names }));
    for (const L of layouts) assert.deepEqual(L.art, layouts[0].art, `${W}x${H}: identical art rect on every display — seams align`);
    const { art } = layouts[0];
    assert.ok(art.x <= 0 && art.x + art.w >= W && art.y <= 0 && art.y + art.h >= H, `${W}x${H}: no gap at any display edge`);
  }
});
