/**
 * The ATLAS world, composed (not scattered): a waterfront city seen from far across a bay at
 * night. Pure and deterministic per seed — no WebGL — so composition rules are unit-tested.
 *
 * Everything is placed in (screen fraction, distance) space and converted to world space for the
 * one shared camera, so the same composition holds on any canvas shape and each display renders
 * its slice of one continuous world. World: x right, y up, camera at (0, CAMERA.height, 0)
 * looking toward -z, tilted up a little so most of the frame is sky.
 *
 *   sky · mountain layers · far water + far-shore lights · the city on a curved shore
 *   (Operations · Research · central skyline · Developer · QA) · bay with islands and bridges ·
 *   dark foreground hills with trees framing the bottom corners
 */
export const CAMERA = Object.freeze({ fov: 18, height: 60, pitchDeg: 2.1, near: 20, far: 60000 });
export const TAN_HALF = Math.tan((CAMERA.fov * Math.PI) / 360);
export const LAND_Y = 1.5; // the city's ground, just above the water
export const DISTRICT_KEYS = ['operations', 'research', 'center', 'developer', 'qa'];
export const ROLE_INDEX = { operations: 0, research: 1, developer: 2, qa: 3 }; // matches ROLE_IDS order

export function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Piecewise-linear lookup in sorted [[t, v], …] control points (clamped at the ends). */
export function lerpTable(table, t) {
  if (t <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [t1, v1] = table[i];
    if (t <= t1) { const [t0, v0] = table[i - 1]; return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0); }
  }
  return table.at(-1)[1];
}

/**
 * Per canvas shape: where each district sits (fraction of the full canvas width), how far the
 * shore is (distance by fraction), and the bay's islands, bridges and foreground hills. The single
 * composition follows the reference wallpaper; wider canvases keep every labelled district inside
 * one display and frame each end with hills.
 */
export const COMPOSITIONS = {
  single: {
    districts: { operations: 0.15, research: 0.36, center: 0.56, developer: 0.745, qa: 0.895 },
    // A U-shaped bay: the side districts sit nearer the viewer, the central skyline farthest back.
    shore: [[-0.1, 2250], [0.08, 2280], [0.16, 2320], [0.25, 2700], [0.36, 3150], [0.46, 3600], [0.56, 3700], [0.66, 3450], [0.745, 3150], [0.82, 2750], [0.9, 2420], [1.1, 2350]],
    // Islands and hills: `y` is where their top should sit on screen (fraction from the top).
    islands: [
      { f: 0.395, w: 0.25, dist: 2450, y: 0.65, trees: 220, lights: 30 },
      { f: 0.655, w: 0.15, dist: 2700, y: 0.668, trees: 90, lights: 18 },
      { f: 0.36, w: 0.08, dist: 1000, y: 0.79, trees: 18, lights: 0 },
    ],
    hills: [
      { fc: -0.22, f1: 0.33, dist: 760, rz: 380, y: 0.748, trees: 700 },
      { fc: 1.28, f1: 0.5, dist: 700, rz: 380, y: 0.748, trees: 700 },
      { fc: 0.84, f1: 0.64, dist: 1500, rz: 420, y: 0.71, trees: 260, road: true },
    ],
    bridges: [
      { a: [0.235, 2560], b: [0.3, 2430] },
      { a: [0.515, 2500], b: [0.645, 2700], hero: true },
      { a: [0.705, 2740], b: [0.77, 3020] },
    ],
  },
  dual: {
    districts: { operations: 0.085, research: 0.23, center: 0.385, developer: 0.63, qa: 0.845 },
    shore: [[-0.1, 2900], [0.085, 3000], [0.23, 3400], [0.385, 3700], [0.5, 3500], [0.63, 3420], [0.74, 3300], [0.845, 3080], [1.1, 2950]],
    islands: [
      { f: 0.2, w: 0.12, dist: 2450, y: 0.648, trees: 70, lights: 14 },
      { f: 0.52, w: 0.1, dist: 2600, y: 0.662, trees: 44, lights: 10 },
      { f: 0.74, w: 0.08, dist: 2700, y: 0.668, trees: 30, lights: 8 },
      { f: 0.15, w: 0.05, dist: 820, y: 0.812, trees: 16, lights: 0 },
    ],
    hills: [
      { fc: -0.1, f1: 0.2, dist: 760, rz: 380, y: 0.748, trees: 520 },
      { fc: 1.12, f1: 0.74, dist: 700, rz: 380, y: 0.748, trees: 520 },
      { fc: 0.92, f1: 0.81, dist: 1500, rz: 420, y: 0.705, trees: 60, road: true },
    ],
    bridges: [
      { a: [0.115, 3020], b: [0.15, 2560] },
      { a: [0.44, 3620], b: [0.49, 2620] },
      { a: [0.70, 3380], b: [0.72, 2720] },
    ],
  },
  triple: {
    districts: { operations: 0.075, research: 0.225, center: 0.5, developer: 0.775, qa: 0.925 },
    shore: [[-0.1, 2900], [0.075, 3000], [0.225, 3350], [0.36, 3550], [0.5, 3700], [0.64, 3550], [0.775, 3380], [0.925, 3050], [1.1, 2950]],
    islands: [
      { f: 0.41, w: 0.1, dist: 2450, y: 0.648, trees: 70, lights: 14 },
      { f: 0.6, w: 0.07, dist: 2700, y: 0.668, trees: 34, lights: 8 },
      { f: 0.16, w: 0.06, dist: 2600, y: 0.662, trees: 34, lights: 8 },
      { f: 0.85, w: 0.06, dist: 2600, y: 0.662, trees: 34, lights: 8 },
      { f: 0.36, w: 0.04, dist: 820, y: 0.812, trees: 16, lights: 0 },
    ],
    hills: [
      { fc: -0.07, f1: 0.13, dist: 760, rz: 380, y: 0.748, trees: 420 },
      { fc: 1.08, f1: 0.83, dist: 700, rz: 380, y: 0.748, trees: 420 },
      { fc: 0.94, f1: 0.87, dist: 1500, rz: 420, y: 0.705, trees: 50, road: true },
    ],
    bridges: [
      { a: [0.36, 3520], b: [0.39, 2470] },
      { a: [0.43, 2470], b: [0.46, 3660] },
      { a: [0.64, 3520], b: [0.72, 3380] },
    ],
  },
};

/** An explicit `name` wins; otherwise pick by canvas aspect (one 16:9 display ≈ 1.78). */
export function pickLayout(aspect, name) {
  if (name && COMPOSITIONS[name]) return name;
  return aspect < 2.7 ? 'single' : aspect < 4.4 ? 'dual' : 'triple';
}

/**
 * Height whose top appears at `yFrac` of the frame (from the top) at distance `dist` — so hills and
 * islands are placed by where they should sit on screen, not by raw world height.
 */
export function heightForY(yFrac, dist) {
  const belowAxis = Math.atan((2 * yFrac - 1) * TAN_HALF);
  return CAMERA.height - dist * Math.tan(belowAxis - (CAMERA.pitchDeg * Math.PI) / 180);
}

/** World x for screen fraction `f` at distance `dist` (the camera's horizontal extent there). */
export const xAt = (f, dist, aspect) => (2 * f - 1) * TAN_HALF * aspect * dist;

const TAU = Math.PI * 2;

/** Smooth deterministic 1-D value noise in [-1, 1]. */
function noise1(seed) {
  const r = mulberry32(seed);
  const table = Array.from({ length: 256 }, () => r() * 2 - 1);
  return (t) => {
    const i = Math.floor(t), k = t - i, s = k * k * (3 - 2 * k);
    return table[i & 255] * (1 - s) + table[(i + 1) & 255] * s;
  };
}

/**
 * Compose the whole world for a canvas of `aspect` (full width / height). Returns buildings (by
 * primitive kind), districts (label anchors), terrain pieces, trees, lights, bridges and mountain
 * layers — all plain data.
 */
export function composeWorld({ aspect = 16 / 9, seed = 7, layout } = {}) {
  const name = pickLayout(aspect, layout);
  const C = COMPOSITIONS[name];
  const rnd = mulberry32(seed * 7919 + 17);
  const nShore = noise1(seed + 303);
  // The composed shore curve, broken up so it reads as a coastline rather than a drawn line.
  const shoreDist = (f) => lerpTable(C.shore, f) + 34 * nShore(f * 14) + 13 * nShore(f * 47 + 31);
  const fOf = (x, dist) => (x / (TAN_HALF * aspect * dist) + 1) / 2;
  const buildings = [];
  const lights = [];
  const districts = [];

  const beacons = []; // small white lights on the tallest tops
  const add = (kind, b) => { buildings.push({ kind, y: LAND_Y, rot: 0, role: null, wash: 0, density: 0.1, cool: 0.3, flags: 0, seed: rnd(), ...b }); return buildings.at(-1); };

  /** A tower with setbacks: base, shaft, crown (and an optional spire), all sharing one identity. */
  function tower(x, z, w, d, h, o = {}) {
    const rot = o.rot ?? 0, common = { rot, role: o.role ?? null, wash: o.wash ?? 0, density: o.density ?? 0.16, cool: o.cool ?? 0.4, seed: rnd() };
    const steps = o.steps ?? (h > 90 ? 3 : h > 45 ? 2 : 1);
    const baseH = steps === 1 ? h : h * (0.42 + rnd() * 0.16);
    add('box', { x, z, w, d, h: baseH, ...common });
    if (steps >= 2) add('box', { x, z, w: w * 0.8, d: d * 0.8, h: steps === 2 ? h : h * (0.78 + rnd() * 0.1), ...common });
    if (steps >= 3) add('box', { x, z, w: w * (0.5 + rnd() * 0.12), d: d * (0.55 + rnd() * 0.1), h, ...common });
    let top = h;
    if (o.crown) { // a crown on top of the shaft: chamfered (taper) or cut on a slant (wedge)
      const cw = (steps >= 3 ? 0.56 : steps === 2 ? 0.8 : 1) * w, ch = h * (0.1 + rnd() * 0.08);
      const slant = o.crown === 'slant';
      add(slant ? 'wedge' : 'taper', { x, z, w: cw, d: cw * (d / w), h: slant ? ch * 1.6 : ch, y: LAND_Y + h, ...common, rot: rot + (slant && rnd() < 0.5 ? Math.PI : 0), wash: common.wash * 0.3, density: 0.03 });
      top += slant ? ch * 1.6 : ch;
    }
    if (o.spire) add('cyl', { x, z, w: Math.max(2, w * 0.08), d: Math.max(2, w * 0.08), h: o.spire, y: LAND_Y + top, ...common, density: 0, flags: 1 });
    top += o.spire ?? 0;
    if (o.beacon) beacons.push([x, LAND_Y + top + 1, z]);
    return { top };
  }

  /** A spot `off` world units beside and `dz` behind district `f`'s shore — always on land, behind the shore where it actually lands. */
  const place = (f, off, dz) => {
    const D = shoreDist(f) + dz, x = xAt(f, D, aspect) + off;
    let d = D;
    for (let i = 0; i < 6; i++) d = Math.max(D, shoreDist(fOf(x, d)) + 15); // the shore under x depends on the distance itself
    return [x, -d];
  };

  // ---- districts ----
  const at = C.districts;
  const hero = {};
  {
    // Operations: industrial and angular — a sloped-roof hall, stepped towers, sheds, stacks. Warm.
    const f = at.operations, o = { role: 'operations', cool: 0.05 };
    let [x, z] = place(f, 20, 90);
    add('wedge', { x, z, w: 124, d: 64, h: 54, rot: 0.42, ...o, wash: 0.12, density: 0.2 });
    { const [xa, za] = place(f, 150, 120); add('wedge', { x: xa, z: za, w: 90, d: 50, h: 34, rot: -0.1, ...o, wash: 0.2, density: 0.1 }); }
    [x, z] = place(f, -70, 170);
    hero.operations = [x, z, tower(x, z, 26, 24, 112, { ...o, wash: 0.3, density: 0.2, steps: 3 }).top];
    let [x2, z2] = place(f, -104, 210); tower(x2, z2, 22, 20, 88, { ...o, wash: 0.1 });
    [x2, z2] = place(f, -40, 250); tower(x2, z2, 20, 18, 70, o);
    [x2, z2] = place(f, 88, 200); add('cyl', { x: x2, z: z2, w: 7, d: 7, h: 64, ...o, flags: 1 });
    [x2, z2] = place(f, 100, 215); add('cyl', { x: x2, z: z2, w: 6, d: 6, h: 52, ...o, flags: 1 });
    for (let i = 0; i < 16; i++) {
      [x2, z2] = place(f, -200 + rnd() * 400, 30 + rnd() * 260);
      if (Math.abs(x2 - x) < 30 && Math.abs(z2 - z) < 40) continue;
      add(rnd() < 0.3 ? 'wedge' : 'box', { x: x2, z: z2, w: 26 + rnd() * 40, d: 18 + rnd() * 26, h: 10 + rnd() * 22, rot: rnd() < 0.5 ? 0.08 : 0, ...o, density: 0.06, flags: rnd() < 0.4 ? 1 : 0 });
    }
    for (let i = 0; i < 12; i++) { [x2, z2] = place(f, -230 + rnd() * 460, 140 + rnd() * 220); tower(x2, z2, 16 + rnd() * 14, 14 + rnd() * 12, 26 + rnd() * 40, { ...o, density: 0.16 }); }
  }
  {
    // Research: a campus — slender tower, observatory dome on a drum, low slabs. Cool.
    const f = at.research, o = { role: 'research', cool: 0.85 };
    let [x, z] = place(f, -28, 150);
    hero.research = [x, z, tower(x, z, 19, 17, 122, { ...o, wash: 0.32, density: 0.2, steps: 2 }).top];
    let [x2, z2] = place(f, 48, 110);
    add('cyl', { x: x2, z: z2, w: 58, d: 58, h: 22, ...o, density: 0.12 });
    add('dome', { x: x2, z: z2, w: 56, d: 56, h: 30, y: LAND_Y + 22, ...o, wash: 0.5, flags: 1 });
    for (const [dx, dz, h] of [[-118, 220, 84], [-96, 280, 70], [-140, 260, 62], [-70, 300, 58], [18, 320, 50]]) {
      [x2, z2] = place(f, dx, dz); tower(x2, z2, 15 + rnd() * 10, 14 + rnd() * 8, h, { ...o, wash: 0.06 });
    }
    for (let i = 0; i < 20; i++) {
      [x2, z2] = place(f, -170 + rnd() * 340, 40 + rnd() * 240);
      if (Math.abs(x2 - x) < 26 || Math.hypot(x2 - (xAt(f, shoreDist(f) + 110, aspect) + 48), z2 + shoreDist(f) + 110) < 44) continue;
      add('box', { x: x2, z: z2, w: 30 + rnd() * 40, d: 20 + rnd() * 24, h: 12 + rnd() * 20, ...o, density: 0.18 });
    }
  }
  {
    // The central skyline: the tallest, neutral, floodlit — the visual anchor. Not a role district.
    // A curated set of individual towers (not a procedural forest): massive shafts with slanted,
    // chamfered or flat crowns, dark bodies, floodlit bases and single lit edges, spaced so the far
    // shore's lights show between them; low buildings fill the gaps; a hazy row stands behind.
    const f = at.center, o = { cool: 0.45 };
    let [x, z] = place(f, 18, 190);
    const top = tower(x, z, 30, 26, 236, { ...o, wash: 0.85, density: 0.035, steps: 3, crown: 'taper', spire: 26, beacon: true }).top;
    hero.center = [x, z, top];
    { const [xt, zt] = place(f, 40, 205); tower(xt, zt, 18, 18, 204, { ...o, wash: 0.7, density: 0.03, steps: 2, crown: 'slant', beacon: true }); }
    { const [xp, zp] = place(f, 2, 140); add('box', { x: xp, z: zp, w: 46, d: 30, h: 34, ...o, wash: 0.25, density: 0.85, cool: 0.2 }); } // the lit glass lobby at its foot
    const heroes = [ // [dx, dz, h, w, crown]
      [-62, 240, 172, 30, 'slant'], [-104, 175, 118, 24, 'flat'], [-146, 265, 152, 28, 'slant'], [-196, 205, 94, 30, 'taper'], [-30, 320, 132, 22, 'flat'],
      [84, 225, 154, 30, 'slant'], [122, 168, 106, 24, 'taper'], [158, 275, 180, 26, 'slant'], [206, 212, 98, 28, 'flat'], [246, 252, 124, 22, 'slant'],
    ];
    for (const [dx, dz, h, w, crown] of heroes) {
      const [x2, z2] = place(f, dx + (rnd() - 0.5) * 6, dz);
      const hh = h * (0.95 + rnd() * 0.1);
      tower(x2, z2, w, w * (0.75 + rnd() * 0.3), hh, {
        ...o, wash: 0.5 + rnd() * 0.35, density: 0.03 + rnd() * 0.04, steps: hh > 140 ? 2 : 1,
        crown: crown === 'flat' ? null : crown, rot: rnd() < 0.3 ? 0.1 : 0, beacon: hh > 140,
      });
    }
    // Low and mid-rise buildings between the towers and along the waterfront.
    for (const [dx, dz, w, h] of [[-150, 110, 70, 24], [-70, 95, 56, 18], [80, 100, 74, 22], [170, 120, 60, 28], [-230, 130, 56, 20], [240, 150, 60, 16]]) {
      const [x2, z2] = place(f, dx, dz);
      add('box', { x: x2, z: z2, w, d: 30 + rnd() * 14, h, ...o, wash: 0.08 + rnd() * 0.12, density: 0.16 + rnd() * 0.14 });
    }
    for (let i = 0; i < 26; i++) {
      const [x2, z2] = place(f, -270 + rnd() * 540, 60 + rnd() * 320);
      tower(x2, z2, 18 + rnd() * 22, 14 + rnd() * 16, 22 + rnd() * 40, { ...o, wash: rnd() * 0.15, density: 0.12 });
    }
    // A hazy back row of big, quiet towers, for depth.
    for (const [dx, dz, h, w] of [[-90, 560, 146, 34], [60, 600, 168, 36], [190, 540, 122, 30], [-210, 580, 112, 30], [-10, 640, 100, 40]]) {
      const [x2, z2] = place(f, dx, dz);
      tower(x2, z2, w, w * 0.8, h, { ...o, wash: 0.12, density: 0.03, steps: 1, crown: rnd() < 0.5 ? 'slant' : 'taper' });
    }
  }
  {
    // Developer: modern, vertical — slim towers, one with a tall accent fin.
    const f = at.developer, o = { role: 'developer', cool: 0.6 };
    let [x, z] = place(f, 10, 150);
    hero.developer = [x, z, tower(x, z, 18, 18, 112, { ...o, wash: 0.3, density: 0.2, steps: 2 }).top];
    add('box', { x, z: z + 10.5, w: 3.2, d: 3, h: 104, ...o, flags: 2 });
    for (const [dx, dz, h] of [[-60, 200, 84], [-34, 260, 72], [48, 230, 78], [80, 170, 62], [-92, 170, 58], [118, 260, 66], [22, 320, 90]]) {
      const [x2, z2] = place(f, dx, dz); tower(x2, z2, 15 + rnd() * 10, 14 + rnd() * 10, h * (0.9 + rnd() * 0.2), { ...o, wash: 0.05, steps: 1 });
    }
    for (let i = 0; i < 20; i++) {
      const [x2, z2] = place(f, -190 + rnd() * 380, 40 + rnd() * 240);
      if (Math.abs(x2 - x) < 24 && Math.abs(z2 - z) < 30) continue;
      add('box', { x: x2, z: z2, w: 22 + rnd() * 34, d: 18 + rnd() * 20, h: 14 + rnd() * 28, ...o, density: 0.18 });
    }
  }
  {
    // QA: quieter — a low campus under a large dome, and one stepped tower.
    const f = at.qa, o = { role: 'qa', cool: 0.7 };
    let [x, z] = place(f, 22, 140);
    hero.qa = [x, z, tower(x, z, 28, 24, 116, { ...o, wash: 0.3, density: 0.2, steps: 3 }).top];
    let [x2, z2] = place(f, -26, 90);
    add('cyl', { x: x2, z: z2, w: 70, d: 70, h: 12, ...o, density: 0.08 });
    add('dome', { x: x2, z: z2, w: 66, d: 66, h: 32, y: LAND_Y + 12, ...o, wash: 0.5, flags: 1 });
    for (let i = 0; i < 20; i++) {
      [x2, z2] = place(f, -190 + rnd() * 380, 40 + rnd() * 230);
      if (Math.hypot(x2 - xAt(f, shoreDist(f) + 90, aspect) + 26, z2 + shoreDist(f) + 90) < 50) continue;
      add('box', { x: x2, z: z2, w: 28 + rnd() * 44, d: 20 + rnd() * 24, h: 10 + rnd() * 16, ...o, density: 0.1 });
    }
    for (const [dx, dz, h] of [[100, 210, 58], [-110, 200, 46], [140, 150, 40]]) { [x2, z2] = place(f, dx, dz); tower(x2, z2, 18, 16, h, o); }
  }
  for (const key of DISTRICT_KEYS) {
    const [x, z, top] = hero[key];
    districts.push({ key, f: at[key], anchor: [x, LAND_Y + top + 10, z], role: key in ROLE_INDEX ? key : null });
  }

  // ---- the rest of the city: low-rise fabric along the whole shore, thinning between districts ----
  const radius = { operations: 230, research: 190, center: 270, developer: 200, qa: 210 };
  const zones = DISTRICT_KEYS.map((k) => { const D = shoreDist(at[k]); return { x: xAt(at[k], D, aspect), r: radius[k] }; });
  for (let f = -0.06; f < 1.06;) {
    const D = shoreDist(f);
    const x = xAt(f, D, aspect);
    const near = Math.max(...zones.map((zn) => Math.exp(-(((x - zn.x) / (zn.r * 1.6)) ** 2))));
    const w = 14 + rnd() * 30;
    f += (w + 6 + rnd() * 16) / (2 * TAN_HALF * aspect * D);
    if (zones.some((zn) => Math.abs(x - zn.x) < zn.r * 0.8)) continue;
    if (near < 0.12) continue; // open waterfront between districts: lights only, no stray buildings
    const rows = 1 + Math.floor(rnd() * 3);
    for (let r = 0; r < rows; r++) {
      if (rnd() > 0.02 + 0.75 * near * near) continue;
      const dz = 25 + rnd() * 520;
      let h = 8 + rnd() * 18 + near * rnd() * 30;
      if (rnd() < 0.06) h += 25 + rnd() * 30;
      const zz = -(D + dz);
      add('box', { x: x + (rnd() - 0.5) * 20, z: zz, w, d: 14 + rnd() * 26, h, rot: rnd() < 0.2 ? 0.1 : 0, density: 0.07 + 0.06 * near, cool: rnd() });
    }
  }
  // Far fabric behind the city: taller, sparser, dissolving into haze.
  for (let i = 0; i < 50; i++) {
    const f = rnd() * 1.1 - 0.05, D = shoreDist(f) + 520 + rnd() * 500;
    const xf = xAt(f, D, aspect);
    if (!zones.some((zn) => Math.abs(xf - zn.x) < zn.r * 2.2)) continue;
    add('box', { x: xAt(f, D, aspect), z: -D, w: 18 + rnd() * 30, d: 18 + rnd() * 24, h: 12 + rnd() * 36, density: 0.06, cool: rnd() });
  }

  // ---- shore lights along the city's waterfront ----
  for (let f = -0.05; f < 1.05;) {
    const D = shoreDist(f);
    f += (10 + rnd() * 18) / (2 * TAN_HALF * aspect * D);
    const x = xAt(f, D, aspect);
    const near = Math.max(...zones.map((zn) => Math.exp(-(((x - zn.x) / (zn.r * 1.4)) ** 2))));
    if (rnd() > 0.12 + 0.75 * near) continue;
    lights.push({ x, y: 3, z: -(D - 4), size: 1.8, warm: 0.75 + rnd() * 0.25, bright: 0.65 + rnd() * 0.35, reflect: 1 });
  }

  // Lit promenades along the waterfront near the districts: short light lines that the water repeats.
  for (let f = -0.02; f < 1.02;) {
    const D = shoreDist(f), f2 = f + 26 / (2 * TAN_HALF * aspect * D);
    const x = xAt(f, D, aspect), near = Math.max(...zones.map((zn) => Math.exp(-(((x - zn.x) / (zn.r * 1.1)) ** 2))));
    if (near > 0.45 && rnd() < 0.8) {
      const D2 = shoreDist(f2), x2 = xAt(f2, D2, aspect);
      const len = Math.hypot(x2 - x, D2 - D), rot = -Math.atan2(-(D2 - D), x2 - x);
      add('box', { x: (x + x2) / 2, z: -((D + D2) / 2 + 6), w: len, d: 0.6, h: 0.7, y: 2.6, rot, density: 0, flags: 3, bridge: 1 });
    }
    f = f2;
  }

  // Street lights among the buildings: warm points at ground level, densest in the districts.
  for (let i = 0; i < Math.round(260 * aspect / (16 / 9)); i++) {
    const zn = zones[Math.floor(rnd() * zones.length)];
    const x = zn.x + (rnd() + rnd() - 1) * zn.r * 1.3, D = shoreDist(fOf(x, 3500)) + 20 + rnd() * 420;
    lights.push({ x, y: 2.5, z: -D, size: 1.3, warm: 0.85 + rnd() * 0.15, bright: 0.35 + rnd() * 0.3, reflect: 0 });
  }

  const terrain = { land: { shore: C.shore, depth: 1150 }, mounds: [] };
  const trees = [];
  const rocks = [];
  const n1 = noise1(seed + 101);

  // ---- islands and foreground hills: mounds whose height is a smooth function on an ellipse ----
  const mound = (cx, cz, rx, rz, h, lean, s) => ({ cx, cz, rx, rz, h, lean, s });
  const moundHeight = (m, x, z) => {
    const u = (x - m.cx) / m.rx, v = (z - m.cz) / m.rz;
    // An irregular outline (coves and points) and a rocky, uneven top — not a cut ellipse.
    const a = Math.atan2(v, u), ca = Math.cos(a), sa = Math.sin(a);
    // Coves and points at the ends only: seen from a near-level camera, a cove in a front edge reads as a hole.
    const warp = 1 + Math.abs(ca) * (0.16 * n1(m.s + 50 + 2.3 * ca + 1.9 * sa) + 0.08 * n1(m.s + 90 + 6.1 * ca - 5.3 * sa));
    const r2 = (u * u + v * v) / (warp * warp);
    if (r2 >= 1) return -m.h * Math.min(1, (r2 - 1) * 2); // continuous below the waterline, so the shoreline follows the true curve
    const bumps = 1 + 0.2 * n1(m.s + u * 5) + 0.12 * (1 - Math.abs(n1(m.s + 40 + u * 13))) + 0.06 * n1(m.s + 70 + u * 31 + v * 7);
    return m.h * Math.pow(1 - r2, 0.5) * bumps;
  };
  /** Trees in clumps (bigger at a clump's heart), plus a few loners — never an even sprinkle. */
  const scatterTrees = (m, count, minFrac, spread, back = 0) => {
    const scale = -m.cz < 1000 ? 1.25 : 0.75 + Math.min(1.5, -m.cz / 2600) * 0.5; // near pines read large
    const centers = [];
    for (let tries = 0; centers.length < Math.max(3, Math.round(count / 10)) && tries < 400; tries++) {
      const u = rnd() * 2 - 1, v = (rnd() * 2 - 1) * spread - back;
      if (moundHeight(m, m.cx + u * m.rx, m.cz + v * m.rz) > m.h * minFrac) centers.push([u, v]);
    }
    for (let i = 0, tries = 0; i < count && tries < count * 20; tries++) {
      const lone = rnd() < 0.2 || !centers.length;
      const [cu, cv] = lone ? [rnd() * 2 - 1, (rnd() * 2 - 1) * spread - back] : centers[Math.floor(rnd() * centers.length)];
      const du = lone ? 0 : (rnd() + rnd() - 1) * 0.07, dv = lone ? 0 : (rnd() + rnd() - 1) * 0.12 * spread;
      const x = m.cx + (cu + du) * m.rx, z = m.cz + (cv + dv) * m.rz;
      const y = moundHeight(m, x, z);
      if (y < m.h * minFrac) continue;
      const heart = lone ? 0.6 : 1 - Math.min(1, Math.hypot(du / 0.07, dv / (0.12 * spread)) / 1.4);
      const th = (4.5 + rnd() * 4 + 4 * heart) * scale;
      trees.push({ x, y: y - 0.6, z, h: th, w: th * (0.34 + rnd() * 0.14) });
      i++;
    }
  };
  for (const is of C.islands) {
    const rx = (is.w / 2) * 2 * TAN_HALF * aspect * is.dist;
    const m = mound(xAt(is.f, is.dist, aspect), -is.dist, rx, rx * 0.32, heightForY(is.y, is.dist), 0, rnd() * 100);
    terrain.mounds.push(m);
    scatterTrees(m, is.trees, 0.35, 0.6);
    for (let i = 0; i < is.lights; i++) {
      const u = -0.85 + (1.7 * (i + rnd() * 0.6)) / is.lights;
      lights.push({ x: m.cx + u * m.rx, y: 2.2, z: m.cz + m.rz * Math.sqrt(1 - u * u) * 0.92, size: 1.9, warm: 0.9, bright: 0.85 + rnd() * 0.15, reflect: 1 });
    }
  }
  const roads = [];
  for (const hl of C.hills) {
    const cx = xAt(hl.fc, hl.dist, aspect), rx = Math.abs(xAt(hl.f1, hl.dist, aspect) - cx);
    const m = mound(cx, -hl.dist, rx, hl.rz, heightForY(hl.y, hl.dist), 0, rnd() * 100);
    terrain.mounds.push(m);
    scatterTrees(m, hl.trees, 0.3, 0.2, 0.02);
    if (hl.road) roads.push(m);
    // Rock outcrops on the near slopes: dark, angular, breaking up the smooth hill forms.
    if (hl.dist < 1000) {
      for (let i = 0, tries = 0; i < 26 && tries < 400; tries++) {
        const u = rnd() * 2 - 1, v = -0.05 + rnd() * 0.2; // along the crest, where they break the outline
        const x = m.cx + u * m.rx, z = m.cz + v * m.rz, y = moundHeight(m, x, z);
        if (y < m.h * 0.45) continue;
        const h = 2.5 + rnd() * 5;
        rocks.push({ x, y: y - h * 0.35, z, w: h * (1.2 + rnd()), h, d: h * (1 + rnd()), rot: rnd() * Math.PI });
        i++;
      }
      // Larger rock forms where the hill meets the water, breaking the shoreline.
      for (let i = 0, tries = 0; i < 14 && tries < 600; tries++) {
        const a = rnd() * Math.PI * 2, r = 0.82 + rnd() * 0.12;
        const x = m.cx + Math.cos(a) * r * m.rx, z = m.cz + Math.abs(Math.sin(a)) * r * m.rz; // the side facing the camera
        const y = moundHeight(m, x, z);
        if (y <= 0.5) continue;
        const h = 5 + rnd() * 9;
        rocks.push({ x, y: y - h * 0.5, z, w: h * (1.6 + rnd()), h, d: h * (1.2 + rnd()), rot: rnd() * Math.PI });
        i++;
      }
    }
  }
  // A lit road winding along the front slope of a hill.
  for (const m of roads) {
    for (let u = -0.7; u < 0.85; u += 0.018) {
      const v = 0.55 + 0.12 * Math.sin(u * 5);
      const x = m.cx + u * m.rx, z = m.cz + v * m.rz;
      const y = moundHeight(m, x, z);
      if (y > 0 && rnd() < 0.6) lights.push({ x, y: y + 1.5, z, size: 1.8, warm: 1, bright: 0.7 + rnd() * 0.3, reflect: 0 });
    }
  }

  // ---- bridges: a deck on close piers, lit rails along both edges ----
  const bridges = [];
  for (const br of C.bridges) {
    const a = [xAt(br.a[0], br.a[1], aspect), -br.a[1]], b = [xAt(br.b[0], br.b[1], aspect), -br.b[1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), rot = -Math.atan2(b[1] - a[1], b[0] - a[0]);
    const deckY = 6, mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const nx = Math.sin(rot), nz = Math.cos(rot);
    add('box', { x: mid[0], z: mid[1], w: len, d: 7, h: 2.6, y: deckY, rot, density: 0, flags: 1, bridge: 1 });
    for (const side of [-1, 1]) add('box', { x: mid[0] + nx * 3.4 * side, z: mid[1] + nz * 3.4 * side, w: len, d: 0.5, h: 0.6, y: deckY + 3.1, rot, density: 0, flags: 3, bridge: 1 });
    for (let t = 0.04; t < 0.98; t += 38 / len) add('box', { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, w: 3.2, d: 6, h: deckY, y: 0, rot, density: 0, flags: 1, bridge: 1 });
    for (let t = 0.01; t < 0.995; t += 11 / len) {
      const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      lights.push({ x: x + nx * 3.4, y: deckY + 4.2, z: z + nz * 3.4, size: 1.9, warm: 0.55, bright: 0.95, reflect: 1 });
      lights.push({ x: x - nx * 3.4, y: deckY + 4.2, z: z - nz * 3.4, size: 1.7, warm: 0.55, bright: 0.75, reflect: rnd() < 0.5 ? 1 : 0 });
    }
    if (br.hero) { // a long main span: two pylons, each with a light on top
      for (const t of [0.33, 0.67]) {
        const px = a[0] + (b[0] - a[0]) * t, pz = a[1] + (b[1] - a[1]) * t;
        for (const side of [-1, 1]) add('box', { x: px + nx * 3.6 * side, z: pz + nz * 3.6 * side, w: 2.4, d: 2.4, h: 30, y: 0, rot, density: 0, flags: 1, bridge: 1, wash: 0.25 });
        lights.push({ x: px, y: 32, z: pz, size: 1.6, warm: 0.3, bright: 0.8, reflect: 1 });
      }
    }
    bridges.push({ a, b, deckY });
  }

  // ---- mountain layers: ridge heights as elevation angles, so they frame the same at any distance ----
  const elevToY = (deg, dist) => CAMERA.height + dist * Math.tan((deg * Math.PI) / 180);
  const peakF = name === 'single' ? 0.77 : name === 'dual' ? 0.9 : 0.86;
  // Ridge heights in degrees above the horizon. `ridged` sharpens crests (1 - |noise|).
  const layers = [
    { dist: 20000, base: 2.15, amp: 0.7, ridged: 0.55, freq: 4, peak: 0, facets: 0.16, color: 0x19233e },
    { dist: 13500, base: 1.5, amp: 0.8, ridged: 0.8, freq: 5.5, peak: 1.65, facets: 0.4, color: 0x131c33 },
    { dist: 9500, base: 0.7, amp: 0.55, ridged: 0.6, freq: 8, peak: 0, facets: 0.26, color: 0x0e1628 },
    { dist: 6600, base: 0.22, amp: 0.3, ridged: 0.4, freq: 12, peak: 0, facets: 0.1, color: 0x0c1322 }, // the far shore's low hills
  ];
  const span = aspect / (16 / 9); // keep the ridge rhythm per display width
  const mountains = layers.map((L, li) => {
    const nz = noise1(seed * 31 + li * 7), points = [];
    for (let i = 0; i <= 600; i++) {
      const f = -0.08 + (1.16 * i) / 600;
      const t = f * L.freq * span;
      const smooth = 0.6 * nz(t) + 0.4 * nz(t * 2.1 + 11);
      const crest = (1 - Math.abs(nz(t * 1.7 + 23))) * 0.7 + (1 - Math.abs(nz(t * 4.3 + 57))) * 0.3;
      let e = L.base + L.amp * ((1 - L.ridged) * smooth + L.ridged * (crest - 0.5) * 1.6)
        + 0.12 * L.amp * (1 - Math.abs(nz(t * 9 + 91))) + 0.05 * L.amp * nz(t * 23 + 7); // jagged crest detail
      if (L.peak) {
        e += L.peak * Math.exp(-Math.abs(f - peakF) / 0.042) + 0.3 * L.peak * Math.exp(-Math.abs(f - peakF + 0.075) / 0.028)
          + 0.22 * L.peak * Math.exp(-Math.abs(f - peakF - 0.065) / 0.03);
      }
      points.push([xAt(f, L.dist, aspect), elevToY(Math.max(0.08, e), L.dist)]);
    }
    return { dist: L.dist, color: L.color, facets: L.facets, points };
  });
  // Far-shore towns at the foot of the low hills, and a long bridge across the far water.
  const farD = 6400;
  for (let i = 0; i < Math.round(18 * span); i++) {
    const fc = rnd() * 1.1 - 0.05, n = 4 + Math.floor(rnd() * 10);
    for (let k = 0; k < n; k++) {
      const D = farD - 100 + rnd() * 150;
      lights.push({ x: xAt(fc, D, aspect) + (rnd() - 0.5) * 160 * rnd(), y: 2 + rnd() * rnd() * 12, z: -D, size: 1.3, warm: 0.7 + rnd() * 0.3, bright: 0.55 + rnd() * 0.35, reflect: rnd() < 0.4 ? 1 : 0 });
    }
  }
  {
    const f0 = name === 'single' ? 0.62 : 0.7, f1 = name === 'single' ? 0.92 : 0.95, D = 5600;
    const x0 = xAt(f0, D, aspect), x1 = xAt(f1, D, aspect);
    for (let x = x0; x < x1; x += 14) lights.push({ x, y: 14, z: -D, size: 1.2, warm: 0.4, bright: 0.5, reflect: 1 });
  }

  for (const [x, y, z] of beacons) lights.push({ x, y, z, size: 1.6, warm: 0.15, bright: 0.85, reflect: 0 });

  return {
    name, aspect, camera: CAMERA, buildings, districts, terrain, moundHeight, trees, rocks, lights, bridges, mountains,
    shoreDist, fOf,
  };
}
