import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireLock, releaseLock, readLock, lockPath, ownerState } from '../lock.js';
import { processInfo, isManagedSession } from '../procs.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-lock-'));
const idle = (...args) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)', ...args], { stdio: 'ignore' });
const writeLock = (dir, lock) => { fs.mkdirSync(path.dirname(lockPath(dir)), { recursive: true }); fs.writeFileSync(lockPath(dir), JSON.stringify(lock)); };

test('lock: the first runtime owns the state directory; a second live owner is refused', () => {
  const dir = tmp();
  const a = acquireLock(dir, { port: 1 });
  assert.equal(a.ok, true);
  assert.equal((fs.statSync(lockPath(dir)).mode & 0o777).toString(8), '600');
  const b = acquireLock(dir, { port: 2 });
  assert.equal(b.ok, false);
  assert.match(b.why, /is running/);
  assert.equal(b.owner.port, 1);
  assert.equal(releaseLock(dir, a.lock), true);
  assert.equal(acquireLock(dir, { port: 3 }).ok, true, 'free again after release');
});

test('lock: an owner that has exited is stale and is taken over, with the reason recorded', async () => {
  const dir = tmp();
  const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => gone.on('exit', r));
  writeLock(dir, { pid: gone.pid, port: 9, processStart: 'Mon Jan  1 00:00:00 2024', startedAt: 1 });
  const got = acquireLock(dir, { port: 4 });
  assert.equal(got.ok, true);
  assert.match(got.takeover.why, /no longer running/);
  assert.equal(readLock(dir).port, 4);
});

test('lock: a PID reused by a different process is stale (start time differs); an unverifiable one is not', () => {
  const dir = tmp();
  const other = idle();
  const real = processInfo(other.pid);
  assert.ok(real, 'helper process is visible');
  writeLock(dir, { pid: other.pid, port: 9, processStart: 'Mon Jan  1 00:00:00 2024', startedAt: 1 });
  assert.equal(ownerState(readLock(dir)).state, 'stale');
  const got = acquireLock(dir, { port: 5 });
  assert.deepEqual([got.ok, /different process/.test(got.takeover.why)], [true, true]);
  writeLock(dir, { pid: other.pid, port: 9, processStart: null, startedAt: 1 });
  assert.equal(ownerState(readLock(dir)).state, 'unknown');
  assert.equal(acquireLock(dir, { port: 6 }).ok, false, 'never assume an unverifiable owner is gone');
  writeLock(dir, { pid: other.pid, port: 9, processStart: real.start, startedAt: 1 });
  assert.equal(ownerState(readLock(dir)).state, 'alive');
});

test('lock: an unreadable lock file is stale; releasing someone else’s lock does nothing', () => {
  const dir = tmp();
  writeLock(dir, {});
  fs.writeFileSync(lockPath(dir), '{ torn');
  const mine = acquireLock(dir, { port: 7 });
  assert.equal(mine.ok, true);
  assert.equal(releaseLock(dir, { pid: 1, startedAt: 0 }), false);
  assert.equal(readLock(dir).port, 7);
});

test('process identity: a live process counts as a managed session only if its command carries that session id', () => {
  const sid = '0f5c2a9e-1111-4222-8333-944455556666';
  const child = idle('--session-id', sid);
  assert.equal(isManagedSession(child.pid, sid), true);
  assert.equal(isManagedSession(child.pid, '0f5c2a9e-9999-4999-8999-999999999999'), false, 'same PID, different session: not ours');
  assert.equal(isManagedSession(process.pid, sid), false);
  assert.equal(isManagedSession(null, sid), false);
  assert.equal(processInfo(-5), null);
});
