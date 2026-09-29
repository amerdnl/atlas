/**
 * City compositions per canvas shape: a distant, nearly level view of a low-rise night city with
 * sky above it. All coordinates are world space (nothing is rotated after the fact), x right,
 * camera looking toward -z.
 *
 * - `camera`: one shared camera per canvas; each display renders its slice via setViewOffset.
 * - `fog`: view-depth range over which buildings dissolve into the horizon haze.
 * - `gridAngle`: the street grid's rotation relative to the camera, so blocks show two faces.
 * - `core`: ellipse the city is densest inside; occupancy and height fall off beyond it.
 * - `field`: hard bounds for generated blocks. `frontZ`: beyond it, only low dark silhouettes.
 * - `areas`: the four ATLAS locations (identity in atlas-areas.js). Ordered as the future activity
 *   loop (operations → research → developer → qa → operations) so city.js can keep those
 *   corridors low-rise. A shallow "U": front corners, back middle — reads left to right, has depth.
 */
export const LAYOUTS = {
  // One display (16:9, 16:10, 21:9 ultrawide).
  single: {
    camera: { fov: 24, position: [0, 420, 2500], lookAt: [0, 150, -900] },
    fog: { near: 1900, far: 7200 },
    gridAngle: 0.46,
    core: { x: 0, z: -300, rx: 1700, rz: 1300 },
    field: { minX: -3400, maxX: 3400, minZ: -3400, maxZ: 1500 },
    frontZ: 650,
    areas: [
      { key: 'operations', x: -640, z: 210 },
      { key: 'research', x: -330, z: -520 },
      { key: 'developer', x: 330, z: -520 },
      { key: 'qa', x: 640, z: 210 },
    ],
  },
  // Two displays side by side (or a 32:9 super-ultrawide): two areas per display.
  dual: {
    camera: { fov: 22, position: [0, 440, 2700], lookAt: [0, 150, -900] },
    fog: { near: 2100, far: 7800 },
    gridAngle: 0.46,
    core: { x: 0, z: -300, rx: 3000, rz: 1300 },
    field: { minX: -5200, maxX: 5200, minZ: -3500, maxZ: 1600 },
    frontZ: 650,
    areas: [
      { key: 'operations', x: -1280, z: 210 },
      { key: 'research', x: -640, z: -520 },
      { key: 'developer', x: 640, z: -520 },
      { key: 'qa', x: 1280, z: 210 },
    ],
  },
  // Three displays side by side: operations left, research + developer center, qa right.
  triple: {
    camera: { fov: 20, position: [0, 460, 2900], lookAt: [0, 150, -900] },
    fog: { near: 2300, far: 8400 },
    gridAngle: 0.46,
    core: { x: 0, z: -300, rx: 4200, rz: 1300 },
    field: { minX: -6600, maxX: 6600, minZ: -3600, maxZ: 1700 },
    frontZ: 650,
    areas: [
      { key: 'operations', x: -1900, z: 210 },
      { key: 'research', x: -420, z: -520 },
      { key: 'developer', x: 420, z: -520 },
      { key: 'qa', x: 1900, z: 210 },
    ],
  },
};

/**
 * Landmark massing and label sizing, shared by landmarks.js (rendering) and the layout tests
 * (on-screen / clipping checks), so the math and the pixels can't drift apart.
 */
export const LANDMARK = {
  podium: { w: 120, d: 96, h: 34 },
  tower: { w: 64, d: 56, h: 118 },
  mastH: 14,
  clearRadius: 90, // city lots keep at least this far (plus their own half-size) from an area center
  labelGapY: 10, // world units between the mast light and the label's bottom edge
  labelPx: { fontPx: 11, letterSpacingEm: 0.22, height: 20, dot: 7, padX: 6 },
};

/** Conservative label width in CSS px (tests have no canvas to measure with). */
export function labelWidthPx(text) {
  const { fontPx, letterSpacingEm, dot, padX } = LANDMARK.labelPx;
  return padX * 2 + dot + 6 + text.length * fontPx * (0.72 + letterSpacingEm);
}

/** An explicit `name` wins; otherwise pick by canvas aspect (one 16:9 display ≈ 1.78). */
export function pickLayout(aspect, name) {
  if (name && LAYOUTS[name]) return name;
  return aspect < 2.7 ? 'single' : aspect < 4.4 ? 'dual' : 'triple';
}
