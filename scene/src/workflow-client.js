/**
 * Subscribes the scene to the authoritative ATLAS runtime (in the collector). Every (re)connect
 * starts with a `sync` — snapshot plus the recent event log — which rebuilds the visual state from
 * scratch; after that, live workflow events are applied in `seq` order. Visuals are a function of
 * event timestamps, so every display (and every reload) converges on the same frame. The browser
 * never runs a workflow engine for real tasks and never launches anything.
 */
export function connectWorkflow(visuals, { url = '/api/workflow/events' } = {}) {
  const es = new EventSource(url); // reconnects by itself; each reconnect delivers a fresh sync
  es.addEventListener('sync', (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    visuals.reset();
    visuals.seed(data.snapshot);
    for (const ev of data.events) visuals.apply(ev);
  });
  es.onmessage = (e) => {
    try { visuals.apply(JSON.parse(e.data)); } catch { /* ignore a bad frame */ }
  };
  return () => es.close();
}
