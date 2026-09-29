import * as THREE from 'three';
import { ATLAS_AREAS } from './atlas-areas.js';
import { LANDMARK, statusText } from './layouts.js';
import { createBuildings } from './buildings.js';
import { BREATHE_S } from './workflow-visuals.js';

const { podium: POD, tower: TWR, mastH, labelGapY, labelPx: LP, statusPx: SP } = LANDMARK;
const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;
const TAU = Math.PI * 2;
const WARN = new THREE.Color(0xff5a44);
// Idle (role off): trim and mast read as ordinary dark architecture.
const TRIM_OFF = new THREE.Color(0x1a1f2a);
const MAST_OFF = new THREE.Color(0x2a2f39);
const MAST_LOCAL = new THREE.Vector3(TWR.w * 0.22, TWR.h + mastH + 1.5, -TWR.d * 0.18);

function canvasTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

/** Map-style location label: small letter-spaced caps with a tiny color dot, drawn at device pixels. */
function labelTexture(text, color, dpr) {
  const s = dpr;
  const font = `600 ${LP.fontPx * s}px -apple-system, "SF Pro Text", system-ui, sans-serif`;
  const spacing = LP.fontPx * LP.letterSpacingEm * s;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = font;
  const chars = [...text].map((ch) => probe.measureText(ch).width);
  const textW = chars.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(LP.padX * 2 * s + LP.dot * s + 6 * s + textW);
  canvas.height = Math.ceil(LP.height * s);
  const ctx = canvas.getContext('2d');
  const mid = canvas.height / 2;
  ctx.fillStyle = hex(color);
  ctx.beginPath();
  ctx.arc(LP.padX * s + (LP.dot * s) / 2, mid, (LP.dot * s) / 2 - 0.5 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(214, 222, 236, 0.78)';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
  ctx.shadowBlur = 3 * s;
  let x = LP.padX * s + LP.dot * s + 6 * s;
  [...text].forEach((ch, i) => { ctx.fillText(ch, x, mid + 0.5 * s); x += chars[i] + spacing; });
  return canvasTexture(canvas);
}

/** The small status line under a name: lowercase, muted, no dot. */
function statusTexture(text, dpr) {
  const s = dpr;
  const font = `500 ${SP.fontPx * s}px -apple-system, "SF Pro Text", system-ui, sans-serif`;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = font;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(probe.measureText(text).width + SP.padX * 2 * s));
  canvas.height = Math.ceil(SP.height * s);
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(214, 222, 236, 0.6)';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
  ctx.shadowBlur = 3 * s;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 0.5 * s);
  return canvasTexture(canvas);
}

/**
 * Constant on-screen size, independent of distance and of which display slice renders it: with
 * sizeAttenuation off, a sprite of scale.y spans scale.y * cot(fov/2) * fullH / 2 CSS px.
 */
function screenSprite(tex, heightPx, pxToWorld, dpr) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, toneMapped: false,
  }));
  sprite.scale.set((tex.image.width / dpr) * pxToWorld, heightPx * pxToWorld, 1);
  sprite.renderOrder = 10;
  return sprite;
}

/**
 * The four ATLAS areas as ordinary city buildings (podium + modest tower, same shader and palette
 * as the city) identified by restrained accents in their role color: upper-floor windows, a thin
 * cornice and corner edge, a faint facade reflection, a tiny mast light, and a small label with an
 * optional status line. How lit each one is comes entirely from `update(sample)` — the workflow
 * visual state — so nothing here decides what an agent is doing.
 */
export function createLandmarks(layout, { haze, fog, fov, fullH, dpr }) {
  const group = new THREE.Group();
  const bodies = [];
  const corniceGeo = new THREE.BoxGeometry(TWR.w + 0.8, 2.2, TWR.d + 0.8);
  const edgeGeo = new THREE.BoxGeometry(1.6, TWR.h * 0.44, 1.6);
  const mastGeo = new THREE.BoxGeometry(1.4, mastH, 1.4);
  const lightGeo = new THREE.SphereGeometry(2.6, 10, 8);
  const rot = layout.gridAngle;
  const pxToWorld = (2 * Math.tan((fov * Math.PI) / 360)) / fullH;
  const anchors = {};
  const statusCache = new Map(); // text → texture, shared by all four landmarks
  const statusTex = (text) => {
    let tex = statusCache.get(text);
    if (!tex) {
      if (statusCache.size >= 32) { const [k, old] = statusCache.entries().next().value; old.dispose(); statusCache.delete(k); }
      tex = statusTexture(text, dpr);
      statusCache.set(text, tex);
    }
    return tex;
  };

  const parts = layout.areas.map(({ key, x, z }, i) => {
    const { color, label } = ATLAS_AREAS[key];
    const seed = 0.13 + i * 0.21;
    bodies.push({ x, z, w: POD.w, d: POD.d, h: POD.h, rot, seed });
    bodies.push({ x, z, w: TWR.w, d: TWR.d, h: TWR.h, rot, seed: seed + 0.07, accent: color, roleIndex: i });

    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rot;
    const roleColor = new THREE.Color(color);
    const edgeMat = new THREE.MeshBasicMaterial({ color: TRIM_OFF.clone() });
    const cornice = new THREE.Mesh(corniceGeo, edgeMat);
    cornice.position.y = TWR.h - 1.1;
    // One thin vertical edge on the tower corner nearest the camera (+z), upper part only.
    const [cu, cv] = [[1, 1], [1, -1], [-1, 1], [-1, -1]]
      .map(([su, sv]) => [su * TWR.w / 2, sv * TWR.d / 2])
      .reduce((best, c) => (-c[0] * Math.sin(rot) + c[1] * Math.cos(rot) > -best[0] * Math.sin(rot) + best[1] * Math.cos(rot) ? c : best));
    const edge = new THREE.Mesh(edgeGeo, edgeMat);
    edge.position.set(cu, TWR.h * 0.78, cv);
    const mast = new THREE.Mesh(mastGeo, new THREE.MeshBasicMaterial({ color: 0x0b0e15 }));
    mast.position.set(MAST_LOCAL.x, TWR.h + mastH / 2, MAST_LOCAL.z);
    const lightMat = new THREE.MeshBasicMaterial({ color: MAST_OFF.clone(), toneMapped: false });
    const light = new THREE.Mesh(lightGeo, lightMat);
    light.position.copy(MAST_LOCAL);
    g.add(cornice, edge, mast, light);
    group.add(g);
    anchors[key] = MAST_LOCAL.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), rot).add(new THREE.Vector3(x, 0, z));

    // Label block above the mast: the status line sits at the anchor, the name just above it.
    const labelY = TWR.h + mastH + labelGapY;
    const name = screenSprite(labelTexture(label, color, dpr), LP.height, pxToWorld, dpr);
    name.material.opacity = 0; // labels are transient: hidden until the role becomes active
    name.visible = false;
    name.center.set(0.5, -SP.height / LP.height);
    name.position.set(x, labelY, z);
    const status = [0, 1].map(() => {
      const sp = screenSprite(statusTex(' '), SP.height, pxToWorld, dpr);
      sp.center.set(0.5, 0);
      sp.position.set(x, labelY, z);
      sp.material.opacity = 0;
      return { sprite: sp, raw: null, text: null };
    });
    group.add(name, ...status.map((st) => st.sprite));

    return { key, roleColor, edgeMat, lightMat, name, status };
  });

  const bodyMesh = createBuildings(bodies, { haze, fog });
  group.add(bodyMesh.mesh);
  const roleUniforms = bodyMesh.uniforms.uRole.value;

  function showStatus(st, text, opacity, warn) {
    if (text && text !== st.raw) { // only when the text actually changes — not every frame
      st.raw = text;
      st.text = statusText(text);
      const tex = statusTex(st.text);
      st.sprite.material.map = tex;
      st.sprite.scale.x = (tex.image.width / dpr) * pxToWorld;
    }
    st.sprite.material.opacity = text ? opacity : 0;
    st.sprite.visible = st.sprite.material.opacity > 0;
    st.sprite.material.color.setRGB(1, 1 - 0.25 * warn, 1 - 0.35 * warn); // blocked: a slightly warm tint
  }

  return {
    group,
    /** World position of each area's mast light — where handoff paths start and end. */
    anchor: (key) => anchors[key],
    /**
     * Apply one sampled workflow visual state. `clock` is wall-clock seconds within the hour; every
     * period used here divides 3600, so the hourly wrap is seamless.
     */
    update(sample, clock) {
      bodyMesh.uniforms.uClock.value = clock;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i], r = sample.roles[p.key];
        roleUniforms[i].set(r.level, r.flow, r.wait, r.warn);
        // Role color only in proportion to the light level: at idle (level 0) the trim and mast are
        // plain dark architecture, indistinguishable from the rest of the city.
        const on = Math.min(1, r.level / 0.45);
        p.edgeMat.color.copy(TRIM_OFF).lerp(p.roleColor, on).multiplyScalar(1 - on + on * (0.3 + 0.45 * r.level));
        const breath = 1
          + 0.14 * r.flow * Math.sin(TAU * clock / BREATHE_S.working)
          + 0.16 * r.wait * Math.sin(TAU * clock / BREATHE_S.waiting)
          + 0.2 * r.warn * Math.sin(TAU * clock / BREATHE_S.blocked);
        p.lightMat.color.copy(MAST_OFF).lerp(p.roleColor, on).lerp(WARN, r.warn).multiplyScalar(1 - on + on * (0.6 + 0.9 * r.level) * breath);
        // Name and status line share the transient label visibility. Status lines crossfade
        // sequentially, never overlapping: the old one out in the first half, the new one in the second.
        p.name.material.opacity = r.label;
        p.name.visible = r.label > 0;
        const incoming = Math.min(1, Math.max(0, r.textMix * 2 - 1));
        const outgoing = r.prevText ? Math.min(1, Math.max(0, 1 - r.textMix * 2)) : 0;
        showStatus(p.status[0], r.text, r.label * (r.prevText ? incoming : r.textMix), r.warn);
        showStatus(p.status[1], r.prevText, r.label * outgoing, r.warn);
      }
    },
  };
}
