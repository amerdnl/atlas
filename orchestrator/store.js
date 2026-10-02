import fs from 'node:fs';
import path from 'node:path';

/**
 * Local-first persistence for the ATLAS runtime. Flat files under one private directory:
 *
 *   <stateDir>/state/runtime-state.json    seq, agents, last owner, clean-shutdown marker
 *   <stateDir>/state/runtime.jsonl         runtime lifecycle log (start, recovery, shutdown)
 *   <stateDir>/state/runtime.lock          single-authority lock (lock.js)
 *   <stateDir>/runs/<taskId>/run.json      task snapshot (v2): task, artifact, sessions, costs
 *   <stateDir>/runs/<taskId>/events.jsonl  append-only: workflow + orchestration events
 *   <stateDir>/runs/<taskId>/sessions/     raw backend streams (never copied into events.jsonl)
 *
 * JSON snapshots are written temp-file → fsync → rename, so a crash leaves the previous version or
 * the new one, never a torn file. Readers skip a torn last JSONL line and report (never throw on)
 * malformed snapshots. Directories are 0700, files 0600: run data can contain source code.
 */
export const RECORD_VERSION = 2;

export function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  // Make the rename itself durable (best effort; not every filesystem allows fsync on a directory).
  try { const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch { /* ignore */ }
}

export function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, missing: e.code === 'ENOENT', error: e.message }; }
  try { return { ok: true, value: JSON.parse(text) }; } catch (e) { return { ok: false, missing: false, error: `malformed JSON: ${e.message}` }; }
}

export function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

/** All parseable lines; a torn final line (crash mid-append) or any malformed line is skipped. */
export function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { records: [], skipped: 0 }; }
  const records = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { skipped++; }
  }
  return { records, skipped };
}

const round = (n) => Math.round(n * 10_000) / 10_000;

/** Task cost from its sessions: total and per role (USD, as reported by the backend). */
export function costOf(sessions = []) {
  const byRole = {};
  let totalUsd = 0;
  for (const s of sessions) {
    if (!s.costUsd) continue;
    totalUsd += s.costUsd;
    byRole[s.role] = round((byRole[s.role] ?? 0) + s.costUsd);
  }
  return { totalUsd: round(totalUsd), byRole };
}

const TERMINAL = ['completed', 'failed', 'cancelled'];

/**
 * Bring any stored run record to the current (v2) shape. Phase 5 records (no `version`) keep their
 * content; missing fields get defaults. History is never rewritten — a Phase 5 "Cancelled by user"
 * stays a failed task, exactly as it was recorded.
 */
export function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('record is not an object');
  const task = raw.task;
  if (!task || typeof task.id !== 'string' || typeof task.stage !== 'string') throw new Error('record has no valid task');
  const legacy = raw.version === undefined;
  if (!legacy && raw.version !== RECORD_VERSION) throw new Error(`unsupported record version ${raw.version}`);
  const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
  return {
    version: RECORD_VERSION,
    taskId: task.id,
    requestId: raw.requestId ?? null,
    request: raw.request ?? task.description ?? task.title,
    createdAt: raw.createdAt ?? task.createdAt,
    updatedAt: raw.updatedAt ?? task.updatedAt,
    completedAt: raw.completedAt ?? (TERMINAL.includes(task.stage) ? task.updatedAt : null),
    task: { pause: null, pauses: [], cancellation: null, ...task },
    project: raw.project ?? null,
    artifact: raw.artifact ? { interventions: [], ...raw.artifact } : null,
    sessions,
    changes: raw.changes ?? null,
    decisions: Array.isArray(raw.decisions) ? raw.decisions.filter((d) => d && typeof d.requestId === 'string') : [],
    cost: costOf(sessions),
    ...(legacy ? { legacy: 'phase5' } : {}),
  };
}

/** One line of history for a record. */
export function summarize(r) {
  const t = r.task;
  return {
    taskId: r.taskId, title: t.title, project: r.project?.cwd ?? null,
    status: t.status, stage: t.stage, owner: t.owner,
    createdAt: r.createdAt, updatedAt: r.updatedAt, completedAt: r.completedAt,
    qaAttempts: (t.qaResults ?? []).length, attempt: t.attempt, costUsd: r.cost?.totalUsd ?? 0,
    reason: t.pause?.reason ?? t.cancellation?.reason ?? t.failure?.reason ?? null,
  };
}

export function createStore(stateDir) {
  const runsDir = path.join(stateDir, 'runs');
  const stateFile = path.join(stateDir, 'state', 'runtime-state.json');
  const runtimeLog = path.join(stateDir, 'state', 'runtime.jsonl');
  const runDir = (id) => path.join(runsDir, id);

  return {
    stateDir,
    runDir,
    saveRecord(record) { writeJsonAtomic(path.join(runDir(record.taskId), 'run.json'), record); },
    /** One record by task id (normalized), or null if missing/unreadable. */
    loadRecord(id) {
      if (!/^[\w.-]+$/.test(id)) return null;
      const r = readJson(path.join(runDir(id), 'run.json'));
      if (!r.ok) return null;
      try { return normalizeRecord(r.value); } catch { return null; }
    },
    /** Every run record; unreadable ones are reported in `problems`, never fatal. */
    loadAll() {
      const records = [], problems = [];
      let names = [];
      try { names = fs.readdirSync(runsDir); } catch { return { records, problems }; }
      for (const name of names) {
        const file = path.join(runDir(name), 'run.json');
        const r = readJson(file);
        if (!r.ok) { if (!r.missing) problems.push({ file, error: r.error }); continue; }
        try { records.push(normalizeRecord(r.value)); } catch (e) { problems.push({ file, error: e.message }); }
      }
      return { records, problems };
    },
    appendEvent(taskId, entry) { appendJsonl(path.join(runDir(taskId), 'events.jsonl'), entry); },
    readEvents(taskId) { return readJsonl(path.join(runDir(taskId), 'events.jsonl')); },
    /** Highest workflow seq recorded for a task (so a restored engine never reuses one). */
    lastSeq(taskId) {
      let max = 0;
      for (const e of readJsonl(path.join(runDir(taskId), 'events.jsonl')).records) if (Number.isInteger(e.seq) && e.seq > max) max = e.seq;
      return max;
    },
    sessionLogPath(taskId, sessionId) {
      const dir = path.join(runDir(taskId), 'sessions');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      return path.join(dir, `${sessionId}.jsonl`);
    },
    readState() { const r = readJson(stateFile); return r.ok && r.value && typeof r.value === 'object' ? r.value : null; },
    writeState(state) { writeJsonAtomic(stateFile, state); },
    logRuntime(entry) { appendJsonl(runtimeLog, entry); },
  };
}
