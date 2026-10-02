import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processInfo } from './procs.js';

export const lockPath = (stateDir) => path.join(stateDir, 'state', 'runtime.lock');

export function readLock(stateDir) {
  try { return JSON.parse(fs.readFileSync(lockPath(stateDir), 'utf8')); } catch { return null; }
}

/**
 * Is the runtime recorded in a lock still alive? Only a PID that is running AND has the recorded
 * start time counts as the same process; a dead PID, or one reused by a different process (other
 * start time), is stale. If identity can't be checked at all, the answer is "unknown" — never
 * assume the owner is gone.
 */
export function ownerState(lock, info = processInfo) {
  if (!lock || !Number.isInteger(lock.pid)) return { state: 'stale', why: 'the lock file is unreadable' };
  const p = info(lock.pid);
  let running = Boolean(p);
  if (!p) { try { process.kill(lock.pid, 0); running = true; } catch { running = false; } }
  if (!running) return { state: 'stale', why: `pid ${lock.pid} is no longer running` };
  if (p && lock.processStart && p.start !== lock.processStart) return { state: 'stale', why: `pid ${lock.pid} now belongs to a different process (started ${p.start})` };
  if (p && lock.processStart && p.start === lock.processStart) return { state: 'alive', why: `pid ${lock.pid} (port ${lock.port}) is running` };
  return { state: 'unknown', why: `pid ${lock.pid} is running but its identity cannot be verified` };
}

/**
 * Take ownership of a state directory: exactly one ATLAS runtime may orchestrate from it. The lock
 * file is created with O_EXCL; an existing lock is taken over only when it is provably stale (its
 * process is gone, or its PID was reused). Returns { ok, lock, takeover? } or { ok: false, owner, why }.
 */
export function acquireLock(stateDir, { port, pid = process.pid, info = processInfo } = {}) {
  const file = lockPath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const me = { pid, port, startedAt: Date.now(), processStart: info(pid)?.start ?? null, host: os.hostname() };
  let takeover = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeSync(fd, JSON.stringify(me)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return { ok: true, lock: me, takeover };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const existing = readLock(stateDir);
    const verdict = ownerState(existing, info);
    if (verdict.state !== 'stale') return { ok: false, owner: existing, why: verdict.why };
    takeover = { previous: existing, why: verdict.why };
    try { fs.unlinkSync(file); } catch { /* another starter removed it first; retry */ }
  }
  return { ok: false, owner: readLock(stateDir), why: 'could not take the lock (contention)' };
}

/** Release the lock — only if it is still ours. */
export function releaseLock(stateDir, lock) {
  const current = readLock(stateDir);
  if (current && current.pid === lock.pid && current.startedAt === lock.startedAt) {
    try { fs.unlinkSync(lockPath(stateDir)); return true; } catch { return false; }
  }
  return false;
}
