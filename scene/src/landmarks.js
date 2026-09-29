import * as THREE from 'three';
import { ATLAS_AREAS } from './atlas-areas.js';
import { LANDMARK } from './layouts.js';
import { createBuildings } from './buildings.js';

const { podium: POD, tower: TWR, mastH, labelGapY, labelPx: LP } = LANDMARK;
const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

/** Map-style location label: small letter-spaced caps with a tiny color dot, drawn at device pixels. */
function labelTexture(text, color, dpr) {
  const s = dpr;
  const font = `600 ${LP.fontPx * s}px -apple-system, "SF Pro Text", system-ui, sans-serif`;
  const spacing = LP.fontPx * LP.letterSpacingEm * s;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = font;
  const chars = [...text].map((ch) => probe.measureText(ch).width);
  const textW = chars.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(LP.padX * 2 * s + LP.dot * s + 6 * s + textW);
  canvas.height = Math.ceil(LP.height * s);
  const ctx = canvas.getContext('2d');
  const mid = canvas.height / 2;
  ctx.fillStyle = hex(color);
  ctx.beginPath();
  ctx.arc(LP.padX * s + (LP.dot * s) / 2, mid, (LP.dot * s) / 2 - 0.5 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(214, 222, 236, 0.78)';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
  ctx.shadowBlur = 3 * s;
  let x = LP.padX * s + LP.dot * s + 6 * s;
  [...text].forEach((ch, i) => { ctx.fillText(ch, x, mid + 0.5 * s); x += chars[i] + spacing; });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

/**
 * Constant on-screen size, independent of distance and of which display slice renders it: with
 * sizeAttenuation off, a sprite of scale.y spans scale.y * cot(fov/2) * fullH / 2 CSS px.
 */
function labelSprite(text, color, { fov, fullH, dpr }) {
  const tex = labelTexture(text, color, dpr);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, toneMapped: false,
  }));
  const k = (2 * Math.tan((fov * Math.PI) / 360)) / fullH; // world-scale per CSS px
  sprite.scale.set((tex.image.width / dpr) * k, LP.height * k, 1);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 10;
  return sprite;
}

/**
 * The four ATLAS areas as ordinary city buildings (podium + modest tower, same shader and palette
 * as the city) identified by restrained accents: a few upper-floor windows in the area color, a
 * thin colored cornice line, a tiny rooftop mast light, and a small location label. Static this
 * phase — no Stats coupling — apart from a slow local-clock breathing of the mast light.
 */
export function createLandmarks(layout, { haze, fog, fov, fullH, dpr }) {
  const group = new THREE.Group();
  const bodies = [];
  const lights = [];
  const corniceGeo = new THREE.BoxGeometry(TWR.w + 0.8, 2.2, TWR.d + 0.8);
  const edgeGeo = new THREE.BoxGeometry(1.6, TWR.h * 0.44, 1.6);
  const mastGeo = new THREE.BoxGeometry(1.4, mastH, 1.4);
  const lightGeo = new THREE.SphereGeometry(2.6, 10, 8);
  const rot = layout.gridAngle;

  layout.areas.forEach(({ key, x, z }, i) => {
    const { color, label } = ATLAS_AREAS[key];
    const seed = 0.13 + i * 0.21;
    bodies.push({ x, z, w: POD.w, d: POD.d, h: POD.h, rot, seed });
    bodies.push({ x, z, w: TWR.w, d: TWR.d, h: TWR.h, rot, seed: seed + 0.07, accent: color });

    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rot;
    const edgeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(0.55) });
    const cornice = new THREE.Mesh(corniceGeo, edgeMat);
    cornice.position.y = TWR.h - 1.1;
    // One thin vertical edge on the tower corner nearest the camera (+z), upper part only.
    const [cu, cv] = [[1, 1], [1, -1], [-1, 1], [-1, -1]]
      .map(([su, sv]) => [su * TWR.w / 2, sv * TWR.d / 2])
      .reduce((best, c) => (-c[0] * Math.sin(rot) + c[1] * Math.cos(rot) > -best[0] * Math.sin(rot) + best[1] * Math.cos(rot) ? c : best));
    const edge = new THREE.Mesh(edgeGeo, edgeMat);
    edge.position.set(cu, TWR.h * 0.78, cv);
    const mast = new THREE.Mesh(mastGeo, new THREE.MeshBasicMaterial({ color: 0x0b0e15 }));
    mast.position.set(TWR.w * 0.22, TWR.h + mastH / 2, -TWR.d * 0.18);
    const lightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.5), transparent: true, toneMapped: false });
    const light = new THREE.Mesh(lightGeo, lightMat);
    light.position.set(TWR.w * 0.22, TWR.h + mastH + 1.5, -TWR.d * 0.18);
    lights.push({ mat: lightMat, phase: i * 1.7 });
    g.add(cornice, edge, mast, light);
    group.add(g);

    const tag = labelSprite(label, color, { fov, fullH, dpr });
    tag.position.set(x, TWR.h + mastH + labelGapY, z);
    group.add(tag);
  });

  const bodyMesh = createBuildings(bodies, { haze, fog });
  group.add(bodyMesh.mesh);

  return {
    group,
    update(t) {
      for (const l of lights) l.mat.opacity = 0.75 + 0.25 * Math.sin(t * 1.1 + l.phase);
    },
  };
}
