/**
 * Label typography, shared by districts.js (rendering) and the composition tests (on-screen,
 * overlap and seam checks), so the math and the pixels can't drift apart. The scene composition
 * itself lives in world.js.
 */
export { pickLayout } from './world.js';

export const LABEL = {
  gapY: 10, // world units between a district's signature building top and the label block's bottom edge
  labelPx: { fontPx: 10.5, letterSpacingEm: 0.22, height: 19, dot: 6, padX: 6 },
  // Optional short status line under the name, truncated to maxChars.
  statusPx: { fontPx: 9.5, height: 14, maxChars: 26, padX: 6 },
};

/** Conservative width in CSS px of a label block — name, plus the widest possible status line. */
export function labelWidthPx(text) {
  const { fontPx, letterSpacingEm, dot, padX } = LABEL.labelPx;
  const S = LABEL.statusPx;
  return Math.max(padX * 2 + dot + 6 + text.length * fontPx * (0.72 + letterSpacingEm), S.padX * 2 + S.maxChars * S.fontPx * 0.62);
}

/** Height in CSS px of a label block (name above the status line). */
export const labelHeightPx = () => LABEL.labelPx.height + LABEL.statusPx.height;

/** A status line as displayed: single line, truncated with an ellipsis. */
export function statusText(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const max = LABEL.statusPx.maxChars;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
