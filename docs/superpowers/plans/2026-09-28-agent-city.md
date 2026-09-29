# agent-city Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A macOS live wallpaper — a procedural night city spanning all displays that lights up and fills with Tron-style light streams while AI agents work, with a stats overlay.

**Architecture:** A zero-dependency Node collector polls herdr + Claude Code logs and serves stats (JSON + SSE) and the static Three.js scene on `127.0.0.1:47823`. A Swift menu-bar app creates one desktop-level, click-through `WKWebView` window per display; each renders its slice of one shared camera via `camera.setViewOffset`.

**Tech Stack:** Node ≥20 (`node:test`), Three.js 0.186.1 (vendored, importmap, no bundler), Swift 5.9 / AppKit / WebKit (SwiftPM, no Xcode project), Make.

**Spec:** `docs/superpowers/specs/2026-09-28-agent-city-design.md`

## Global Constraints

- Collector: Node ≥20, zero npm dependencies, binds `127.0.0.1` only, default port `47823`, poll every 2s.
- Scene: plain ES modules, `three` via importmap from `scene/vendor/three/`, no build step.
- App: macOS 13+, `LSUIElement`, windows at `kCGDesktopWindowLevel`, `ignoresMouseEvents = true`.
- herdr statuses: `idle | working | blocked | done | unknown`; only `working` counts.
- Tokens: `input + output + cache_creation (+ cache_read if includeCacheRead, default true)`, deduped by `message.id` (the same id appears on several lines with repeated usage).
- Config file (optional): `~/.config/agent-city/config.json` keys `port`, `includeCacheRead`, `herdrPath`, `claudeProjectsDir`, `sceneDir`.
- Bundle id `io.github.dorukanc.agent-city`; license MIT.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A JSONL line half-written when the collector reads it → counted exactly once after it completes (Task 1 test `partial line`).
2. Collector running across local midnight → "Tokens today" resets to only the new day's usage (Task 1 test `midnight rollover`).
3. Same `message.id` on several lines, usage repeated or growing → counted once, at its largest value (Task 1 test `dedupes`).
4. herdr not installed / exits non-zero / prints non-JSON → silently falls back to Claude-log activity (Task 2 tests `runHerdr missing binary`, `parse garbage`).
5. A collector already listening on the port (dev run, second app instance) → new collector exits code 3 and the app keeps using the existing one, no crash loop (Task 3 test `port in use`; Task 6 handles exit 3).

---

## File Structure

```
package.json                     root: "type": "module", test/dev scripts
Makefile                         vendor / test / dev / app / install / run / clean
collector/package.json           "type": "module" (needed inside the .app bundle)
collector/index.js               entry: config, poll loop, server
collector/src/tokens.js          TokenCounter: incremental JSONL tail, today's total, per-minute
collector/src/agents.js          herdr parsing + Claude-log activity fallback + subagents
collector/src/stats.js           collect(): merges sources into one Stats object
collector/src/server.js          HTTP: /stats, /events (SSE), static scene files
collector/test/*.test.js
scene/index.html, scene/style.css
scene/vendor/three/              three.module.js, three.core.js, addons/{postprocessing,shaders}
scene/src/activity.js            stats → activity/pulse/district boosts, easing (pure)
scene/src/params.js              URL → slice/fps/overlay params (pure)
scene/src/city.js                seeded city generation (pure)
scene/src/format.js              overlay text formatting (pure)
scene/src/demo.js                fake stats timeline (pure)
scene/src/ground.js              ground plane + street shader
scene/src/buildings.js           instanced buildings + window shader
scene/src/streams.js             Tron light-stream ribbons
scene/src/overlay.js             overlay DOM + count-up
scene/src/stats-client.js        EventSource with retry
scene/src/main.js                renderer, camera slice, composer/bloom, loop, window.agentCity API
scene/test/*.test.js
app/Package.swift, app/Info.plist
app/Sources/AgentCity/{main,AppDelegate,SliceLayout,WallpaperWindow,Collector}.swift
README.md, LICENSE
```

Stats object (produced by collector, consumed by scene):

```js
{ source: 'herdr'|'claude'|'demo'|'starting', working: number, subagents: number,
  projects: number, keys: string[] /* project keys of working agents */,
  tokensToday: number, tokensPerMin: number, updatedAt: number }
```

---

### Task 1: Repo scaffolding + TokenCounter

**Files:**
- Create: `package.json`, `collector/package.json`, `Makefile` (test/dev targets only for now)
- Create: `collector/src/tokens.js`
- Test: `collector/test/tokens.test.js`

**Interfaces:**
- Produces: `dayKey(date): string` (local `YYYY-MM-DD`), `usageTotal(usage, includeCacheRead): number`, `listJsonl(root): string[]`, `class TokenCounter({root, includeCacheRead=true, now=()=>new Date()})` with `scan()`, `total: number`, `perMinute: number` (getter).

- [ ] **Step 1: Scaffolding**

`package.json`:
```json
{
  "name": "agent-city",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test 'collector/test/*.test.js' 'scene/test/*.test.js'",
    "dev": "node collector/index.js --scene scene"
  }
}
```
`collector/package.json`:
```json
{ "name": "agent-city-collector", "private": true, "type": "module" }
```
`Makefile`:
```make
.PHONY: test dev
test:
	node --test 'collector/test/*.test.js' 'scene/test/*.test.js'
dev:
	node collector/index.js --scene scene
```

- [ ] **Step 2: Write the failing tests** — `collector/test/tokens.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenCounter, usageTotal, dayKey } from '../src/tokens.js';

const NOW = new Date(2026, 8, 28, 15, 0, 0); // local time
const at = (h, m = 0, s = 0, day = 28) => new Date(2026, 8, day, h, m, s).toISOString();
const line = (id, ts, usage) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, usage } }) + '\n';
const U = (i, o, cc = 0, cr = 0) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cc, cache_read_input_tokens: cr });

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-tokens-'));
  fs.mkdirSync(path.join(root, 'proj'));
  return root;
}
const counter = (root, opts = {}) => new TokenCounter({ root, now: () => opts.now ?? NOW, includeCacheRead: opts.cache ?? true });

test('usageTotal respects includeCacheRead', () => {
  assert.equal(usageTotal(U(1, 2, 3, 100), true), 106);
  assert.equal(usageTotal(U(1, 2, 3, 100), false), 6);
  assert.equal(usageTotal(undefined, true), 0);
});

test('dayKey is local date', () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('sums today, ignores yesterday, skips malformed and non-assistant lines', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'proj', 's.jsonl'),
    line('a', at(10), U(10, 20)) +
    line('y', at(10, 0, 0, 27), U(999, 999)) +
    '{not json\n' +
    JSON.stringify({ type: 'user', timestamp: at(11), message: { usage: U(5, 5) } }) + '\n' +
    line('b', at(12), U(1, 1, 1, 1)));
  const c = counter(root); c.scan();
  assert.equal(c.total, 34);
});

test('dedupes repeated message ids, counting growth once', () => {
  const root = tmpRoot();
  const f = path.join(root, 'proj', 's.jsonl');
  fs.writeFileSync(f, line('a', at(10), U(10, 20)) + line('a', at(10), U(10, 20)));
  const c = counter(root); c.scan();
  assert.equal(c.total, 30);
  fs.appendFileSync(f, line('a', at(10), U(10, 50)));
  c.scan();
  assert.equal(c.total, 60);
});

test('partial line is counted once after completion', () => {
  const root = tmpRoot();
  const f = path.join(root, 'proj', 's.jsonl');
  const full = line('a', at(10), U(10, 20));
  fs.writeFileSync(f, full.slice(0, 25));
  const c = counter(root); c.scan();
  assert.equal(c.total, 0);
  fs.appendFileSync(f, full.slice(25));
  c.scan(); c.scan();
  assert.equal(c.total, 30);
});

test('finds files in nested dirs (subagents)', () => {
  const root = tmpRoot();
  const dir = path.join(root, 'proj', 'sess', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-1.jsonl'), line('x', at(9), U(1, 1)));
  const c = counter(root); c.scan();
  assert.equal(c.total, 2);
});

test('includeCacheRead=false excludes cache reads', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'proj', 's.jsonl'), line('a', at(10), U(1, 1, 1, 1000)));
  const c = counter(root, { cache: false }); c.scan();
  assert.equal(c.total, 3);
});

test('midnight rollover resets the total', () => {
  const root = tmpRoot();
  const f = path.join(root, 'proj', 's.jsonl');
  fs.writeFileSync(f, line('a', at(23, 59), U(10, 10)));
  let now = new Date(2026, 8, 28, 23, 59, 30);
  const c = new TokenCounter({ root, now: () => now });
  c.scan();
  assert.equal(c.total, 20);
  now = new Date(2026, 8, 29, 0, 0, 30);
  fs.appendFileSync(f, line('b', new Date(2026, 8, 29, 0, 0, 10).toISOString(), U(1, 2)));
  c.scan();
  assert.equal(c.total, 3);
});

test('perMinute sums the last 60 seconds by message timestamp', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'proj', 's.jsonl'),
    line('old', at(14, 58), U(100, 0)) + line('new', at(14, 59, 30), U(5, 5)));
  const c = counter(root); c.scan();
  assert.equal(c.perMinute, 10);
});

test('multi-byte characters split across reads survive', () => {
  const root = tmpRoot();
  const f = path.join(root, 'proj', 's.jsonl');
  const obj = JSON.stringify({ type: 'assistant', timestamp: at(10), message: { id: 'u', usage: U(1, 1), content: 'çğü🙂' } }) + '\n';
  const buf = Buffer.from(obj);
  const cut = buf.indexOf(Buffer.from('🙂')) + 2;
  fs.writeFileSync(f, buf.subarray(0, cut));
  const c = counter(root); c.scan();
  fs.appendFileSync(f, buf.subarray(cut));
  c.scan();
  assert.equal(c.total, 2);
});
```

- [ ] **Step 3: Run tests, expect FAIL** — `node --test collector/test/tokens.test.js` → "Cannot find module ../src/tokens.js".

- [ ] **Step 4: Implement** — `collector/src/tokens.js`

```js
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export function dayKey(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function usageTotal(u, includeCacheRead) {
  if (!u) return 0;
  return (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) +
    (includeCacheRead ? u.cache_read_input_tokens || 0 : 0);
}

export function listJsonl(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return out;
}

export class TokenCounter {
  constructor({ root, includeCacheRead = true, now = () => new Date() }) {
    this.root = root;
    this.includeCacheRead = includeCacheRead;
    this.now = now;
    this.files = new Map(); // path -> { offset, rest, decoder }
    this.resetDay(dayKey(now()));
  }

  resetDay(key) {
    this.day = key;
    this.byId = new Map();
    this.total = 0;
    this.events = [];
  }

  ingestLine(text) {
    let o;
    try { o = JSON.parse(text); } catch { return; }
    const msg = o?.message;
    if (o?.type !== 'assistant' || !msg?.usage || !o.timestamp) return;
    const ts = new Date(o.timestamp);
    if (Number.isNaN(ts.getTime()) || dayKey(ts) !== this.day) return;
    const n = usageTotal(msg.usage, this.includeCacheRead);
    const id = msg.id || o.uuid || text;
    const prev = this.byId.get(id) || 0;
    if (n <= prev) return;
    this.byId.set(id, n);
    this.total += n - prev;
    this.events.push({ t: ts.getTime(), n: n - prev });
  }

  ingestFile(file) {
    let st;
    try { st = fs.statSync(file); } catch { return; }
    let rec = this.files.get(file);
    if (!rec) {
      if (dayKey(st.mtime) !== this.day) return;
      rec = { offset: 0, rest: '', decoder: new StringDecoder('utf8') };
      this.files.set(file, rec);
    }
    if (st.size < rec.offset) Object.assign(rec, { offset: 0, rest: '', decoder: new StringDecoder('utf8') });
    if (st.size === rec.offset) return;
    const buf = Buffer.alloc(st.size - rec.offset);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, rec.offset); } finally { fs.closeSync(fd); }
    rec.offset = st.size;
    const lines = (rec.rest + rec.decoder.write(buf)).split('\n');
    rec.rest = lines.pop();
    for (const l of lines) if (l) this.ingestLine(l);
  }

  scan() {
    const key = dayKey(this.now());
    if (key !== this.day) this.resetDay(key);
    for (const f of listJsonl(this.root)) this.ingestFile(f);
    const cutoff = this.now().getTime() - 60_000;
    this.events = this.events.filter((e) => e.t >= cutoff);
  }

  get perMinute() {
    const cutoff = this.now().getTime() - 60_000;
    return this.events.reduce((s, e) => s + (e.t >= cutoff ? e.n : 0), 0);
  }
}
```

- [ ] **Step 5: Run tests, expect PASS** — `node --test collector/test/tokens.test.js`.
- [ ] **Step 6: Commit** — `git add package.json Makefile collector && git commit -m "feat(collector): incremental token counter"`

---

### Task 2: Agent activity sources

**Files:**
- Create: `collector/src/agents.js`
- Test: `collector/test/agents.test.js`

**Interfaces:**
- Produces: `parseHerdrList(text): {total, working, blocked, cwds: string[]}` (throws on bad input); `runHerdr(bin='herdr', timeoutMs=3000): Promise<parsed|null>`; `scanClaudeActivity(root, nowMs, {mainWindowMs=30000, subWindowMs=30000}): {keys: string[], subagents: number}` where `keys` has one entry per active main session (project dir name); `projectKey(s): string` folds worktrees into their repo.

- [ ] **Step 1: Write failing tests** — `collector/test/agents.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHerdrList, runHerdr, scanClaudeActivity, projectKey } from '../src/agents.js';

const herdrJson = (statuses) => JSON.stringify({ id: 'cli:agent:list', result: { type: 'agent_list', agents:
  statuses.map(([s, cwd]) => ({ agent: 'claude', agent_status: s, cwd })) } });

test('parseHerdrList counts only working agents', () => {
  const r = parseHerdrList(herdrJson([['working', '/a'], ['idle', '/b'], ['blocked', '/c'], ['working', '/a/.claude/worktrees/x']]));
  assert.equal(r.total, 4);
  assert.equal(r.working, 2);
  assert.equal(r.blocked, 1);
  assert.deepEqual(r.cwds, ['/a', '/a/.claude/worktrees/x']);
});

test('parseHerdrList throws on garbage', () => {
  assert.throws(() => parseHerdrList('nope'));
  assert.throws(() => parseHerdrList('{"result":{}}'));
});

test('runHerdr returns null for a missing binary', async () => {
  assert.equal(await runHerdr('/nonexistent/herdr'), null);
});

test('runHerdr returns null for non-JSON output', async () => {
  assert.equal(await runHerdr('/bin/echo'), null);
});

test('projectKey folds worktrees into the repo', () => {
  assert.equal(projectKey('/Users/me/app/.claude/worktrees/feat'), '/Users/me/app');
  assert.equal(projectKey('-Users-me-app--claude-worktrees-feat'), '-Users-me-app');
  assert.equal(projectKey('/Users/me/app'), '/Users/me/app');
});

test('scanClaudeActivity finds recent sessions and subagents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-agents-'));
  const now = Date.now();
  const touch = (p, ageMs) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '{}\n'); const t = new Date(now - ageMs); fs.utimesSync(p, t, t); };
  touch(path.join(root, '-a', 's1.jsonl'), 5_000);
  touch(path.join(root, '-a', 's2.jsonl'), 10_000);
  touch(path.join(root, '-b', 's3.jsonl'), 120_000);
  touch(path.join(root, '-a', 's1', 'subagents', 'agent-1.jsonl'), 3_000);
  touch(path.join(root, '-a', 's1', 'subagents', 'agent-2.jsonl'), 4_000);
  touch(path.join(root, '-a', 's1', 'subagents', 'agent-3.jsonl'), 90_000);
  const r = scanClaudeActivity(root, now);
  assert.deepEqual(r.keys.sort(), ['-a', '-a']);
  assert.equal(r.subagents, 2);
});

test('scanClaudeActivity tolerates a missing root', () => {
  assert.deepEqual(scanClaudeActivity('/nonexistent/x', Date.now()), { keys: [], subagents: 0 });
});
```

- [ ] **Step 2: Run, expect FAIL** — `node --test collector/test/agents.test.js`.

- [ ] **Step 3: Implement** — `collector/src/agents.js`

```js
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export function parseHerdrList(text) {
  const agents = JSON.parse(text)?.result?.agents;
  if (!Array.isArray(agents)) throw new Error('unexpected herdr output');
  const working = agents.filter((a) => a.agent_status === 'working');
  return {
    total: agents.length,
    working: working.length,
    blocked: agents.filter((a) => a.agent_status === 'blocked').length,
    cwds: working.map((a) => a.cwd || a.foreground_cwd || ''),
  };
}

export function runHerdr(bin = 'herdr', timeoutMs = 3000) {
  return new Promise((resolve) => {
    execFile(bin, ['agent', 'list'], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(parseHerdrList(stdout)); } catch { resolve(null); }
    });
  });
}

export function projectKey(s) {
  return s.replace(/\/\.claude\/worktrees\/[^/]+\/?$/, '').replace(/--claude-worktrees-.*$/, '');
}

const readdir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
const mtimeMs = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };

export function scanClaudeActivity(root, nowMs, { mainWindowMs = 30_000, subWindowMs = 30_000 } = {}) {
  const keys = [];
  let subagents = 0;
  for (const proj of readdir(root)) {
    if (!proj.isDirectory()) continue;
    const pdir = path.join(root, proj.name);
    for (const e of readdir(pdir)) {
      const full = path.join(pdir, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        if (nowMs - mtimeMs(full) <= mainWindowMs) keys.push(proj.name);
      } else if (e.isDirectory()) {
        const sdir = path.join(full, 'subagents');
        for (const s of readdir(sdir)) {
          if (s.isFile() && s.name.endsWith('.jsonl') && nowMs - mtimeMs(path.join(sdir, s.name)) <= subWindowMs) subagents++;
        }
      }
    }
  }
  return { keys, subagents };
}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(collector): herdr + claude-log agent activity"` (add new files first).

---

### Task 3: Stats merge, HTTP/SSE server, entry point

**Files:**
- Create: `collector/src/stats.js`, `collector/src/server.js`, `collector/index.js`
- Test: `collector/test/stats.test.js`, `collector/test/server.test.js`

**Interfaces:**
- Consumes: `TokenCounter` (Task 1), `runHerdr`, `scanClaudeActivity`, `projectKey` (Task 2).
- Produces: `collect({herdr, claudeRoot, counter, nowMs}): Promise<Stats>`; `createServer({getStats, sceneDir}): {server, broadcast(stats), ping()}`; CLI `node collector/index.js [--scene DIR] [--port N]`, exit code 3 on EADDRINUSE.

- [ ] **Step 1: Write failing tests** — `collector/test/stats.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collect } from '../src/stats.js';

const fakeCounter = { scan() {}, total: 1234, perMinute: 56 };
const emptyRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ac-stats-'));

test('uses herdr when available and folds worktrees into projects', async () => {
  const s = await collect({
    herdr: async () => ({ total: 3, working: 2, blocked: 0, cwds: ['/r', '/r/.claude/worktrees/x'] }),
    claudeRoot: emptyRoot(), counter: fakeCounter, nowMs: 1,
  });
  assert.equal(s.source, 'herdr');
  assert.equal(s.working, 2);
  assert.equal(s.projects, 1);
  assert.deepEqual(s.keys, ['/r']);
  assert.equal(s.tokensToday, 1234);
  assert.equal(s.tokensPerMin, 56);
});

test('falls back to claude logs when herdr returns null', async () => {
  const root = emptyRoot();
  fs.mkdirSync(path.join(root, '-p'));
  fs.writeFileSync(path.join(root, '-p', 's.jsonl'), '{}\n');
  const s = await collect({ herdr: async () => null, claudeRoot: root, counter: fakeCounter, nowMs: Date.now() });
  assert.equal(s.source, 'claude');
  assert.equal(s.working, 1);
  assert.equal(s.projects, 1);
});
```

`collector/test/server.test.js`:
```js
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
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** — `collector/src/stats.js`

```js
import { scanClaudeActivity, projectKey } from './agents.js';

export async function collect({ herdr, claudeRoot, counter, nowMs }) {
  const h = herdr ? await herdr() : null;
  const act = scanClaudeActivity(claudeRoot, nowMs);
  counter.scan();
  const rawKeys = h ? h.cwds : act.keys;
  const keys = [...new Set(rawKeys.map(projectKey))];
  return {
    source: h ? 'herdr' : 'claude',
    working: h ? h.working : act.keys.length,
    subagents: act.subagents,
    projects: keys.length,
    keys,
    tokensToday: counter.total,
    tokensPerMin: counter.perMinute,
    updatedAt: nowMs,
  };
}
```

`collector/src/server.js`:
```js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
};

export function createServer({ getStats, sceneDir }) {
  const root = sceneDir ? path.resolve(sceneDir) : null;
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
    if (!root) { res.writeHead(404); return res.end(); }
    let rel;
    try { rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); } catch { res.writeHead(400); return res.end(); }
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
```

`collector/index.js`:
```js
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
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/agent-city/config.json'), 'utf8')); } catch { return {}; }
})();

const port = Number(arg('port') ?? config.port ?? 47823);
const sceneDir = path.resolve(arg('scene') ?? config.sceneDir ?? path.join(import.meta.dirname, '..', 'scene'));
const claudeRoot = config.claudeProjectsDir ?? path.join(os.homedir(), '.claude', 'projects');
const herdrBin = config.herdrPath ?? 'herdr';
const counter = new TokenCounter({ root: claudeRoot, includeCacheRead: config.includeCacheRead ?? true });

let stats = { source: 'starting', working: 0, subagents: 0, projects: 0, keys: [], tokensToday: 0, tokensPerMin: 0, updatedAt: Date.now() };
const { server, broadcast, ping } = createServer({ getStats: () => stats, sceneDir });
const log = (...a) => console.log('[agent-city]', ...a);

let lastSource = null;
async function tick() {
  try {
    const next = await collect({ herdr: () => runHerdr(herdrBin), claudeRoot, counter, nowMs: Date.now() });
    if (next.source !== lastSource) { lastSource = next.source; log(`agent source: ${next.source}`); }
    const changed = JSON.stringify({ ...next, updatedAt: 0 }) !== JSON.stringify({ ...stats, updatedAt: 0 });
    stats = next;
    if (changed) broadcast(stats);
  } catch (e) {
    console.error('[agent-city] tick failed:', e.message);
  }
  setTimeout(tick, 2000);
}

server.on('error', (e) => {
  console.error(`[agent-city] ${e.message}`);
  process.exit(e.code === 'EADDRINUSE' ? 3 : 1);
});
server.listen(port, '127.0.0.1', () => {
  log(`serving http://127.0.0.1:${port}/ (scene: ${sceneDir})`);
  tick();
  setInterval(ping, 15_000);
});
```

- [ ] **Step 4: Run all collector tests, expect PASS** — `make test` (scene tests glob may warn "no files" until Task 4; acceptable) then run `node collector/index.js` for 5s and `curl -s 127.0.0.1:47823/stats` → JSON with real `tokensToday > 0`, `source: "herdr"`.
- [ ] **Step 5: Commit** — `feat(collector): stats merge, http/sse server, entry point`

---

### Task 4: Scene pure modules (activity, params, city, format, demo)

**Files:**
- Create: `scene/src/activity.js`, `scene/src/params.js`, `scene/src/city.js`, `scene/src/format.js`, `scene/src/demo.js`
- Test: `scene/test/pure.test.js`

**Interfaces:**
- Produces:
  - `activityLevel({working, subagents}): number∈[0,1]`, `pulseLevel(tokensPerMin): number∈[0,1]`, `districtOf(key, n=8): int`, `districtBoosts(keys, n=8): number[n]`, `easeToward(cur, target, dt, tau=1): number`
  - `readParams(search, {w, h}): {fullW, fullH, x, y, w, h, fps, overlay, demo, seed}`
  - `mulberry32(seed): () => number`; `generateCity({seed=7}): {buildings: [{x,z,w,d,h,seed,district}], grid: {ox, oz, pitch, cols, rows, street, block}, highway: {ax, az, bx, bz, width}, rotation}` — coordinates are **local** to a group rotated by `rotation` around Y.
  - `formatStats(stats|null): {projects, agents, agentsSub, tokens, rate}` (strings); `formatInt(n)`
  - `demoStats(tSec): Stats`

- [ ] **Step 1: Write failing tests** — `scene/test/pure.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityLevel, pulseLevel, districtOf, districtBoosts, easeToward } from '../src/activity.js';
import { readParams } from '../src/params.js';
import { generateCity } from '../src/city.js';
import { formatStats } from '../src/format.js';
import { demoStats } from '../src/demo.js';

test('activityLevel curve', () => {
  assert.equal(activityLevel({ working: 0, subagents: 0 }), 0);
  assert.equal(activityLevel({ working: 1 }), 0.45);
  assert.ok(Math.abs(activityLevel({ working: 2 }) - 0.65) < 1e-9);
  assert.equal(activityLevel({ working: 1, subagents: 6 }), 1);
  assert.equal(activityLevel({ subagents: 1 }), 0.45);
  assert.equal(activityLevel(undefined), 0);
});

test('pulseLevel clamps', () => {
  assert.equal(pulseLevel(0), 0);
  assert.equal(pulseLevel(50_000), 0.5);
  assert.equal(pulseLevel(1e9), 1);
});

test('districts are stable and bounded', () => {
  assert.equal(districtOf('/a'), districtOf('/a'));
  for (const k of ['/a', '/b', 'x', '']) assert.ok(districtOf(k) >= 0 && districtOf(k) < 8);
  const b = districtBoosts(['/a', '/a', '/a']);
  assert.equal(b.length, 8);
  assert.equal(Math.max(...b), 1);
});

test('easeToward converges', () => {
  let v = 0;
  for (let i = 0; i < 300; i++) v = easeToward(v, 1, 1 / 60, 1);
  assert.ok(v > 0.99 && v <= 1);
});

test('readParams defaults to the window and reads slices', () => {
  assert.deepEqual(readParams('', { w: 800, h: 600 }),
    { fullW: 800, fullH: 600, x: 0, y: 0, w: 800, h: 600, fps: 60, overlay: true, demo: false, seed: 7 });
  const p = readParams('?fullW=5760&fullH=1080&x=1920&y=0&w=1920&h=1080&fps=30&overlay=0&demo=1', { w: 1, h: 1 });
  assert.equal(p.fullW, 5760); assert.equal(p.x, 1920); assert.equal(p.fps, 30);
  assert.equal(p.overlay, false); assert.equal(p.demo, true);
});

test('generateCity is deterministic, dense downtown, bounded', () => {
  const a = generateCity({ seed: 7 }), b = generateCity({ seed: 7 });
  assert.deepEqual(a.buildings.slice(0, 20), b.buildings.slice(0, 20));
  assert.ok(a.buildings.length > 3000);
  const { ox, oz, pitch, cols, rows } = a.grid;
  for (const bl of a.buildings) {
    assert.ok(bl.x > ox && bl.x < ox + cols * pitch && bl.z > oz && bl.z < oz + rows * pitch);
    assert.ok(bl.h > 0 && bl.district >= 0 && bl.district < 8);
  }
  const tallest = [...a.buildings].sort((p, q) => q.h - p.h).slice(0, 50);
  assert.ok(tallest.every((t) => t.h > 80));
});

test('formatStats', () => {
  assert.deepEqual(formatStats(null), { projects: '—', agents: '—', agentsSub: 'offline', tokens: '—', rate: '' });
  const f = formatStats({ source: 'herdr', working: 1, subagents: 6, projects: 1, tokensToday: 215615003, tokensPerMin: 218000 });
  assert.deepEqual(f, { projects: '1', agents: '7', agentsSub: '6 subagents · working', tokens: '215,615,003', rate: '218k / min' });
  assert.equal(formatStats({ working: 0, subagents: 0, projects: 0, tokensToday: 5, tokensPerMin: 0 }).agentsSub, 'idle');
  assert.equal(formatStats({ source: 'demo', working: 1, subagents: 0, projects: 1, tokensToday: 5, tokensPerMin: 900 }).agentsSub, 'demo working');
  assert.equal(formatStats({ working: 1, subagents: 1, projects: 1, tokensToday: 5, tokensPerMin: 900 }).rate, '900 / min');
});

test('demoStats cycles idle → busy and tokens only grow', () => {
  assert.equal(demoStats(1).working, 0);
  assert.ok(demoStats(20).working + demoStats(20).subagents >= 3);
  assert.ok(demoStats(21).tokensToday >= demoStats(20).tokensToday);
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

`scene/src/activity.js`:
```js
export function activityLevel({ working = 0, subagents = 0 } = {}) {
  const eff = working + 0.5 * subagents;
  if (eff <= 0) return 0;
  return Math.min(1, 0.45 + 0.2 * Math.log2(Math.max(1, eff)));
}

export const pulseLevel = (tokensPerMin = 0) => Math.max(0, Math.min(1, tokensPerMin / 100_000));

export function districtOf(key, n = 8) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % n;
}

export function districtBoosts(keys = [], n = 8) {
  const b = new Array(n).fill(0);
  for (const k of keys) { const d = districtOf(k, n); b[d] = Math.min(1, b[d] + 0.5); }
  return b;
}

export const easeToward = (cur, target, dt, tau = 1) => target + (cur - target) * Math.exp(-dt / tau);
```

`scene/src/params.js`:
```js
export function readParams(search, win) {
  const q = new URLSearchParams(search);
  const num = (k, d) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
  const w = num('w', win.w), h = num('h', win.h);
  return {
    fullW: num('fullW', w), fullH: num('fullH', h), x: num('x', 0), y: num('y', 0), w, h,
    fps: num('fps', 60), overlay: q.get('overlay') !== '0', demo: q.get('demo') === '1', seed: num('seed', 7),
  };
}
```

`scene/src/city.js`:
```js
export function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Density peaks, in grid-local coordinates (x right, z toward camera before rotation).
const CENTERS = [
  { x: -1150, z: -250, r: 420, w: 1.0 },  // downtown (left display)
  { x: 150, z: -350, r: 300, w: 0.55 },   // secondary cluster (middle)
  { x: 1300, z: -150, r: 260, w: 0.35 },  // small cluster (right)
];

export function generateCity({ seed = 7, cols = 64, rows = 30, block = 56, street = 14, rotation = 0.55 } = {}) {
  const rnd = mulberry32(seed);
  const pitch = block + street;
  const ox = -(cols * pitch) / 2, oz = -(rows * pitch) / 2;
  const density = (x, z) => CENTERS.reduce((s, c) => s + c.w * Math.exp(-((x - c.x) ** 2 + (z - c.z) ** 2) / (2 * c.r * c.r)), 0);
  const buildings = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const bx = ox + i * pitch + street / 2, bz = oz + j * pitch + street / 2;
      const d0 = density(bx + block / 2, bz + block / 2);
      if (d0 < 0.3 && rnd() < 0.07) continue; // park / empty block
      const n = d0 > 0.55 ? 2 : rnd() < 0.5 ? 2 : 3;
      const lot = block / n;
      const district = Math.min(3, Math.floor((i / cols) * 4)) + 4 * (j >= rows / 2 ? 1 : 0);
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) {
          if (rnd() < 0.06) continue;
          const inset = 1.2 + rnd() * 2.3;
          const x = bx + a * lot + lot / 2, z = bz + b * lot + lot / 2;
          const d = density(x, z);
          const spike = rnd() < 0.08 + d * 0.3 ? 2.1 : 1;
          const h = 7 + rnd() * 10 + d * (50 + rnd() * 170) * spike;
          buildings.push({ x, z, w: lot - inset * 2, d: lot - inset * 2, h, seed: rnd(), district });
        }
      }
    }
  }
  const W = cols * pitch, D = rows * pitch;
  const highway = { ax: ox + W * 0.2, az: oz + D + 200, bx: ox + W + 200, bz: oz + D * 0.05, width: 22 };
  return { buildings, grid: { ox, oz, pitch, cols, rows, street, block }, highway, rotation };
}
```

`scene/src/format.js`:
```js
export const formatInt = (n) => Math.round(n).toLocaleString('en-US');

export function formatStats(s) {
  if (!s) return { projects: '—', agents: '—', agentsSub: 'offline', tokens: '—', rate: '' };
  const working = s.working || 0, sub = s.subagents || 0;
  let agentsSub = 'idle';
  if (working + sub > 0) {
    const verb = s.source === 'demo' ? 'demo working' : 'working';
    agentsSub = sub > 0 ? `${sub} subagent${sub === 1 ? '' : 's'} · ${verb}` : verb;
  }
  const r = s.tokensPerMin || 0;
  const rate = r <= 0 ? '' : r >= 1000 ? `${Math.round(r / 1000)}k / min` : `${Math.round(r)} / min`;
  return { projects: String(s.projects || 0), agents: String(working + sub), agentsSub, tokens: formatInt(s.tokensToday || 0), rate };
}
```

`scene/src/demo.js`:
```js
// 40s loop: idle 0-6s, 1 agent 6-10s, subagents ramp to 6 by 22s, hold, wind down at 34s.
export function demoStats(tSec) {
  const p = tSec % 40;
  const working = p >= 6 && p < 34 ? 1 : 0;
  const subagents = p < 10 || p >= 32 ? 0 : Math.min(6, 1 + Math.floor((p - 10) / 2));
  return {
    source: 'demo', working, subagents, projects: working, keys: working ? ['demo'] : [],
    tokensToday: 215_399_164 + Math.floor(tSec * 5200),
    tokensPerMin: working ? 42_000 + subagents * 29_000 : 0, updatedAt: Date.now(),
  };
}
```

- [ ] **Step 4: Run, expect PASS** — `make test`.
- [ ] **Step 5: Commit** — `feat(scene): pure modules for activity, params, city, overlay text, demo`

---

### Task 5: Scene rendering — ground, buildings, overlay, bloom, loop

**Files:**
- Modify: `Makefile` (add `vendor` target), `.gitignore` (add `build/`)
- Create: `scene/vendor/three/**` (via `make vendor`), `scene/index.html`, `scene/style.css`, `scene/src/ground.js`, `scene/src/buildings.js`, `scene/src/overlay.js`, `scene/src/stats-client.js`, `scene/src/main.js`

**Interfaces:**
- Consumes: Task 4 modules; collector `/events` (Task 3).
- Produces: `createGround(city): {mesh, uniforms}`, `createBuildings(city): {mesh, uniforms}` — both uniforms include `uActivity, uTime, uPulse, uFogColor, uFogNear, uFogFar`; buildings also `uDistrict` (float[8]). `createOverlay(el): {set(stats|null), tick(dt)}`. `connectStats(onStats)`. Global `window.agentCity = { setPaused(bool), setFps(n) }`. `main.js` has a placeholder `streams` hook filled in Task 6.

- [ ] **Step 1: Vendor three** — add to `Makefile`:

```make
THREE_VERSION := 0.186.1
.PHONY: vendor
vendor: scene/vendor/three/three.module.js
scene/vendor/three/three.module.js:
	rm -rf build/three && mkdir -p build/three scene/vendor/three/addons
	cd build/three && npm pack three@$(THREE_VERSION) --silent >/dev/null && tar xzf three-$(THREE_VERSION).tgz
	cp build/three/package/build/three.module.js build/three/package/build/three.core.js build/three/package/LICENSE scene/vendor/three/
	cp -R build/three/package/examples/jsm/postprocessing build/three/package/examples/jsm/shaders scene/vendor/three/addons/
```
and make `dev: vendor`. Run `make vendor`; confirm `scene/vendor/three/three.module.js` exists. Vendored files are committed so the repo runs without npm.

- [ ] **Step 2: `scene/index.html` + `scene/style.css`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>agent-city</title>
  <link rel="stylesheet" href="style.css">
  <script type="importmap">
    { "imports": { "three": "./vendor/three/three.module.js", "three/addons/": "./vendor/three/addons/" } }
  </script>
</head>
<body>
  <div id="overlay" hidden>
    <div class="stat"><div class="label">Projects</div><div class="value" data-k="projects">0</div></div>
    <div class="stat"><div class="label">Agents</div><div class="value" data-k="agents">0</div><div class="sub" data-k="agentsSub">idle</div></div>
    <div class="stat"><div class="label">Tokens today</div><div class="value" data-k="tokens">0</div><div class="sub" data-k="rate"></div></div>
  </div>
  <script type="module" src="src/main.js"></script>
</body>
</html>
```
```css
html, body { margin: 0; height: 100%; overflow: hidden; background: #05070b; cursor: none; }
canvas { display: block; }
#overlay { position: fixed; left: 44px; bottom: var(--overlay-bottom, 72px); display: flex; gap: 56px;
  font: 500 13px -apple-system, "SF Pro Text", system-ui, sans-serif; color: rgba(255,255,255,.72);
  text-shadow: 0 1px 8px rgba(0,0,0,.6); pointer-events: none; user-select: none; }
#overlay .value { font: 600 38px -apple-system, "SF Pro Display", system-ui, sans-serif; color: #fff;
  font-variant-numeric: tabular-nums; letter-spacing: .5px; margin-top: 6px; }
#overlay .sub { font-size: 12px; color: rgba(255,255,255,.55); margin-top: 2px; min-height: 15px; }
```

- [ ] **Step 3: `scene/src/stats-client.js`**

```js
export function connectStats(onStats, { url = '/events', retryMs = 5000 } = {}) {
  const open = () => {
    const es = new EventSource(url);
    es.onmessage = (e) => { try { onStats(JSON.parse(e.data)); } catch { /* ignore bad frame */ } };
    es.onerror = () => { es.close(); onStats(null); setTimeout(open, retryMs); };
  };
  open();
}
```

- [ ] **Step 4: `scene/src/overlay.js`**

```js
import { formatStats, formatInt } from './format.js';

export function createOverlay(el) {
  const fields = Object.fromEntries([...el.querySelectorAll('[data-k]')].map((n) => [n.dataset.k, n]));
  let target = null, shown = 0;
  return {
    set(stats) {
      target = stats;
      const f = formatStats(stats);
      for (const k of ['projects', 'agents', 'agentsSub', 'rate']) fields[k].textContent = f[k];
      if (!stats) fields.tokens.textContent = f.tokens;
      else if (shown === 0) shown = stats.tokensToday;
    },
    tick(dt) {
      if (!target) return;
      const goal = target.tokensToday || 0;
      shown = goal < shown ? goal : shown + (goal - shown) * Math.min(1, dt * 3);
      if (goal - shown < 1) shown = goal;
      fields.tokens.textContent = formatInt(shown);
    },
  };
}
```

- [ ] **Step 5: `scene/src/ground.js`**

```js
import * as THREE from 'three';

export function createGround(city) {
  const { ox, oz, pitch, cols, rows, street } = city.grid;
  const W = cols * pitch + 3000, D = rows * pitch + 3000;
  const uniforms = {
    uActivity: { value: 0 }, uTime: { value: 0 }, uPulse: { value: 0 },
    uGrid: { value: new THREE.Vector4(ox, oz, pitch, street) },
    uFogColor: { value: new THREE.Color(0x0a0d14) }, uFogNear: { value: 1400 }, uFogFar: { value: 4200 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      varying vec2 vXZ; varying float vDepth;
      void main() {
        vXZ = position.xz;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uActivity; uniform vec4 uGrid; uniform vec3 uFogColor; uniform float uFogNear, uFogFar;
      varying vec2 vXZ; varying float vDepth;
      void main() {
        vec2 g = mod(vXZ - uGrid.xy, uGrid.z);
        vec2 dist = min(g, uGrid.z - g);                 // distance to nearest street centerline
        float onStreet = 1.0 - step(uGrid.w * 0.5, min(dist.x, dist.y));
        float edge = 1.0 - smoothstep(0.0, 1.2, abs(min(dist.x, dist.y) - uGrid.w * 0.5));
        vec3 block = vec3(0.012, 0.014, 0.019);
        vec3 road = vec3(0.022, 0.022, 0.028) + vec3(0.03, 0.012, 0.004) * uActivity;
        vec3 col = mix(block, road, onStreet) + vec3(0.02, 0.022, 0.03) * edge;
        col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, vDepth) * 0.85);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const geo = new THREE.PlaneGeometry(W, D);
  geo.rotateX(-Math.PI / 2);
  return { mesh: new THREE.Mesh(geo, mat), uniforms };
}
```

- [ ] **Step 6: `scene/src/buildings.js`**

```js
import * as THREE from 'three';

export function createBuildings(city) {
  const list = city.buildings, n = list.length;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const seeds = new Float32Array(n), districts = new Float32Array(n), sizes = new Float32Array(n * 3);
  const uniforms = {
    uActivity: { value: 0 }, uTime: { value: 0 }, uPulse: { value: 0 }, uDistrict: { value: new Array(8).fill(0) },
    uFogColor: { value: new THREE.Color(0x0a0d14) }, uFogNear: { value: 1400 }, uFogFar: { value: 4200 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      attribute float aSeed; attribute float aDistrict; attribute vec3 aSize;
      varying vec3 vLocal; varying vec3 vN; varying float vSeed; varying float vDistrict; varying float vDepth;
      void main() {
        vLocal = (position + vec3(0.5, 0.0, 0.5)) * aSize;
        vN = normal; vSeed = aSeed; vDistrict = aDistrict;
        vec4 mv = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uActivity, uTime, uPulse; uniform float uDistrict[8];
      uniform vec3 uFogColor; uniform float uFogNear, uFogFar;
      varying vec3 vLocal; varying vec3 vN; varying float vSeed; varying float vDistrict; varying float vDepth;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec3 base = vec3(0.028, 0.032, 0.045) * (0.7 + 0.5 * clamp(vLocal.y / 250.0, 0.0, 1.0));
        vec3 col = base * 1.3;                                       // roofs
        if (abs(vN.y) < 0.5) {
          bool sideX = abs(vN.x) > 0.5;
          float u = sideX ? vLocal.z : vLocal.x;
          float face = sideX ? (vN.x > 0.0 ? 1.0 : 2.0) : (vN.z > 0.0 ? 3.0 : 4.0);
          vec2 cellSize = vec2(2.4, 3.3);
          vec2 q = vec2(u, vLocal.y) / cellSize;
          vec2 cell = floor(q), f = fract(q);
          float win = step(0.16, f.x) * step(f.x, 0.84) * step(0.22, f.y) * step(f.y, 0.82) * step(3.3, vLocal.y);
          float r = hash(cell + vec2(vSeed * 97.0, face * 13.0));
          float r2 = hash(cell.yx * 1.31 + vSeed * 31.0);
          float local = clamp(uActivity * (1.0 + uDistrict[int(vDistrict + 0.5)]), 0.0, 1.0);
          float litFrac = mix(0.035, 0.8, local);
          float drift = 0.05 * sin(uTime * (0.05 + uPulse * 0.5) + r2 * 6.2831);
          float lit = step(r * 0.65 + vSeed * 0.35 + drift, litFrac) * win;   // whole buildings tend to switch together
          vec3 warm = vec3(1.0, 0.68, 0.34), cool = vec3(0.72, 0.84, 1.0);
          vec3 wc = mix(warm, cool, step(0.58, r2)) * (0.55 + 0.9 * hash(cell * 1.7 + vSeed)) * (0.8 + 0.9 * local);
          col = base + base * win * 0.5;
          col = mix(col, wc, lit);
        }
        col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, vDepth) * 0.85);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  const m = new THREE.Matrix4();
  list.forEach((b, i) => {
    m.makeScale(b.w, b.h, b.d).setPosition(b.x, 0, b.z);
    mesh.setMatrixAt(i, m);
    seeds[i] = b.seed; districts[i] = b.district; sizes.set([b.w, b.h, b.d], i * 3);
  });
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  geo.setAttribute('aDistrict', new THREE.InstancedBufferAttribute(districts, 1));
  geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 3));
  mesh.frustumCulled = false;
  return { mesh, uniforms };
}
```

- [ ] **Step 7: `scene/src/main.js`**

```js
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { readParams } from './params.js';
import { generateCity, mulberry32 } from './city.js';
import { activityLevel, pulseLevel, districtBoosts, easeToward } from './activity.js';
import { createGround } from './ground.js';
import { createBuildings } from './buildings.js';
import { createOverlay } from './overlay.js';
import { connectStats } from './stats-client.js';
import { demoStats } from './demo.js';

const P = readParams(location.search, { w: innerWidth, h: innerHeight });

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x06080d);

const camera = new THREE.PerspectiveCamera(30, P.fullW / P.fullH, 10, 9000);
camera.position.set(-250, 1500, 1900);
camera.lookAt(-250, 0, -100);
const applyView = () => {
  const p = readParams(location.search, { w: innerWidth, h: innerHeight });
  camera.aspect = p.fullW / p.fullH;
  camera.setViewOffset(p.fullW, p.fullH, p.x, p.y, p.w, p.h);
  camera.updateProjectionMatrix();
};
applyView();

const city = generateCity({ seed: P.seed });
const group = new THREE.Group();
group.rotation.y = city.rotation;
scene.add(group);
const ground = createGround(city);
const buildings = createBuildings(city);
group.add(ground.mesh, buildings.mesh);
const streams = { update() {} }; // replaced in Task 6

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.6, 0.55, 0.2);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const overlayEl = document.getElementById('overlay');
overlayEl.hidden = !P.overlay;
const overlay = createOverlay(overlayEl);

const state = { a: 0, pulse: 0, districts: new Array(8).fill(0) };
let target = { a: 0, pulse: 0, districts: new Array(8).fill(0) };
function applyStats(s) {
  target = s
    ? { a: activityLevel(s), pulse: pulseLevel(s.tokensPerMin), districts: districtBoosts(s.keys) }
    : { a: 0, pulse: 0, districts: new Array(8).fill(0) };
  overlay.set(s);
}
if (P.demo) { const t0 = performance.now(); setInterval(() => applyStats(demoStats((performance.now() - t0) / 1000)), 500); }
else connectStats(applyStats);

let paused = false, last = performance.now(), lastDraw = 0;
function frame(now) {
  if (paused) return;
  requestAnimationFrame(frame);
  const settled = target.a === 0 && state.a < 0.005;
  const fps = settled ? Math.min(P.fps, 10) : P.fps;
  if (now - lastDraw < 1000 / fps - 2) return;
  lastDraw = now;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  state.a = easeToward(state.a, target.a, dt, 1);
  state.pulse = easeToward(state.pulse, target.pulse, dt, 1);
  state.districts = state.districts.map((v, i) => easeToward(v, target.districts[i], dt, 1.5));
  for (const u of [ground.uniforms, buildings.uniforms]) {
    u.uActivity.value = state.a; u.uPulse.value = state.pulse; u.uTime.value = now / 1000;
  }
  buildings.uniforms.uDistrict.value = state.districts;
  streams.update(dt, state);
  bloom.strength = 0.45 + 0.85 * state.a;
  composer.render(dt);
  overlay.tick(dt);
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  applyView();
});

window.agentCity = {
  setPaused(p) {
    if (p === paused) return;
    paused = p;
    if (!p) { last = performance.now(); requestAnimationFrame(frame); }
  },
  setFps(f) { P.fps = f; },
  setOverlayBottom(px) { overlayEl.style.setProperty('--overlay-bottom', `${px}px`); },
};
```

- [ ] **Step 8: Visual check** — `make dev`, then open in the built-in browser:
  - `http://127.0.0.1:47823/?demo=1&fullW=5760&fullH=1080&x=0&y=0&w=1920&h=1080` (left slice), and `x=1920`, `x=3840`.
  - Expect: dark city, dense tall towers in the left slice thinning rightward, windows lighting up in clusters during the demo busy phase and dimming at idle, overlay bottom-left in the left slice. Check console for zero errors. Adjust camera/centers/fog so the left slice resembles the reference screenshot's framing (tilted grid, towers filling the upper-middle).
- [ ] **Step 9: Commit** — `feat(scene): city rendering, window shader, overlay, bloom`

---

### Task 6: Tron light streams

**Files:**
- Create: `scene/src/streams.js`
- Modify: `scene/src/main.js` (replace the placeholder `streams`)

**Interfaces:**
- Consumes: `city.grid`, `city.highway` (Task 4), `mulberry32`, `easeToward`.
- Produces: `createStreams(city, rnd): {mesh, update(dt, {a, pulse})}`.

- [ ] **Step 1: Implement** — `scene/src/streams.js`

```js
import * as THREE from 'three';
import { easeToward } from './activity.js';

const MAX_QUADS = 7000;
const MAX_STREET = 600, MAX_HIGHWAY = 180;
const WHITE = [1.3, 1.2, 1.1], RED = [1.5, 0.22, 0.1], ORANGE = [1.4, 0.55, 0.14], CYAN = [0.35, 1.1, 1.4];
const Y = 0.8;

export function createStreams(city, rnd) {
  const { ox, oz, pitch, cols, rows } = city.grid;
  const pos = new Float32Array(MAX_QUADS * 12), col = new Float32Array(MAX_QUADS * 12);
  const idx = new Uint32Array(MAX_QUADS * 6);
  for (let q = 0; q < MAX_QUADS; q++) { const v = q * 4; idx.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], q * 6); }
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('color', colAttr);
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  }));
  mesh.frustumCulled = false;

  const node = (i, j) => [ox + i * pitch, oz + j * pitch];
  const valid = (i, j) => i >= 0 && j >= 0 && i <= cols && j <= rows;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const pickColor = () => { const r = rnd(); return r < 0.05 ? CYAN : r < 0.55 ? WHITE : r < 0.85 ? RED : ORANGE; };

  function turn(s, allowReverse) {
    const opts = DIRS.filter(([a, b]) => valid(s.i + a, s.j + b) && (allowReverse || a !== -s.di || b !== -s.dj));
    const straight = opts.find(([a, b]) => a === s.di && b === s.dj);
    [s.di, s.dj] = straight && rnd() < 0.7 ? straight : opts[Math.floor(rnd() * opts.length)];
  }

  const streets = Array.from({ length: MAX_STREET }, () => {
    const s = { i: Math.floor(rnd() * (cols + 1)), j: Math.floor(rnd() * (rows + 1)), di: 1, dj: 0, t: rnd(),
      speed: 35 + rnd() * 45, len: 80 + rnd() * 170, fade: 0, color: pickColor(), trail: [] };
    turn(s, true);
    s.trail.push(node(s.i, s.j));
    return s;
  });

  const hw = city.highway;
  const hwLen = Math.hypot(hw.bx - hw.ax, hw.bz - hw.az);
  const hdx = (hw.bx - hw.ax) / hwLen, hdz = (hw.bz - hw.az) / hwLen;
  const highway = Array.from({ length: MAX_HIGHWAY }, (_, k) => {
    const forward = k % 2 === 0;
    const lane = (forward ? 1 : -1) * (3 + 5 * (Math.floor(k / 2) % 2));
    return { u: rnd(), forward, lane, speed: 110 + rnd() * 80, len: 160 + rnd() * 240, fade: 0, color: forward ? WHITE : RED };
  });

  let q = 0;
  function quad(x1, z1, x0, z0, nx, nz, c, a1, a0) {
    if (q >= MAX_QUADS) return;
    const p = q * 12;
    pos.set([x1 + nx, Y, z1 + nz, x1 - nx, Y, z1 - nz, x0 + nx, Y, z0 + nz, x0 - nx, Y, z0 - nz], p);
    col.set([c[0] * a1, c[1] * a1, c[2] * a1, c[0] * a1, c[1] * a1, c[2] * a1,
      c[0] * a0, c[1] * a0, c[2] * a0, c[0] * a0, c[1] * a0, c[2] * a0], p);
    q++;
  }

  // points: head first, then older corners. Draws a ribbon whose brightness fades to 0 at `len`.
  function ribbon(points, len, c, width, alpha) {
    let dist = 0;
    for (let k = 0; k < points.length - 1 && dist < len; k++) {
      const [x1, z1] = points[k], [xb, zb] = points[k + 1];
      const dx = xb - x1, dz = zb - z1, L = Math.hypot(dx, dz);
      if (L < 1e-3) continue;
      const take = Math.min(L, len - dist);
      const x0 = x1 + (dx * take) / L, z0 = z1 + (dz * take) / L;
      const nx = (-dz / L) * width * 0.5, nz = (dx / L) * width * 0.5;
      const a1 = alpha * (1 - dist / len) ** 1.6, a0 = alpha * (1 - (dist + take) / len) ** 1.6;
      quad(x1, z1, x0, z0, nx, nz, c, a1, a0);
      if (k === 0) { const h = Math.min(6, take); quad(x1, z1, x1 + (dx * h) / L, z1 + (dz * h) / L, nx * 1.6, nz * 1.6, c, alpha * 2.5, alpha); }
      dist += take;
    }
  }

  function update(dt, { a, pulse }) {
    q = 0;
    const nStreet = Math.round(10 + a * (MAX_STREET - 10)), nHw = Math.round(16 + a * (MAX_HIGHWAY - 16));
    const speedMul = (0.55 + 0.45 * a) * (1 + 0.8 * pulse);
    streets.forEach((s, k) => {
      s.fade = easeToward(s.fade, k < nStreet ? 1 : 0, dt, 0.8);
      if (s.fade < 0.01) return;
      s.t += (s.speed * speedMul * dt) / pitch;
      while (s.t >= 1) {
        s.t -= 1; s.i += s.di; s.j += s.dj;
        s.trail.push(node(s.i, s.j));
        if (s.trail.length > 8) s.trail.shift();
        turn(s, false);
      }
      const [nx0, nz0] = node(s.i, s.j);
      const head = [nx0 + s.di * pitch * s.t, nz0 + s.dj * pitch * s.t];
      const pts = [head];
      for (let m = s.trail.length - 1; m >= 0; m--) pts.push(s.trail[m]);
      ribbon(pts, s.len, s.color, 1.8, s.fade);
    });
    highway.forEach((h, k) => {
      h.fade = easeToward(h.fade, k < nHw ? 1 : 0, dt, 0.8);
      if (h.fade < 0.01) return;
      const du = (h.speed * speedMul * dt) / hwLen;
      h.u += h.forward ? du : -du;
      const margin = h.len / hwLen;
      if (h.forward && h.u > 1 + margin) h.u = -0.02;
      if (!h.forward && h.u < -margin) h.u = 1.02;
      const px = -hdz * h.lane, pz = hdx * h.lane;
      const hx = hw.ax + hdx * hwLen * h.u + px, hz = hw.az + hdz * hwLen * h.u + pz;
      const sgn = h.forward ? -1 : 1;
      ribbon([[hx, hz], [hx + sgn * hdx * h.len, hz + sgn * hdz * h.len]], h.len, h.color, 2.4, h.fade);
    });
    geo.setDrawRange(0, q * 6);
    posAttr.clearUpdateRanges(); posAttr.addUpdateRange(0, q * 12); posAttr.needsUpdate = true;
    colAttr.clearUpdateRanges(); colAttr.addUpdateRange(0, q * 12); colAttr.needsUpdate = true;
  }

  return { mesh, update };
}
```

Also add a faint highway road surface to `ground.js`? No — the dense highway streams read as the highway; keep ground untouched (YAGNI).

- [ ] **Step 2: Wire into `main.js`** — replace `const streams = { update() {} }; // replaced in Task 6` with:

```js
const streams = createStreams(city, mulberry32(P.seed + 1));
group.add(streams.mesh);
```
and add `import { createStreams } from './streams.js';`.

- [ ] **Step 3: Visual check** — same three slice URLs with `?demo=1`. Expect: at idle a few slow faint streams; in the busy phase hundreds of long white/red ribbons flowing through the grid and turning at intersections, a dense bidirectional highway band, bright heads, bloom glow like the reference. No console errors; frame time < 16ms (check with `performance.now()` sampling in the console). Tune `len`, widths, colors, and bloom if needed.
- [ ] **Step 4: Commit** — `feat(scene): tron light streams`

---

### Task 7: Swift menu-bar app

**Files:**
- Create: `app/Package.swift`, `app/Info.plist`, `app/Sources/AgentCity/main.swift`, `AppDelegate.swift`, `SliceLayout.swift`, `WallpaperWindow.swift`, `Collector.swift`

**Interfaces:**
- Consumes: collector CLI (`--scene`, `--port`, exit 3), scene URL params (`fullW, fullH, x, y, w, h, fps, overlay, demo`), `window.agentCity.setPaused(bool)`.
- Produces: `AgentCity` executable; `AgentCity --self-test` exits 0 when layout checks pass. Dev env var `AGENT_CITY_ROOT` points at a folder containing `scene/` and `collector/` (defaults to the bundle's Resources).

- [ ] **Step 1: `app/Package.swift`**

```swift
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "AgentCity",
    platforms: [.macOS(.v13)],
    targets: [.executableTarget(name: "AgentCity", path: "Sources/AgentCity")]
)
```

- [ ] **Step 2: Failing self-test** — `SliceLayout.swift` with `selfTest()` first returning checks against a stub `make` (write the checks, run `cd app && swift run AgentCity --self-test`, see failure), then the real implementation:

```swift
import CoreGraphics

struct Slice: Equatable {
    let x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat
}

struct SliceLayout: Equatable {
    let fullW: CGFloat, fullH: CGFloat
    let slices: [Slice]

    /// `frames` are AppKit global screen frames (origin bottom-left, y up).
    /// Slices use a top-left origin, matching `camera.setViewOffset`.
    static func make(frames: [CGRect]) -> SliceLayout {
        guard let first = frames.first else { return SliceLayout(fullW: 0, fullH: 0, slices: []) }
        let union = frames.dropFirst().reduce(first) { $0.union($1) }
        let slices = frames.map { f in
            Slice(x: f.minX - union.minX, y: union.maxY - f.maxY, w: f.width, h: f.height)
        }
        return SliceLayout(fullW: union.width, fullH: union.height, slices: slices)
    }

    /// The left-most display shows the overlay and runs at full frame rate.
    var showcaseIndex: Int {
        slices.indices.min { slices[$0].x < slices[$1].x } ?? 0
    }

    static func selfTest() -> Bool {
        var ok = true
        func check(_ c: Bool, _ msg: String) { if !c { print("FAIL: \(msg)"); ok = false } }
        // Main display in the middle (origin 0,0), one left, one right.
        let three = make(frames: [
            CGRect(x: 0, y: 0, width: 1920, height: 1080),
            CGRect(x: -1920, y: 0, width: 1920, height: 1080),
            CGRect(x: 1920, y: 0, width: 1920, height: 1080),
        ])
        check(three.fullW == 5760 && three.fullH == 1080, "three wide union")
        check(three.slices[0] == Slice(x: 1920, y: 0, w: 1920, h: 1080), "main slice in middle")
        check(three.slices[1].x == 0 && three.slices[2].x == 3840, "left/right slices")
        check(three.showcaseIndex == 1, "showcase is left-most")
        // Mixed heights, bottoms aligned: shorter display sits lower in the top-left frame.
        let mixed = make(frames: [CGRect(x: 0, y: 0, width: 2560, height: 1440), CGRect(x: 2560, y: 0, width: 1920, height: 1080)])
        check(mixed.fullH == 1440 && mixed.slices[1].y == 360, "mixed heights")
        check(make(frames: []).slices.isEmpty, "no screens")
        print(ok ? "self-test ok" : "self-test failed")
        return ok
    }
}
```

- [ ] **Step 3: `WallpaperWindow.swift`**

```swift
import AppKit
import WebKit

final class WallpaperWindow: NSWindow, WKNavigationDelegate {
    let webView: WKWebView
    private var url: URL?

    init(screen: NSScreen) {
        let config = WKWebViewConfiguration()
        config.suppressesIncrementalRendering = true
        webView = WKWebView(frame: NSRect(origin: .zero, size: screen.frame.size), configuration: config)
        super.init(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
        setFrame(screen.frame, display: false)
        level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)))
        collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenNone]
        ignoresMouseEvents = true
        isOpaque = true
        hasShadow = false
        backgroundColor = .black
        isReleasedWhenClosed = false
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        contentView = webView
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    func load(_ url: URL) {
        self.url = url
        webView.load(URLRequest(url: url))
    }

    /// The collector may still be starting; keep retrying until the page loads.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, let url = self.url else { return }
            self.webView.load(URLRequest(url: url))
        }
    }

    func setPaused(_ paused: Bool) {
        webView.evaluateJavaScript("window.agentCity && window.agentCity.setPaused(\(paused))")
    }
}
```

- [ ] **Step 4: `Collector.swift`**

```swift
import Foundation

final class Collector {
    private let collectorDir: URL, sceneDir: URL, port: Int
    private var process: Process?
    private var failures = 0
    private var stopped = false
    private let logURL: URL

    init(collectorDir: URL, sceneDir: URL, port: Int) {
        self.collectorDir = collectorDir; self.sceneDir = sceneDir; self.port = port
        let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/AgentCity")
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        logURL = logs.appendingPathComponent("collector.log")
    }

    /// PATH from an interactive login shell, so nvm/homebrew node and herdr are found.
    private static func loginPath() -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-ilc", "echo __PATH__$PATH"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        let fallback = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        do { try p.run() } catch { return fallback }
        p.waitUntilExit()
        let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        guard let line = text.split(separator: "\n").last(where: { $0.hasPrefix("__PATH__") }) else { return fallback }
        return String(line.dropFirst("__PATH__".count)) + ":" + fallback
    }

    func start() {
        DispatchQueue.global().async {
            let path = Collector.loginPath()
            DispatchQueue.main.async { self.launch(path: path) }
        }
    }

    private func launch(path: String) {
        guard !stopped else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["node", collectorDir.appendingPathComponent("index.js").path, "--scene", sceneDir.path, "--port", String(port)]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = path
        p.environment = env
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
        if let log = try? FileHandle(forWritingTo: logURL) { log.seekToEndOfFile(); p.standardOutput = log; p.standardError = log }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, !self.stopped else { return }
                if proc.terminationStatus == 3 { return } // port taken: another collector is serving; use it
                self.failures += 1
                let delay = min(30.0, pow(2.0, Double(self.failures)))
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { self.launch(path: path) }
            }
        }
        do { try p.run(); process = p } catch { NSLog("agent-city: failed to start collector: \(error)") }
    }

    func stop() {
        stopped = true
        process?.terminate()
    }
}
```

- [ ] **Step 5: `AppDelegate.swift`**

```swift
import AppKit
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let port = 47823
    private var windows: [WallpaperWindow] = []
    private var collector: Collector!
    private var statusItem: NSStatusItem!
    private var userPaused = false, systemPaused = false, demo = false
    private var rebuildWork: DispatchWorkItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let root = ProcessInfo.processInfo.environment["AGENT_CITY_ROOT"].map { URL(fileURLWithPath: $0) }
            ?? Bundle.main.resourceURL!
        collector = Collector(collectorDir: root.appendingPathComponent("collector"),
                              sceneDir: root.appendingPathComponent("scene"), port: port)
        collector.start()
        buildMenu()
        rebuildWindows()
        observeSystem()
    }

    func applicationWillTerminate(_ notification: Notification) { collector.stop() }

    // MARK: windows

    private func rebuildWindows() {
        windows.forEach { $0.close() }
        windows = []
        let screens = NSScreen.screens
        let layout = SliceLayout.make(frames: screens.map(\.frame))
        for (i, screen) in screens.enumerated() {
            let s = layout.slices[i]
            let showcase = i == layout.showcaseIndex
            var c = URLComponents(string: "http://127.0.0.1:\(port)/")!
            c.queryItems = [
                ("fullW", layout.fullW), ("fullH", layout.fullH), ("x", s.x), ("y", s.y), ("w", s.w), ("h", s.h),
            ].map { URLQueryItem(name: $0.0, value: String(Int($0.1))) } + [
                URLQueryItem(name: "fps", value: showcase ? "60" : "30"),
                URLQueryItem(name: "overlay", value: showcase ? "1" : "0"),
                URLQueryItem(name: "demo", value: demo ? "1" : "0"),
            ]
            let w = WallpaperWindow(screen: screen)
            w.load(c.url!)
            w.orderFrontRegardless()
            windows.append(w)
        }
        applyPaused()
    }

    private func scheduleRebuild() {
        rebuildWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.rebuildWindows() }
        rebuildWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: work)
    }

    private func applyPaused() { windows.forEach { $0.setPaused(userPaused || systemPaused) } }

    // MARK: system events

    private func observeSystem() {
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in self?.scheduleRebuild() }
        let ws = NSWorkspace.shared.notificationCenter
        for (name, paused) in [(NSWorkspace.screensDidSleepNotification, true), (NSWorkspace.willSleepNotification, true),
                               (NSWorkspace.screensDidWakeNotification, false), (NSWorkspace.didWakeNotification, false)] {
            ws.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.systemPaused = paused; self?.applyPaused() }
        }
        let dnc = DistributedNotificationCenter.default()
        for (name, paused) in [("com.apple.screenIsLocked", true), ("com.apple.screenIsUnlocked", false)] {
            dnc.addObserver(forName: Notification.Name(name), object: nil, queue: .main) { [weak self] _ in self?.systemPaused = paused; self?.applyPaused() }
        }
    }

    // MARK: menu

    private func buildMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "building.2", accessibilityDescription: "Agent City")
        statusItem.menu = makeMenu()
    }

    private func makeMenu() -> NSMenu {
        let menu = NSMenu()
        func item(_ title: String, _ action: Selector, _ on: Bool? = nil) {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: "")
            i.target = self
            if let on { i.state = on ? .on : .off }
            menu.addItem(i)
        }
        item(userPaused ? "Resume" : "Pause", #selector(togglePause))
        item("Demo mode", #selector(toggleDemo), demo)
        item("Reload scene", #selector(reload))
        item("Launch at login", #selector(toggleLogin), SMAppService.mainApp.status == .enabled)
        menu.addItem(.separator())
        item("Quit Agent City", #selector(quit))
        return menu
    }

    private func refreshMenu() { statusItem.menu = makeMenu() }

    @objc private func togglePause() { userPaused.toggle(); applyPaused(); refreshMenu() }
    @objc private func toggleDemo() { demo.toggle(); rebuildWindows(); refreshMenu() }
    @objc private func reload() { windows.forEach { $0.webView.reload() } }
    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() }
        } catch { NSLog("agent-city: login item: \(error)") }
        refreshMenu()
    }
    @objc private func quit() { NSApp.terminate(nil) }
}
```

- [ ] **Step 6: `main.swift`**

```swift
import AppKit

if CommandLine.arguments.contains("--self-test") {
    exit(SliceLayout.selfTest() ? 0 : 1)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
```

- [ ] **Step 7: Build + self-test** — `cd app && swift build && swift run AgentCity --self-test` → "self-test ok".
- [ ] **Step 8: Dev smoke run** — stop any `make dev`, then `AGENT_CITY_ROOT=$PWD app/.build/debug/AgentCity` from repo root. Expect: wallpaper visible behind desktop icons on all three displays, continuous across seams, clicks pass through to the desktop, menu-bar icon works (Pause, Demo mode, Reload). Quit from the menu; confirm the node collector exits (`pgrep -f collector/index.js` empty).
- [ ] **Step 9: Commit** — `feat(app): menu-bar app with per-display desktop windows`

---

### Task 8: Packaging, install, README, publish to the private repo

**Files:**
- Create: `app/Info.plist`, `README.md`, `LICENSE`
- Modify: `Makefile` (app/install/run/clean), `.gitignore`

- [ ] **Step 1: `app/Info.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>AgentCity</string>
  <key>CFBundleIdentifier</key><string>io.github.dorukanc.agent-city</string>
  <key>CFBundleName</key><string>Agent City</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
```

- [ ] **Step 2: Makefile targets**

```make
APP := build/AgentCity.app
.PHONY: app install run clean
app: vendor
	cd app && swift build -c release
	rm -rf $(APP) && mkdir -p $(APP)/Contents/MacOS $(APP)/Contents/Resources
	cp app/.build/release/AgentCity $(APP)/Contents/MacOS/
	cp app/Info.plist $(APP)/Contents/
	cp -R scene collector $(APP)/Contents/Resources/
	rm -rf $(APP)/Contents/Resources/scene/test $(APP)/Contents/Resources/collector/test
	codesign --force --deep --sign - $(APP)
install: app
	mkdir -p ~/Applications && rm -rf ~/Applications/AgentCity.app && cp -R $(APP) ~/Applications/
	open ~/Applications/AgentCity.app
run: app
	open $(APP)
clean:
	rm -rf build app/.build
```
`.gitignore` gains `build/` and `app/.build/`.

- [ ] **Step 3: Verify** — `make test && make install`. Expect the app running from `~/Applications`, wallpaper on all displays, "Launch at login" toggles on and appears in System Settings → General → Login Items. With a real Claude session working in herdr, the city brightens within ~3s and the overlay shows the real token count.
- [ ] **Step 4: README.md + LICENSE (MIT, "Copyright (c) 2026 Dorukan Catak")** — README covers: what it is (credit the inspiration tweet), requirements (macOS 13+, Node ≥20, optional herdr), `make install`, `make dev` + slice URLs for browser development, config keys, how activity/tokens are computed, and troubleshooting (`~/Library/Logs/AgentCity/collector.log`).
- [ ] **Step 5: Commit and push** — `git add -A && git commit -m "feat: packaging, install, README" && git push`.
