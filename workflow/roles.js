/**
 * The canonical ATLAS role registry — the only place role identity is defined. The scene's areas,
 * the workflow's stage owners and any future consumer (the app, orchestration, integrations) read
 * from here. Colors are CSS hex strings so they travel unchanged through JSON to any platform.
 *
 * Listed in workflow order: operations → research → developer → qa (→ operations).
 */
const ROLE_LIST = [
  { id: 'operations', name: 'Operations', color: '#ff9a3c' },
  { id: 'research', name: 'Research', color: '#4a9dff' },
  { id: 'developer', name: 'Developer', color: '#3ddc84' },
  { id: 'qa', name: 'QA', color: '#b96bff' },
];

export const ROLE_IDS = Object.freeze(ROLE_LIST.map((r) => r.id));
export const ROLES = Object.freeze(Object.fromEntries(ROLE_LIST.map((r) => [r.id, Object.freeze({ ...r })])));

export const isRole = (id) => Object.hasOwn(ROLES, id);

export function getRole(id) {
  if (!isRole(id)) throw new Error(`unknown role: ${id}`);
  return ROLES[id];
}
