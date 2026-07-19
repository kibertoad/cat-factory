import { describe } from 'vitest'
import type { ConformanceHarness } from '../harness.js'
import { defineCredentialsConformance } from './integration-credentials.js'
import { defineEnvironmentsConformance } from './integration-environments.js'
import { defineProvisioningConformance } from './integration-provisioning.js'
import { defineSecretsConformance } from './integration-secrets.js'
import { defineSourcesConformance } from './integration-sources.js'

// The shared integration-slice conformance (credentials / provisioning / secrets / source
// integrations / environments), split into cohesive sibling files so no single suite file
// grows unbounded. Each `defineX` emits its nested `describe` blocks inside the one
// per-facade `[name] conformance` group, so the reported test tree is unchanged.
export function defineIntegrationConformance(harness: ConformanceHarness): void {
  describe(`[${harness.name}] conformance`, () => {
    defineCredentialsConformance(harness)
    defineProvisioningConformance(harness)
    defineSecretsConformance(harness)
    defineSourcesConformance(harness)
    defineEnvironmentsConformance(harness)
  })
}
