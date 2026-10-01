import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityLevel, pulseLevel, districtOf, districtBoosts, easeToward } from '../src/activity.js';
import { readParams } from '../src/params.js';
import { formatInt, formatHud, hudValues } from '../src/format.js';
import { demoStats } from '../src/demo.js';
import { LABEL, labelWidthPx, labelHeightPx, statusText, pickLayout } from '../src/layouts.js';
import { composeWorld, COMPOSITIONS, CAMERA, DISTRICT_KEYS, LAND_Y, heightForY } from '../src/world.js';
import { ATLAS_AREAS } from '../src/atlas-areas.js';
import * as THREE from '../vendor/three/three.module.js';

test('activityLevel curve', () => {
  assert.equal(activityLevel({ working: 0, subagents: 0 }), 0);
  assert.equal(activityLevel({ working: 1 }), 0.45);
  assert.ok(Math.abs(activityLevel({ working: 2 }) - 0.65) < 1e-9);
  assert.ok(Math.abs(activityLevel({ working: 1, subagents: 6 }) - 0.85) < 1e-9);
  assert.equal(activityLevel({ working: 8 }), 1);
  assert.equal(activityLevel({ subagents: 1 }), 0.45);
  assert.equal(activityLevel(undefined), 0);
});

test('pulseLevel clamps', () => {
  assert.equal(pulseLevel(0), 0);
  assert.equal(pulseLevel(50_000), 0.5);
  assert.equal(pulseLevel(1e9), 1);
});

test('districts are stable and bounded', () => {
  assert.equal(districtOf('/a'), districtOf('/a'));
  for (const k of ['/a', '/b', 'x', '']) assert.ok(districtOf(k) >= 0 && districtOf(k) < 8);
  const b = districtBoosts(['/a', '/a', '/a']);
  assert.equal(b.length, 8);
  assert.equal(Math.max(...b), 1);
});

test('easeToward converges', () => {
  let v = 0;
  for (let i = 0; i < 300; i++) v = easeToward(v, 1, 1 / 60, 1);
  assert.ok(v > 0.99 && v <= 1);
});

test('readParams defaults to the window and reads slices', () => {
  assert.deepEqual(readParams('', { w: 800, h: 600 }),
    { fullW: 800, fullH: 600, x: 0, y: 0, w: 800, h: 600, fps: 60, overlay: true, demo: false, seed: 7, forceActivity: -1, layout: null, workflowDemo: false, demoAt: -1, freeze: false, scene: 'reference' });
  const p = readParams('?fullW=5760&fullH=1080&x=1920&y=0&w=1920&h=1080&fps=30&overlay=0&demo=1', { w: 1, h: 1 });
  assert.equal(p.fullW, 5760); assert.equal(p.x, 1920); assert.equal(p.fps, 30);
  assert.equal(p.overlay, false); assert.equal(p.demo, true);
  assert.equal(p.workflowDemo, true, 'app Demo mode also plays the workflow demo');
  const w = readParams('?workflow=demo&demoAt=42', { w: 1, h: 1 });
  assert.deepEqual([w.demo, w.workflowDemo, w.demoAt], [false, true, 42], 'workflow demo alone keeps real HUD stats');
});

test('status line text is single-line and truncated for the label block', () => {
  assert.equal(statusText('running tests'), 'running tests');
  assert.equal(statusText('  reading\n requirements '), 'reading requirements');
  const long = statusText('Implementing sign-in, sign-out and session middleware');
  assert.ok(long.length <= LABEL.statusPx.maxChars && long.endsWith('…'), long);
  assert.equal(statusText(null), '');
});

test('HUD: tokens are the full integer with thousands separators — never abbreviated, no decimals', () => {
  const cases = [[0, '0'], [984, '984'], [999, '999'], [1000, '1,000'], [12_430, '12,430'], [128_449, '128,449'],
    [999_950, '999,950'], [1_204_331, '1,204,331'], [174_900_000, '174,900,000'], [2_500_000_000, '2,500,000,000'],
    [12_449.7, '12,450'], [-5, '0'], [undefined, '0'], [NaN, '0']];
  for (const [n, s] of cases) assert.equal(formatInt(n), s, `${n}`);
  for (const [n] of cases) assert.doesNotMatch(formatInt(n), /[KMB.]/, `${n} is not abbreviated`);
});

test('HUD: values come from collector stats with existing semantics; offline shows dashes', () => {
  const v = hudValues({ source: 'herdr', working: 1, subagents: 6, projects: 1, tokensToday: 215_615_003, tokensPerMin: 218_000 });
  assert.deepEqual(v, { projects: 1, agents: 7, tokens: 215_615_003 }, 'agents = working + subagents; tokens = today');
  assert.deepEqual(formatHud(v), { projects: '1', agents: '7', tokens: '215,615,003' });
  assert.deepEqual(formatHud(hudValues({})), { projects: '0', agents: '0', tokens: '0' });
  assert.equal(hudValues(null), null);
  assert.deepEqual(formatHud(null), { projects: '—', agents: '—', tokens: '—' });
  assert.deepEqual(formatHud({ projects: 2.6, agents: 3.4, tokens: 12_449.7 }), { projects: '3', agents: '3', tokens: '12,450' }, 'eased values round cleanly');
});

test('demoStats cycles idle → busy and tokens only grow', () => {
  assert.equal(demoStats(1).working, 0);
  assert.ok(demoStats(20).working + demoStats(20).subagents >= 3);
  assert.ok(demoStats(21).tokensToday >= demoStats(20).tokensToday);
});

test('the four ATLAS areas have the specified identity', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(ATLAS_AREAS).map(([k, v]) => [k, v.label])),
    { operations: 'OPERATIONS', research: 'RESEARCH', developer: 'DEVELOPER', qa: 'QA' },
  );
  // Derived from the canonical role registry, unchanged from Phase 2's colors.
  assert.deepEqual(Object.values(ATLAS_AREAS).map((a) => a.color), [0xff9a3c, 0x4a9dff, 0x3ddc84, 0xb96bff]);
});

test('pickLayout by canvas aspect, URL override wins', () => {
  assert.equal(pickLayout(16 / 9), 'single');
  assert.equal(pickLayout(21 / 9), 'single');
  assert.equal(pickLayout(9 / 32), 'single'); // stacked displays
  assert.equal(pickLayout(32 / 9), 'dual');
  assert.equal(pickLayout(3.2), 'dual'); // two 16:10
  assert.equal(pickLayout(48 / 9), 'triple');
  assert.equal(pickLayout(4.8), 'triple'); // three 16:10
  assert.equal(pickLayout(16 / 9, 'triple'), 'triple');
  assert.equal(pickLayout(16 / 9, 'bogus'), 'single');
});


// ---- the composed world (world.js), checked through the real camera ----

function view(aspect) {
  const cam = new THREE.PerspectiveCamera(CAMERA.fov, aspect, CAMERA.near, CAMERA.far);
  cam.position.set(0, CAMERA.height, 0);
  cam.rotation.x = (CAMERA.pitchDeg * Math.PI) / 180;
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  const project = (x, y, z) => { const v = new THREE.Vector3(x, y, z).project(cam); return [(v.x + 1) / 2, (1 - v.y) / 2]; };
  /** Where the ray through screen point (fx, fy) meets the water plane (null above the horizon). */
  const onWater = (fx, fy) => {
    const v = new THREE.Vector3(fx * 2 - 1, 1 - fy * 2, 0.5).unproject(cam).sub(cam.position).normalize();
    if (v.y >= 0) return null;
    const t = -cam.position.y / v.y;
    return [cam.position.x + v.x * t, cam.position.z + v.z * t];
  };
  return { project, onWater };
}

// Canvas shapes each composition is used for, with their display count.
const CANVASES = [[16 / 9, 1], [16 / 10, 1], [21 / 9, 1], [32 / 9, 2], [3.2, 2], [48 / 9, 3], [4.8, 3]];
const tops = (b) => [b.x, b.y + b.h, b.z];
const cv = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) / m; };

test('world: deterministic per seed, different across seeds', () => {
  const a = composeWorld({ aspect: 16 / 9, seed: 7 }), b = composeWorld({ aspect: 16 / 9, seed: 7 }), c = composeWorld({ aspect: 16 / 9, seed: 8 });
  assert.deepEqual(a.buildings, b.buildings);
  assert.deepEqual(a.lights, b.lights);
  assert.deepEqual(a.trees, b.trees);
  assert.notDeepEqual(a.buildings, c.buildings);
});

test('world: a level, cinematic view — horizon low in the frame, the top of the frame open sky', () => {
  for (const [aspect] of CANVASES) {
    const w = composeWorld({ aspect });
    const { project } = view(aspect);
    const [, horizon] = project(0, CAMERA.height, -1e6);
    assert.ok(horizon > 0.55 && horizon < 0.65, `@${aspect.toFixed(2)} horizon at ${(horizon * 100) | 0}%`);
    const things = [...w.buildings.map(tops), ...w.trees.map((t) => [t.x, t.y + t.h, t.z]), ...w.lights.map((l) => [l.x, l.y, l.z]),
      ...w.mountains.flatMap((m) => m.points.map(([x, y]) => [x, y, -m.dist]))];
    const highest = Math.min(...things.map((p) => project(...p)[1]));
    assert.ok(highest > 0.4, `@${aspect.toFixed(2)} something reaches ${(highest * 100) | 0}% from the top — the sky must stay open`);
    assert.ok(highest < 0.5, `@${aspect.toFixed(2)} the skyline should rise to near mid-frame (top at ${(highest * 100) | 0}%)`);
  }
});

test('world: the central skyline is the anchor — tallest on screen, near the middle, neutral', () => {
  const w = composeWorld({ aspect: 16 / 9 });
  const { project } = view(16 / 9);
  const center = w.districts.find((d) => d.key === 'center');
  const [cx, cy] = project(...center.anchor);
  assert.ok(cx > 0.45 && cx < 0.65, `center skyline at ${(cx * 100) | 0}% across`);
  for (const d of w.districts) if (d.key !== 'center') assert.ok(project(...d.anchor)[1] > cy + 0.03, `${d.key} rises above the central skyline`);
  const tallest = [...w.buildings].sort((a, b) => project(...tops(a))[1] - project(...tops(b))[1]).slice(0, 6);
  for (const b of tallest) assert.equal(b.role, null, 'the tallest buildings are neutral, not a role district');
});

test('world: districts read left to right — Operations, Research, center, Developer, QA — in every composition', () => {
  for (const [aspect] of CANVASES) {
    const w = composeWorld({ aspect });
    const { project } = view(aspect);
    assert.deepEqual(w.districts.map((d) => d.key), DISTRICT_KEYS);
    const xs = w.districts.map((d) => project(...d.anchor)[0]);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1] + 0.05, `@${aspect.toFixed(2)} ${DISTRICT_KEYS[i]} is right of ${DISTRICT_KEYS[i - 1]}`);
    for (const role of ['operations', 'research', 'developer', 'qa']) {
      assert.ok(w.buildings.filter((b) => b.role === role).length >= 15, `${role} is a district, not a single tower`);
    }
  }
});

/** Screen box (CSS px on a fullH = 1080 canvas) of each role district's label block. */
function labelBoxes(aspect) {
  const w = composeWorld({ aspect });
  const { project } = view(aspect);
  const H = 1080, W = H * aspect;
  return w.districts.filter((d) => d.role).map((d) => {
    const [fx, fy] = project(...d.anchor);
    const lw = labelWidthPx(ATLAS_AREAS[d.key].label);
    return { key: d.key, W, H, x0: fx * W - lw / 2, x1: fx * W + lw / 2, y0: fy * H - labelHeightPx(), y1: fy * H };
  });
}

test('labels: on screen with breathing room, never overlapping, never across a display seam', () => {
  for (const [aspect, n] of CANVASES) {
    const boxes = labelBoxes(aspect);
    for (const b of boxes) {
      const where = `@${aspect.toFixed(2)} ${b.key}`;
      assert.ok(b.x0 > 0.03 * b.H && b.x1 < b.W - 0.03 * b.H, `${where}: too close to a side edge`);
      assert.ok(b.y0 > 0.35 * b.H && b.y1 < 0.7 * b.H, `${where}: outside the skyline band`);
      for (let k = 1; k < n; k++) {
        const seam = (k * b.W) / n;
        assert.ok(b.x1 < seam - 30 || b.x0 > seam + 30, `${where}: crosses the seam at ${seam | 0}px`);
      }
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        assert.ok(!(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1), `@${aspect.toFixed(2)}: ${a.key} and ${b.key} labels overlap`);
      }
    }
  }
});

test('world: buildings stand on land behind the shore; the city varies instead of repeating', () => {
  for (const [aspect] of CANVASES) {
    const w = composeWorld({ aspect });
    for (const b of w.buildings) {
      if (b.bridge) continue;
      const dist = -b.z;
      assert.ok(dist >= w.shoreDist(w.fOf(b.x, dist)) - 2, `@${aspect.toFixed(2)} a building stands in the water at ${b.x | 0},${b.z | 0}`);
      assert.ok(b.y >= LAND_Y - 1e-9 || b.kind === 'dome' || b.kind === 'cyl', 'buildings start at ground level');
    }
    const city = w.buildings.filter((b) => !b.bridge);
    assert.ok(cv(city.map((b) => b.h)) > 0.6, 'heights vary widely');
    assert.ok(cv(city.map((b) => b.w)) > 0.3, 'widths vary');
    const keys = new Set(city.map((b) => `${b.kind}|${b.x.toFixed(1)}|${b.z.toFixed(1)}|${b.w.toFixed(1)}|${b.h.toFixed(1)}`));
    assert.equal(keys.size, city.length, 'no duplicated buildings');
    assert.ok(w.buildings.some((b) => b.kind === 'dome') && w.buildings.some((b) => b.kind === 'wedge'), 'domes and angular halls, not only boxes');
  }
});

test('world: open water in the middle of the bay, dark land framing the bottom corners', () => {
  for (const [aspect] of CANVASES.filter(([, n]) => n === 1)) {
    const w = composeWorld({ aspect });
    const { onWater } = view(aspect);
    const landAt = (fx, fy) => { const p = onWater(fx, fy); return w.terrain.mounds.some((m) => w.moundHeight(m, p[0], p[1]) > 0); };
    for (const [fx, fy] of [[0.5, 0.72], [0.45, 0.78], [0.55, 0.76], [0.42, 0.86]]) assert.ok(!landAt(fx, fy), `@${aspect.toFixed(2)} water expected at ${fx},${fy}`);
    for (const [fx, fy] of [[0.03, 0.97], [0.97, 0.97], [0.03, 0.85], [0.97, 0.85]]) assert.ok(landAt(fx, fy), `@${aspect.toFixed(2)} foreground land expected at ${fx},${fy}`);
  }
});

test('world: layered mountains (three ranges plus the far shore\'s hills), lighter with distance, the prominent peak on the right', () => {
  const w = composeWorld({ aspect: 16 / 9 });
  const { project } = view(16 / 9);
  assert.equal(w.mountains.length, 4);
  const lum = (c) => ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255);
  const byDist = [...w.mountains].sort((a, b) => b.dist - a.dist);
  for (let i = 1; i < byDist.length; i++) assert.ok(lum(byDist[i].color) < lum(byDist[i - 1].color), 'nearer layers are darker');
  const peak = w.mountains.flatMap((m) => m.points.map(([x, y]) => project(x, y, -m.dist))).sort((a, b) => a[1] - b[1])[0];
  assert.ok(peak[0] > 0.6 && peak[0] < 0.95, `highest peak at ${(peak[0] * 100) | 0}% across`);
});

test('heightForY places a top exactly where asked on screen', () => {
  const { project } = view(16 / 9);
  for (const [y, d] of [[0.7, 800], [0.65, 2500], [0.75, 600]]) {
    assert.ok(Math.abs(project(0, heightForY(y, d), -d)[1] - y) < 1e-6);
  }
});

test('every composition defines exactly the four ATLAS role districts plus the neutral center', () => {
  for (const name of Object.keys(COMPOSITIONS)) {
    assert.deepEqual(Object.keys(COMPOSITIONS[name].districts).sort(), [...Object.keys(ATLAS_AREAS), 'center'].sort());
  }
});
