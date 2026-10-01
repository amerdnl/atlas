// Minimal uncompressed BMP read/write (24/32-bit), for the reference-art tooling. No dependencies:
// macOS `sips` converts PNG <-> BMP around it.
import fs from 'node:fs';

/** Read a BMP into { width, height, data: Uint8Array RGB, top-down }. */
export function readBmp(file) {
  const b = fs.readFileSync(file);
  const off = b.readUInt32LE(10), w = b.readInt32LE(18), hRaw = b.readInt32LE(22), bpp = b.readUInt16LE(28) / 8;
  const h = Math.abs(hRaw), stride = Math.ceil((w * bpp) / 4) * 4;
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const row = hRaw > 0 ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const i = off + row * stride + x * bpp, o = (y * w + x) * 3;
      data[o] = b[i + 2]; data[o + 1] = b[i + 1]; data[o + 2] = b[i];
    }
  }
  return { width: w, height: h, data };
}

/** Write a top-down RGB image as a 24-bit bottom-up BMP. */
export function writeBmp(file, { width: w, height: h, data }) {
  const stride = Math.ceil((w * 3) / 4) * 4, size = 54 + stride * h;
  const b = Buffer.alloc(size);
  b.write('BM', 0); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14); b.writeInt32LE(w, 18); b.writeInt32LE(h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28);
  b.writeUInt32LE(stride * h, 34);
  for (let y = 0; y < h; y++) {
    const row = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const i = 54 + row * stride + x * 3, o = (y * w + x) * 3;
      b[i] = data[o + 2]; b[i + 1] = data[o + 1]; b[i + 2] = data[o];
    }
  }
  fs.writeFileSync(file, b);
}
