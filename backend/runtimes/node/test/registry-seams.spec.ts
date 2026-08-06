import { describe, expect, it } from 'vitest'
import type { CoreDependencies } from '@cat-factory/orchestration'
import type { NodeContainerOptions } from '../src/container-options.js'
import type { StartOptions } from '../src/server.js'

// ---------------------------------------------------------------------------
// The APP-OWNED REGISTRY SEAM drift guard.
//
// Every app-owned registry is a DI seam a deployment registers on and injects. The Worker takes
// them as `overrides: Partial<CoreDependencies>`, so it accepts a new one by construction; this
// facade names each seam on its own options interface, so a new registry reaches Node only if
// somebody remembers to add the option AND map it in `assembleNodeCoreDependencies`.
//
// Forgetting is SILENT and expensive, which is why this file exists rather than a behavioural
// test. `createCore` defaults an absent registry to the empty one, so an unthreaded seam
// typechecks, boots, passes every test, and fails only in production as a feature that works on
// Cloudflare and is inert on Node — the shape the generative-binary-integration seam shipped in
// (registered on the Worker, unreachable here) and the reason the classification below is
// EXHAUSTIVE rather than a list of the ones we remembered.
//
// The mechanism: `RegistrySeam` is derived from `CoreDependencies` itself, and `SEAM_ROUTES` is a
// total `Record` over it. Add a registry to `CoreDependencies` and this file stops compiling until
// its route is declared; declare it `option` and the type-level assertion below stops compiling
// until `NodeContainerOptions` carries it.
// ---------------------------------------------------------------------------

/**
 * Every app-owned registry seam on `CoreDependencies`, derived rather than restated — plus the
 * SOURCES that decide where such a registry is read FROM.
 *
 * A source belongs here for the same reason a registry does, and the same way round: it is a DI
 * seam a facade must thread, an unthreaded one defaults to the in-process registry, and the
 * default is indistinguishable from correct until the deployment is a mothership pair. It is
 * exactly the shape the generative-integration registry itself shipped in.
 */
type RegistrySeam = Extract<keyof CoreDependencies, `${string}Registry` | `${string}Source`>

/**
 * How a seam reaches `CoreDependencies` on this facade.
 *
 * - `option` — its own field on {@link NodeContainerOptions}, mapped in `container-core-deps.ts`.
 *   The default for anything a DEPLOYMENT registers on.
 * - `bundled`: reached through a composite option rather than its own field, because the
 *   registries in that family are registered together (`backendRegistries`).
 * - `internal`: built by the facade from its own configuration, so a deployment has nothing to
 *   inject and an option would be a second, drifting source of truth.
 */
const SEAM_ROUTES = {
  agentKindRegistry: 'option',
  gateRegistry: 'option',
  judgeRegistry: 'option',
  stepResolverRegistry: 'option',
  pipelineRegistry: 'option',
  taskTypeRegistry: 'option',
  initiativePresetRegistry: 'option',
  vcsRegistry: 'option',
  foundationalServiceRegistry: 'option',
  binaryGeneratorRegistry: 'option',
  promptFragmentRegistry: 'option',
  // The three SOURCES. Each is `option` for the same reason its registry is, and each is set by
  // exactly one caller, the local facade booting in mothership mode, which reads what the
  // deployment registered from the mothership rather than from this node's own (stale-by-
  // construction) build.
  foundationalBuiltinSource: 'option',
  binaryGeneratorSource: 'option',
  promptFragmentSource: 'option',
  // Registered together on one `createBackendRegistries()` bundle and injected as
  // `backendRegistries`, because an environment backend and its runner backend are two halves of
  // one deployment's infrastructure and splitting them into two options would let a deployment
  // wire half of it.
  environmentBackendRegistry: 'bundled',
  runnerBackendRegistry: 'bundled',
  // Built by the facade: the provider set is derived from the configured model credentials, and
  // the manifest/user-secret kinds from the deployment's own env, so there is nothing for a
  // caller to hand in.
  providerRegistry: 'internal',
  customManifestTypeRegistry: 'internal',
  userSecretKindRegistry: 'internal',
} as const satisfies Record<RegistrySeam, 'option' | 'bundled' | 'internal'>

/**
 * Every seam routed as `option` must be a key of {@link NodeContainerOptions}. A compile-time
 * assertion rather than a runtime one, because the options interface is a TYPE — there is no value
 * to reflect over, and a missing key is exactly what we need to fail on.
 */
type OptionSeam = {
  [K in RegistrySeam]: (typeof SEAM_ROUTES)[K] extends 'option' ? K : never
}[RegistrySeam]
type _EveryOptionSeamIsANodeOption = OptionSeam extends keyof NodeContainerOptions ? true : never
// If this line errors, a seam classified `option` above is missing from `NodeContainerOptions`.
const _optionSeamsAreThreaded: _EveryOptionSeamIsANodeOption = true

// ---------------------------------------------------------------------------
// The same guard, one layer OUT: at the BOOT ENTRY POINT rather than the container builder.
//
// The assertion above asserts against `NodeContainerOptions`, which is what `buildNodeContainer`
// takes, not what a deployment calls. `pipelineRegistry` passed it for months while being
// unreachable through `start()`: the option existed, carried a doc comment describing the
// deployment use case, and no boot path forwarded it. On the LOCAL facade that is terminal, since
// `startLocal` deliberately withholds `buildContainer` (overriding it would discard local mode's
// whole point), so there was no escape hatch behind the missing option at all.
//
// So the classification below answers a different question: how does a seam reach a deployment
// that calls the documented entry point?
// ---------------------------------------------------------------------------

/**
 * How a seam reaches a deployment through the BOOT entry points (`start` / `startLocal`).
 *
 * - `entry-point`: its own field on {@link StartOptions} (and on `StartLocalOptions`, asserted by
 *   the local facade's own sibling spec). The default for anything a DEPLOYMENT registers on.
 * - `facade-internal`: set by a facade for itself and never by a caller. Today the three
 *   mothership SOURCES, which the local mothership boot points at the mothership; a deployment has
 *   nothing to hand in, and an option would invite pointing them somewhere incoherent.
 * - `bundled`: reached through the `backendRegistries` composite (its own entry-point option on
 *   the local facade, and `NodeContainerOptions.backendRegistries` behind `buildContainer` on
 *   Node), because an environment backend and its runner backend are two halves of one thing.
 * - `internal`: built by the facade from its own configuration, so there is nothing to inject.
 */
const BOOT_ROUTES = {
  agentKindRegistry: 'entry-point',
  gateRegistry: 'entry-point',
  judgeRegistry: 'entry-point',
  stepResolverRegistry: 'entry-point',
  pipelineRegistry: 'entry-point',
  taskTypeRegistry: 'entry-point',
  initiativePresetRegistry: 'entry-point',
  vcsRegistry: 'entry-point',
  foundationalServiceRegistry: 'entry-point',
  binaryGeneratorRegistry: 'entry-point',
  promptFragmentRegistry: 'entry-point',
  // The mothership SOURCES. Deliberately NOT entry-point options: each is the answer to "where is
  // this code-registered org state READ from", which is a property of the deployment TOPOLOGY, and
  // the local mothership boot is the one caller that knows it. A deployment that could set them
  // could point a standalone node at a mothership it does not have.
  foundationalBuiltinSource: 'facade-internal',
  binaryGeneratorSource: 'facade-internal',
  promptFragmentSource: 'facade-internal',
  environmentBackendRegistry: 'bundled',
  runnerBackendRegistry: 'bundled',
  providerRegistry: 'internal',
  customManifestTypeRegistry: 'internal',
  userSecretKindRegistry: 'internal',
} as const satisfies Record<
  RegistrySeam,
  'entry-point' | 'facade-internal' | 'bundled' | 'internal'
>

/**
 * Every seam routed `entry-point` must be a key of {@link StartOptions}. Compile-time, for the
 * same reason the builder assertion is: the entry point's options are a TYPE, and a missing key is
 * exactly what must fail.
 */
type EntryPointSeam = {
  [K in RegistrySeam]: (typeof BOOT_ROUTES)[K] extends 'entry-point' ? K : never
}[RegistrySeam]
type _EveryEntryPointSeamIsAStartOption = EntryPointSeam extends keyof StartOptions ? true : never
// If this line errors, a seam classified `entry-point` above is missing from `StartOptions`, the
// deployment-facing door, not the builder behind it.
const _entryPointSeamsAreReachable: _EveryEntryPointSeamIsAStartOption = true

describe('app-owned registry seams', () => {
  it('routes every registry on CoreDependencies, so a new one cannot land unthreaded', () => {
    // The compile-time assertions carry the guard; this keeps the classification honest at
    // runtime too, and gives the file a failing assertion to point at rather than only a red
    // typecheck in a separate CI job.
    expect(_optionSeamsAreThreaded).toBe(true)
    expect(Object.values(SEAM_ROUTES).every((route) => route !== undefined)).toBe(true)
  })

  it('exposes the generative-binary-integration registry as its own option', () => {
    // The specific regression: registered on the Worker, absent from this facade's options, so a
    // deployment's image/music generators were unreachable on Node and local while every test
    // passed. Named explicitly so the guard reads as the thing it protects.
    expect(SEAM_ROUTES.binaryGeneratorRegistry).toBe('option')
  })

  it('routes both code-registered-org-state SOURCES as options too', () => {
    // The second half of the same failure mode. A source left unthreaded silently falls back to
    // this process's own registry, which is precisely the drifting second copy the source exists
    // to remove — and it only misbehaves on a mothership deployment, which no test here is.
    expect(SEAM_ROUTES.foundationalBuiltinSource).toBe('option')
    expect(SEAM_ROUTES.binaryGeneratorSource).toBe('option')
    expect(SEAM_ROUTES.promptFragmentSource).toBe('option')
  })

  it('reaches every deployment-registered seam from the BOOT entry point, not only the builder', () => {
    expect(_entryPointSeamsAreReachable).toBe(true)
    // The specific regression this half exists for: `pipelineRegistry` was a documented
    // `NodeContainerOptions` key, passed the builder assertion above, and no boot path forwarded
    // it, so the only way to register a pipeline was to bypass `start()` entirely, and on the
    // local facade there was no way at all.
    expect(BOOT_ROUTES.pipelineRegistry).toBe('entry-point')
  })

  it('keeps the two classifications INDEPENDENT, so neither can vacuously satisfy the other', () => {
    // A seam a facade builds for itself is `option` on the BUILDER (the local mothership boot sets
    // it) and NOT a deployment-facing entry-point option. That divergence is the reason two
    // classifications exist rather than one: collapsing them would either force a meaningless
    // `start({ foundationalBuiltinSource })` or re-open the hole this guard just closed.
    const facadeInternal = Object.entries(BOOT_ROUTES)
      .filter(([, route]) => route === 'facade-internal')
      .map(([seam]) => seam as RegistrySeam)
    expect(facadeInternal.length).toBeGreaterThan(0)
    for (const seam of facadeInternal) expect(SEAM_ROUTES[seam]).toBe('option')
  })
})
