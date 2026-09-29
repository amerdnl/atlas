// Records the real scene frame by frame: 3×1080p panorama, virtual clock, scripted stats.
// Usage: node capture/capture.mjs [--seconds 30] [--from 0] [--out footage/panorama.mp4] [--still 12]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const promo = path.resolve(here, '..');
const sceneDir = path.resolve(promo, '../scene');
const story = JSON.parse(fs.readFileSync(path.join(promo, 'story.json'), 'utf8'));

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const W = 5760, H = 1080, FPS = story.fps;
const seconds = Number(arg('seconds', story.seconds));
const still = arg('still', null);
const out = path.resolve(promo, arg('out', 'footage/panorama.mp4'));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Collector stats at film time t (seconds): step through story keys, integrate tokens. */
export function statsAt(t) {
  let tokens = story.tokensAtStart, cur = story.stats[0];
  for (let i = 0; i < story.stats.length; i++) {
    const k = story.stats[i], end = Math.min(t, story.stats[i + 1]?.t ?? Infinity);
    if (k.t > t) break;
    cur = k;
    tokens += (k.tokensPerMin / 60) * Math.max(0, end - k.t);
  }
  return {
    source: 'claude-log', working: cur.working, subagents: cur.subagents, projects: cur.working,
    keys: cur.working ? ['agent-city'] : [], tokensToday: Math.floor(tokens), tokensPerMin: cur.tokensPerMin,
    updatedAt: Date.parse('2026-09-28T22:30:00') + t * 1000,
  };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.join(sceneDir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = p.endsWith('/') ? path.join(p, 'index.html') : p;
  if (!file.startsWith(sceneDir) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  args: [`--window-size=${W},${H}`, '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage();
page.on('console', (m) => console.log('[scene]', m.text()));
page.on('pageerror', (e) => console.error('[scene error]', e.message));
await page.evaluateOnNewDocument(fs.readFileSync(path.join(here, 'clock.js'), 'utf8'));
await page.goto(`http://127.0.0.1:${port}/?fullW=${W}&fullH=${H}&x=0&w=${W}&h=${H}`, { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelector('canvas'));
const cdp = await page.createCDPSession();
const shot = async (format) => Buffer.from((await cdp.send('Page.captureScreenshot', { format, optimizeForSpeed: true })).data, 'base64');

const dt = 1000 / FPS;
const total = Math.round(seconds * FPS);
const until = still != null ? Math.round(Number(still) * FPS) : total;
let lastPush = -1;
const advanceTo = async (f) => {
  const t = f / FPS;
  // The real collector pushes every ~500ms; push on the same cadence (and on the first frame).
  const slot = Math.floor(t * 2);
  if (slot !== lastPush) { lastPush = slot; await page.evaluate((s) => window.__capture.push(s), statsAt(t)); }
  await page.evaluate((ms) => window.__capture.step(ms), dt);
};

if (still != null) {
  for (let f = 0; f <= until; f++) await advanceTo(f);
  const file = path.join(promo, 'out', `still-${still}.png`);
  fs.writeFileSync(file, await shot('png'));
  console.log('wrote', file);
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '10', '-pix_fmt', 'yuv420p', '-tune', 'film', '-movflags', '+faststart', out],
  { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = Date.now();
  for (let f = 0; f < total; f++) {
    await advanceTo(f);
    const png = await shot('png');
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
    if (f % 60 === 0) console.log(`frame ${f}/${total}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  console.log('wrote', out);
}
await browser.close();
server.close();
