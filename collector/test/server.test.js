import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createServer } from '../src/server.js';

const scene = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-scene-'));
fs.writeFileSync(path.join(scene, 'index.html'), '<h1>hi</h1>');

async function withServer(fn) {
  const { server, broadcast } = createServer({ getStats: () => ({ working: 1 }), sceneDir: scene });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`, broadcast); } finally { server.closeAllConnections(); server.close(); }
}

test('GET /stats returns JSON', () => withServer(async (base) => {
  const r = await fetch(`${base}/stats`);
  assert.deepEqual(await r.json(), { working: 1 });
}));

test('GET / serves index.html', () => withServer(async (base) => {
  const r = await fetch(`${base}/`);
  assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await r.text(), '<h1>hi</h1>');
}));

test('path traversal is refused', () => withServer(async (base) => {
  const r = await fetch(`${base}/..%2fetc%2fpasswd`);
  assert.equal(r.status, 403);
}));

test('/events sends current stats then broadcasts', () => withServer((base, broadcast) => new Promise((resolve, reject) => {
  http.get(`${base}/events`, (res) => {
    let buf = '';
    res.on('data', (d) => {
      buf += d;
      const msgs = buf.split('\n\n').filter(Boolean);
      if (msgs.length === 1) broadcast({ working: 2 });
      if (msgs.length === 2) {
        assert.equal(msgs[0], 'data: {"working":1}');
        assert.equal(msgs[1], 'data: {"working":2}');
        res.destroy(); resolve();
      }
    });
  }).on('error', reject);
})));

test('collector exits with code 3 when the port is in use', async () => {
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const port = blocker.address().port;
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'index.js'), '--port', String(port), '--scene', scene]);
    p.on('exit', resolve);
  });
  blocker.close();
  assert.equal(code, 3);
});
