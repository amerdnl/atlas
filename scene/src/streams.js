import * as THREE from 'three';
import { easeToward } from './activity.js';

const MAX_QUADS = 9000;
const WHITE = [1.3, 1.2, 1.1], RED = [1.5, 0.22, 0.1], ORANGE = [1.4, 0.55, 0.14], CYAN = [0.35, 1.1, 1.4];
const Y = 0.8;

/**
 * Tron-style light streams: heads that drive along the street grid (and a two-way highway),
 * each dragging a long additive ribbon that fades toward its tail. Streams only live inside the
 * layout's world-space box (the part of the grid the camera can see).
 */
export function createStreams(city, rnd, { box: VISIBLE, street: MAX_STREET, highway: MAX_HIGHWAY }) {
  const { ox, oz, pitch, cols, rows } = city.grid;
  const pos = new Float32Array(MAX_QUADS * 12), col = new Float32Array(MAX_QUADS * 12);
  const idx = new Uint32Array(MAX_QUADS * 6);
  for (let q = 0; q < MAX_QUADS; q++) { const v = q * 4; idx.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], q * 6); }
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('color', colAttr);
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  }));
  mesh.frustumCulled = false;

  const cos = Math.cos(city.rotation), sin = Math.sin(city.rotation);
  const node = (i, j) => [ox + i * pitch, oz + j * pitch];
  const visible = (i, j) => {
    const [x, z] = node(i, j);
    const wx = x * cos + z * sin, wz = -x * sin + z * cos;
    return wx > VISIBLE.minX && wx < VISIBLE.maxX && wz > VISIBLE.minZ && wz < VISIBLE.maxZ;
  };
  const valid = (i, j) => i >= 0 && j >= 0 && i <= cols && j <= rows && visible(i, j);
  const nodes = [];
  for (let i = 0; i <= cols; i++) for (let j = 0; j <= rows; j++) if (valid(i, j)) nodes.push([i, j]);
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const pickColor = () => { const r = rnd(); return r < 0.05 ? CYAN : r < 0.55 ? WHITE : r < 0.85 ? RED : ORANGE; };

  function turn(s, allowReverse) {
    const opts = DIRS.filter(([a, b]) => valid(s.i + a, s.j + b) && (allowReverse || a !== -s.di || b !== -s.dj));
    const pool = opts.length ? opts : DIRS.filter(([a, b]) => valid(s.i + a, s.j + b));
    const straight = pool.find(([a, b]) => a === s.di && b === s.dj);
    [s.di, s.dj] = straight && rnd() < 0.7 ? straight : pool[Math.floor(rnd() * pool.length)];
  }

  const streets = Array.from({ length: MAX_STREET }, () => {
    const [i, j] = nodes[Math.floor(rnd() * nodes.length)];
    const s = { i, j, di: 1, dj: 0, t: rnd(), speed: 35 + rnd() * 45, len: 80 + rnd() * 170, fade: 0, color: pickColor(), trail: [] };
    turn(s, true);
    s.trail.push(node(s.i, s.j));
    return s;
  });

  const hw = city.highway;
  const hwLen = Math.hypot(hw.bx - hw.ax, hw.bz - hw.az);
  const hdx = (hw.bx - hw.ax) / hwLen, hdz = (hw.bz - hw.az) / hwLen;
  const highway = Array.from({ length: MAX_HIGHWAY }, (_, k) => {
    const forward = k % 2 === 0;
    const lane = (forward ? 1 : -1) * (3 + 5 * (Math.floor(k / 2) % 2));
    return { u: rnd(), forward, lane, speed: 110 + rnd() * 80, len: 160 + rnd() * 240, fade: 0, color: forward ? WHITE : RED };
  });

  let q = 0;
  function quad(x1, z1, x0, z0, nx, nz, c, a1, a0) {
    if (q >= MAX_QUADS) return;
    const p = q * 12;
    pos.set([x1 + nx, Y, z1 + nz, x1 - nx, Y, z1 - nz, x0 + nx, Y, z0 + nz, x0 - nx, Y, z0 - nz], p);
    col.set([c[0] * a1, c[1] * a1, c[2] * a1, c[0] * a1, c[1] * a1, c[2] * a1,
      c[0] * a0, c[1] * a0, c[2] * a0, c[0] * a0, c[1] * a0, c[2] * a0], p);
    q++;
  }

  // points: head first, then older corners. Draws a ribbon whose brightness fades to 0 at `len`.
  function ribbon(points, len, c, width, alpha) {
    let dist = 0;
    for (let k = 0; k < points.length - 1 && dist < len; k++) {
      const [x1, z1] = points[k], [xb, zb] = points[k + 1];
      const dx = xb - x1, dz = zb - z1, L = Math.hypot(dx, dz);
      if (L < 1e-3) continue;
      const take = Math.min(L, len - dist);
      const x0 = x1 + (dx * take) / L, z0 = z1 + (dz * take) / L;
      const nx = (-dz / L) * width * 0.5, nz = (dx / L) * width * 0.5;
      const a1 = alpha * (1 - dist / len) ** 1.6, a0 = alpha * (1 - (dist + take) / len) ** 1.6;
      quad(x1, z1, x0, z0, nx, nz, c, a1, a0);
      if (dist === 0) { const h = Math.min(6, take); quad(x1, z1, x1 + (dx * h) / L, z1 + (dz * h) / L, nx * 1.3, nz * 1.3, c, alpha * 1.6, alpha); }
      dist += take;
    }
  }

  function update(dt, { a, pulse }) {
    q = 0;
    const nStreet = Math.round(10 + a * (MAX_STREET - 10)), nHw = Math.round(16 + a * (MAX_HIGHWAY - 16));
    const speedMul = (0.55 + 0.45 * a) * (1 + 0.8 * pulse);
    streets.forEach((s, k) => {
      s.fade = easeToward(s.fade, k < nStreet ? 1 : 0, dt, 0.8);
      if (s.fade < 0.01) return;
      s.t += (s.speed * speedMul * dt) / pitch;
      while (s.t >= 1) {
        s.t -= 1; s.i += s.di; s.j += s.dj;
        s.trail.push(node(s.i, s.j));
        if (s.trail.length > 8) s.trail.shift();
        turn(s, false);
      }
      const [nx0, nz0] = node(s.i, s.j);
      const head = [nx0 + s.di * pitch * s.t, nz0 + s.dj * pitch * s.t];
      const pts = [head];
      for (let m = s.trail.length - 1; m >= 0; m--) pts.push(s.trail[m]);
      ribbon(pts, s.len, s.color, 1.8, s.fade * 0.85);
    });
    highway.forEach((h, k) => {
      h.fade = easeToward(h.fade, k < nHw ? 1 : 0, dt, 0.8);
      if (h.fade < 0.01) return;
      const du = (h.speed * speedMul * dt) / hwLen;
      h.u += h.forward ? du : -du;
      const margin = h.len / hwLen;
      if (h.forward && h.u > 1 + margin) h.u = -0.02;
      if (!h.forward && h.u < -margin) h.u = 1.02;
      const px = -hdz * h.lane, pz = hdx * h.lane;
      const hx = hw.ax + hdx * hwLen * h.u + px, hz = hw.az + hdz * hwLen * h.u + pz;
      const sgn = h.forward ? -1 : 1;
      ribbon([[hx, hz], [hx + sgn * hdx * h.len, hz + sgn * hdz * h.len]], h.len, h.color, 1.8, h.fade * 0.3);
    });
    geo.setDrawRange(0, q * 6);
    posAttr.clearUpdateRanges(); posAttr.addUpdateRange(0, q * 12); posAttr.needsUpdate = true;
    colAttr.clearUpdateRanges(); colAttr.addUpdateRange(0, q * 12); colAttr.needsUpdate = true;
  }

  return { mesh, update };
}
