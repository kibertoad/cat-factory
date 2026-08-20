import { describe } from 'vitest'
import type { ConformanceHarness } from '../harness.js'
import { defineCredentialsConformance } from './integration-credentials.js'
import { defineEnvironmentsConformance } from './integration-environments.js'
import { defineProvisioningConformance } from './integration-provisioning.js'
import { definePublicBoardConformance } from './integration-public-board.js'
import { definePublicDebugConformance } from './integration-public-debug.js'
import { definePublicDecisionsConformance } from './integration-public-decisions.js'
import { definePublicEvidenceConformance } from './integration-public-evidence.js'
import { definePublicMcpConformance } from './integration-public-mcp.js'
import { definePublicPresetConformance } from './integration-public-presets.js'
import { definePublicUseCaseConformance } from './integration-public-use-cases.js'
import { definePublicWebhookConformance } from './integration-public-webhooks.js'
import { defineSecretsConformance } from './integration-secrets.js'
import { defineSourcesConformance } from './integration-sources.js'
import { defineTrackerWebhookConformance } from './integration-tracker-webhooks.js'

// The shared integration-slice conformance (credentials / provisioning / secrets / source
// integrations / inbound tracker webhooks / environments / the public-API decision, remote
// debugging, board-provisioning, preset-pinning, run-evidence, key-provisioning, outbound-webhook management and hosted MCP surfaces), split into cohesive sibling
// files so no single suite file grows unbounded. Each `defineX` emits its nested `describe` blocks
// inside the one per-facade `[name] conformance` group, so the reported test tree is unchanged.
export function defineIntegrationConformance(harness: ConformanceHarness): void {
  describe(`[${harness.name}] conformance`, () => {
    defineCredentialsConformance(harness)
    defineProvisioningConformance(harness)
    defineSecretsConformance(harness)
    defineSourcesConformance(harness)
    defineTrackerWebhookConformance(harness)
    defineEnvironmentsConformance(harness)
    definePublicDecisionsConformance(harness)
    definePublicDebugConformance(harness)
    definePublicBoardConformance(harness)
    definePublicPresetConformance(harness)
    definePublicEvidenceConformance(harness)
    definePublicWebhookConformance(harness)
    definePublicMcpConformance(harness)
    definePublicUseCaseConformance(harness)
  })
}
