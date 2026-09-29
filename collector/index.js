#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { TokenCounter } from './src/tokens.js';
import { runHerdr, scanClaudeActivity } from './src/agents.js';
import { collect } from './src/stats.js';
import { createServer } from './src/server.js';
import { createRuntime } from '../orchestrator/runtime.js';
import { createApi } from '../orchestrator/api.js';
import { createClaudeBackend } from '../orchestrator/backends/claude.js';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 1 ? process.argv[i + 1] : undefined; };
const config = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/atlas/config.json'), 'utf8')); } catch { return {}; }
})();

const port = Number(arg('port') ?? config.port ?? 47823);
const sceneDir = path.resolve(arg('scene') ?? config.sceneDir ?? path.join(import.meta.dirname, '..', 'scene'));
const claudeRoot = config.claudeProjectsDir ?? path.join(os.homedir(), '.claude', 'projects');
const herdrBin = config.herdrPath ?? 'herdr';
const counter = new TokenCounter({ root: claudeRoot, includeCacheRead: config.includeCacheRead ?? true });

let stats = { source: 'starting', working: 0, subagents: 0, projects: 0, keys: [], tokensToday: 0, tokensPerMin: 0, updatedAt: Date.now() };
const workflowDir = path.join(import.meta.dirname, '..', 'workflow');
const log = (...a) => console.log('[atlas]', ...a);

// The one authoritative ATLAS runtime (workflow engine + managed Claude sessions) lives here, in the
// single collector process — never in the wallpaper pages, which only subscribe to it.
const stateDir = path.resolve(arg('state-dir') ?? config.stateDir ?? path.join(os.homedir(), '.config', 'atlas'));
const orch = config.orchestration ?? {};
const backend = createClaudeBackend({
  bin: orch.claudePath ?? 'claude', model: orch.model ?? null, maxBudgetUsd: orch.maxBudgetUsd ?? 3,
  timeoutMs: (orch.sessionTimeoutMin ?? 20) * 60_000, log: (m) => log(m),
});
const runtime = createRuntime({
  backend, stateDir, log: (m) => log(m), maxQaAttempts: orch.maxQaAttempts ?? 3,
  atlasRoot: path.resolve(import.meta.dirname, '..'),
});
const token = crypto.randomBytes(24).toString('hex');
const runtimeFile = path.join(stateDir, 'runtime.json');
const api = createApi({ runtime, token, port, getActivity: () => scanClaudeActivity(claudeRoot, Date.now()).active });
const { server, broadcast, ping } = createServer({ getStats: () => stats, sceneDir, workflowDir, routes: api.route });

function removeRuntimeFile() {
  try { if (JSON.parse(fs.readFileSync(runtimeFile, 'utf8')).pid === process.pid) fs.unlinkSync(runtimeFile); } catch { /* not ours / gone */ }
}
let stopping = false;
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  api.close();
  await runtime.shutdown('ATLAS stopped');
  process.exit(code);
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('exit', () => { backend.killAllSync(); removeRuntimeFile(); });

let lastSource = null;
async function tick() {
  try {
    const next = await collect({ herdr: () => runHerdr(herdrBin), claudeRoot, counter, nowMs: Date.now() });
    if (next.source !== lastSource) { lastSource = next.source; log(`agent source: ${next.source}`); }
    const changed = JSON.stringify({ ...next, updatedAt: 0 }) !== JSON.stringify({ ...stats, updatedAt: 0 });
    stats = next;
    if (changed) broadcast(stats);
  } catch (e) {
    console.error('[atlas] tick failed:', e.message);
  }
  setTimeout(tick, 2000);
}

server.on('error', (e) => {
  console.error(`[atlas] ${e.message}`);
  process.exit(e.code === 'EADDRINUSE' ? 3 : 1);
});
server.listen(port, '127.0.0.1', () => {
  log(`serving http://127.0.0.1:${port}/ (scene: ${sceneDir})`);
  // Only the process that owns the port publishes a token (a second instance exits with code 3 above).
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(runtimeFile, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
  log(`orchestration API ready (state: ${stateDir})`);
  tick();
  setInterval(ping, 15_000);
});

// When launched by the app, exit if the app goes away (we get re-parented to launchd).
if (process.env.ATLAS_PARENT) setInterval(() => { if (process.ppid === 1) shutdown(0); }, 5000);
