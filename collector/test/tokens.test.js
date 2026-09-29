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
// Files written now have today's mtime; tests pin "now" to NOW, so align mtimes to NOW's day.
function writeToday(file, data) {
  fs.writeFileSync(file, data);
  fs.utimesSync(file, NOW, NOW);
}
function appendToday(file, data) {
  fs.appendFileSync(file, data);
  fs.utimesSync(file, NOW, NOW);
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
  writeToday(path.join(root, 'proj', 's.jsonl'),
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
  writeToday(f, line('a', at(10), U(10, 20)) + line('a', at(10), U(10, 20)));
  const c = counter(root); c.scan();
  assert.equal(c.total, 30);
  appendToday(f, line('a', at(10), U(10, 50)));
  c.scan();
  assert.equal(c.total, 60);
});

test('partial line is counted once after completion', () => {
  const root = tmpRoot();
  const f = path.join(root, 'proj', 's.jsonl');
  const full = line('a', at(10), U(10, 20));
  writeToday(f, full.slice(0, 25));
  const c = counter(root); c.scan();
  assert.equal(c.total, 0);
  appendToday(f, full.slice(25));
  c.scan(); c.scan();
  assert.equal(c.total, 30);
});

test('finds files in nested dirs (subagents)', () => {
  const root = tmpRoot();
  const dir = path.join(root, 'proj', 'sess', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  writeToday(path.join(dir, 'agent-1.jsonl'), line('x', at(9), U(1, 1)));
  const c = counter(root); c.scan();
  assert.equal(c.total, 2);
});

test('includeCacheRead=false excludes cache reads', () => {
  const root = tmpRoot();
  writeToday(path.join(root, 'proj', 's.jsonl'), line('a', at(10), U(1, 1, 1, 1000)));
  const c = counter(root, { cache: false }); c.scan();
  assert.equal(c.total, 3);
});

test('midnight rollover resets the total', () => {
  const root = tmpRoot();
  const f = path.join(root, 'proj', 's.jsonl');
  let now = new Date(2026, 8, 28, 23, 59, 30);
  fs.writeFileSync(f, line('a', at(23, 59), U(10, 10)));
  fs.utimesSync(f, now, now);
  const c = new TokenCounter({ root, now: () => now });
  c.scan();
  assert.equal(c.total, 20);
  now = new Date(2026, 8, 29, 0, 0, 30);
  fs.appendFileSync(f, line('b', new Date(2026, 8, 29, 0, 0, 10).toISOString(), U(1, 2)));
  fs.utimesSync(f, now, now);
  c.scan();
  assert.equal(c.total, 3);
});

test('perMinute sums the last 60 seconds by message timestamp', () => {
  const root = tmpRoot();
  writeToday(path.join(root, 'proj', 's.jsonl'),
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
  writeToday(f, buf.subarray(0, cut));
  const c = counter(root); c.scan();
  appendToday(f, buf.subarray(cut));
  c.scan();
  assert.equal(c.total, 2);
});
