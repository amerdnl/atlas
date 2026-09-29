// Role identity lives in workflow/roles.js; this is the scene's view of it (map-style label, numeric color).
// On disk this path is <repo>/workflow/roles.js. In the browser, `/src/` + `../../` resolves to `/`,
// i.e. `/workflow/roles.js`, which the collector serves from the same directory.
import { ROLE_IDS, ROLES } from '../../workflow/roles.js';

/** The four ATLAS areas the city draws, keyed by role id. Layouts (`layouts.js`) place them. */
export const ATLAS_AREAS = Object.freeze(Object.fromEntries(ROLE_IDS.map((id) => [id, Object.freeze({
  label: ROLES[id].name.toUpperCase(),
  color: parseInt(ROLES[id].color.slice(1), 16),
})])));
