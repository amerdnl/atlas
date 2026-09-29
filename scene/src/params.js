/** Slice geometry etc. from the URL; without params the window is the whole canvas. */
export function readParams(search, win) {
  const q = new URLSearchParams(search);
  const num = (k, d) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
  const w = num('w', win.w), h = num('h', win.h);
  return {
    fullW: num('fullW', w), fullH: num('fullH', h), x: num('x', 0), y: num('y', 0), w, h,
    fps: num('fps', 60), overlay: q.get('overlay') !== '0', demo: q.get('demo') === '1', seed: num('seed', 7),
    forceActivity: num('a', -1), layout: q.get('layout'),
  };
}
