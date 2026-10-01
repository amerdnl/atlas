/**
 * The reference wallpaper's map: where each ATLAS district is in the reference art, what its
 * role-colored light looks like, where labels and handoff paths attach, and how the art is
 * cropped onto a canvas of any shape. Pure (no DOM, no WebGL) so tests can check it.
 *
 * Coordinates are reference pixels (the 1672×941 art, x right, y down). The art shows every
 * district lit; the scene neutralizes each district's role color at idle and brings it back
 * through these masks when that role is active.
 */
export const REF = Object.freeze({ width: 1672, height: 941, src: 'assets/reference/atlas-reference.png' });

/**
 * Per district: soft ellipses `[cx, cy, rx, ry, strength]` covering its buildings and their light
 * on the water (a district, never a single tower); `label` (above the signature tower) and `path`
 * (the district's light center) anchors; and the hue window that identifies its colored light
 * (`minValue` keeps the research blues apart from the navy sky and water).
 */
export const DISTRICTS = Object.freeze({
  operations: {
    blobs: [[215, 590, 78, 60, 1], [175, 566, 32, 48, 1], [100, 610, 62, 28, 1], [176, 626, 42, 24, 1], [335, 634, 96, 28, 1], [332, 584, 42, 32, 1], [292, 650, 70, 22, 1], [318, 702, 78, 34, 0.8]],
    label: [208, 528], path: [222, 592],
    hue: [-100, 52], minSat: 0.18, minValue: 0.08, // wraps through red, rose and the plum facades
  },
  research: {
    blobs: [[571, 545, 15, 52, 1], [612, 580, 34, 26, 1], [520, 572, 46, 34, 1], [560, 602, 88, 16, 1], [500, 640, 52, 18, 0.7]],
    label: [571, 492], path: [576, 578],
    hue: [198, 236], minSat: 0.3, minValue: 0.36,
  },
  developer: {
    blobs: [[1214, 572, 16, 58, 1], [1214, 612, 26, 16, 1], [1165, 614, 52, 30, 1], [1265, 600, 52, 28, 1], [1320, 612, 17, 23, 1], [1180, 641, 72, 14, 1], [1150, 690, 42, 15, 0.6]],
    label: [1214, 518], path: [1214, 602],
    hue: [88, 192], minSat: 0.12, minValue: 0.14,
  },
  qa: {
    blobs: [[1555, 590, 23, 52, 1], [1565, 628, 24, 24, 1], [1545, 642, 30, 16, 1], [1500, 620, 50, 28, 1], [1445, 625, 46, 28, 1], [1615, 626, 34, 27, 1], [1500, 652, 96, 16, 1]],
    label: [1518, 528], path: [1520, 612],
    hue: [241, 318], minSat: 0.3, minValue: 0.15,
  },
});
export const ROLE_ORDER = Object.freeze(['operations', 'research', 'developer', 'qa']);

const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/** One soft ellipse: full strength inside its inner 70%, fading to 0 at its edge. */
export function blobValue([cx, cy, rx, ry, strength], x, y) {
  const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
  return strength * (1 - smooth(0.7, 1, d));
}

/** A district's mask at reference pixel (x, y): the strongest of its blobs. */
export function maskValue(role, x, y) {
  let m = 0;
  for (const b of DISTRICTS[role].blobs) m = Math.max(m, blobValue(b, x, y));
  return m;
}

/** HSV of an sRGB color given as 0–255 components: hue in degrees, saturation and value in 0–1. */
export function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx / 255];
}

/** Whether a pixel color is this district's role-colored light (the part neutralized at idle). */
export function isRoleLight(role, r, g, b) {
  const { hue: [h0, h1], minSat, minValue } = DISTRICTS[role];
  let [h, s, v] = hsv(r, g, b);
  if (h0 < 0 && h > 180) h -= 360; // windows that wrap through red
  return h >= h0 && h <= h1 && s >= minSat && v >= minValue;
}

/**
 * How the reference art covers a canvas of fullW × fullH CSS px: uniform scale `s`, offset
 * (`ox`, `oy`) of the art's top-left corner in canvas px. Narrower canvases crop the sides evenly;
 * wider ones (several displays) crop top and bottom, anchored so the skyline's top stays in view.
 * The whole canvas shares this one mapping — each display renders its own slice of it.
 */
export function coverView(fullW, fullH) {
  // A 1 CSS px overscan so rounding can never leave a hairline of background at an edge.
  const s = Math.max((fullW + 1) / REF.width, (fullH + 1) / REF.height);
  const w = REF.width * s, h = REF.height * s;
  const visibleV = fullH / h; // fraction of the art's height that fits
  // Wider canvases keep the skyline's top in view; the overscan stays split between top and bottom.
  const edge = 0.5 / h;
  const v0 = Math.max(edge, Math.min(1 - visibleV - edge, 0.4 - (visibleV - 0.33) * 0.32));
  return { s, ox: (fullW - w) / 2, oy: -v0 * h, w, h };
}

/** Reference pixel → canvas CSS px, for a cover view. */
export const toCanvas = (view, [x, y]) => [view.ox + x * view.s, view.oy + y * view.s];

const TAU = Math.PI * 2;
/** The working level at which a district shows its full reference light (STATUS_VISUALS.working). */
const FULL = 0.85;

/**
 * How much of a district's own (reference) light shows, from one role's sampled visual state.
 * Writes `out.lit` (0 = neutral idle art, 1 = the reference's lit district), `out.glow` (a little
 * extra of its own light, breathing while working) and `out.warn` (blocked: the light turns a
 * restrained warning red). Idle → all zero. `clock` is wall-clock seconds within the hour.
 */
export function districtLight(r, clock, out) {
  const base = Math.min(1, r.level / FULL);
  const breath = 0.5 + 0.5 * Math.sin((TAU * clock) / 3); // the ~3 s working breathe
  const slow = 0.5 + 0.5 * Math.sin((TAU * clock) / 9); // waiting: slower
  out.lit = base * (1 - 0.14 * r.flow * (1 - breath) - 0.12 * r.wait * (1 - slow));
  out.glow = base * 0.22 * r.flow * breath;
  out.warn = base * r.warn * (0.85 + 0.15 * (0.5 + 0.5 * Math.sin((TAU * clock) / 4)));
  return out;
}

/**
 * Where a district's label goes on the canvas: above its signature tower, nudged sideways if its
 * block (`width` CSS px) would straddle a seam between displays of width `displayW`.
 */
export function labelPosition(view, role, width, fullW, displayW) {
  let [x, y] = toCanvas(view, DISTRICTS[role].label);
  if (displayW > 0 && displayW < fullW) {
    const half = width / 2, gap = 28;
    for (let seam = displayW; seam < fullW - 1; seam += displayW) {
      if (x + half > seam - gap && x - half < seam + gap) x = x < seam ? seam - gap - half : seam + gap + half;
    }
  }
  return [x, y];
}

/** A label block's width in CSS px: the name, or the longest status word ("implementing"). */
export function labelBlockWidth(role, LABEL, label) {
  const { fontPx, letterSpacingEm, dot, padX } = LABEL.labelPx;
  return Math.max(padX * 2 + dot + 6 + label.length * fontPx * (0.72 + letterSpacingEm), LABEL.statusPx.padX * 2 + 12 * LABEL.statusPx.fontPx * 0.62);
}

/**
 * The whole reference layout for the canvas as it is now (`p` = readParams result): where the art
 * quad goes (canvas px, y down) and every label and path anchor. Pure — the scene recomputes it at
 * load and on every resize, so the art always covers the viewport exactly as the canvas is now.
 */
export function referenceLayout(p, { LABEL, labels }) {
  const view = coverView(p.fullW, p.fullH);
  return {
    view,
    art: { x: view.ox, y: view.oy, w: view.w, h: view.h },
    paths: Object.fromEntries(ROLE_ORDER.map((r) => [r, toCanvas(view, DISTRICTS[r].path)])),
    labels: Object.fromEntries(ROLE_ORDER.map((r) => [r, labelPosition(view, r, labelBlockWidth(r, LABEL, labels[r]), p.fullW, p.w)])),
  };
}
