import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityLevel, pulseLevel, districtOf, districtBoosts, easeToward } from '../src/activity.js';
import { readParams } from '../src/params.js';
import { generateCity } from '../src/city.js';
import { formatStats } from '../src/format.js';
import { demoStats } from '../src/demo.js';
import { LAYOUTS, LANDMARK, labelWidthPx, pickLayout } from '../src/layouts.js';
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
    { fullW: 800, fullH: 600, x: 0, y: 0, w: 800, h: 600, fps: 60, overlay: true, demo: false, seed: 7, forceActivity: -1, layout: null });
  const p = readParams('?fullW=5760&fullH=1080&x=1920&y=0&w=1920&h=1080&fps=30&overlay=0&demo=1', { w: 1, h: 1 });
  assert.equal(p.fullW, 5760); assert.equal(p.x, 1920); assert.equal(p.fps, 30);
  assert.equal(p.overlay, false); assert.equal(p.demo, true);
});

const segDist = (p, a, b) => {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
};

test('generateCity: deterministic, modest, low-rise, landmarks stand clear, corridors and foreground stay low', () => {
  for (const [name, n] of [['single', 1], ['dual', 2], ['triple', 3]]) {
    const layout = LAYOUTS[name];
    const a = generateCity({ seed: 7, layout }), b = generateCity({ seed: 7, layout });
    assert.deepEqual(a.buildings, b.buildings);
    assert.deepEqual(a.lights, b.lights);
    // Roughly one display's worth of city per display (the original scene had >3000 on triple).
    const perDisplay = a.buildings.length / n;
    assert.ok(perDisplay > 300 && perDisplay < 900, `${name}: ${a.buildings.length} buildings (${perDisplay | 0}/display)`);
    const { minX, maxX, minZ, maxZ } = layout.field;
    const loop = layout.areas.map((p, i) => [p, layout.areas[(i + 1) % layout.areas.length]]);
    for (const bl of a.buildings) {
      assert.ok(bl.x > minX && bl.x < maxX && bl.z > minZ && bl.z < maxZ);
      assert.ok(bl.h > 0 && bl.h < LANDMARK.tower.h, `${name}: a city building out-tops the landmarks`);
      const half = Math.hypot(bl.w, bl.d) / 2;
      for (const ar of layout.areas) {
        assert.ok(Math.hypot(bl.x - ar.x, bl.z - ar.z) >= LANDMARK.clearRadius + half, `${name}: building overlaps a landmark`);
      }
      if (loop.some(([p, q]) => segDist(bl, p, q) < 60 + half)) assert.ok(bl.h <= 22, `${name}: tall building in an activity corridor`);
      if (bl.z > layout.frontZ) assert.ok(bl.h <= 26, `${name}: tall building in the foreground`);
    }
    assert.ok(a.grid.pitch > 0 && a.grid.avenueEvery >= 2, `${name}: ground needs the street grid, with sparse avenues`);
  }
});

test('formatStats', () => {
  assert.deepEqual(formatStats(null), { projects: '—', agents: '—', agentsSub: 'offline', tokens: '—', rate: '' });
  const f = formatStats({ source: 'herdr', working: 1, subagents: 6, projects: 1, tokensToday: 215615003, tokensPerMin: 218000 });
  assert.deepEqual(f, { projects: '1', agents: '7', agentsSub: '6 subagents · working', tokens: '215,615,003', rate: '218k / min' });
  assert.equal(formatStats({ working: 0, subagents: 0, projects: 0, tokensToday: 5, tokensPerMin: 0 }).agentsSub, 'idle');
  assert.equal(formatStats({ source: 'demo', working: 1, subagents: 0, projects: 1, tokensToday: 5, tokensPerMin: 900 }).agentsSub, 'demo working');
  assert.equal(formatStats({ working: 1, subagents: 1, projects: 1, tokensToday: 5, tokensPerMin: 900 }).rate, '900 / min');
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

test('every layout defines exactly the four ATLAS areas', () => {
  for (const name of ['single', 'dual', 'triple']) {
    const keys = LAYOUTS[name].areas.map((a) => a.key).sort();
    assert.deepEqual(keys, Object.keys(ATLAS_AREAS).sort());
  }
});

/**
 * Screen-space boxes (CSS px on a fullH=1080 canvas) for each landmark — the whole massing (podium
 * + tower + mast, rotated with the street grid) and its label (constant pixel size, bottom-anchored
 * above the mast) — projected through the layout's real camera. World coordinates are exact:
 * nothing in the scene is rotated after placement.
 */
function landmarkBoxes(layout, aspect) {
  const H = 1080, W = H * aspect;
  const { camera: c, areas, gridAngle } = layout;
  const cam = new THREE.PerspectiveCamera(c.fov, aspect, 10, 24000);
  cam.position.set(...c.position);
  cam.lookAt(...c.lookAt);
  cam.updateMatrixWorld();
  const px = (x, y, z) => { const v = new THREE.Vector3(x, y, z).project(cam); return [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H]; };
  const { podium, tower, mastH, labelGapY, labelPx } = LANDMARK;
  const cos = Math.cos(gridAngle), sin = Math.sin(gridAngle);
  return areas.map((a) => {
    const pts = [];
    for (const [hw, hd, h] of [[podium.w / 2, podium.d / 2, podium.h], [tower.w / 2, tower.d / 2, tower.h + mastH]]) {
      for (const [su, sv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const u = su * hw, v = sv * hd;
        for (const y of [0, h]) pts.push(px(a.x + u * cos + v * sin, y, a.z - u * sin + v * cos));
      }
    }
    const [lx, ly] = px(a.x, tower.h + mastH + labelGapY, a.z);
    const lw = labelWidthPx(ATLAS_AREAS[a.key].label);
    return {
      key: a.key, W, H,
      body: { x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), y1: Math.max(...pts.map((p) => p[1])) },
      label: { x0: lx - lw / 2, x1: lx + lw / 2, y0: ly - labelPx.height, y1: ly },
    };
  });
}

// Aspect ratios pickLayout routes into each bucket, with the display count they typically mean
// (the narrowest — two or three 16:10 displays — is the tightest fit).
const CANVASES = {
  single: [[16 / 9, 1], [16 / 10, 1], [21 / 9, 1]],
  dual: [[32 / 9, 2], [3.2, 2], [4.3, 2]],
  triple: [[48 / 9, 3], [4.8, 3], [5.7, 3]],
};

test('every landmark and label is fully on screen with breathing room, in every layout', () => {
  for (const [name, canvases] of Object.entries(CANVASES)) {
    for (const [aspect] of canvases) {
      for (const { key, W, H, body, label } of landmarkBoxes(LAYOUTS[name], aspect)) {
        const margin = 0.06 * H; // ≈65px at 1080p
        for (const [what, b] of [['building', body], ['label', label]]) {
          const where = `${name} @${aspect.toFixed(2)} ${key} ${what}`;
          assert.ok(b.x0 > margin && b.x1 < W - margin, `${where}: too close to a side edge (${b.x0 | 0}..${b.x1 | 0} of ${W | 0})`);
          assert.ok(b.y0 > 0.25 * H && b.y1 < 0.85 * H, `${where}: outside the city band (${b.y0 | 0}..${b.y1 | 0})`);
        }
      }
    }
  }
});

test('no landmark or label straddles a display seam on multi-display layouts', () => {
  for (const [name, canvases] of Object.entries(CANVASES)) {
    for (const [aspect, n] of canvases) {
      if (n === 1) continue;
      for (const { key, W, body, label } of landmarkBoxes(LAYOUTS[name], aspect)) {
        for (let k = 1; k < n; k++) {
          const seam = (k * W) / n, gap = 40;
          for (const b of [body, label]) {
            assert.ok(b.x1 < seam - gap || b.x0 > seam + gap, `${name} @${aspect.toFixed(2)} ${key}: crosses the seam at ${seam | 0}px`);
          }
        }
      }
    }
  }
});

test('labels never overlap each other, and the city sits below a band of open sky', () => {
  for (const [name, canvases] of Object.entries(CANVASES)) {
    for (const [aspect] of canvases) {
      const boxes = landmarkBoxes(LAYOUTS[name], aspect);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i].label, b = boxes[j].label;
          const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
          assert.ok(!overlap, `${name} @${aspect.toFixed(2)}: ${boxes[i].key} and ${boxes[j].key} labels overlap`);
        }
      }
      // The visible skyline is where the city's far edge dissolves into haze (the true horizon above it
      // is haze-on-haze, invisible). It should leave roughly the top third-to-half of the frame as sky.
      const { camera: c, field } = LAYOUTS[name];
      const cam = new THREE.PerspectiveCamera(c.fov, aspect, 10, 24000);
      cam.position.set(...c.position);
      cam.lookAt(...c.lookAt);
      cam.updateMatrixWorld();
      const edgeY = (1 - new THREE.Vector3(0, 0, field.minZ).project(cam).y) / 2;
      assert.ok(edgeY > 0.35 && edgeY < 0.55, `${name}: city's far edge at ${(edgeY * 100) | 0}% from top`);
    }
  }
});
