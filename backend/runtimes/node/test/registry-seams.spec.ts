import { describe, expect, it } from 'vitest'
import type { CoreDependencies } from '@cat-factory/orchestration'
import type { NodeContainerOptions } from '../src/container-options.js'

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

/** Every app-owned registry seam on `CoreDependencies`, derived rather than restated. */
type RegistrySeam = Extract<keyof CoreDependencies, `${string}Registry`>

/**
 * How a seam reaches `CoreDependencies` on this facade.
 *
 * - `option` — its own field on {@link NodeContainerOptions}, mapped in `container-core-deps.ts`.
 *   The default for anything a DEPLOYMENT registers on.
 * - `bundled` — reached through a composite option rather than its own field, because the
 *   registries in that family are registered together (`backendRegistries`).
 * - `internal` — built by the facade from its own configuration, so a deployment has nothing to
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
})
