import * as THREE from 'three';

/**
 * Night palette. HAZE is both the sky at the horizon and the fog color everything fades into, so
 * distant buildings dissolve seamlessly into the horizon instead of ending at a hard edge.
 */
export const HAZE = 0x19212e;
export const ZENITH = 0x05070c;

/**
 * A world-space gradient dome (not a screen-space background), so it stays continuous when the
 * canvas is sliced across several displays with setViewOffset.
 */
export function createSky(radius = 15000) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uHaze: { value: new THREE.Color(HAZE) }, uZenith: { value: new THREE.Color(ZENITH) } },
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
        float h = normalize(vWorld - cameraPosition).y;
        vec3 col = mix(uHaze, uZenith, smoothstep(0.0, 0.32, h));
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), mat);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  return { mesh };
}
