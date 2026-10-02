import { execFileSync } from 'node:child_process';

/**
 * Process identity on macOS/BSD. A PID alone proves nothing — PIDs are reused — so identity is the
 * PID plus the process start time (`ps -o lstart`) and its command line.
 */
export function processInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '');
    if (!out.trim()) return null;
    return { pid, start: out.slice(0, 24).trim(), command: out.slice(24).trim() };
  } catch {
    return null; // not running (or ps unavailable — callers then treat identity as unproven)
  }
}

/**
 * True only when `pid` is alive AND its command line carries this exact Claude session id
 * (`--session-id <uuid>` or `--resume <uuid>`, which ATLAS assigned). A reused PID belonging to
 * anything else fails this check, so it is never touched.
 */
export function isManagedSession(pid, backendSessionId, info = processInfo) {
  if (!pid || typeof backendSessionId !== 'string' || backendSessionId.length < 8) return false;
  const p = info(pid);
  return Boolean(p && p.command.includes(backendSessionId));
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Terminate a verified process and its group (SIGTERM, then SIGKILL after a grace period).
 * Synchronous: used once at startup, before anything else runs. Only call after isManagedSession.
 */
export function terminateGroup(pid, { graceMs = 3000 } = {}) {
  const kill = (sig) => { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* gone */ } } };
  kill('SIGTERM');
  for (let waited = 0; waited < graceMs && alive(pid); waited += 50) sleep(50);
  if (alive(pid)) kill('SIGKILL');
  return !alive(pid);
}
