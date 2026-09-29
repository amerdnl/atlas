export function connectStats(onStats, { url = '/events', retryMs = 5000 } = {}) {
  const open = () => {
    const es = new EventSource(url);
    es.onmessage = (e) => { try { onStats(JSON.parse(e.data)); } catch { /* ignore bad frame */ } };
    es.onerror = () => { es.close(); onStats(null); setTimeout(open, retryMs); };
  };
  open();
}
