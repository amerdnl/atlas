import * as THREE from 'three';

export function createGround(city) {
  const { ox, oz, pitch, cols, rows, street } = city.grid;
  const W = cols * pitch + 3000, D = rows * pitch + 3000;
  const uniforms = {
    uActivity: { value: 0 }, uTime: { value: 0 }, uPulse: { value: 0 },
    uGrid: { value: new THREE.Vector4(ox, oz, pitch, street) },
    uFogColor: { value: new THREE.Color(0x0a0d14) }, uFogNear: { value: 3600 }, uFogFar: { value: 8500 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      varying vec2 vXZ; varying float vDepth;
      void main() {
        vXZ = position.xz;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uActivity; uniform vec4 uGrid; uniform vec3 uFogColor; uniform float uFogNear, uFogFar;
      varying vec2 vXZ; varying float vDepth;
      void main() {
        vec2 g = mod(vXZ - uGrid.xy, uGrid.z);
        vec2 dist = min(g, uGrid.z - g);                 // distance to nearest street centerline
        float onStreet = 1.0 - step(uGrid.w * 0.5, min(dist.x, dist.y));
        float edge = 1.0 - smoothstep(0.0, 1.2, abs(min(dist.x, dist.y) - uGrid.w * 0.5));
        vec3 block = vec3(0.012, 0.014, 0.019);
        vec3 road = vec3(0.016, 0.016, 0.02) + vec3(0.012, 0.005, 0.002) * uActivity;
        vec3 col = mix(block, road, onStreet) + vec3(0.006, 0.007, 0.01) * edge;
        col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, vDepth) * 0.85);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const geo = new THREE.PlaneGeometry(W, D);
  geo.rotateX(-Math.PI / 2);
  return { mesh: new THREE.Mesh(geo, mat), uniforms };
}
