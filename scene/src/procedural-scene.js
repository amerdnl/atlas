import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { composeWorld, CAMERA } from './world.js';
import { createAtmosphere, PALETTE } from './glsl.js';
import { createSky } from './sky.js';
import { createMountains } from './mountains.js';
import { createCityGlow } from './glow.js';
import { createWater } from './water.js';
import { createTerrain } from './terrain.js';
import { createBuildings } from './buildings.js';
import { createLights } from './lights.js';
import { createDistricts } from './districts.js';
import { createHandoffPaths } from './handoff-paths.js';
import { ATLAS_AREAS } from './atlas-areas.js';

/**
 * The procedural city (Phase 6B): a composed 3D world under one shared perspective camera. Kept as
 * a fallback and for debugging (`?scene=procedural`); the default is the reference-art scene.
 */
export function createProceduralScene({ renderer, P, readView }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.zenith);
  const world = composeWorld({ aspect: P.fullW / P.fullH, seed: P.seed, layout: P.layout });

  // One camera frames the whole canvas; each window renders its own slice of it.
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, P.fullW / P.fullH, CAMERA.near, CAMERA.far);
  camera.position.set(0, CAMERA.height, 0);
  camera.rotation.x = (CAMERA.pitchDeg * Math.PI) / 180;
  const applyView = () => {
    const p = readView();
    camera.aspect = p.fullW / p.fullH;
    camera.setViewOffset(p.fullW, p.fullH, p.x, p.y, p.w, p.h);
    camera.updateProjectionMatrix();
  };
  applyView();

  const dpr = renderer.getPixelRatio();
  const atmosphere = createAtmosphere();
  const colors = Object.fromEntries(Object.entries(ATLAS_AREAS).map(([k, v]) => [k, v.color]));
  const sky = createSky({ aspect: P.fullW / P.fullH, dpr, seed: P.seed });
  const mountains = createMountains(world);
  const glow = createCityGlow(world);
  const water = createWater({ atmosphere });
  const terrain = createTerrain(world, { atmosphere });
  const buildings = createBuildings(world.buildings, { atmosphere, colors });
  const lights = createLights(world, { atmosphere, dpr });
  const districts = createDistricts(world, { buildings, fov: CAMERA.fov, fullH: P.fullH, dpr });
  const paths = createHandoffPaths({ anchor: districts.anchor, camera, fov: CAMERA.fov, fullH: P.fullH });
  scene.add(sky.group, mountains.group, glow.mesh, water.mesh, terrain.group, buildings.group, lights.group, districts.group, paths.group);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.35, 0.4, 0.62));
  composer.addPass(new OutputPass());

  return {
    applyView,
    /** One sampled workflow visual state; `activity` is the collector's overall level (neutral windows only). */
    update(visual, clock, activity) {
      buildings.uniforms.uActivity.value = activity;
      districts.update(visual, clock);
      paths.update(visual);
    },
    render(dt) { composer.render(dt); },
    resize(w, h) { composer.setSize(w, h); },
  };
}
