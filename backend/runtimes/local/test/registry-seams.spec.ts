import { describe, expect, it } from 'vitest'
import type { StartOptions } from '@cat-factory/node-server'
import type { StartLocalOptions } from '../src/server.js'

// ---------------------------------------------------------------------------
// The LOCAL half of the boot-entry-point seam guard (the Node half, which owns the authoritative
// classification of every seam on `CoreDependencies`, is `runtimes/node/test/registry-seams.spec.ts`).
//
// This facade is where a missing seam is TERMINAL. `startLocal` deliberately withholds
// `buildContainer` (overriding it would discard local mode's differentiators, which is its whole
// reason to exist), so where a Node deployment can drop to `start({ buildContainer })` and reach an
// unforwarded registry by hand, a local deployment simply cannot register at all. That is how the
// pipeline registry came to be unreachable here with a green guard over there.
//
// DERIVED rather than re-classified: the Node entry point is the reference, so the rule is simply
// that this facade's options are a superset of its registry seams. A second copy of the route table
// would be one more thing to forget, which is the failure mode this whole file exists for.
// ---------------------------------------------------------------------------

/** Every app-owned registry/source seam the Node BOOT entry point exposes. */
type NodeEntryPointSeam = Extract<keyof StartOptions, `${string}Registry` | `${string}Source`>

/**
 * …must also be reachable from this one. If this line errors, `startLocal` is missing a seam
 * `start` already exposes, and a local deployment has NO way to register it.
 */
type _LocalExposesEveryNodeSeam = NodeEntryPointSeam extends keyof StartLocalOptions ? true : never
const _localSeamsAreReachable: _LocalExposesEveryNodeSeam = true

describe('local boot entry point', () => {
  it('exposes every app-owned seam the Node entry point does', () => {
    // The compile-time assertion carries the guard; this gives it a failing assertion to point at
    // rather than only a red typecheck in a separate CI job.
    expect(_localSeamsAreReachable).toBe(true)
  })
})
