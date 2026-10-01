import * as THREE from 'three';
import { FOG_GLSL, PALETTE } from './glsl.js';
import { ROLE_INDEX } from './world.js';

export const KINDS = ['box', 'taper', 'wedge', 'cyl', 'dome'];
/** How much narrower a `taper` is at its top than at its base. */
export const TAPER = 0.38;

/** Unit primitives: footprint [-0.5, 0.5]², base at y = 0, top at y = 1. Flat-shaded. */
function geometryFor(kind) {
  if (kind === 'cyl') return new THREE.CylinderGeometry(0.5, 0.5, 1, 14).translate(0, 0.5, 0);
  if (kind === 'dome') return new THREE.SphereGeometry(0.5, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 2, 1);
  if (kind === 'taper') { // a square frustum: a chamfered, narrowing crown
    const g = new THREE.CylinderGeometry(0.5 * (1 - TAPER), 0.5, 1, 4, 1).rotateY(Math.PI / 4).scale(Math.SQRT2, 1, Math.SQRT2).translate(0, 0.5, 0).toNonIndexed();
    g.computeVertexNormals();
    return g;
  }
  const g = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  if (kind !== 'wedge') return g;
  const p = g.attributes.position; // a hall with a sloped roof: the +x side is lower
  for (let i = 0; i < p.count; i++) if (p.getY(i) > 0.99 && p.getX(i) > 0) p.setY(i, 0.38);
  const w = g.toNonIndexed();
  w.computeVertexNormals();
  return w;
}

const VERT = /* glsl */`
  attribute float aSeed; attribute vec3 aSize; attribute vec4 aAccent; attribute vec4 aStyle;
  uniform vec4 uRole[4];
  varying vec3 vLocal; varying vec3 vN; varying vec3 vWN; varying vec3 vWorld; varying vec3 vView;
  varying float vSeed; varying vec3 vSize; varying float vDepth; varying vec4 vAccent; varying vec4 vRole; varying vec4 vStyle;
  void main() {
    int ri = int(aAccent.a + 0.5) - 1;
    vRole = ri == 0 ? uRole[0] : ri == 1 ? uRole[1] : ri == 2 ? uRole[2] : ri == 3 ? uRole[3] : vec4(0.0);
    vLocal = (position + vec3(0.5, 0.0, 0.5)) * aSize;
    vN = normal;
    vWN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
    vSeed = aSeed; vSize = aSize; vAccent = aAccent; vStyle = aStyle;
    vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vView = normalize(cameraPosition - w.xyz);
    vec4 mv = viewMatrix * w;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;

const FRAG = /* glsl */`
  uniform float uActivity, uClock, uReflect; uniform vec3 uWall, uRoof, uWash;
  varying vec3 vLocal; varying vec3 vN; varying vec3 vWN; varying vec3 vWorld; varying vec3 vView;
  varying float vSeed; varying vec3 vSize; varying float vDepth; varying vec4 vAccent; varying vec4 vRole; varying vec4 vStyle;
  ${FOG_GLSL}
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  const float TAU = 6.2831853;
  void main() {
    float yf = clamp(vLocal.y / vSize.y, 0.0, 1.0);
    float flags = vStyle.w, wash = vStyle.x;
    bool accent = vAccent.a > 0.5;
    float level = vRole.x, flow = vRole.y, waiting = vRole.z, warn = vRole.w;
    vec3 roleCol = mix(vAccent.rgb, vec3(1.0, 0.36, 0.27), warn);
    float r2 = hash(vec2(vSeed * 53.0, 3.0));
    float wave = 0.5 + 0.5 * sin(TAU * (uClock / 3.0 - yf * 0.9 - r2 * 0.35));
    float breath = 0.5 + 0.5 * sin(TAU * uClock / 3.0);
    float slow = 0.5 + 0.5 * sin(TAU * uClock / 9.0);
    float motion = 1.0 + flow * (wave - 0.5) * 0.45 + waiting * (slow - 0.5) * 0.3;
    float roleBreath = 1.0 + 0.3 * flow * (breath - 0.5);

    // Facade coordinates: u runs along the face, halfW is the face's half width at this height.
  #if defined(KIND_CYL) || defined(KIND_DOME)
    float u = (atan(vLocal.z - 0.5 * vSize.z, vLocal.x - 0.5 * vSize.x) + 3.14159) * 0.5 * vSize.x;
    float faceW = 3.14159 * vSize.x, face = 1.0, halfW = 1e4;
  #else
    bool sideX = abs(vN.x) > abs(vN.z);
    float u = sideX ? vLocal.z : vLocal.x;
    float faceW = sideX ? vSize.z : vSize.x;
    float face = sideX ? (vN.x > 0.0 ? 1.0 : 2.0) : (vN.z > 0.0 ? 3.0 : 4.0);
    #ifdef KIND_TAPER
      float halfW = 0.5 * faceW * (1.0 - ${TAPER.toFixed(2)} * yf);
    #else
      float halfW = 0.5 * faceW;
    #endif
  #endif
    float edgeDist = halfW - abs(u - 0.5 * faceW); // distance to the nearest vertical edge
    // Each tower lights one of its vertical edges, like the reference's single bright lines.
    float litSide = step(0.5, hash(vec2(vSeed * 9.0, 4.0)));
    float stripDist = litSide > 0.5 ? (0.5 * faceW + halfW) - u : u - (0.5 * faceW - halfW);
    // Neutral architectural floodlight: warm and brightest at the base, fading to a dark crown.
    // Floodlights stand on the ground, so their falloff follows height above it, not each setback.
    float hy = clamp(abs(vWorld.y) / 240.0, 0.0, 1.0);
    vec3 tint = mix(vec3(1.08, 1.0, 0.9), vec3(0.92, 0.98, 1.1), step(0.5, hash(vec2(vSeed * 3.0, 8.0)))); // warm- or cool-lit
    vec3 washCol = mix(uWash * vec3(1.4, 1.12, 0.8), uWash * tint, smoothstep(0.0, 0.25, hy));
    float washProfile = 0.04 + 0.66 * pow(1.0 - hy, 2.6);
    float edgeLit = step(r2, 0.7) * step(0.25, wash); // most floodlit towers carry a vertical light strip
    float mullion = 0.93 + 0.07 * step(0.5, fract(u / 3.2));
    float activeFade = accent ? 1.0 - 0.7 * level : 1.0; // an active district's own color replaces its neutral light
    bool roof = vN.y > 0.5;

  #ifdef REFLECT
    // In the water only light survives, smeared into vertical streaks of different lengths and strengths.
    vec3 light = vec3(0.0);
    if (flags > 2.5) light = uWash * 0.8;
    else if (!roof) {
      light = washCol * wash * washProfile * activeFade * 0.9
            + vec3(1.0, 0.8, 0.56) * vStyle.y * 0.4 * (flags > 0.5 ? 0.0 : 1.0)
            + edgeLit * uWash * 0.8 * smoothstep(1.6, 0.3, stripDist);
      if (accent) light += roleCol * level * (0.12 + 0.6 * wash) * roleBreath;
    }
    float lane = floor((u + 0.9 * sin(vLocal.y * 0.3 + vSeed * 20.0)) / 2.6);
    float rs = hash(vec2(lane, vSeed * 71.0));
    float len = 0.1 + 0.9 * rs * rs;
    float streak = smoothstep(len, 0.0, yf) * (0.5 + 0.5 * step(0.28, fract(vLocal.y * 0.09 + rs * 5.0)));
    vec3 col = light * vec3(1.0, 0.9, 0.76) * streak * (0.12 + 0.88 * step(0.55, rs)) * uReflect; // warmer in the water
    col *= 1.0 - smoothstep(0.35, 0.7, atmosphereAmount(vDepth, abs(vWorld.y)));
    gl_FragColor = vec4(col, 1.0);
  #else
    float shade = 0.7 + 0.55 * max(dot(vWN, normalize(vec3(-0.5, 0.35, 0.8))), 0.0);
    vec3 col = uWall * shade * (0.9 + 0.25 * yf);
    #ifdef KIND_DOME
      float rim = pow(1.0 - max(dot(vWN, vView), 0.0), 2.0);
      col = uRoof * (0.8 + 0.4 * vN.y);
      col += uWash * wash * (0.3 + 0.7 * rim) * 0.75 * activeFade;
      if (accent) col += roleCol * level * (0.3 + 0.95 * rim) * roleBreath;
    #else
    if (roof) {
      col = uRoof;
      if (accent) col += roleCol * level * 0.05;
    } else if (flags > 2.5) {
      col = uWash * 1.0; // a light line: bridge rails and promenades
    } else if (flags > 1.5) {
      // An accent fin: dark architecture at rest, the district's light line while it works.
      col = uWall * 1.2;
      if (accent) col += roleCol * level * (0.4 + 0.9 * yf) * (0.8 + 0.4 * flow * breath + 0.2 * (1.0 - flow));
    } else {
      vec2 q = vec2(u, vLocal.y) / vec2(4.0, 4.8);
      vec2 f = fract(q);
      vec2 cell = floor(q);
      float win = step(0.26, f.x) * step(f.x, 0.74) * step(0.3, f.y) * step(f.y, 0.76)
                * step(3.0, edgeDist) * step(4.0, vLocal.y) * step(vLocal.y, vSize.y - 3.0);
      if (flags > 0.5) win = 0.0;
      // Each building has its own pattern: scattered rooms, lit floors, lit columns, or nearly dark.
      float mode = floor(hash(vec2(vSeed * 7.0, 11.0)) * 4.0);
      float dens = vStyle.y * (1.15 + 0.5 * uActivity);
      float pLit = mode < 0.5 ? dens
                 : mode < 1.5 ? step(hash(vec2(cell.y, vSeed * 13.0)), 0.28) * min(1.0, dens * 3.2)
                 : mode < 2.5 ? step(hash(vec2(cell.x + face * 7.0, vSeed * 17.0)), 0.25) * min(1.0, dens * 3.2)
                 : dens * 0.35;
      float r = hash(cell + vec2(vSeed * 97.0, face * 13.0));
      float lit = step(r, pLit) * win;
      vec3 warm = vec3(1.0, 0.78, 0.52), cool = vec3(0.78, 0.86, 1.0);
      float coolBias = step(1.0 - vStyle.z, hash(vec2(vSeed, 5.0))); // mostly one temperature per building…
      float temp = mix(coolBias, 1.0 - coolBias, step(0.82, hash(cell.yx + vSeed))); // …with exceptions
      vec3 wc = mix(warm, cool, temp) * (0.3 + 0.3 * hash(cell * 1.9 + vSeed));
      col += washCol * wash * washProfile * mullion * (0.6 + 0.4 * shade) * activeFade;
      col += edgeLit * uWash * 1.6 * smoothstep(1.5, 0.2, stripDist) * (0.3 + 0.7 * (1.0 - hy)) * activeFade;
      if (accent) {
        // Role light: the district's windows power on in its color and a colored wash rises on its facades.
        float on = smoothstep(r2, r2 + 0.08, 0.62 * level - 0.02);
        float accLit = on * win * step(hash(cell * 2.3 + vSeed), 0.75);
        col = mix(col, roleCol * (0.45 + 0.9 * level) * motion, accLit);
        lit *= 1.0 - accLit;
        col += roleCol * level * (0.1 + 0.6 * wash) * (0.45 + 0.55 * (1.0 - yf)) * mullion * roleBreath;
      }
      col = mix(col, wc, lit);
    }
    #endif
    col = atmosphere(col, vDepth, abs(vWorld.y));
    gl_FragColor = vec4(col, 1.0);
  #endif
  }`;

/**
 * All buildings as a few instanced meshes (one per primitive kind), plus a mirrored copy of each
 * for the water's reflection — the same shader with REFLECT: windows become broken vertical
 * streaks that fade with depth. Instances with a `role` belong to that role's district and are lit
 * by its live channels `uRole[roleIndex]` = (level, working flow, waiting pulse, warning); at level
 * 0 they are ordinary architecture. `uClock` is wall-clock seconds within the hour.
 */
export function createBuildings(list, { atmosphere, colors }) {
  const uniforms = {
    ...atmosphere,
    uActivity: { value: 0 }, uClock: { value: 0 },
    uWall: { value: new THREE.Color(PALETTE.wall) }, uRoof: { value: new THREE.Color(PALETTE.roof) },
    uWash: { value: new THREE.Color(0x7c879f) },
    uRole: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
  };
  const group = new THREE.Group();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3(), scl = new THREE.Vector3(), c = new THREE.Color();
  for (const kind of KINDS) {
    const items = list.filter((b) => b.kind === kind);
    if (!items.length) continue;
    const geo = geometryFor(kind);
    const n = items.length;
    const seeds = new Float32Array(n), sizes = new Float32Array(n * 3), accents = new Float32Array(n * 4), styles = new Float32Array(n * 4);
    const mats = [false, true].map((reflect) => new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uReflect: { value: reflect ? 0.68 : 1 } },
      defines: { [`KIND_${kind.toUpperCase()}`]: '', ...(reflect ? { REFLECT: '' } : {}) },
      vertexShader: VERT, fragmentShader: FRAG,
      ...(reflect ? { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false } : {}),
    }));
    const [mesh, mirror] = mats.map((mat) => new THREE.InstancedMesh(geo, mat, n));
    items.forEach((b, i) => {
      q.setFromAxisAngle(up, b.rot || 0);
      mesh.setMatrixAt(i, m.compose(pos.set(b.x, b.y, b.z), q, scl.set(b.w, b.h, b.d)));
      seeds[i] = b.seed;
      sizes.set([b.w, b.h, b.d], i * 3);
      if (b.role) { c.set(colors[b.role]); accents.set([c.r, c.g, c.b, ROLE_INDEX[b.role] + 1], i * 4); }
      styles.set([b.wash, b.density, b.cool, b.flags], i * 4);
    });
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 3));
    geo.setAttribute('aAccent', new THREE.InstancedBufferAttribute(accents, 4));
    geo.setAttribute('aStyle', new THREE.InstancedBufferAttribute(styles, 4));
    mirror.instanceMatrix = mesh.instanceMatrix; // the same instances…
    mirror.scale.y = -1; // …mirrored in the water plane, adding only their light on top of it
    mirror.renderOrder = 1.5;
    for (const x of [mesh, mirror]) { x.frustumCulled = false; group.add(x); }
  }
  return { group, uniforms };
}
