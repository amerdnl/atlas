import * as THREE from 'three';
import { FOG_GLSL, PALETTE } from './glsl.js';

/**
 * The bay: one flat plane at y = 0, dark navy near the viewer and lighter toward the horizon,
 * where it reflects the haze. It is slightly see-through, which is the whole reflection system:
 * the mirrored city, mountains and light streaks drawn below it show through, dimmed. Static — no
 * animated waves, so a resting wallpaper costs nothing to keep on screen.
 */
export function createWater({ atmosphere }) {
  const geo = new THREE.PlaneGeometry(200000, 200000).rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...atmosphere, uNear: { value: new THREE.Color(PALETTE.water) }, uFar: { value: new THREE.Color(PALETTE.waterFar) } },
    vertexShader: /* glsl */`
      varying vec3 vWorld; varying float vDepth;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vec4 mv = viewMatrix * w;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uNear, uFar;
      varying vec3 vWorld; varying float vDepth;
      ${FOG_GLSL}
      void main() {
        vec3 v = normalize(cameraPosition - vWorld);
        float t = 1.0 - smoothstep(0.004, 0.11, v.y); // 0 looking down into the water, 1 at grazing angles
        vec3 col = mix(uNear, uFar, t * t);
        // Very faint, static swell bands: enough to read as water, never shimmer.
        float band = 0.5 + 0.5 * sin(vWorld.z * 0.07 + 2.0 * sin(vWorld.x * 0.011));
        col *= 0.95 + 0.07 * band * (1.0 - t);
        // The bay is a little lighter toward the city, catching its light.
        col += vec3(0.012, 0.014, 0.02) * smoothstep(1800.0, 3400.0, vDepth) * (1.0 - smoothstep(3600.0, 6000.0, vDepth));
        col = atmosphere(col, vDepth, 0.0);
        gl_FragColor = vec4(col, mix(0.9, 0.74, t));
      }`,
    transparent: true, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1; // after everything opaque, including the mirrored scene below it
  mesh.frustumCulled = false;
  return { mesh };
}
