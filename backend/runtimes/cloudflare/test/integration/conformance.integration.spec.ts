import { defineIntegrationConformance } from '@cat-factory/conformance'
import { harness } from './conformanceHarness'

// One group of the shared cross-runtime conformance suite against the Cloudflare Worker facade.
// See `conformanceHarness.ts` for the split's rationale.
defineIntegrationConformance(harness)
