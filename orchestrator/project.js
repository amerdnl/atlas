import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

export class PreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PreflightError';
    this.code = code;
  }
}

/** Run git read-only in `dir`; resolves stdout (trimmed) or null on failure. */
export function git(dir, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout.replace(/\s+$/, '')));
  });
}

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

/**
 * Validate a task's target before anything runs. The directory must exist, be a directory, and be
 * inside a git repository (so every change is reviewable). A dirty working tree is refused unless
 * the user explicitly acknowledges it (`allowDirty`); ATLAS never resets, stashes or checks out
 * anything to "clean" it. A target inside ATLAS itself is refused unless explicitly allowed.
 * Every role session then runs in the returned `cwd`.
 */
export async function preflight(dir, { allowDirty = false, allowSelf = false, atlasRoot = null } = {}) {
  if (typeof dir !== 'string' || !dir.trim()) throw new PreflightError('no_cwd', 'a project directory (cwd) is required');
  if (!path.isAbsolute(dir)) throw new PreflightError('relative_cwd', `cwd must be an absolute path: ${dir}`);
  let cwd;
  try {
    cwd = await fs.realpath(dir);
    if (!(await fs.stat(cwd)).isDirectory()) throw new PreflightError('not_a_directory', `not a directory: ${dir}`);
  } catch (e) {
    if (e instanceof PreflightError) throw e;
    throw new PreflightError('missing_cwd', `directory does not exist: ${dir}`);
  }
  if (atlasRoot && !allowSelf) {
    const self = await fs.realpath(atlasRoot).catch(() => atlasRoot);
    if (inside(cwd, self)) throw new PreflightError('atlas_target', `${cwd} is inside ATLAS itself; pass allowSelf to target it deliberately`);
  }
  const root = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) throw new PreflightError('not_git', `${cwd} is not inside a git repository; ATLAS only works in git projects so every change is reviewable`);
  const [branch, head, status] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']),
    git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']),
  ]);
  const dirty = status ? status.split('\n').filter(Boolean) : [];
  if (dirty.length && !allowDirty) {
    throw new PreflightError('dirty', `${root} has uncommitted changes (${dirty.length} path${dirty.length === 1 ? '' : 's'}): ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}. Commit or stash them yourself, or pass allowDirty to proceed anyway.`);
  }
  return { cwd, root, branch: branch === 'HEAD' ? null : branch, head: head || null, dirtyAtStart: dirty };
}

/** What changed in the project since the task started (for Operations' final check and the run record). */
export async function changesSince(project) {
  const [status, diffStat] = await Promise.all([
    git(project.cwd, ['status', '--porcelain=v1', '--untracked-files=all']),
    project.head ? git(project.cwd, ['diff', '--stat', project.head]) : git(project.cwd, ['diff', '--stat']),
  ]);
  return { status: status ? status.split('\n').filter(Boolean) : [], diffStat: diffStat || '' };
}
