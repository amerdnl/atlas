import { Easing, interpolate } from 'remotion';

export const E = {
  out: Easing.bezier(0.16, 1, 0.3, 1),
  outSoft: Easing.bezier(0.22, 1, 0.36, 1),
  in: Easing.bezier(0.7, 0, 0.84, 0),
  inOut: Easing.bezier(0.87, 0, 0.13, 1),
  smooth: Easing.bezier(0.65, 0, 0.35, 1),
  cam: Easing.bezier(0.48, 0.1, 0.0, 0.9),
  linear: (t: number) => t,
};
type Ease = (t: number) => number;

export const tw = (f: number, from: number, to: number, a: number, b: number, ease: Ease = E.out) =>
  interpolate(f, [from, to], [a, b], { easing: ease, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
export const prog = (f: number, from: number, to: number, ease: Ease = E.out) => tw(f, from, to, 0, 1, ease);
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Attack–decay envelope that peaks `attack` frames after t = 0. */
export const hit = (t: number, attack = 2, tau = 6) =>
  t <= 0 || t > attack + 6 * tau ? 0 : t < attack ? Math.sin((t / attack) * (Math.PI / 2)) : Math.exp(-(t - attack) / tau);

/** Keyframed values: each key holds `v`, eased toward the next key over its span. */
export function keys<T extends Record<string, number>>(f: number, ks: { f: number; v: T; ease?: Ease }[]): T {
  if (f <= ks[0].f) return ks[0].v;
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i], z = ks[i + 1];
    if (f <= z.f) {
      const t = prog(f, a.f, z.f, z.ease ?? E.cam);
      return Object.fromEntries(Object.keys(a.v).map((k) => [k, mix(a.v[k], z.v[k], t)])) as T;
    }
  }
  return ks[ks.length - 1].v;
}
