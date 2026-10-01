import * as THREE from 'three';
import { FOG_GLSL } from './glsl.js';

/**
 * Small point lights — the waterfront, islands, bridges, a hillside road, the far shore — and, for
 * those near the water, a soft vertical streak on the water below them. Two draw calls, static.
 */
export function createLights(world, { atmosphere, dpr }) {
  const make = (list, reflect) => {
    const n = list.length;
    const pos = new Float32Array(n * 3), data = new Float32Array(n * 4);
    list.forEach((l, i) => {
      pos.set([l.x, reflect ? -l.y * 1.2 : l.y, l.z], i * 3);
      const k = Math.abs(Math.sin(l.x * 12.9898 + l.z * 78.233) * 43758.5453) % 1; // per-light variety
      data.set([l.size, l.warm, l.bright * (reflect ? 0.28 + 0.45 * k : 1), 0.5 + k], i * 4);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aData', new THREE.BufferAttribute(data, 4));
    const points = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms: { ...atmosphere, uDpr: { value: dpr } },
      defines: reflect ? { STREAK: '' } : {},
      vertexShader: /* glsl */`
        attribute vec4 aData; uniform float uDpr;
        varying vec4 vData; varying float vDepth; varying float vY;
        void main() {
          vData = aData;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vY = w.y;
          vec4 mv = viewMatrix * w;
          vDepth = -mv.z;
        #ifdef STREAK
          gl_PointSize = uDpr * aData.w * (10.0 + 16.0 * clamp(3000.0 / vDepth, 0.0, 1.0)); // square; the streak is drawn inside
        #else
          gl_PointSize = uDpr * aData.x * (1.0 + 0.6 * clamp(900.0 / vDepth, 0.0, 1.0));
        #endif
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying vec4 vData; varying float vDepth; varying float vY;
        ${FOG_GLSL}
        void main() {
          vec2 p = gl_PointCoord - 0.5;
        #ifdef STREAK
          float a = exp(-(p.x * p.x) * 380.0 - max(p.y + 0.35, 0.0) * 5.0) * smoothstep(-0.5, -0.38, p.y); // hangs down from the light
          a *= 0.7 + 0.3 * step(0.3, fract(p.y * 6.0 + vData.w * 3.0)); // broken by ripples
        #else
          float a = smoothstep(0.5, 0.12, length(p));
        #endif
          vec3 col = mix(vec3(0.84, 0.9, 1.0), vec3(1.0, 0.8, 0.55), vData.y) * vData.z;
          col = atmosphere(col, vDepth, abs(vY));
          gl_FragColor = vec4(col, a * clamp(vData.z * 1.6, 0.0, 1.0));
        }`,
      transparent: true, depthWrite: false,
    }));
    points.frustumCulled = false;
    return points;
  };
  const group = new THREE.Group();
  const lit = make(world.lights, false);
  lit.renderOrder = 2;
  const streaks = make(world.lights.filter((l) => l.reflect), true);
  streaks.material.blending = THREE.AdditiveBlending;
  streaks.renderOrder = 1.6; // added on top of the water
  group.add(lit, streaks);
  return { group };
}
