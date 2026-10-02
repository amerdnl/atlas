import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../../collector/src/server.js';
import { createApi } from '../api.js';
import { createRuntime } from '../runtime.js';
import { createFakeBackend } from '../backends/fake.js';
import { PreflightError } from '../project.js';

const TOKEN = 'a'.repeat(48);
const OK = {
  planning: { status: 'complete', summary: 's', goal: 'g', acceptanceCriteria: ['c'] },
  research: { status: 'complete', summary: 's', findings: [], relevantFiles: [] },
};

async function withApi(fn, { respond } = {}) {
  const backend = createFakeBackend({ respond: respond ?? ((c) => (c.stage === 'research' ? 'hang' : { ok: true, structured: OK[c.stage] })) });
  const runtime = createRuntime({
    backend,
    preflight: async (cwd) => { if (cwd === '/dirty') throw new PreflightError('dirty', 'has uncommitted changes'); return { cwd, root: cwd, branch: 'main', head: 'abc', dirtyAtStart: [] }; },
    changesSince: async () => ({ status: [], diffStat: '' }),
  });
  // The API needs the port (for its Host check), which is only known after listen.
  let api = null;
  const { server } = createServer({ getStats: () => ({}), sceneDir: null, routes: (...a) => api.route(...a) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  api = createApi({ runtime, token: TOKEN, port, getActivity: () => [{ key: '-x', session: 'external' }] });
  try {
    await fn({ port, runtime, backend });
  } finally {
    api.close();
    await runtime.shutdown();
    server.closeAllConnections();
    server.close();
  }
}

/** Raw HTTP so tests can set any Host/Origin header. */
function req(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const task = { request: 'Add multiply', cwd: '/fixture' };

test('reads work locally, with no CORS headers; a foreign Host (DNS rebinding) is refused', () => withApi(async ({ port }) => {
  const ok = await req(port, 'GET', '/api/workflow');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['access-control-allow-origin'], undefined, 'other origins cannot read workflow state');
  assert.deepEqual(Object.keys(ok.body), ['snapshot', 'events']);
  assert.equal((await req(port, 'GET', '/api/workflow', { headers: { host: 'localhost:' + port } })).status, 200);
  assert.equal((await req(port, 'GET', '/api/workflow', { headers: { host: `evil.example:${port}` } })).status, 403);
  assert.equal((await req(port, 'GET', '/api/nope')).status, 401, 'unknown paths reveal nothing without the token');
  assert.equal((await req(port, 'GET', '/api/nope', { headers: auth })).status, 404);
}));

test('starting or cancelling work needs the token and must not come from a browser', () => withApi(async ({ port, backend }) => {
  assert.equal((await req(port, 'POST', '/api/tasks', { body: task })).status, 401);
  assert.equal((await req(port, 'POST', '/api/tasks', { headers: { authorization: 'Bearer wrong' }, body: task })).status, 401);
  assert.equal((await req(port, 'POST', '/api/tasks', { headers: { ...auth, origin: 'https://evil.example' }, body: task })).status, 403);
  assert.equal(backend.calls.length, 0, 'nothing was launched');
  const created = await req(port, 'POST', '/api/tasks', { headers: auth, body: task });
  assert.equal(created.status, 201);
  assert.match(created.body.taskId, /^t-/);
  assert.equal(created.body.project.cwd, '/fixture');
}));

test('errors map to clear status codes', () => withApi(async ({ port }) => {
  assert.equal((await req(port, 'POST', '/api/tasks', { headers: auth, body: '{not json' })).status, 400);
  assert.equal((await req(port, 'POST', '/api/tasks', { headers: auth, body: { cwd: '/fixture' } })).status, 400);
  const dirty = await req(port, 'POST', '/api/tasks', { headers: auth, body: { ...task, cwd: '/dirty' } });
  assert.deepEqual([dirty.status, dirty.body.code], [422, 'dirty']);
  assert.equal((await req(port, 'POST', '/api/tasks', { headers: auth, body: task })).status, 201);
  assert.equal((await req(port, 'POST', '/api/tasks', { headers: auth, body: task })).status, 409, 'one task per project');
  assert.equal((await req(port, 'GET', '/api/tasks/t-missing', { headers: auth })).status, 404);
}));

test('the event stream starts with a sync, then streams live events in order; cancel works over HTTP', () => withApi(async ({ port, backend }) => {
  const { taskId } = (await req(port, 'POST', '/api/tasks', { headers: auth, body: task })).body;
  const got = [];
  const res = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/api/workflow/events', headers: { host: `127.0.0.1:${port}` } }, resolve));
  const blocks = [];
  let buf = '';
  res.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) { blocks.push(buf.slice(0, i)); buf = buf.slice(i + 2); }
  });
  while (!blocks.length) await new Promise((r) => setTimeout(r, 5));
  assert.match(blocks[0], /^event: sync\ndata: /);
  const sync = JSON.parse(blocks[0].split('\ndata: ')[1]);
  assert.ok(sync.events.some((e) => e.type === 'task_created' && e.taskId === taskId));
  while (backend.calls.length < 2) await new Promise((r) => setTimeout(r, 5));
  const cancelled = await req(port, 'POST', `/api/tasks/${taskId}/cancel`, { headers: auth });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.task.stage, 'cancelled');
  while (!blocks.some((b) => b.includes('task_cancelled'))) await new Promise((r) => setTimeout(r, 5));
  for (const b of blocks.slice(1)) if (b.startsWith('data: ')) got.push(JSON.parse(b.slice(6)));
  const seqs = [...sync.events, ...got].map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'ordered');
  assert.equal(new Set(seqs).size, seqs.length, 'no duplicates');
  res.destroy();
}));

test('/api/activity splits Claude activity into managed (with role) and unmanaged (no role)', () => withApi(async ({ port }) => {
  const a = await req(port, 'GET', '/api/activity', { headers: auth });
  assert.deepEqual(a.body, { managed: [], unmanaged: [{ key: '-x', session: 'external', managed: false, role: null, taskId: null, sessionId: null }] });
}));

test('task details and history need the token; the city stream does not', () => withApi(async ({ port }) => {
  for (const p of ['/api/tasks', '/api/history', '/api/runtime', '/api/tasks/t-x']) assert.equal((await req(port, 'GET', p)).status, 401, p);
  assert.equal((await req(port, 'GET', '/api/history', { headers: { ...auth, origin: 'https://evil.example' } })).status, 403);
  const h = await req(port, 'GET', '/api/history?limit=5', { headers: auth });
  assert.deepEqual([h.status, Array.isArray(h.body)], [200, true]);
}));

test('intervention over HTTP: respond, resume, fail; duplicate requestId returns the same task', () => withApi(async ({ port, runtime }) => {
  const body = { ...task, requestId: 'req-api-00000001' };
  const first = await req(port, 'POST', '/api/tasks', { headers: auth, body });
  const again = await req(port, 'POST', '/api/tasks', { headers: auth, body });
  assert.deepEqual([first.status, again.status, again.body.taskId, again.body.duplicate], [201, 200, first.body.taskId, true]);
  const id = first.body.taskId;
  await runtime.whenDone(id);
  assert.equal((await req(port, 'GET', `/api/tasks/${id}`, { headers: auth })).body.task.status, 'blocked');
  assert.equal((await req(port, 'POST', `/api/tasks/${id}/respond`, { headers: auth, body: {} })).status, 400);
  const r = await req(port, 'POST', `/api/tasks/${id}/respond`, { headers: auth, body: { response: 'Use node --test' } });
  assert.equal(r.body.task.pause.response, 'Use node --test');
  const f = await req(port, 'POST', `/api/tasks/${id}/fail`, { headers: auth, body: { reason: 'not needed' } });
  assert.deepEqual([f.status, f.body.task.stage], [200, 'failed']);
  assert.equal((await req(port, 'POST', `/api/tasks/${id}/resume`, { headers: auth, body: {} })).status, 409);
}, { respond: (c) => ({ ok: true, structured: { status: 'blocked', summary: 'which runner?', question: 'Which test runner?' } }) }));
