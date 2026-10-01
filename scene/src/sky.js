import * as THREE from 'three';
import { PALETTE } from './glsl.js';
import { CAMERA, TAN_HALF, mulberry32 } from './world.js';

export const HAZE = PALETTE.haze;

/**
 * A calm night sky: deep navy overhead easing to a slightly brighter horizon, and a sparse field
 * of static stars. World-space (a dome and points on it, not a screen-space background), so it
 * stays continuous when the canvas is sliced across several displays.
 */
export function createSky({ aspect, dpr, seed = 7, radius = 30000 }) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uHaze: { value: new THREE.Color(PALETTE.haze) }, uZenith: { value: new THREE.Color(PALETTE.zenith) } },
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uHaze, uZenith;
      varying vec3 vWorld;
      void main() {
        vec3 dir = normalize(vWorld - cameraPosition);
        float h = dir.y;
        vec3 col = mix(uHaze, uZenith, pow(clamp((h + 0.01) / 0.2, 0.0, 1.0), 0.6));
        col *= 1.0 + 0.1 * clamp(dir.x / 0.35, -1.0, 1.0) * (1.0 - smoothstep(0.0, 0.2, h)); // a slightly brighter sky to one side
        if (h < 0.0) col = uHaze * 0.7;
        col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0; // dither: no banding
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide, depthWrite: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), mat);
  dome.renderOrder = -2;
  dome.frustumCulled = false;

  // Stars: only where the frame can see, above the mountains; mostly faint, a few brighter.
  const rnd = mulberry32(seed * 131 + 5);
  const hHalf = Math.atan(TAN_HALF * aspect) + 0.05;
  const count = Math.round(120 * (aspect / (16 / 9)));
  const pos = new Float32Array(count * 3), data = new Float32Array(count * 2);
  const pitch = (CAMERA.pitchDeg * Math.PI) / 180, vHalf = Math.atan(TAN_HALF);
  for (let i = 0; i < count; i++) {
    const az = (rnd() * 2 - 1) * hHalf;
    const el = pitch - vHalf * 0.2 + rnd() * (vHalf * 1.3);
    pos.set([Math.sin(az) * Math.cos(el) * radius * 0.95, CAMERA.height + Math.sin(el) * radius * 0.95, -Math.cos(az) * Math.cos(el) * radius * 0.95], i * 3);
    const b = rnd();
    data.set([b > 0.9 ? 2.0 : 1.2 + rnd() * 0.5, b > 0.9 ? 0.8 : 0.22 + 0.34 * rnd()], i * 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aData', new THREE.BufferAttribute(data, 2));
  const stars = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms: { uDpr: { value: dpr } },
    vertexShader: /* glsl */`
      attribute vec2 aData; uniform float uDpr; varying float vB;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        float el = normalize(w.xyz - cameraPosition).y;
        vB = aData.y * smoothstep(0.045, 0.1, el); // fade out toward the horizon haze
        gl_PointSize = aData.x * uDpr;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      varying float vB;
      void main() {
        float a = smoothstep(0.5, 0.1, length(gl_PointCoord - 0.5)) * vB;
        gl_FragColor = vec4(vec3(0.86, 0.9, 1.0), a);
      }`,
    transparent: true, depthWrite: false,
  }));
  stars.renderOrder = -1;
  stars.frustumCulled = false;
  const group = new THREE.Group();
  group.add(dome, stars);
  return { group, mesh: group };
}
