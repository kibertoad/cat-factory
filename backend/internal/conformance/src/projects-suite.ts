import type { ConformanceHarness } from './harness.js'
import { defineCoreProjectsConformance } from './suites/core-projects.js'
import { defineCoreResearchRunsConformance } from './suites/core-research-runs.js'
import { defineCoreResearchViewsConformance } from './suites/core-research-views.js'
import { defineCoreTaskProjectLinksConformance } from './suites/core-task-project-links.js'

/**
 * Projects and research on the board and in the engine: the slices of the core group that cover
 * them, bundled so a harness running only part of the suite (the mothership node) can prove every
 * repository method they reach is proxied and scoped. The full-suite facades already run each of
 * these inside the core group. The public `/api/v1` projects suite is not here: the public API is
 * served by the mothership, not by a node.
 */
export function defineProjectsSuite(harness: ConformanceHarness): void {
  defineCoreProjectsConformance(harness)
  defineCoreResearchRunsConformance(harness)
  defineCoreResearchViewsConformance(harness)
  defineCoreTaskProjectLinksConformance(harness)
}
