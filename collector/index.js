#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { TokenCounter } from './src/tokens.js';
import { runHerdr } from './src/agents.js';
import { collect } from './src/stats.js';
import { createServer } from './src/server.js';

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
const { server, broadcast, ping } = createServer({ getStats: () => stats, sceneDir, workflowDir });
const log = (...a) => console.log('[atlas]', ...a);

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
  tick();
  setInterval(ping, 15_000);
});

// When launched by the app, exit if the app goes away (we get re-parented to launchd).
if (process.env.ATLAS_PARENT) setInterval(() => { if (process.ppid === 1) process.exit(0); }, 5000);
