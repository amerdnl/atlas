/** How long a lost connection is tolerated before the role districts stop claiming any state. */
export const OFFLINE_GRACE_MS = 4000;

/**
 * Subscribes the scene to the authoritative ATLAS runtime (in the collector). Every (re)connect
 * starts with a `sync` — the recent event log plus the current snapshot — which rebuilds the visual
 * state from scratch: the log is replayed at its original timestamps (so finished handoffs and
 * completed roles are already over, and only still-running ones animate), then the snapshot
 * corrects anything the log doesn't cover. After that, live events are applied in `seq` order.
 *
 * If the runtime goes away (collector stopped or restarted, network gone) the last known state is
 * not trusted: after a short grace everything role-specific fades out until the next sync.
 * The browser never runs a workflow engine for real tasks and never launches anything.
 */
export function connectWorkflow(visuals, { url = '/api/workflow/events', onChange = () => {}, EventSourceImpl = globalThis.EventSource, now = () => Date.now() } = {}) {
  const es = new EventSourceImpl(url); // reconnects by itself; each reconnect delivers a fresh sync
  let offline = null;
  const online = () => { if (offline) { clearTimeout(offline); offline = null; } };
  es.addEventListener('sync', (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    online();
    visuals.reset();
    for (const ev of data.events ?? []) visuals.apply(ev);
    visuals.seed(data.snapshot);
    onChange();
  });
  es.onmessage = (e) => {
    try { visuals.apply(JSON.parse(e.data)); onChange(); } catch { /* ignore a bad frame */ }
  };
  es.onerror = () => {
    if (offline) return;
    offline = setTimeout(() => { offline = null; visuals.settle(now()); onChange(); }, OFFLINE_GRACE_MS);
  };
  return () => { online(); es.close(); };
}
