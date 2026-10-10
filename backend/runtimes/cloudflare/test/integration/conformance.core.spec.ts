import { defineCoreConformance } from '@cat-factory/conformance'
import { harness } from './conformanceHarness'

// One group of the shared cross-runtime conformance suite against the Cloudflare Worker facade
// (real Hono app, real local D1, inside workerd). Split per group so vitest's file-level `--shard`
// can balance the lane; see `conformanceHarness.ts` for why one file could not be.
defineCoreConformance(harness)
