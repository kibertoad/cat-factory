import { describe, expect, it } from 'vitest'
import * as nodeServer from '@cat-factory/node-server'
import type { StartOptions } from '@cat-factory/node-server'
import * as localServer from '../src/index.js'
import type { RegistrationProblem, RegistrationWarning } from '../src/index.js'
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
// TWO rules, both DERIVED rather than re-classified: the Node facade is the reference, so this one's
// OPTIONS must be a superset of its registry seams and its EXPORTS a superset of the constructors
// that build values for them. A second copy of either table would be one more thing to forget,
// which is the failure mode this whole file exists for.
//
// They are separate because they failed separately: `pipelineRegistry` was an option no boot path
// forwarded, and `gateRegistry` was a forwarded option nothing here could build a value for.
// ---------------------------------------------------------------------------

/** Every app-owned registry/source seam the Node BOOT entry point exposes. */
type NodeEntryPointSeam = Extract<keyof StartOptions, `${string}Registry` | `${string}Source`>

/**
 * …must also be reachable from this one. If this line errors, `startLocal` is missing a seam
 * `start` already exposes, and a local deployment has NO way to register it.
 */
type _LocalExposesEveryNodeSeam = NodeEntryPointSeam extends keyof StartLocalOptions ? true : never
const _localSeamsAreReachable: _LocalExposesEveryNodeSeam = true

/**
 * A name that BUILDS an app-owned registry: the registry class itself, a `default…Registry()` /
 * `create…Registries()` builder, or a `…WithBuiltins()` one.
 *
 * A rule over names rather than a second list of them, for the same reason the seam assertion above
 * is derived: what must hold is that the two facades agree, and any table stating which names those
 * are is a table one of them can fall behind. The Node facade is the reference (it owns the
 * authoritative seam classification in `runtimes/node/test/registry-seams.spec.ts`), so whatever it
 * publishes under this shape is what a deployment may reasonably reach for here.
 *
 * A false POSITIVE (an export matching the shape that local genuinely should not re-export) fails
 * loudly and is fixed by re-exporting it or narrowing this predicate; a false NEGATIVE would be
 * silent, which is why the shape is deliberately broad.
 */
function isRegistryConstructor(name: string): boolean {
  return (
    name.endsWith('Registry') ||
    /^(default|create).*Registr(y|ies)$/.test(name) ||
    // `gateRegistryWithBuiltins` / `promptFragmentRegistryWithBuiltins`. Spelled out because the
    // two clauses above miss them, and these are precisely the builders a deployment
    // almost always wants: the bare `default…()` sibling is EMPTY, so re-exporting only that pair
    // would leave a local deployment able to construct a registry and unable to construct the one
    // with the platform's own built-ins in it.
    name.endsWith('WithBuiltins')
  )
}

/**
 * The TYPE half of the same seam, which neither rule above can see: `Object.keys` reads runtime
 * values, and a type-only re-export has none, so deleting one leaves this file green while a local
 * deployment loses the ability to name what its own `escalateRegistrationWarning` predicate is
 * handed. Enumerated rather than derived for the reason the Node guard's block is (a type union is
 * not reflectable), and imported from THIS facade, so the compile error lands here.
 */
const _bootValidationVocabulary:
  | { registrationProblem: RegistrationProblem; registrationWarning: RegistrationWarning }
  | undefined = undefined

describe('local boot entry point', () => {
  it('re-exports the BOOT-VALIDATION types a deployment predicate names', () => {
    // The compile-time assertion above carries the guard; this gives it a failing assertion to
    // point at rather than only a red typecheck in a separate CI job.
    expect(_bootValidationVocabulary).toBeUndefined()
  })

  it('exposes every app-owned seam the Node entry point does', () => {
    // The compile-time assertion carries the guard; this gives it a failing assertion to point at
    // rather than only a red typecheck in a separate CI job.
    expect(_localSeamsAreReachable).toBe(true)
  })

  it('publishes every registry CONSTRUCTOR the Node facade does', () => {
    // The layer past reachability: `startLocal({ gateRegistry })` was an option no local deployment
    // could fill, because building a `GateRegistry` meant a direct `@cat-factory/kernel` /
    // `@cat-factory/gates` dependency. Those publish as EXACT versions, so a consumer floating the
    // range gets a second physical copy and registers into the one nothing reads, the failure the
    // facade re-export removes by construction, on the facade the deployment already depends on.
    const exported = new Set(Object.keys(localServer))
    const missing = Object.keys(nodeServer)
      .filter(isRegistryConstructor)
      .filter((name) => !exported.has(name))
    expect(missing).toEqual([])
  })

  it('re-exports every built-in pipeline id the Node facade does', () => {
    // Same derived-from-the-reference rule as the constructors above, and for the same reason: a
    // deployment pinning a shipped pipeline reads the id off the facade it already depends on, and
    // a hand-copied list is how two of them went missing from all three facades at once.
    const exported = new Set(Object.keys(localServer))
    const published = Object.keys(nodeServer).filter((name) => name.endsWith('_PIPELINE_ID'))
    expect(published.length).toBeGreaterThan(0)
    expect(published.filter((name) => !exported.has(name))).toEqual([])
  })

  it('re-exports the pipeline AUTHORING vocabulary the Node facade does', () => {
    // Pinning a shipped pipeline by id is half of replacing one. The other half is naming what its
    // step selects: the agent kind, the traits that decide what that kind is handed, the platform's
    // own storage service, the reserved capability tags. Each is a value the platform BRANCHES on,
    // so a deployment that cannot import it copies a string literal, and a copy that misses by a
    // character fails a registration rather than a compile (the reason the reserved tags have a
    // near-miss check at the write boundary at all).
    const exported = new Set(Object.keys(localServer))
    const isAuthoringName = (name: string) =>
      name === 'definePipeline' ||
      /_(AGENT_KIND|TRAIT|CAPABILITY|SERVICE_ID)$/.test(name) ||
      name.endsWith('_GENERATOR_ID')
    const published = Object.keys(nodeServer).filter(isAuthoringName)
    expect(published).toContain('definePipeline')
    expect(published.filter((name) => !exported.has(name))).toEqual([])
  })
})
