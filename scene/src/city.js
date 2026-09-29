import { LAYOUTS } from './layouts.js';

export function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded street grid with buildings on subdivided lots, dense around the layout's centers.
 * All coordinates are local to a group rotated by `rotation` around Y.
 */
export function generateCity({ seed = 7, layout = LAYOUTS.triple, cols = 120, rows = 70, block = 56, street = 14, rotation = 0.55 } = {}) {
  const { centers, highway: road } = layout;
  const rnd = mulberry32(seed);
  const pitch = block + street;
  const ox = -(cols * pitch) / 2, oz = -(rows * pitch) / 2;
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  const toLocal = (x, z) => ({ x: x * cos - z * sin, z: x * sin + z * cos });
  // Highway: a straight diagonal in world space (toward the upper right), kept clear of buildings.
  const ha = toLocal(road.ax, road.az), hb = toLocal(road.bx, road.bz);
  const highway = { ax: ha.x, az: ha.z, bx: hb.x, bz: hb.z, width: road.width };
  const hLen = Math.hypot(hb.x - ha.x, hb.z - ha.z);
  const onHighway = (x, z, pad) => {
    const t = ((x - ha.x) * (hb.x - ha.x) + (z - ha.z) * (hb.z - ha.z)) / (hLen * hLen);
    const px = ha.x + (hb.x - ha.x) * t, pz = ha.z + (hb.z - ha.z) * t;
    return Math.hypot(x - px, z - pz) < road.width / 2 + pad;
  };
  const density = (lx, lz) => densityWorld(lx * cos + lz * sin, -lx * sin + lz * cos);
  const densityWorld = (x, z) => centers.reduce((s, c) => s + c.w * Math.exp(-((x - c.x) ** 2 + (z - c.z) ** 2) / (2 * c.r * c.r)), 0);
  const buildings = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const bx = ox + i * pitch + street / 2, bz = oz + j * pitch + street / 2;
      const d0 = density(bx + block / 2, bz + block / 2);
      if (d0 < 0.3 && rnd() < 0.07) continue; // park / empty block
      const n = d0 > 0.55 ? 2 : rnd() < 0.5 ? 2 : 3;
      const lot = block / n;
      const district = Math.min(3, Math.floor((i / cols) * 4)) + 4 * (j >= rows / 2 ? 1 : 0);
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) {
          if (rnd() < 0.06) continue;
          const inset = 1.2 + rnd() * 2.3;
          const x = bx + a * lot + lot / 2, z = bz + b * lot + lot / 2;
          if (onHighway(x, z, lot * 0.75)) continue;
          const d = density(x, z);
          const spike = rnd() < 0.06 + d * 0.3 ? 2.2 : 1;
          const h = 6 + rnd() * 9 + d * d * (70 + rnd() * 240) * spike;
          buildings.push({ x, z, w: lot - inset * 2, d: lot - inset * 2, h, seed: rnd(), district });
        }
      }
    }
  }
  return { buildings, grid: { ox, oz, pitch, cols, rows, street, block }, highway, rotation };
}
