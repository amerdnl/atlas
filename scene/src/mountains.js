import * as THREE from 'three';
import { PALETTE } from './glsl.js';

/**
 * Layered mountain silhouettes behind the city: flat strips at fixed distances, each a step
 * closer to the haze the farther away it is, with mist at their feet. Each strip continues below
 * the waterline as its own dimmed mirror image, so the far water carries a faint reflection.
 */
export function createMountains(world) {
  const group = new THREE.Group();
  const haze = new THREE.Color(PALETTE.haze);
  for (const layer of world.mountains) {
    const pts = layer.points, n = pts.length;
    const x0 = pts[0][0], x1 = pts[n - 1][0], top = Math.max(...pts.map((p) => p[1]));
    // The ridge profile as a 1-D texture, so the shader can shade facets from the ridge's shape.
    const data = new Uint16Array(n * 4);
    pts.forEach(([, y], i) => { data[i * 4] = THREE.DataUtils.toHalfFloat(y / top); data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1); });
    const ridge = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    ridge.minFilter = ridge.magFilter = THREE.LinearFilter;
    ridge.wrapS = THREE.ClampToEdgeWrapping;
    ridge.needsUpdate = true;
    const pos = [], idx = [];
    pts.forEach(([x, y], i) => {
      pos.push(x, y, -layer.dist, x, 0, -layer.dist, x, -y * 0.8, -layer.dist);
      if (i > 0) {
        const a = (i - 1) * 3, b = i * 3;
        idx.push(a, a + 1, b, b, a + 1, b + 1, a + 1, a + 2, b + 1, b + 1, a + 2, b + 2);
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(layer.color) }, uHaze: { value: haze }, uTop: { value: top }, uFacets: { value: layer.facets ?? 0.3 },
        uRidge: { value: ridge }, uSpan: { value: new THREE.Vector2(x0, x1 - x0) },
      },
      vertexShader: /* glsl */`
        varying vec2 vXY;
        void main() { vXY = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor, uHaze; uniform float uTop, uFacets; uniform sampler2D uRidge; uniform vec2 uSpan;
        varying vec2 vXY;
        float ridge(float x) { return texture2D(uRidge, vec2((x - uSpan.x) / uSpan.y, 0.5)).r * uTop; }
        void main() {
          float y = abs(vXY.y);
          float r = ridge(vXY.x);
          float d = max(r - y, 0.0);
          // Facets: the ridge's slope over a window that widens with depth below the crest, lit from the left.
          float w = 0.02 * uTop + d * 1.1;
          float slope = (ridge(vXY.x + w) - ridge(vXY.x - w)) / (2.0 * w);
          float lit = clamp(slope * 2.2, -1.0, 1.0) * exp(-d / (0.55 * uTop));
          vec3 col = uColor * (1.0 + uFacets * lit);
          col = mix(col, uHaze, 0.4 * exp(-(y / uTop) * 6.5)); // mist at the feet: separates each layer from the next
          if (vXY.y < 0.0) col = mix(uHaze * 0.45, col * 0.55, 0.7) * (1.0 - 0.5 * smoothstep(0.0, 0.6 * uTop, y)); // faint reflection
          col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
          gl_FragColor = vec4(col, 1.0);
        }`,
      side: THREE.DoubleSide,
    }));
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  return { group };
}
