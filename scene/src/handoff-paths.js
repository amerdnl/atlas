import * as THREE from 'three';
import { MAX_PATHS } from './workflow-visuals.js';

const LINE_PX = 1.4; // on-screen line width, CSS px
const POINT_PX = 9; // on-screen size of the moving point's soft sprite, CSS px

/** A soft round dot (bright core, quick falloff) — the single moving light on a path. */
function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/**
 * Handoff paths: a thin straight world-space line from the source area's mast light to the
 * destination's, in the source role's color, with one soft point travelling source → destination
 * and a short trail behind it that shows the direction. World-space geometry under one shared
 * camera, so a path crossing a display seam stays continuous.
 *
 * A small fixed pool of slots is reused: activating a path writes its endpoints and color into
 * uniforms (the quad's vertices are computed in the shader), so nothing is allocated per frame.
 * The line is billboarded once per activation against the (static) camera, ~1.4 px wide. With
 * `ortho` (a 2D scene laid out in CSS px) widths and sizes are plain pixels.
 */
export function createHandoffPaths({ anchor, camera, fov, fullH, ortho = false }) {
  const group = new THREE.Group();
  const quad = new THREE.BufferGeometry();
  quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0]), 3));
  quad.setIndex([0, 1, 2, 2, 1, 3]);
  const dot = dotTexture();
  const tanHalf = Math.tan((fov * Math.PI) / 360);
  const dir = new THREE.Vector3(), view = new THREE.Vector3(), mid = new THREE.Vector3();

  const slots = Array.from({ length: MAX_PATHS }, () => {
    const uniforms = {
      uA: { value: new THREE.Vector3() }, uB: { value: new THREE.Vector3() }, uSide: { value: new THREE.Vector3() },
      uColor: { value: new THREE.Color() }, uOpacity: { value: 0 }, uProgress: { value: 0 },
    };
    const line = new THREE.Mesh(quad, new THREE.ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */`
        uniform vec3 uA, uB, uSide; varying float vAlong;
        void main() {
          vAlong = position.x;
          vec3 p = mix(uA, uB, position.x) + uSide * position.y;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uOpacity, uProgress; varying float vAlong;
        void main() {
          float ends = smoothstep(0.0, 0.05, vAlong) * smoothstep(1.0, 0.95, vAlong);
          float behind = uProgress - vAlong;
          float trail = behind >= 0.0 ? exp(-behind * 9.0) : 0.0; // brightest just behind the point
          gl_FragColor = vec4(uColor, uOpacity * ends * (0.14 + 0.55 * trail));
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    line.frustumCulled = false;
    line.visible = false;
    line.renderOrder = 5;
    const point = new THREE.Sprite(new THREE.SpriteMaterial({
      map: dot, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: false, toneMapped: false,
    }));
    const s = ortho ? POINT_PX : (POINT_PX * 2 * tanHalf) / fullH;
    point.scale.set(s, s, 1);
    point.visible = false;
    point.renderOrder = 6;
    group.add(line, point);
    return { uniforms, line, point, from: null, to: null };
  });

  function place(slot, from, to, color) {
    const a = anchor(from), b = anchor(to), u = slot.uniforms;
    u.uA.value.copy(a);
    u.uB.value.copy(b);
    mid.addVectors(a, b).multiplyScalar(0.5);
    if (ortho) view.set(0, 0, -1);
    else view.subVectors(mid, camera.position);
    const halfWidth = ortho ? LINE_PX / 2 : (LINE_PX / 2) * (2 * view.length() * tanHalf) / fullH; // world units for LINE_PX at this distance
    u.uSide.value.crossVectors(dir.subVectors(b, a), view).normalize().multiplyScalar(halfWidth);
    u.uColor.value.set(color);
    slot.point.material.color.set(color);
    slot.from = from;
    slot.to = to;
  }

  return {
    group,
    /** Anchors moved (e.g. a resize): re-place every visible path on its next update. */
    invalidate() { for (const slot of slots) { slot.from = null; slot.to = null; } },
    /** Show the sampled paths (see workflow-visuals `sample`). */
    update(sample) {
      for (let i = 0; i < MAX_PATHS; i++) {
        const slot = slots[i], p = sample.paths[i];
        const on = i < sample.pathCount && p.opacity > 0;
        slot.line.visible = slot.point.visible = on;
        if (!on) continue;
        if (slot.from !== p.from || slot.to !== p.to) place(slot, p.from, p.to, p.color);
        slot.uniforms.uOpacity.value = p.opacity;
        slot.uniforms.uProgress.value = p.progress;
        slot.point.position.lerpVectors(slot.uniforms.uA.value, slot.uniforms.uB.value, p.progress);
        slot.point.material.opacity = p.opacity * 0.9;
      }
    },
  };
}
