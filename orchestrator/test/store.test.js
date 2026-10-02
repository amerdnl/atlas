import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic, readJson, appendJsonl, readJsonl, normalizeRecord, costOf, summarize, createStore } from '../store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-store-'));

test('atomic JSON: new content replaces old whole; a leftover temp file never shadows the good copy', () => {
  const dir = tmp();
  const file = path.join(dir, 'a', 'run.json');
  writeJsonAtomic(file, { v: 1 });
  fs.writeFileSync(path.join(dir, 'a', '.run.json.999.tmp'), '{"v": 2, "torn'); // crash mid-write of a later version
  assert.deepEqual(readJson(file).value, { v: 1 }, 'last known-good snapshot survives');
  writeJsonAtomic(file, { v: 3 });
  assert.deepEqual(readJson(file).value, { v: 3 });
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  assert.equal((fs.statSync(path.join(dir, 'a')).mode & 0o777).toString(8), '700');
});

test('readJson reports missing vs malformed without throwing', () => {
  const dir = tmp();
  assert.deepEqual([readJson(path.join(dir, 'nope')).ok, readJson(path.join(dir, 'nope')).missing], [false, true]);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
  const r = readJson(path.join(dir, 'bad.json'));
  assert.deepEqual([r.ok, r.missing], [false, false]);
  assert.match(r.error, /malformed JSON/);
});

test('JSONL append and read: a torn final line is skipped, order kept', () => {
  const file = path.join(tmp(), 'e', 'events.jsonl');
  appendJsonl(file, { seq: 1 });
  appendJsonl(file, { seq: 2 });
  fs.appendFileSync(file, '{"seq": 3, "ty');
  const r = readJsonl(file);
  assert.deepEqual(r.records.map((x) => x.seq), [1, 2]);
  assert.equal(r.skipped, 1);
});

test('cost totals and history summary', () => {
  const sessions = [{ role: 'research', costUsd: 0.1 }, { role: 'qa', costUsd: 0.25 }, { role: 'qa', costUsd: 0.05 }, { role: 'developer', costUsd: null }];
  assert.deepEqual(costOf(sessions), { totalUsd: 0.4, byRole: { research: 0.1, qa: 0.3 } });
  const r = normalizeRecord({ task: { id: 't', title: 'x', stage: 'cancelled', status: 'cancelled', owner: null, qaResults: [{}], attempt: 1, cancellation: { reason: 'nope' }, createdAt: 1, updatedAt: 2 }, project: { cwd: '/p' }, sessions });
  const s = summarize(r);
  assert.deepEqual([s.status, s.qaAttempts, s.costUsd, s.reason, s.project, s.completedAt], ['cancelled', 1, 0.4, 'nope', '/p', 2]);
});

test('Phase 5 records upgrade to v2 without rewriting history', () => {
  const v1 = { task: { id: 't1', title: 'x', description: 'Add multiply', stage: 'failed', status: 'failed', failure: { reason: 'Cancelled by user' }, createdAt: 1, updatedAt: 5 }, project: { cwd: '/p' }, artifact: { goal: 'g' }, sessions: [], active: false };
  const r = normalizeRecord(v1);
  assert.deepEqual([r.version, r.legacy, r.request, r.task.stage, r.task.failure.reason, r.task.pause, r.artifact.interventions], [2, 'phase5', 'Add multiply', 'failed', 'Cancelled by user', null, []]);
  assert.throws(() => normalizeRecord({ version: 9, task: { id: 't', stage: 'planning' } }), /unsupported record version/);
  assert.throws(() => normalizeRecord({ nope: true }), /no valid task/);
});

test('store: loadAll reports unreadable records instead of failing', () => {
  const dir = tmp();
  const store = createStore(dir);
  store.saveRecord(normalizeRecord({ task: { id: 'good', title: 'g', stage: 'completed', status: 'completed', createdAt: 1, updatedAt: 2 } }));
  fs.mkdirSync(path.join(dir, 'runs', 'bad'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'runs', 'bad', 'run.json'), '{"task": ');
  const { records, problems } = store.loadAll();
  assert.deepEqual(records.map((r) => r.taskId), ['good']);
  assert.equal(problems.length, 1);
  assert.equal(store.loadRecord('../../etc'), null, 'ids cannot escape the runs directory');
});
