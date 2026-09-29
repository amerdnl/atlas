import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHerdrList, runHerdr, scanClaudeActivity, projectKey, encodeCwd } from '../src/agents.js';

const herdrJson = (statuses) => JSON.stringify({ id: 'cli:agent:list', result: { type: 'agent_list', agents:
  statuses.map(([s, cwd, id]) => ({ agent: 'claude', agent_status: s, cwd, agent_session: id ? { kind: 'id', value: id } : undefined })) } });

test('parseHerdrList counts only working agents', () => {
  const r = parseHerdrList(herdrJson([['working', '/a'], ['idle', '/b'], ['blocked', '/c'], ['working', '/a/.claude/worktrees/x']]));
  assert.equal(r.total, 4);
  assert.equal(r.working, 2);
  assert.equal(r.blocked, 1);
  assert.deepEqual(r.cwds, ['/a', '/a/.claude/worktrees/x']);
});

test('parseHerdrList collects session ids of all herdr agents', () => {
  const r = parseHerdrList(herdrJson([['working', '/a', 's1'], ['idle', '/b', 's2'], ['working', '/c']]));
  assert.deepEqual([...r.sessions].sort(), ['s1', 's2']);
});

test('encodeCwd matches Claude project dir names', () => {
  assert.equal(encodeCwd('/Users/me/live-wallpaper'), '-Users-me-live-wallpaper');
  assert.equal(projectKey(encodeCwd('/Users/me/app/.claude/worktrees/feat')), '-Users-me-app');
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
  assert.deepEqual(r.active.map((x) => `${x.key}/${x.session}`).sort(), ['-a/s1', '-a/s2']);
  assert.equal(r.subagents, 2);
});

test('scanClaudeActivity tolerates a missing root', () => {
  assert.deepEqual(scanClaudeActivity('/nonexistent/x', Date.now()), { active: [], subagents: 0 });
});
