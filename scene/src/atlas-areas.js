/**
 * The four ATLAS engineering areas: stable identity (label, color), shared by every layout.
 * Layouts (`layouts.js`) supply only where each one sits in world space; a future straight-line
 * agent-path module can read this plus a layout's positions without any new data model.
 */
export const ATLAS_AREAS = {
  operations: { label: 'OPERATIONS', color: 0xff9a3c },
  research: { label: 'RESEARCH', color: 0x4a9dff },
  developer: { label: 'DEVELOPER', color: 0x3ddc84 },
  qa: { label: 'QA', color: 0xb96bff },
};
