import * as THREE from 'three';

/**
 * Supporting environment on the ground: a near-black plane where only the avenues (every Nth street
 * of the city grid) are faintly lighter — anti-aliased and fading with distance, so the eye reads
 * "city" before "grid" — plus sparse warm streetlights along those avenues. Nothing here reacts
 * to activity.
 */
export function createGround(city, { haze, fog }) {
  const { angle, pitch, street, avenueEvery } = city.grid;
  const uniforms = {
    uActivity: { value: 0 }, uTime: { value: 0 }, uPulse: { value: 0 },
    uAngle: { value: angle }, uAvenue: { value: new THREE.Vector2(pitch * avenueEvery, street * 0.5) },
    uBase: { value: new THREE.Color(0x06080d) }, uRoad: { value: new THREE.Color(0x0b0e15) },
    uFogColor: { value: new THREE.Color(haze) }, uFogNear: { value: fog.near }, uFogFar: { value: fog.far },
  };
  const plane = new THREE.Mesh(
    (() => { const g = new THREE.PlaneGeometry(40000, 40000); g.rotateX(-Math.PI / 2); return g; })(),
    new THREE.ShaderMaterial({
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
        uniform float uAngle; uniform vec2 uAvenue; uniform vec3 uBase, uRoad;
        uniform vec3 uFogColor; uniform float uFogNear, uFogFar;
        varying vec2 vXZ; varying float vDepth;
        void main() {
          float c = cos(uAngle), s = sin(uAngle);
          vec2 g = vec2(vXZ.x * c - vXZ.y * s, vXZ.x * s + vXZ.y * c);   // world → street-grid frame
          vec2 m = mod(g + uAvenue.x * 0.5, uAvenue.x) - uAvenue.x * 0.5; // offset from nearest avenue
          vec2 aa = fwidth(g) * 1.2;
          vec2 road = 1.0 - smoothstep(uAvenue.y - aa, uAvenue.y + aa, abs(m));
          float onRoad = max(road.x, road.y) * (1.0 - smoothstep(1500.0, 5000.0, vDepth));
          vec3 col = mix(uBase, uRoad, onRoad);
          col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, vDepth));
          gl_FragColor = vec4(col, 1.0);
        }`,
    }),
  );

  const pts = new Float32Array(city.lights.length * 3);
  city.lights.forEach(([x, z], i) => pts.set([x, 5, z], i * 3));
  const lightGeo = new THREE.BufferGeometry();
  lightGeo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  const lights = new THREE.Points(lightGeo, new THREE.ShaderMaterial({
    uniforms: {
      uSize: { value: 1.6 * Math.min(devicePixelRatio, 2) },
      uFogColor: uniforms.uFogColor, uFogNear: uniforms.uFogNear, uFogFar: uniforms.uFogFar,
    },
    vertexShader: /* glsl */`
      uniform float uSize; varying float vDepth;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_PointSize = uSize;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uFogColor; uniform float uFogNear, uFogFar; varying float vDepth;
      void main() {
        vec3 col = mix(vec3(0.5, 0.36, 0.2), uFogColor, smoothstep(uFogNear, uFogFar, vDepth));
        gl_FragColor = vec4(col, 1.0);
      }`,
  }));
  lights.frustumCulled = false;

  const group = new THREE.Group();
  group.add(plane, lights);
  return { group, uniforms };
}
