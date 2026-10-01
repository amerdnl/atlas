import * as THREE from 'three';
import { REF, DISTRICTS, ROLE_ORDER, maskValue, districtLight, referenceLayout } from './reference-map.js';
import { ATLAS_AREAS } from './atlas-areas.js';
import { LABEL } from './layouts.js';
import { createRoleLabels } from './labels.js';
import { createHandoffPaths } from './handoff-paths.js';

const MASK_W = 512, MASK_H = 288;

/** The four district masks packed into one small RGBA texture (R ops, G research, B developer, A qa). */
function maskTexture() {
  const data = new Uint8Array(MASK_W * MASK_H * 4);
  for (let j = 0; j < MASK_H; j++) {
    const y = ((MASK_H - 1 - j) + 0.5) * (REF.height / MASK_H); // rows bottom-up, like texture v
    for (let i = 0; i < MASK_W; i++) {
      const x = (i + 0.5) * (REF.width / MASK_W), o = (j * MASK_W + i) * 4;
      ROLE_ORDER.forEach((role, c) => { data[o + c] = Math.round(255 * maskValue(role, x, y)); });
    }
  }
  const tex = new THREE.DataTexture(data, MASK_W, MASK_H, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

const FRAG = /* glsl */`
  uniform sampler2D uArt, uMask;
  uniform vec4 uLit, uGlow, uWarn; // per role: x operations, y research, z developer, w qa
  uniform vec4 uHue[4]; // per role: hue window (degrees), min saturation, min value
  varying vec2 vUv;
  vec3 hsv(vec3 c) {
    float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), d = mx - mn;
    float h = 0.0;
    if (d > 1e-5) h = mx == c.r ? mod((c.g - c.b) / d, 6.0) : mx == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0;
    return vec3(h * 60.0, mx > 0.0 ? d / mx : 0.0, mx);
  }
  // How much a pixel is this district's role-colored light (soft edges, no speckle).
  float roleLight(vec3 c, vec4 k, float lo, float hi) {
    vec3 h = hsv(c);
    if (lo < 0.0 && h.x > 180.0) h.x -= 360.0; // windows that wrap through red
    return smoothstep(lo - 8.0, lo + 4.0, h.x) * (1.0 - smoothstep(hi - 4.0, hi + 8.0, h.x))
      * smoothstep(k.z * 0.7, k.z * 1.25, h.y) * smoothstep(k.w * 0.75, k.w * 1.2, h.z);
  }
  void main() {
    vec3 art = texture2D(uArt, vUv).rgb; // the reference art, in display (sRGB) values
    vec4 m = texture2D(uMask, vUv);
    vec4 w = m * vec4(roleLight(art, uHue[0], uHue[0].x, uHue[0].y), roleLight(art, uHue[1], uHue[1].x, uHue[1].y),
                      roleLight(art, uHue[2], uHue[2].x, uHue[2].y), roleLight(art, uHue[3], uHue[3].x, uHue[3].y));
    // Idle: each district's role-colored light becomes neutral warm-white light of the same brightness.
    float l = dot(art, vec3(0.299, 0.587, 0.114));
    float v = max(art.r, max(art.g, art.b));
    // Neutral light of the same perceived brightness: bright lights warm white, dimmer facades the
    // cool grey of the moonlit city around them — and a little calmer than their role glow.
    vec3 tint = mix(vec3(0.9, 0.96, 1.1), vec3(1.07, 1.0, 0.88), smoothstep(0.28, 0.62, v));
    vec3 neutral = mix(l, v, 0.45) * tint * (0.78 + 0.22 * smoothstep(0.3, 0.7, v));
    float wAny = max(max(w.x, w.y), max(w.z, w.w)); // districts never overlap
    vec3 idle = mix(art, neutral, wAny);
    // Active: the district's own light from the reference comes back, then a breath more of it.
    vec4 lit = m * uLit;
    vec3 col = mix(idle, art, max(max(lit.x, lit.y), max(lit.z, lit.w)));
    col += max(art - idle, 0.0) * dot(w, uGlow);
    // Blocked: that light turns a restrained warning red.
    vec4 wn = w * uWarn;
    col = mix(col, mix(l, v, 0.45) * vec3(1.3, 0.55, 0.45) * 1.1, max(max(wn.x, wn.y), max(wn.z, wn.w)));
    gl_FragColor = vec4(col, 1.0);
  }`;

/**
 * The reference wallpaper scene: the approved artwork as the picture, with ATLAS's live layer on
 * top — each role district lighting up from its own reference light, transient labels, handoff
 * paths. A 2D scene in CSS px of the full multi-display canvas (one shared cover crop of the art);
 * each window renders its slice through the camera's view offset.
 */
export function createReferenceScene({ renderer, P, readView, invalidate }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1424);
  const camera = new THREE.OrthographicCamera(0, P.fullW, 0, -P.fullH, -100, 100);

  const art = new THREE.TextureLoader().load(REF.src, () => invalidate());
  art.colorSpace = THREE.NoColorSpace; // composite in the art's own display values; written out unchanged
  art.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const uniforms = {
    uArt: { value: art }, uMask: { value: maskTexture() },
    uLit: { value: new THREE.Vector4() }, uGlow: { value: new THREE.Vector4() }, uWarn: { value: new THREE.Vector4() },
    uHue: { value: ROLE_ORDER.map((r) => { const d = DISTRICTS[r]; return new THREE.Vector4(d.hue[0], d.hue[1], d.minSat, d.minValue); }) },
  };
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0.5, -0.5, 0), new THREE.ShaderMaterial({
    uniforms, depthTest: false, depthWrite: false,
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: FRAG,
  }));
  bg.frustumCulled = false;

  const names = Object.fromEntries(ROLE_ORDER.map((r) => [r, ATLAS_AREAS[r].label]));
  const pathAnchors = Object.fromEntries(ROLE_ORDER.map((r) => [r, new THREE.Vector3()]));
  const labels = createRoleLabels(Object.fromEntries(ROLE_ORDER.map((r) => [r, [0, 0, 2]])), { pxToWorld: 1, dpr: renderer.getPixelRatio() });
  const paths = createHandoffPaths({ anchor: (k) => pathAnchors[k], camera, fov: 0, fullH: P.fullH, ortho: true });
  scene.add(bg, paths.group, labels.group);

  /**
   * Lay everything out for the canvas as it is now: camera slice, the art's cover crop, and the
   * label and path anchors (reference px → canvas px → world, y up). Runs at load and on every
   * resize, so the art always fills the viewport — never a stale size with background showing.
   */
  const applyView = () => {
    const p = readView();
    Object.assign(camera, { left: 0, right: p.fullW, top: 0, bottom: -p.fullH });
    camera.setViewOffset(p.fullW, p.fullH, p.x, p.y, p.w, p.h);
    camera.updateProjectionMatrix();
    const L = referenceLayout(p, { LABEL, labels: names });
    bg.scale.set(L.art.w, L.art.h, 1);
    bg.position.set(L.art.x, -L.art.y, 0);
    for (const r of ROLE_ORDER) pathAnchors[r].set(L.paths[r][0], -L.paths[r][1], 1);
    labels.setAnchors(Object.fromEntries(ROLE_ORDER.map((r) => [r, [L.labels[r][0], -L.labels[r][1], 2]])));
    paths.invalidate();
  };
  applyView();

  const light = { lit: 0, glow: 0, warn: 0 };
  const channels = ['x', 'y', 'z', 'w'];
  return {
    applyView,
    /** One sampled workflow visual state (allocation-free). */
    update(visual, clock) {
      for (let i = 0; i < ROLE_ORDER.length; i++) {
        districtLight(visual.roles[ROLE_ORDER[i]], clock, light);
        uniforms.uLit.value[channels[i]] = light.lit;
        uniforms.uGlow.value[channels[i]] = light.glow;
        uniforms.uWarn.value[channels[i]] = light.warn;
      }
      labels.update(visual);
      paths.update(visual);
    },
    render() { renderer.render(scene, camera); },
    resize() {},
  };
}
