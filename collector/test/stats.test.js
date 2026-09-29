import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collect } from '../src/stats.js';

const fakeCounter = { scan() {}, total: 1234, perMinute: 56 };
const emptyRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ac-stats-'));

const activeLog = (root, dir, session) => {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, `${session}.jsonl`), '{}\n');
};

test('uses herdr when available and folds worktrees into projects', async () => {
  const s = await collect({
    herdr: async () => ({ total: 3, working: 2, blocked: 0, cwds: ['/r', '/r/.claude/worktrees/x'], sessions: new Set() }),
    claudeRoot: emptyRoot(), counter: fakeCounter, nowMs: Date.now(),
  });
  assert.equal(s.source, 'herdr+claude');
  assert.equal(s.working, 2);
  assert.equal(s.projects, 1);
  assert.deepEqual(s.keys, ['-r']);
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

test('merges herdr with claude sessions outside herdr, without double counting', async () => {
  const root = emptyRoot();
  activeLog(root, '-r', 'in-herdr');       // same session herdr reports → not counted twice
  activeLog(root, '-r', 'desktop-app');    // same project, session outside herdr → +1 agent, same project
  activeLog(root, '-other', 'terminal');   // another project outside herdr → +1 agent, +1 project
  const s = await collect({
    herdr: async () => ({ total: 2, working: 1, blocked: 0, cwds: ['/r'], sessions: new Set(['in-herdr', 'idle-one']) }),
    claudeRoot: root, counter: fakeCounter, nowMs: Date.now(),
  });
  assert.equal(s.working, 3);
  assert.equal(s.projects, 2);
  assert.deepEqual(s.keys.sort(), ['-other', '-r']);
});

test('a herdr agent that is idle stays idle even if its log was just written', async () => {
  const root = emptyRoot();
  activeLog(root, '-r', 'idle-one');
  const s = await collect({
    herdr: async () => ({ total: 1, working: 0, blocked: 0, cwds: [], sessions: new Set(['idle-one']) }),
    claudeRoot: root, counter: fakeCounter, nowMs: Date.now(),
  });
  assert.equal(s.working, 0);
});
