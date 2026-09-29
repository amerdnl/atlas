import crypto from 'node:crypto';
import { RuntimeError } from './runtime.js';
import { PreflightError } from './project.js';
import { classifySessions } from './sessions.js';

const MAX_BODY = 64 * 1024;

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new RuntimeError('too_large', 'request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new RuntimeError('invalid_input', 'body must be JSON')); } });
    req.on('error', reject);
  });
}

const STATUS = { invalid_input: 400, too_large: 413, unknown_task: 404, busy_project: 409, stopped: 503 };

/**
 * Local HTTP API for the ATLAS runtime, mounted into the collector's server under /api/.
 *
 *   GET  /api/workflow          snapshot + recent events (JSON)
 *   GET  /api/workflow/events   SSE: `event: sync` (snapshot + events), then one message per workflow event
 *   GET  /api/tasks, /api/tasks/:id
 *   GET  /api/activity          active Claude sessions, split into managed (with role) and unmanaged
 *   POST /api/tasks             { request, cwd, acceptanceCriteria?, allowDirty?, allowSelf? }   (token)
 *   POST /api/tasks/:id/cancel                                                                 (token)
 *
 * Launching Claude from a local endpoint is only safe if web pages can't reach it: /api sends no
 * CORS headers, rejects any Host but 127.0.0.1/localhost on this port (DNS rebinding), and every
 * state-changing call needs the per-run token from runtime.json (0600) and must not come from a
 * browser (no Origin header).
 */
export function createApi({ runtime, token, port, getActivity = () => [] }) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const tokenBuf = Buffer.from(token);
  const authorized = (req) => {
    const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
    return got.length === tokenBuf.length && crypto.timingSafeEqual(got, tokenBuf);
  };
  const streams = new Set();
  const ping = setInterval(() => { for (const res of streams) res.write(': ping\n\n'); }, 15_000);
  ping.unref?.();

  async function handle(req, res, url) {
    if (!hosts.has(req.headers.host)) return json(res, 403, { error: 'forbidden host' });
    const p = url.pathname;
    try {
      if (req.method === 'GET' && p === '/api/workflow') return json(res, 200, runtime.sync());
      if (req.method === 'GET' && p === '/api/workflow/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        // Sync, then subscribe — synchronously back to back, so no event can fall between them.
        res.write(`event: sync\ndata: ${JSON.stringify(runtime.sync())}\n\n`);
        const off = runtime.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
        streams.add(res);
        req.on('close', () => { off(); streams.delete(res); });
        return;
      }
      if (req.method === 'GET' && p === '/api/tasks') return json(res, 200, runtime.listTasks());
      if (req.method === 'GET' && p === '/api/activity') {
        const rows = classifySessions(getActivity(), runtime.managedSessions());
        return json(res, 200, { managed: rows.filter((r) => r.managed), unmanaged: rows.filter((r) => !r.managed) });
      }
      const m = p.match(/^\/api\/tasks\/([\w.-]+)(\/cancel)?$/);
      if (req.method === 'GET' && m && !m[2]) return json(res, 200, runtime.getTask(m[1]));

      if (req.method === 'POST' && (p === '/api/tasks' || (m && m[2]))) {
        if (req.headers.origin) return json(res, 403, { error: 'browser requests cannot start or stop tasks' });
        if (!authorized(req)) return json(res, 401, { error: 'missing or invalid token (see runtime.json)' });
        if (p === '/api/tasks') {
          const body = await readBody(req);
          const out = await runtime.submitTask({
            request: body.request, cwd: body.cwd, acceptanceCriteria: body.acceptanceCriteria ?? [],
            allowDirty: body.allowDirty === true, allowSelf: body.allowSelf === true,
          });
          return json(res, 201, out);
        }
        return json(res, 200, runtime.cancelTask(m[1], 'Cancelled by user'));
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof PreflightError) return json(res, 422, { error: e.message, code: e.code });
      if (e instanceof RuntimeError) return json(res, STATUS[e.code] ?? 400, { error: e.message, code: e.code });
      return json(res, 500, { error: e.message });
    }
  }

  return {
    /** Route handler for the collector server: returns true if it handled the request. */
    route(req, res, url) {
      if (!url.pathname.startsWith('/api/')) return false;
      handle(req, res, url);
      return true;
    },
    close() { clearInterval(ping); for (const res of streams) res.end(); streams.clear(); },
  };
}
