/**
 * City compositions per canvas shape. Each one frames downtown on the left-most (overlay)
 * display and fits the secondary clusters and the highway into the space that setup has.
 * World coordinates: camera looks toward -z, x < 0 is left.
 */
export const LAYOUTS = {
  // One display (16:9, 16:10, 21:9 ultrawide): a slightly wider lens so the whole skyline fits.
  single: {
    camera: { fov: 16, position: [0, 2600, 1700], lookAt: [0, 0, -250] },
    centers: [
      { x: -260, z: -260, r: 300, w: 1.0 },  // downtown (left of center)
      { x: 520, z: -700, r: 200, w: 0.45 },  // small cluster (upper right)
    ],
    highway: { ax: -260, az: 900, bx: 1640, bz: -1500, width: 26 },
    streams: { box: { minX: -1500, maxX: 1500, minZ: -1300, maxZ: 500 }, street: 320, highway: 90 },
  },
  // Two displays side by side (or a 32:9 super-ultrawide): downtown left, cluster + highway right.
  dual: {
    camera: { fov: 13, position: [0, 2600, 1700], lookAt: [0, 0, -250] },
    centers: [
      { x: -680, z: -220, r: 320, w: 1.0 },  // downtown (left display)
      { x: 420, z: -420, r: 230, w: 0.5 },   // secondary cluster (right display)
    ],
    highway: { ax: 100, az: 900, bx: 1760, bz: -1500, width: 26 },
    streams: { box: { minX: -2100, maxX: 2100, minZ: -1300, maxZ: 500 }, street: 500, highway: 120 },
  },
  // Three displays side by side: the original panorama.
  triple: {
    camera: { fov: 13, position: [0, 2600, 1700], lookAt: [0, 0, -250] },
    centers: [
      { x: -1250, z: -200, r: 340, w: 1.0 },  // downtown (left display)
      { x: -50, z: -350, r: 240, w: 0.5 },    // secondary cluster (middle)
      { x: 1250, z: -250, r: 220, w: 0.4 },   // small cluster (right)
    ],
    highway: { ax: -300, az: 900, bx: 3400, bz: -1500, width: 26 },
    streams: { box: { minX: -3000, maxX: 3000, minZ: -1300, maxZ: 500 }, street: 700, highway: 140 },
  },
};

/** An explicit `name` wins; otherwise pick by canvas aspect (one 16:9 display ≈ 1.78). */
export function pickLayout(aspect, name) {
  if (name && LAYOUTS[name]) return name;
  return aspect < 2.7 ? 'single' : aspect < 4.4 ? 'dual' : 'triple';
}
