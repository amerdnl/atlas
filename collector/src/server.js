import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
};

/**
 * GET /stats (JSON), GET /events (SSE), anything `routes` claims (the orchestration API), /workflow/*
 * static files from `workflowDir` (the pure workflow modules the scene imports), everything else a
 * static file from `sceneDir`.
 */
export function createServer({ getStats, sceneDir, workflowDir, routes = null }) {
  const sceneRoot = sceneDir ? path.resolve(sceneDir) : null;
  const workflowRoot = workflowDir ? path.resolve(workflowDir) : null;
  const clients = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify(getStats()));
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'access-control-allow-origin': '*' });
      res.write(`data: ${JSON.stringify(getStats())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (routes && routes(req, res, url)) return; // e.g. the orchestration API under /api/
    const underWorkflow = url.pathname.startsWith('/workflow/');
    const root = underWorkflow ? workflowRoot : sceneRoot;
    if (!root) { res.writeHead(404); return res.end(); }
    const pathname = underWorkflow ? url.pathname.slice('/workflow'.length) : url.pathname;
    let rel;
    try { rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); } catch { res.writeHead(400); return res.end(); }
    const file = path.join(root, rel);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(buf);
    });
  });
  const send = (msg) => { for (const c of clients) c.write(msg); };
  return {
    server,
    broadcast: (stats) => send(`data: ${JSON.stringify(stats)}\n\n`),
    ping: () => send(': ping\n\n'),
  };
}
