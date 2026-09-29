import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { preflight, changesSince, PreflightError } from '../project.js';

function repo({ dirty = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-proj-')));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  if (dirty) fs.writeFileSync(path.join(dir, 'b.txt'), 'untracked\n');
  return dir;
}
const rejects = async (p, code) => assert.rejects(p, (e) => e instanceof PreflightError && e.code === code, code);

test('preflight: a clean git repository is accepted with root, branch and HEAD recorded', async () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, 'sub'));
  const p = await preflight(path.join(dir, 'sub'));
  assert.equal(p.cwd, path.join(dir, 'sub'), 'sessions run exactly where the user pointed');
  assert.equal(p.root, dir);
  assert.equal(p.branch, 'main');
  assert.match(p.head, /^[0-9a-f]{40}$/);
  assert.deepEqual(p.dirtyAtStart, []);
});

test('preflight: missing, relative, non-directory and non-git targets are refused', async () => {
  await rejects(preflight(''), 'no_cwd');
  await rejects(preflight('relative/path'), 'relative_cwd');
  await rejects(preflight('/nonexistent/atlas/xyz'), 'missing_cwd');
  const file = path.join(repo(), 'a.txt');
  await rejects(preflight(file), 'not_a_directory');
  await rejects(preflight(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-nogit-'))), 'not_git');
});

test('preflight: a dirty tree is refused unless explicitly acknowledged — and never touched', async () => {
  const dir = repo({ dirty: true });
  await assert.rejects(preflight(dir), (e) => e.code === 'dirty' && /b\.txt/.test(e.message));
  const p = await preflight(dir, { allowDirty: true });
  assert.deepEqual(p.dirtyAtStart, ['?? b.txt']);
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'untracked\n', 'the user change is still there');
});

test('preflight: ATLAS itself is refused as a target unless explicitly selected', async () => {
  const atlasRoot = path.resolve(import.meta.dirname, '..', '..');
  await rejects(preflight(path.join(atlasRoot, 'scene'), { atlasRoot, allowDirty: true }), 'atlas_target');
  const p = await preflight(atlasRoot, { atlasRoot, allowSelf: true, allowDirty: true });
  assert.equal(p.root, fs.realpathSync(atlasRoot));
});

test('changesSince reports what changed after the task started', async () => {
  const dir = repo();
  const p = await preflight(dir);
  fs.appendFileSync(path.join(dir, 'a.txt'), 'b\n');
  fs.writeFileSync(path.join(dir, 'c.txt'), 'new\n');
  const c = await changesSince(p);
  assert.deepEqual(c.status.sort(), [' M a.txt', '?? c.txt']);
  assert.match(c.diffStat, /a\.txt/);
});
