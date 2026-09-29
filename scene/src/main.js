import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { readParams } from './params.js';
import { generateCity } from './city.js';
import { activityLevel, pulseLevel, easeToward } from './activity.js';
import { createGround } from './ground.js';
import { createBuildings } from './buildings.js';
import { createLandmarks } from './landmarks.js';
import { createSky, HAZE } from './sky.js';
import { createOverlay } from './overlay.js';
import { connectStats } from './stats-client.js';
import { demoStats } from './demo.js';
import { LAYOUTS, pickLayout } from './layouts.js';

const P = readParams(location.search, { w: innerWidth, h: innerHeight });

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(HAZE);

// The canvas shape (1, 2 or 3 displays wide) picks the composition.
const layout = LAYOUTS[pickLayout(P.fullW / P.fullH, P.layout)];

// One camera frames the whole multi-display canvas; each window renders its own slice of it.
const camera = new THREE.PerspectiveCamera(layout.camera.fov, P.fullW / P.fullH, 10, 24000);
camera.position.set(...layout.camera.position);
camera.lookAt(...layout.camera.lookAt);
const applyView = () => {
  const p = readParams(location.search, { w: innerWidth, h: innerHeight });
  camera.aspect = p.fullW / p.fullH;
  camera.setViewOffset(p.fullW, p.fullH, p.x, p.y, p.w, p.h);
  camera.updateProjectionMatrix();
};
applyView();

// Everything is placed in world space by layouts.js/city.js — no group rotation to account for.
const env = { haze: HAZE, fog: layout.fog };
const city = generateCity({ seed: P.seed, layout });
const sky = createSky();
const ground = createGround(city, env);
const buildings = createBuildings(city.buildings, { ...env, nearDark: [layout.fog.near * 0.55, layout.fog.near * 0.9] });
const landmarks = createLandmarks(layout, { ...env, fov: layout.camera.fov, fullH: P.fullH, dpr: renderer.getPixelRatio() });
scene.add(sky.mesh, ground.group, buildings.mesh, landmarks.group);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.3, 0.35, 0.75);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// Stats HUD hidden for now — a minimal status UI may come back later. Forced off regardless of
// the `overlay` URL param (which the app still passes to the showcase display) so it's a purely
// scene-local, easily-reversible change; overlay.js/format.js are untouched underneath.
const overlayEl = document.getElementById('overlay');
overlayEl.hidden = true;
const overlay = createOverlay(overlayEl);

// `a`/`pulse` drive only the sparse background silhouette's subtle window flicker — the same
// stats transport the city already had. The four ATLAS landmarks are static this phase (no
// per-area role attribution yet); see landmarks.js for their local-clock-only beacon animation.
const state = { a: 0, pulse: 0 };
let target = { a: 0, pulse: 0 };
function applyStats(s) {
  target = s ? { a: activityLevel(s), pulse: pulseLevel(s.tokensPerMin) } : { a: 0, pulse: 0 };
  if (P.forceActivity >= 0) { target.a = P.forceActivity; state.a = P.forceActivity; }
  overlay.set(s);
}
if (P.demo) { const t0 = performance.now(); setInterval(() => applyStats(demoStats((performance.now() - t0) / 1000)), 500); }
else connectStats(applyStats);

let paused = false, last = performance.now(), lastDraw = 0;
function frame(now) {
  if (paused) return;
  requestAnimationFrame(frame);
  const settled = target.a === 0 && state.a < 0.005;
  const fps = settled ? Math.min(P.fps, 10) : P.fps;
  if (now - lastDraw < 1000 / fps - 2) return;
  lastDraw = now;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  state.a = easeToward(state.a, target.a, dt, 1);
  state.pulse = easeToward(state.pulse, target.pulse, dt, 1);
  for (const u of [ground.uniforms, buildings.uniforms]) {
    u.uActivity.value = state.a; u.uPulse.value = state.pulse; u.uTime.value = now / 1000;
  }
  landmarks.update(now / 1000);
  bloom.strength = 0.3 + 0.1 * state.a;
  composer.render(dt);
  overlay.tick(dt);
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  applyView();
});

window.atlas = {
  setPaused(p) {
    if (p === paused) return;
    paused = p;
    if (!p) { last = performance.now(); requestAnimationFrame(frame); }
  },
  setFps(f) { P.fps = f; },
  // Debug: render one frame and return the canvas as a PNG blob (used for screenshot tuning).
  capture() {
    composer.render(0);
    return new Promise((resolve) => renderer.domElement.toBlob(resolve, 'image/png'));
  },
  setOverlayBottom(px) { overlayEl.style.setProperty('--overlay-bottom', `${px}px`); },
};
