import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export function dayKey(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function usageTotal(u, includeCacheRead) {
  if (!u) return 0;
  return (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) +
    (includeCacheRead ? u.cache_read_input_tokens || 0 : 0);
}

export function listJsonl(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return out;
}

/**
 * Tails every Claude Code session log under `root` and keeps a running total of
 * today's token usage. Files are read incrementally from a remembered offset.
 */
export class TokenCounter {
  constructor({ root, includeCacheRead = true, now = () => new Date() }) {
    this.root = root;
    this.includeCacheRead = includeCacheRead;
    this.now = now;
    this.files = new Map(); // path -> { offset, rest, decoder }
    this.resetDay(dayKey(now()));
  }

  resetDay(key) {
    this.day = key;
    this.byId = new Map();
    this.total = 0;
    this.events = [];
  }

  ingestLine(text) {
    let o;
    try { o = JSON.parse(text); } catch { return; }
    const msg = o?.message;
    if (o?.type !== 'assistant' || !msg?.usage || !o.timestamp) return;
    const ts = new Date(o.timestamp);
    if (Number.isNaN(ts.getTime()) || dayKey(ts) !== this.day) return;
    const n = usageTotal(msg.usage, this.includeCacheRead);
    // The same message is logged once per content block with repeated usage; count it once, at its largest.
    const id = msg.id || o.uuid || text;
    const prev = this.byId.get(id) || 0;
    if (n <= prev) return;
    this.byId.set(id, n);
    this.total += n - prev;
    this.events.push({ t: ts.getTime(), n: n - prev });
  }

  ingestFile(file) {
    let st;
    try { st = fs.statSync(file); } catch { return; }
    let rec = this.files.get(file);
    if (!rec) {
      if (dayKey(st.mtime) !== this.day) return; // untouched today, nothing to count
      rec = { offset: 0, rest: '', decoder: new StringDecoder('utf8') };
      this.files.set(file, rec);
    }
    if (st.size < rec.offset) Object.assign(rec, { offset: 0, rest: '', decoder: new StringDecoder('utf8') });
    if (st.size === rec.offset) return;
    const buf = Buffer.alloc(st.size - rec.offset);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, rec.offset); } finally { fs.closeSync(fd); }
    rec.offset = st.size;
    const lines = (rec.rest + rec.decoder.write(buf)).split('\n');
    rec.rest = lines.pop(); // incomplete trailing line, finished on a later read
    for (const l of lines) if (l) this.ingestLine(l);
  }

  scan() {
    const key = dayKey(this.now());
    if (key !== this.day) this.resetDay(key);
    for (const f of listJsonl(this.root)) this.ingestFile(f);
    const cutoff = this.now().getTime() - 60_000;
    this.events = this.events.filter((e) => e.t >= cutoff);
  }

  get perMinute() {
    const cutoff = this.now().getTime() - 60_000;
    return this.events.reduce((s, e) => s + (e.t >= cutoff ? e.n : 0), 0);
  }
}
