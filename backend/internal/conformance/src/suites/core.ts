import { describe } from 'vitest'
import type { ConformanceHarness } from '../harness.js'
import { defineCorePlanningConformance } from './core-planning.js'
import { defineCoreRunsConformance } from './core-runs.js'
import { defineCoreWorkspaceFeaturesConformance } from './core-workspace-features.js'
import { defineCoreWorkspacesConformance } from './core-workspaces.js'
import { defineCoreRiskPolicyTiersConformance } from './core-risk-policy-tiers.js'

// The core backend conformance (workspaces, run persistence, planning, and the remaining
// workspace feature surfaces), split into cohesive sibling files so no single suite file grows
// unbounded (the file-size ratchet guard). Each `defineX` emits its nested `describe` blocks
// inside the one per-facade `[name] conformance` group, so the reported test tree is unchanged.
export function defineCoreConformance(harness: ConformanceHarness): void {
  describe(`[${harness.name}] conformance`, () => {
    defineCoreWorkspacesConformance(harness)
    defineCoreRunsConformance(harness)
    defineCorePlanningConformance(harness)
    defineCoreWorkspaceFeaturesConformance(harness)
    defineCoreRiskPolicyTiersConformance(harness)
  })
}
