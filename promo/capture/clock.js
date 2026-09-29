// Injected before the scene loads: a virtual clock the capture script steps one frame at a time,
// and a fake EventSource so the capture can serve scripted collector stats.
(() => {
  let now = 0, nextId = 1;
  const realRaf = window.requestAnimationFrame.bind(window);
  let rafs = [];
  const timers = new Map();
  const epoch = Date.parse('2026-09-28T22:30:00');
  performance.now = () => now;
  Date.now = () => epoch + now;
  window.requestAnimationFrame = (cb) => { rafs.push(cb); return rafs.length; };
  window.cancelAnimationFrame = () => {};
  const add = (cb, ms, args, every) => { const id = nextId++; timers.set(id, { at: now + (ms || 0), cb: () => cb(...args), every }); return id; };
  window.setTimeout = (cb, ms, ...args) => add(cb, ms, args, 0);
  window.setInterval = (cb, ms, ...args) => add(cb, ms, args, Math.max(1, ms || 0));
  window.clearTimeout = window.clearInterval = (id) => timers.delete(id);

  window.EventSource = class { constructor() { window.__es = this; } close() {} };

  window.__capture = {
    push(stats) { window.__es?.onmessage?.({ data: JSON.stringify(stats) }); },
    // Advance the clock, fire due timers, run one animation frame, then wait for a real paint.
    step(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at > now) continue;
        if (t.every) t.at += t.every; else timers.delete(id);
        t.cb();
      }
      const cbs = rafs; rafs = [];
      for (const cb of cbs) cb(now);
      return new Promise((r) => realRaf(() => realRaf(r)));
    },
  };
})();
