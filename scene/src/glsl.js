import * as THREE from 'three';

/**
 * Night palette and atmosphere, shared by every material so the layers sit in one air: distant
 * things fade toward the horizon haze, and a low mist hangs over far water and mountain feet.
 */
export const PALETTE = Object.freeze({
  haze: 0x26324d, // horizon sky and fog
  zenith: 0x0a1424,
  wall: 0x0b101b,
  roof: 0x090d17,
  land: 0x04070e,
  water: 0x0c1424,
  waterFar: 0x1e2942,
});

/** Uniforms for `FOG_GLSL`; pass the same objects to every material. */
export function createAtmosphere() {
  return {
    uFogColor: { value: new THREE.Color(PALETTE.haze) },
    uFog: { value: new THREE.Vector4(3000, 11000, 0.5, 0) }, // near, far, max amount, — : the far shore sits in haze
    uMist: { value: new THREE.Vector4(4200, 12000, 90, 0.55) }, // near, far, height scale, max amount
  };
}

export const FOG_GLSL = /* glsl */`
  uniform vec3 uFogColor; uniform vec4 uFog; uniform vec4 uMist;
  float atmosphereAmount(float depth, float worldY) {
    float f = uFog.z * smoothstep(uFog.x, uFog.y, depth);
    float m = uMist.w * smoothstep(uMist.x, uMist.y, depth) * exp(-max(worldY, 0.0) / uMist.z);
    return clamp(max(f, m), 0.0, 1.0);
  }
  vec3 atmosphere(vec3 col, float depth, float worldY) { return mix(col, uFogColor, atmosphereAmount(depth, worldY)); }`;
