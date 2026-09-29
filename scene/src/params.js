/** Slice geometry etc. from the URL; without params the window is the whole canvas. */
export function readParams(search, win) {
  const q = new URLSearchParams(search);
  const num = (k, d) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
  const w = num('w', win.w), h = num('h', win.h);
  return {
    fullW: num('fullW', w), fullH: num('fullH', h), x: num('x', 0), y: num('y', 0), w, h,
    fps: num('fps', 60), overlay: q.get('overlay') !== '0', demo: q.get('demo') === '1', seed: num('seed', 7),
    forceActivity: num('a', -1), layout: q.get('layout'),
    // `workflow=demo` plays the workflow demo on the landmarks (demo=1 implies it, with fake HUD stats too).
    // `demoAt=S` starts this page S seconds into the demo loop — a review/screenshot aid.
    // `freeze=1` (with demoAt) pins the clock there: every visual is a function of time, so this renders that exact moment.
    workflowDemo: q.get('demo') === '1' || q.get('workflow') === 'demo', demoAt: num('demoAt', -1), freeze: q.get('freeze') === '1',
  };
}
