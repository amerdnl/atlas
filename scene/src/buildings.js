import * as THREE from 'three';

/** All buildings as one instanced box mesh; windows are drawn procedurally in the fragment shader. */
export function createBuildings(city) {
  const list = city.buildings, n = list.length;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const seeds = new Float32Array(n), districts = new Float32Array(n), sizes = new Float32Array(n * 3);
  const uniforms = {
    uActivity: { value: 0 }, uTime: { value: 0 }, uPulse: { value: 0 }, uDistrict: { value: new Array(8).fill(0) },
    uFogColor: { value: new THREE.Color(0x0a0d14) }, uFogNear: { value: 3600 }, uFogFar: { value: 8500 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      attribute float aSeed; attribute float aDistrict; attribute vec3 aSize;
      varying vec3 vLocal; varying vec3 vN; varying float vSeed; varying float vDistrict; varying float vDepth;
      void main() {
        vLocal = (position + vec3(0.5, 0.0, 0.5)) * aSize;
        vN = normal; vSeed = aSeed; vDistrict = aDistrict;
        vec4 mv = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uActivity, uTime, uPulse; uniform float uDistrict[8];
      uniform vec3 uFogColor; uniform float uFogNear, uFogFar;
      varying vec3 vLocal; varying vec3 vN; varying float vSeed; varying float vDistrict; varying float vDepth;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec3 base = vec3(0.016, 0.019, 0.027) * (0.7 + 0.5 * clamp(vLocal.y / 250.0, 0.0, 1.0));
        vec3 col = base * 1.3;                                       // roofs
        if (abs(vN.y) < 0.5) {
          bool sideX = abs(vN.x) > 0.5;
          float u = sideX ? vLocal.z : vLocal.x;
          float face = sideX ? (vN.x > 0.0 ? 1.0 : 2.0) : (vN.z > 0.0 ? 3.0 : 4.0);
          vec2 cellSize = vec2(2.4, 3.3);
          vec2 q = vec2(u, vLocal.y) / cellSize;
          vec2 cell = floor(q), f = fract(q);
          float win = step(0.3, f.x) * step(f.x, 0.7) * step(0.3, f.y) * step(f.y, 0.72) * step(3.3, vLocal.y);
          float r = hash(cell + vec2(vSeed * 97.0, face * 13.0));
          float r2 = hash(cell.yx * 1.31 + vSeed * 31.0);
          float local = clamp(uActivity * (1.0 + uDistrict[int(vDistrict + 0.5)]), 0.0, 1.0);
          float litFrac = mix(0.04, 0.6, local);
          float drift = 0.05 * sin(uTime * (0.05 + uPulse * 0.5) + r2 * 6.2831);
          float lit = step(r * 0.65 + vSeed * 0.35 + drift, litFrac) * win;   // whole buildings tend to switch together
          vec3 warm = vec3(1.0, 0.68, 0.34), cool = vec3(0.72, 0.84, 1.0);
          vec3 wc = mix(warm, cool, step(0.58, r2)) * (0.35 + 0.75 * hash(cell * 1.7 + vSeed)) * (0.7 + 0.6 * local);
          col = base + base * win * 0.3;
          col = mix(col, wc, lit);
        }
        col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, vDepth) * 0.85);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  const m = new THREE.Matrix4();
  list.forEach((b, i) => {
    m.makeScale(b.w, b.h, b.d).setPosition(b.x, 0, b.z);
    mesh.setMatrixAt(i, m);
    seeds[i] = b.seed; districts[i] = b.district; sizes.set([b.w, b.h, b.d], i * 3);
  });
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  geo.setAttribute('aDistrict', new THREE.InstancedBufferAttribute(districts, 1));
  geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 3));
  mesh.frustumCulled = false;
  return { mesh, uniforms };
}
