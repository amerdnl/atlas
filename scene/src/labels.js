import * as THREE from 'three';
import { ATLAS_AREAS } from './atlas-areas.js';
import { LABEL, statusText } from './layouts.js';

const { labelPx: LP, statusPx: SP } = LABEL;
const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

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
 * Constant on-screen size: `pxToWorld` converts CSS px to world units at the label (for a
 * perspective camera with sizeAttenuation off it is 2·tan(fov/2)/fullH; for an orthographic
 * camera laid out in CSS px it is 1).
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
 * Transient role labels — name plus a short status line — at fixed anchors. Visibility comes only
 * from the sampled workflow visual state (`r.label`): hidden by default, shown briefly on
 * activation and handoff arrival, held while blocked. `anchors` maps role → [x, y, z].
 */
export function createRoleLabels(anchors, { pxToWorld, dpr }) {
  const group = new THREE.Group();
  const statusCache = new Map(); // text → texture, shared by all four labels
  const statusTex = (text) => {
    let tex = statusCache.get(text);
    if (!tex) {
      if (statusCache.size >= 32) { const [k, old] = statusCache.entries().next().value; old.dispose(); statusCache.delete(k); }
      tex = statusTexture(text, dpr);
      statusCache.set(text, tex);
    }
    return tex;
  };
  const parts = Object.entries(anchors).map(([key, [x, y, z]]) => {
    const { color, label } = ATLAS_AREAS[key];
    // The status line sits at the anchor, the name just above it.
    const name = screenSprite(labelTexture(label, color, dpr), LP.height, pxToWorld, dpr);
    name.center.set(0.5, -SP.height / LP.height);
    name.position.set(x, y, z);
    name.material.opacity = 0; // labels are transient: hidden until the role becomes active
    name.visible = false;
    const status = [0, 1].map(() => {
      const sp = screenSprite(statusTex(' '), SP.height, pxToWorld, dpr);
      sp.center.set(0.5, 0);
      sp.position.set(x, y, z);
      sp.material.opacity = 0;
      sp.visible = false;
      return { sprite: sp, raw: null, text: null };
    });
    group.add(name, ...status.map((st) => st.sprite));
    return { key, name, status };
  });

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
    /** Move the labels to new anchors (role → [x, y, z]), e.g. after the canvas was resized. */
    setAnchors(next) {
      for (const p of parts) {
        const a = next[p.key];
        if (!a) continue;
        p.name.position.set(a[0], a[1], a[2]);
        for (const st of p.status) st.sprite.position.set(a[0], a[1], a[2]);
      }
    },
    /** Apply one sampled workflow visual state (allocation-free). */
    update(sample) {
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i], r = sample.roles[p.key];
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
