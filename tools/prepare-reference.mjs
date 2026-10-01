#!/usr/bin/env node
// Prepares the reference wallpaper art for the scene: removes the HUD that is baked into the
// reference image (the live HUD is drawn by the page) and writes a lossless PNG.
//
//   node tools/prepare-reference.mjs <reference.png> [out.png]
//
// Needs macOS `sips` (PNG <-> BMP); everything else is plain Node.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readBmp, writeBmp } from './bmp.mjs';

const [src, out = 'scene/assets/reference/atlas-reference.png'] = process.argv.slice(2);
if (!src) { console.error('usage: prepare-reference.mjs <reference.png> [out.png]'); process.exit(2); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ref-'));
const bmpIn = path.join(tmp, 'in.bmp'), bmpOut = path.join(tmp, 'out.bmp');
execFileSync('sips', ['-s', 'format', 'bmp', src, '--out', bmpIn], { stdio: 'ignore' });
const img = readBmp(bmpIn);
const { width: W, height: H, data } = img;
if (W !== 1672 || H !== 941) console.warn(`warning: expected the 1672x941 reference, got ${W}x${H}; HUD box scaled`);

// The baked HUD: a hairline rule plus three rows of text over flat, near-black foreground.
// Fill the box by interpolating its border (top/bottom rows, left/right columns), plus a
// whisper of noise so the patch doesn't read as perfectly flat.
const sx = W / 1672, sy = H / 941;
const x0 = Math.round(28 * sx), x1 = Math.round(232 * sx), y0 = Math.round(826 * sy), y1 = Math.round(906 * sy);
const at = (x, y, c) => data[(y * W + x) * 3 + c];
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
for (let y = y0 + 1; y < y1; y++) {
  for (let x = x0 + 1; x < x1; x++) {
    const u = (x - x0) / (x1 - x0), v = (y - y0) / (y1 - y0);
    for (let c = 0; c < 3; c++) {
      const vert = at(x, y0, c) * (1 - v) + at(x, y1, c) * v;
      const horiz = at(x0, y, c) * (1 - u) + at(x1, y, c) * u;
      data[(y * W + x) * 3 + c] = Math.max(0, Math.min(255, Math.round((vert + horiz) / 2 + (rnd() - 0.5) * 1.2)));
    }
  }
}
writeBmp(bmpOut, img);
fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync('sips', ['-s', 'format', 'png', bmpOut, '--out', out], { stdio: 'ignore' });
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${out} (${W}x${H}); removed the baked HUD box ${x0},${y0}..${x1},${y1}`);
