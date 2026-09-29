import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClaudeBackend, claudeArgs, describeTool } from '../backends/claude.js';
import { ROLE_POLICY } from '../prompts.js';
import { schemaFor } from '../contracts.js';

// A stand-in `claude` executable speaking the stream-json protocol, so no real Claude usage is spent.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-fake-claude-'));
const bin = path.join(dir, 'claude');
fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin, env: { CLAUDECODE: process.env.CLAUDECODE ?? null } }));
  const sid = process.argv[process.argv.indexOf(process.argv.includes('--resume') ? '--resume' : '--session-id') + 1];
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const mode = process.env.FAKE_MODE;
  out({ type: 'system', subtype: 'init', session_id: sid, tools: ['Read'] });
  if (mode === 'ok') {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/p/src/math.js' } }] } });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: '{}', structured_output: { status: 'complete', summary: 'done' }, total_cost_usd: 0.12 });
  } else if (mode === 'error') {
    out({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, session_id: sid });
    process.exit(1);
  } else if (mode === 'crash') {
    process.stderr.write('boom: something broke\\n');
    process.exit(2);
  } else if (mode === 'hang') {
    const child = spawn('sleep', ['60'], { stdio: 'ignore' }); // a descendant, like a test runner Claude started
    fs.writeFileSync(process.env.FAKE_PIDS, JSON.stringify({ self: process.pid, child: child.pid }));
    setInterval(() => {}, 1000);
  }
});
`, { mode: 0o755 });

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (cond, ms = 5000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

function run(mode, { policy = ROLE_POLICY.research, onProgress = () => {}, timeoutMs, bin: exe = bin, resume } = {}) {
  const log = path.join(dir, `${mode}-${Math.random().toString(36).slice(2)}.json`);
  const pids = `${log}.pids`;
  const rawLogPath = `${log}.raw.jsonl`;
  const backend = createClaudeBackend({ bin: exe, maxBudgetUsd: 1.5, timeoutMs, killGraceMs: 300, env: { ...process.env, FAKE_MODE: mode, FAKE_LOG: log, FAKE_PIDS: pids, CLAUDECODE: '1' } });
  const handle = backend.start({ backendSessionId: '11111111-2222-3333-4444-555555555555', resume, cwd: dir, system: 'You are the ATLAS Research agent.', prompt: 'Investigate multiply.\nSecond line.', schema: schemaFor('research'), policy, rawLogPath, onProgress });
  return { backend, handle, log: () => JSON.parse(fs.readFileSync(log, 'utf8')), pids: () => JSON.parse(fs.readFileSync(pids, 'utf8')), rawLogPath };
}

test('arguments: assigned session id, schema, role policy; the prompt goes on stdin, never argv; nested-session env removed', async () => {
  const progress = [];
  const r = run('ok', { onProgress: (a) => progress.push(a) });
  const out = await r.handle.done;
  const { argv, stdin, env } = r.log();
  assert.equal(stdin, 'Investigate multiply.\nSecond line.');
  assert.ok(!argv.some((a) => a.includes('Investigate multiply')), 'prompt not visible in the process list');
  const val = (f) => argv[argv.indexOf(f) + 1];
  assert.equal(val('--session-id'), '11111111-2222-3333-4444-555555555555');
  assert.equal(val('--output-format'), 'stream-json');
  assert.deepEqual(JSON.parse(val('--json-schema')), schemaFor('research'));
  assert.equal(val('--max-budget-usd'), '1.5');
  assert.equal(val('--append-system-prompt'), 'You are the ATLAS Research agent.');
  assert.ok(argv.includes('-p') && argv.includes('--restricted') && argv.includes('--strict-mcp-config'));
  assert.ok(argv.includes('Edit') && argv.indexOf('Edit') > argv.indexOf('--disallowedTools'), 'read-only role denies Edit');
  assert.equal(env.CLAUDECODE, null);
  assert.deepEqual(out, { ok: true, structured: { status: 'complete', summary: 'done' }, permissionDenials: [], exitCode: 0, costUsd: 0.12, backendSessionId: '11111111-2222-3333-4444-555555555555' });
  assert.deepEqual(progress, ['reading math.js']);
  assert.ok(fs.readFileSync(r.rawLogPath, 'utf8').includes('"type":"result"'), 'raw stream kept for the run record');
  assert.equal((fs.statSync(r.rawLogPath).mode & 0o777).toString(8), '600');
});

test('arguments: resume uses --resume instead of a new session id; editing roles are not restricted', () => {
  const a = claudeArgs({ resume: 'abc', schema: {}, policy: ROLE_POLICY.developer });
  assert.ok(a.includes('--resume') && !a.includes('--session-id') && !a.includes('--restricted'));
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'acceptEdits');
});

test('failures are reported with a reason: error results, crashes, and a missing binary', async () => {
  const e = await run('error').handle.done;
  assert.equal(e.ok, false);
  assert.match(e.reason, /error_max_budget_usd/);
  const c = await run('crash').handle.done;
  assert.match(c.reason, /exited with code 2: boom: something broke/);
  const m = await run('ok', { bin: path.join(dir, 'no-such-claude') }).handle.done;
  assert.match(m.reason, /could not launch claude \(ENOENT\)/);
});

test('cancellation terminates the whole process group — Claude and what it spawned — and is idempotent', async () => {
  const r = run('hang');
  await waitFor(() => { try { r.pids(); return true; } catch { return false; } });
  const { self, child } = r.pids();
  assert.ok(alive(self) && alive(child));
  r.handle.cancel('Cancelled by user');
  r.handle.cancel('again');
  const out = await r.handle.done;
  assert.deepEqual([out.ok, out.cancelled, out.reason], [false, true, 'Cancelled by user']);
  await waitFor(() => !alive(self) && !alive(child));
  assert.equal(r.backend.liveCount(), 0);
});

test('a session that runs past its time limit is terminated and reported', async () => {
  const r = run('hang', { timeoutMs: 300 });
  const out = await r.handle.done;
  assert.equal(out.ok, false);
  assert.match(out.reason, /timed out/);
  const { self, child } = r.pids();
  await waitFor(() => !alive(self) && !alive(child));
});

test('tool calls become short status text, never full inputs', () => {
  assert.equal(describeTool('Read', { file_path: '/very/long/path/src/math.js' }), 'reading math.js');
  assert.equal(describeTool('Edit', { file_path: '/p/test/math.test.js' }), 'editing math.test.js');
  assert.equal(describeTool('Bash', { command: 'npm test -- --reporter spec && echo done' }), 'running npm test -- --reporter spec…');
  assert.equal(describeTool('Grep', { pattern: 'secret-token' }), 'searching the code');
  assert.equal(describeTool('SomethingElse'), null);
});
