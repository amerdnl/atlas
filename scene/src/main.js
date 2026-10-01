import * as THREE from 'three';
import { readParams } from './params.js';
import { activityLevel, pulseLevel, easeToward } from './activity.js';
import { createReferenceScene } from './reference-scene.js';
import { createProceduralScene } from './procedural-scene.js';
import { createWorkflowVisuals, createSample } from './workflow-visuals.js';
import { createDemoDriver } from './workflow-demo.js';
import { connectWorkflow } from './workflow-client.js';
import { createOverlay } from './overlay.js';
import { connectStats } from './stats-client.js';
import { demoStats } from './demo.js';

const P = readParams(location.search, { w: innerWidth, h: innerHeight });
const readView = () => readParams(location.search, { w: innerWidth, h: innerHeight });

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NoToneMapping; // colors are authored in display values: what's written is what's seen
renderer.info.autoReset = false; // count every pass of a frame together (reset per frame below)
document.body.appendChild(renderer.domElement);

// The picture: the reference artwork with ATLAS's live layer on top (default), or the procedural
// city (`?scene=procedural`). Both share the same live inputs, frame policy and HUD below.
const view = P.scene === 'procedural'
  ? createProceduralScene({ renderer, P, readView })
  : createReferenceScene({ renderer, P, readView, invalidate: () => { lastDraw = 0; } });

// Bottom-left HUD (collector stats) on the display the app marks with overlay=1 (the left-most).
const overlayEl = document.getElementById('overlay');
overlayEl.hidden = !P.overlay;
const overlay = createOverlay(overlayEl);

// Two separate inputs, never mixed:
// - collector stats (overall Claude telemetry) → the HUD, and the city's neutral windows (subtly);
// - workflow events (ATLAS roles/tasks) → the four role districts, their labels and the handoff paths.
// Exactly one workflow source per page, chosen at load: the demo (in-memory, this page only) or
// the one authoritative ATLAS runtime (in the collector). Switching modes reloads the page, so
// demo state never reaches a live page and vice versa. With no task running every role is off.
const visuals = createWorkflowVisuals();
const visual = createSample();
const workflowDemo = P.workflowDemo ? createDemoDriver(visuals) : null;
if (!workflowDemo) connectWorkflow(visuals, { onChange: () => { lastDraw = 0; } }); // draw a new event on the next frame
// Animation time is the wall clock (shared by every display), optionally shifted for review.
const clockOffset = workflowDemo && P.demoAt >= 0 ? P.demoAt * 1000 - (Date.now() % workflowDemo.periodMs) : 0;
const frozenAt = P.freeze && workflowDemo && P.demoAt >= 0 ? Date.now() + clockOffset : null;
const wallClock = () => frozenAt ?? Date.now() + clockOffset;

const state = { a: 0, pulse: 0 };
let target = { a: 0, pulse: 0 };
let statsKey = '';
function applyStats(s) {
  target = s ? { a: activityLevel(s), pulse: pulseLevel(s.tokensPerMin) } : { a: 0, pulse: 0 };
  if (P.forceActivity >= 0) { target.a = P.forceActivity; state.a = P.forceActivity; }
  overlay.set(s);
  // Only a change that moves something on screen wakes an idle page (tokens are plain DOM text).
  const key = s ? `${target.a}|${s.projects}|${s.working}|${s.subagents}` : '';
  if (key !== statsKey) { statsKey = key; lastDraw = 0; }
}
if (P.demo) { const t0 = performance.now(); setInterval(() => applyStats(demoStats((performance.now() - t0) / 1000)), 500); }
else connectStats(applyStats);

let paused = false, last = performance.now(), lastDraw = 0, moving = true, lit = false, renders = 0;
function frame(now) {
  if (paused) return;
  requestAnimationFrame(frame);
  // Full frame rate only while something visibly moves (a light turning on/off, a working role's
  // flow, a label fading, a path); slow pulses and held labels redraw at 10 fps. A fully idle city
  // is static, so it is redrawn only when something changes (a new live event or stats update sets
  // lastDraw = 0), with a slow safety redraw.
  const fps = moving ? P.fps : lit || workflowDemo ? Math.min(P.fps, 10) : 0.5; // the demo steps on frames
  if (now - lastDraw < 1000 / fps - 2) return;
  lastDraw = now;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  state.a = easeToward(state.a, target.a, dt, 1);
  state.pulse = easeToward(state.pulse, target.pulse, dt, 1);
  const wall = wallClock();
  workflowDemo?.update(wall);
  visuals.sample(wall, visual);
  const clock = (wall % 3_600_000) / 1000;
  view.update(visual, clock, state.a);
  renderer.info.reset();
  view.render(dt);
  renders++;
  const hudMoving = overlay.tick(dt);
  moving = visual.busy || hudMoving || Math.abs(state.a - target.a) > 0.005;
  lit = visual.active;
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); // moving between displays can change it
  renderer.setSize(innerWidth, innerHeight);
  view.resize(innerWidth, innerHeight);
  view.applyView();
  lastDraw = 0;
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
    view.render(0);
    return new Promise((resolve) => renderer.domElement.toBlob(resolve, 'image/png'));
  },
  setOverlayBottom(px) { overlayEl.style.setProperty('--overlay-bottom', `${px}px`); },
  // Debug: how many frames were drawn, and the cost of the last one.
  info: () => ({ renders, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, moving, lit, busy: visual.busy, a: state.a, target: target.a }),
};
