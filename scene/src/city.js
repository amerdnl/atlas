import { LANDMARK } from './layouts.js';

export function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BLOCK = 130;
export const STREET = 24;
export const PITCH = BLOCK + STREET;
export const AVENUE_EVERY = 3; // only every third street is a (faintly) painted avenue with lights
const CORRIDOR = 60; // half-width of the low-rise corridors kept between consecutive areas

const segDist = (px, pz, a, b) => {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(px - (a.x + dx * t), pz - (a.z + dz * t));
};

/**
 * A modest, low-rise night city around the four ATLAS areas. Streets form a grid rotated by
 * `layout.gridAngle` (so blocks show two faces and the grid doesn't read as a checkerboard). Blocks
 * thin out and get lower away from `layout.core`; each area sits in a slightly taller district;
 * the foreground stays low so it reads as dark silhouette; the corridors between consecutive areas
 * (the future activity loop) stay low-rise. Deterministic per seed. Returns world-space buildings
 * (with the grid yaw), streetlight positions along avenues, and the grid frame for ground.js.
 */
export function generateCity({ seed = 7, layout } = {}) {
  const rnd = mulberry32(seed);
  const { field, areas, core, frontZ, gridAngle: angle } = layout;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  // Grid frame (u, v) ↔ world (x, z); matches three.js rotation.y = angle.
  const toWorld = (u, v) => [u * cos + v * sin, -u * sin + v * cos];
  const toGrid = (x, z) => [x * cos - z * sin, x * sin + z * cos];
  const inField = (x, z) => x > field.minX && x < field.maxX && z > field.minZ && z < field.maxZ;
  const coreFalloff = (x, z) => Math.exp(-(((x - core.x) / core.rx) ** 2 + ((z - core.z) / core.rz) ** 2));
  const loop = areas.map((a, i) => [a, areas[(i + 1) % areas.length]]);

  const corners = [[field.minX, field.minZ], [field.maxX, field.minZ], [field.minX, field.maxZ], [field.maxX, field.maxZ]].map(([x, z]) => toGrid(x, z));
  const [u0, u1] = [Math.min(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[0]))];
  const [v0, v1] = [Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[1]))];
  const i0 = Math.floor(u0 / PITCH), i1 = Math.ceil(u1 / PITCH), j0 = Math.floor(v0 / PITCH), j1 = Math.ceil(v1 / PITCH);

  const buildings = [];
  for (let i = i0; i < i1; i++) {
    for (let j = j0; j < j1; j++) {
      const bu = i * PITCH + STREET / 2, bv = j * PITCH + STREET / 2; // block's low corner, grid frame
      const [cx, cz] = toWorld(bu + BLOCK / 2, bv + BLOCK / 2);
      if (!inField(cx, cz)) continue;
      const density = coreFalloff(cx, cz);
      if (rnd() > 0.04 + 0.8 * density) continue; // open block: park, lot, plaza
      const nu = [1, 2, 2, 3][Math.floor(rnd() * 4)], nv = rnd() < 0.5 ? 1 : 2;
      const lu = BLOCK / nu, lv = BLOCK / nv;
      for (let a = 0; a < nu; a++) {
        for (let b = 0; b < nv; b++) {
          if (rnd() < 0.14) continue;
          const inset = 3 + rnd() * 7;
          const w = lu - inset * 2, d = lv - inset * 2;
          const [x, z] = toWorld(bu + a * lu + lu / 2, bv + b * lv + lv / 2);
          if (!inField(x, z)) continue;
          const half = Math.hypot(w, d) / 2;
          if (areas.some((ar) => Math.hypot(x - ar.x, z - ar.z) < LANDMARK.clearRadius + half)) continue;

          const district = areas.reduce((s, ar) => s + Math.exp(-((x - ar.x) ** 2 + (z - ar.z) ** 2) / (2 * 380 * 380)), 0);
          let h = 9 + rnd() * 20 + density * rnd() * 34 + district * rnd() * 14;
          if (rnd() < 0.05 + 0.08 * density) h += 30 + rnd() * 40; // occasional mid-rise
          if (z > frontZ) h = Math.min(h, 8 + rnd() * 18); // low, dark foreground
          if (loop.some(([p, q]) => segDist(x, z, p, q) < CORRIDOR + half)) h = Math.min(h, 10 + rnd() * 12);
          h = Math.min(h, LANDMARK.tower.h * (district > 0.35 ? 0.5 : 0.8)); // landmarks stand clear of their neighbors
          buildings.push({ x, z, w, d, h, rot: angle, seed: rnd() });
        }
      }
    }
  }

  // Streetlights: both sides of each avenue, only where the city is, with gaps.
  const lights = [];
  const side = STREET / 2 - 4;
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      for (let k = 0; k < 4; k++) {
        const t = (k + 0.5) * (PITCH / 4);
        const cand = [];
        if (((i % AVENUE_EVERY) + AVENUE_EVERY) % AVENUE_EVERY === 0) cand.push([i * PITCH - side, j * PITCH + t], [i * PITCH + side, j * PITCH + t]);
        if (((j % AVENUE_EVERY) + AVENUE_EVERY) % AVENUE_EVERY === 0) cand.push([i * PITCH + t, j * PITCH - side], [i * PITCH + t, j * PITCH + side]);
        for (const [u, v] of cand) {
          const [x, z] = toWorld(u, v);
          if (!inField(x, z) || rnd() > 0.08 + 0.34 * coreFalloff(x, z)) continue;
          lights.push([x, z]);
        }
      }
    }
  }

  return { buildings, lights, grid: { angle, pitch: PITCH, street: STREET, avenueEvery: AVENUE_EVERY } };
}
