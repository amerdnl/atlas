import * as THREE from 'three';
import { ROLE_IDS } from '../../workflow/roles.js';
import { createRoleLabels } from './labels.js';

/**
 * The four ATLAS role districts: which city instances belong to each is decided by world.js;
 * this drives their live light (the shared `uRole` uniforms the building shader reads) and their
 * transient labels. How lit a district is comes entirely from `update(sample)` — the workflow
 * visual state — so nothing here decides what an agent is doing. Labels sit above each district's
 * signature building, which is also where handoff paths start and end.
 */
export function createDistricts(world, { buildings, fov, fullH, dpr }) {
  const group = new THREE.Group();
  const pxToWorld = (2 * Math.tan((fov * Math.PI) / 360)) / fullH;
  const anchors = {};
  for (const d of world.districts) anchors[d.key] = new THREE.Vector3(...d.anchor);
  const roles = world.districts.filter((d) => d.role);
  const labels = createRoleLabels(Object.fromEntries(roles.map((d) => [d.key, d.anchor])), { pxToWorld, dpr });
  group.add(labels.group);
  const parts = roles.map((d) => ({ key: d.key, index: ROLE_IDS.indexOf(d.key) }));
  const roleUniforms = buildings.uniforms.uRole.value;

  return {
    group,
    /** World position above each district's signature building — where labels sit and handoff paths start and end. */
    anchor: (key) => anchors[key],
    /**
     * Apply one sampled workflow visual state. `clock` is wall-clock seconds within the hour; every
     * period used by the building shader divides 3600, so the hourly wrap is seamless.
     */
    update(sample, clock) {
      buildings.uniforms.uClock.value = clock;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i], r = sample.roles[p.key];
        roleUniforms[p.index].set(r.level, r.flow, r.wait, r.warn);
      }
      labels.update(sample);
    },
  };
}
