import * as THREE from 'three';
import { FOG_GLSL, PALETTE } from './glsl.js';
import { LAND_Y, TAN_HALF } from './world.js';

const VERT = /* glsl */`
  varying vec3 vWorld; varying float vDepth; varying vec3 vWN;
  void main() {
  #ifdef TREE
    vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  #else
    vec4 w = modelMatrix * vec4(position, 1.0);
  #endif
    vWorld = w.xyz;
    vWN = normalize(mat3(modelMatrix) * normal);
    vec4 mv = viewMatrix * w;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;

const FRAG = /* glsl */`
  uniform vec3 uLand;
  varying vec3 vWorld; varying float vDepth; varying vec3 vWN;
  ${FOG_GLSL}
  void main() {
  #ifndef TREE
    if (vWorld.y < 0.0) discard; // only what stands above the water
  #endif
    float lightSide = max(dot(vWN, normalize(vec3(-0.4, 0.8, 0.45))), 0.0);
    vec3 col = uLand * (0.75 + 0.5 * lightSide);
    col = atmosphere(col, vDepth, vWorld.y);
    gl_FragColor = vec4(col, 1.0);
  }`;

/**
 * Land: the city's ground (a band from the shore back), the bay's islands and the dark foreground
 * hills — one merged mesh, static — plus instanced silhouette trees. Everything is dark and fades
 * with distance; its job is depth and framing, not detail.
 */
export function createTerrain(world, { atmosphere }) {
  const positions = [], indices = [];
  const grid = (nx, nz, at) => {
    const base = positions.length / 3;
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) positions.push(...at(i / nx, j / nz));
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = base + j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
  };

  // The city's ground: from just in front of the shore back past the city, flat.
  const { depth } = world.terrain.land;
  const aspect = world.aspect;
  grid(520, 2, (u, v) => {
    const f = -0.15 + 1.3 * u, D = world.shoreDist(f) + (v === 0 ? -6 : v < 1 ? 12 : depth);
    return [(2 * f - 1) * TAN_HALF * aspect * D, v === 0 ? -1 : LAND_Y, -D];
  });
  // Islands and hills: smooth mounds (height ≤ 0 is underwater and discarded by the shader).
  for (const m of world.terrain.mounds) {
    const near = -m.cz < 1000; // the framing hills need a finer grid so their shorelines don't stair-step
    grid(near ? 200 : 140, near ? 64 : 26, (u, v) => {
      const x = m.cx + (u * 2 - 1) * m.rx * 1.3, z = m.cz + (v * 2 - 1) * m.rz * 1.05;
      const y = world.moundHeight(m, x, z);
      return [x, Math.max(y, -6), z];
    });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const uniforms = { ...atmosphere, uLand: { value: new THREE.Color(PALETTE.land) } };
  const land = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG }));
  land.frustumCulled = false;

  const cone = new THREE.ConeGeometry(0.5, 1, 5).translate(0, 0.5, 0);
  const trees = new THREE.InstancedMesh(cone, new THREE.ShaderMaterial({
    uniforms: { ...atmosphere, uLand: { value: new THREE.Color(PALETTE.land).multiplyScalar(0.8) } },
    defines: { TREE: '' }, vertexShader: VERT, fragmentShader: FRAG,
  }), Math.max(1, world.trees.length));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  world.trees.forEach((t, i) => trees.setMatrixAt(i, m4.compose(p.set(t.x, t.y, t.z), q, s.set(t.w, t.h, t.w))));
  trees.count = world.trees.length;
  trees.frustumCulled = false;

  // Rock outcrops: low-poly, flat-shaded, a touch lighter than the ground so their faces catch the sky.
  const rockGeo = new THREE.DodecahedronGeometry(0.5, 0).translate(0, 0.5, 0);
  const rocks = new THREE.InstancedMesh(rockGeo, new THREE.ShaderMaterial({
    uniforms: { ...atmosphere, uLand: { value: new THREE.Color(PALETTE.land).multiplyScalar(1.25) } },
    defines: { TREE: '' }, vertexShader: VERT.replace('vWN = normalize(mat3(modelMatrix) * normal);', 'vWN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);'), fragmentShader: FRAG,
  }), Math.max(1, world.rocks.length));
  const up = new THREE.Vector3(0, 1, 0);
  world.rocks.forEach((r, i) => rocks.setMatrixAt(i, m4.compose(p.set(r.x, r.y, r.z), q.setFromAxisAngle(up, r.rot), s.set(r.w, r.h, r.d))));
  rocks.count = world.rocks.length;
  rocks.frustumCulled = false;

  // Islands and hills darken the water below them a little: the same land, mirrored, multiplied
  // over the water after it is drawn. One draw call; no reflection rendering.
  const shadow = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    vertexShader: /* glsl */`
      varying float vY;
      void main() { vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      varying float vY;
      void main() {
        if (vY < 0.5) discard; // only land that stands above the water casts a reflection
        float k = 0.72 + 0.28 * smoothstep(0.0, 1.0, 1.0 - min(1.0, vY / 40.0)); // darkest under the tallest ground
        gl_FragColor = vec4(vec3(k), 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.MultiplyBlending, premultipliedAlpha: true,
  }));
  shadow.scale.y = -1;
  shadow.renderOrder = 1.2; // right after the water, before the light streaks
  shadow.frustumCulled = false;

  const group = new THREE.Group();
  group.add(land, trees, rocks, shadow);
  return { group };
}
