import * as THREE from 'three';

/**
 * A faint glow of city light in the haze behind the central skyline: one additive quad, static.
 * It separates the lit city from the dark mountains behind it without any post-processing.
 */
export function createCityGlow(world) {
  const center = world.districts.find((d) => d.key === 'center');
  const [x, , z] = center.anchor;
  const w = 1500, h = 420, dist = -z + 1400;
  const geo = new THREE.PlaneGeometry(w, h).translate(x * (dist / -z), h * 0.32, -dist);
  const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vec2 p = (vUv - vec2(0.5, 0.3)) / vec2(0.5, 0.7);
        float g = pow(max(0.0, 1.0 - length(p)), 2.2); // reaches zero before the quad's edges
        gl_FragColor = vec4(vec3(0.05, 0.056, 0.072) * g, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  mesh.renderOrder = -0.8;
  mesh.frustumCulled = false;
  return { mesh };
}
