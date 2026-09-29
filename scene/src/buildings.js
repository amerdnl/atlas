import * as THREE from 'three';

/**
 * Buildings as one instanced box mesh: solid dark volumes with faint face shading (so they read as
 * forms, not flat blobs), sparse window lights, and depth fog into the horizon haze. Windows near
 * the camera fade out so the foreground reads as silhouette. An instance may carry `accent` (a
 * color): a few of its upper-floor windows then glow in that color — used by the ATLAS landmarks,
 * so they share the city's architecture instead of looking like separate objects.
 */
export function createBuildings(list, { haze, fog, nearDark = [0, 0] }) {
  const n = list.length;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const seeds = new Float32Array(n), sizes = new Float32Array(n * 3), accents = new Float32Array(n * 4);
  // Palette as sRGB hex (THREE.Color converts to linear), so what's written here is what's seen.
  const uniforms = {
    uActivity: { value: 0 }, uTime: { value: 0 }, uPulse: { value: 0 },
    uWall: { value: new THREE.Color(0x141924) }, uRoof: { value: new THREE.Color(0x161b27) },
    uFogColor: { value: new THREE.Color(haze) }, uFogNear: { value: fog.near }, uFogFar: { value: fog.far },
    uNearDark: { value: new THREE.Vector2(...nearDark) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      attribute float aSeed; attribute vec3 aSize; attribute vec4 aAccent;
      varying vec3 vLocal; varying vec3 vN; varying vec3 vWN; varying float vSeed; varying vec3 vSize;
      varying float vDepth; varying vec4 vAccent;
      void main() {
        vLocal = (position + vec3(0.5, 0.0, 0.5)) * aSize;
        vN = normal;
        vWN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        vSeed = aSeed; vSize = aSize; vAccent = aAccent;
        vec4 mv = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uActivity; uniform vec3 uWall, uRoof, uFogColor; uniform float uFogNear, uFogFar; uniform vec2 uNearDark;
      varying vec3 vLocal; varying vec3 vN; varying vec3 vWN; varying float vSeed; varying vec3 vSize;
      varying float vDepth; varying vec4 vAccent;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        float grad = 0.8 + 0.35 * clamp(vLocal.y / 120.0, 0.0, 1.0);
        float shade = 0.72 + 0.6 * max(dot(vWN, normalize(vec3(-0.55, 0.45, 0.7))), 0.0);
        vec3 col = uWall * grad * shade;
        if (abs(vN.y) > 0.5) {
          col = uRoof;
        } else {
          bool sideX = abs(vN.x) > 0.5;
          float u = sideX ? vLocal.z : vLocal.x;
          float faceW = sideX ? vSize.z : vSize.x;
          float face = sideX ? (vN.x > 0.0 ? 1.0 : 2.0) : (vN.z > 0.0 ? 3.0 : 4.0);
          vec2 q = vec2(u, vLocal.y) / vec2(4.6, 5.4);
          vec2 cell = floor(q), f = fract(q);
          float win = step(0.28, f.x) * step(f.x, 0.72) * step(0.32, f.y) * step(f.y, 0.74)
                    * step(3.0, u) * step(u, faceW - 3.0) * step(4.5, vLocal.y) * step(vLocal.y, vSize.y - 3.0);
          float r = hash(cell + vec2(vSeed * 97.0, face * 13.0));
          float busy = hash(vec2(vSeed * 31.0, 7.0));
          float nearFade = smoothstep(uNearDark.x, uNearDark.y, vDepth);
          float litFrac = mix(0.003, 0.05, busy * busy) * (1.0 + 0.9 * uActivity) * nearFade;
          float lit = step(r, litFrac) * win;
          vec3 warm = vec3(1.0, 0.74, 0.46), cool = vec3(0.74, 0.84, 1.0);
          vec3 wc = mix(warm, cool, step(0.72, hash(cell.yx + vSeed))) * (0.32 + 0.22 * hash(cell * 1.9 + vSeed));
          if (vAccent.a > 0.0) {
            float yf = vLocal.y / vSize.y;
            col += vAccent.rgb * 0.014 * smoothstep(0.25, 1.0, yf); // faint reflected color, upper facade only
            float band = step(0.52, yf) * step(yf, 0.86);
            float accLit = step(hash(cell * 1.7 + vSeed * 5.0), 0.2) * band * win;
            col = mix(col, vAccent.rgb * 0.62 * vAccent.a, accLit);
            lit *= 1.0 - accLit;
          }
          col = mix(col, wc, lit);
        }
        col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, vDepth));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3(), scl = new THREE.Vector3(), c = new THREE.Color();
  list.forEach((b, i) => {
    q.setFromAxisAngle(up, b.rot || 0);
    mesh.setMatrixAt(i, m.compose(pos.set(b.x, 0, b.z), q, scl.set(b.w, b.h, b.d)));
    seeds[i] = b.seed;
    sizes.set([b.w, b.h, b.d], i * 3);
    if (b.accent != null) { c.set(b.accent); accents.set([c.r, c.g, c.b, 1], i * 4); }
  });
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 3));
  geo.setAttribute('aAccent', new THREE.InstancedBufferAttribute(accents, 4));
  mesh.frustumCulled = false;
  return { mesh, uniforms };
}
