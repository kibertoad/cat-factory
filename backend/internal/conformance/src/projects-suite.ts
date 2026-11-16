import type { ConformanceHarness } from './harness.js'
import { defineCoreProjectsConformance } from './suites/core-projects.js'
import { defineCoreResearchRunsConformance } from './suites/core-research-runs.js'
import { defineCoreProjectViewsConformance } from './suites/core-project-views.js'
import { defineCoreTaskProjectLinksConformance } from './suites/core-task-project-links.js'

/**
 * Projects of every kind on the board and in the engine, driven by the research kind: the slices
 * of the core group that cover them, bundled so a harness running only part of the suite (the
 * mothership node) can prove every repository method they reach is proxied and scoped. The
 * full-suite facades already run each of these inside the core group. The public `/api/v1`
 * projects suite is not here: the public API is served by the mothership, not by a node.
 */
export function defineProjectsSuite(harness: ConformanceHarness): void {
  defineCoreProjectsConformance(harness)
  defineCoreResearchRunsConformance(harness)
  defineCoreProjectViewsConformance(harness)
  defineCoreTaskProjectLinksConformance(harness)
}
