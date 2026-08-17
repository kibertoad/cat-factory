import { describe, expect, it } from 'vitest'
import type { CoreDependencies } from '@cat-factory/orchestration'
import * as kernel from '@cat-factory/kernel'
import * as facade from '../src/index.js'
import type {
  AgentKindVariantDefinition,
  BinaryOutputConfig,
  CustomTaskType,
  DescriptorField,
  DescriptorFieldShowWhen,
  GateDefinition,
  JudgeDefinition,
  PipelineSpec,
  PipelineStepSpec,
  PromptFragment,
  StepCompletionResolver,
  StepOptions,
  TaskTypeFieldDescriptor,
  TaskTypeFieldOption,
  TaskTypePresentation,
} from '../src/index.js'
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
  binaryStoreRegistry: 'option',
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
  binaryStoreRegistry: 'entry-point',
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

// ---------------------------------------------------------------------------
// The same guard, one layer out AGAIN: from "can a deployment PASS this seam" to "can it BUILD a
// value to pass".
//
// The two classifications above grade the DOOR. Both were green for `gateRegistry`, `judgeRegistry`,
// `stepResolverRegistry`, `vcsRegistry` and `promptFragmentRegistry` while this facade exported no
// way to construct one, so the only route to a custom gate or an org standards pool was a direct
// dependency on `@cat-factory/kernel` / `@cat-factory/gates` / `@cat-factory/prompt-fragments`.
//
// That is not a documentation problem. A `workspace:*` dependency publishes as an EXACT version, so
// a consumer floating the range onto a newer patch resolves a SECOND physical copy of the package
// it reached below the facade for: the registration lands in the copy the server does not read, and
// the only symptom is agents that fold nothing. Making the seam's constructor an export of the
// facade the deployment ALREADY depends on removes the second copy by construction, which is why
// this belongs in the guard rather than in a doc.
// ---------------------------------------------------------------------------

/** The seams a DEPLOYMENT supplies a value for: everything the boot routes do not build itself. */
type ConstructibleSeam = {
  [K in RegistrySeam]: (typeof BOOT_ROUTES)[K] extends 'entry-point' | 'bundled' ? K : never
}[RegistrySeam]

/**
 * What this facade must EXPORT for a deployment to produce a value for each seam it may inject,
 * derived from {@link BOOT_ROUTES} rather than listed, so a new deployment-facing seam fails to
 * compile here until its constructor is named.
 *
 * Each entry lists every supported construction, not one blessed path, because for three of these
 * the choice between them is load-bearing and the platform must not make it: an injected
 * `gateRegistry` / `promptFragmentRegistry` REPLACES the pool rather than merging with it, so
 * `defaultGateRegistry()` and `promptFragmentRegistryWithBuiltins()` are opposite deployments and
 * both are legitimate.
 */
const SEAM_CONSTRUCTORS = {
  agentKindRegistry: ['AgentKindRegistry', 'defaultAgentKindRegistry'],
  gateRegistry: ['GateRegistry', 'defaultGateRegistry', 'gateRegistryWithBuiltins'],
  judgeRegistry: ['JudgeRegistry', 'defaultJudgeRegistry'],
  stepResolverRegistry: ['StepResolverRegistry', 'defaultStepResolverRegistry'],
  pipelineRegistry: ['PipelineRegistry', 'defaultPipelineRegistry'],
  taskTypeRegistry: ['TaskTypeRegistry', 'defaultTaskTypeRegistry'],
  initiativePresetRegistry: ['InitiativePresetRegistry', 'defaultInitiativePresetRegistry'],
  vcsRegistry: ['VcsProviderRegistry', 'defaultVcsRegistry'],
  foundationalServiceRegistry: [
    'FoundationalServiceRegistry',
    'defaultFoundationalServiceRegistry',
  ],
  binaryGeneratorRegistry: [
    'BinaryGeneratorRegistry',
    'defaultBinaryGeneratorRegistry',
    'binaryGeneratorRegistryWithBuiltins',
  ],
  binaryStoreRegistry: ['BinaryStoreRegistry', 'defaultBinaryStoreRegistry'],
  promptFragmentRegistry: [
    'PromptFragmentRegistry',
    'defaultPromptFragmentRegistry',
    'promptFragmentRegistryWithBuiltins',
  ],
  // Both halves of the bundle come from ONE builder, which is the point of bundling them.
  environmentBackendRegistry: ['createBackendRegistries'],
  runnerBackendRegistry: ['createBackendRegistries'],
} as const satisfies Record<ConstructibleSeam, readonly string[]>

/**
 * The TYPE half of the same surface, which no runtime check can see: a deployment writing a
 * registration literal names its shape, and a type it cannot import from the facade is a direct
 * `@cat-factory/contracts` dependency with the same duplicate-copy hazard as a missing constructor.
 *
 * Enumerated rather than derived because a type union is not reflectable; the compile error when
 * one is missing is the guard, and this value exists only to make the imports load-bearing.
 */
const _authoringVocabulary:
  | {
      taskType: CustomTaskType
      presentation: TaskTypePresentation
      field: TaskTypeFieldDescriptor
      option: TaskTypeFieldOption
      descriptorField: DescriptorField
      condition: DescriptorFieldShowWhen
      fragment: PromptFragment
      gate: GateDefinition
      judge: JudgeDefinition
      resolver: StepCompletionResolver
      // The PIPELINE authoring half: a deployment replacing a shipped preset writes its steps by
      // name and fills in the per-step options its kinds read, so the spec shapes are as much part
      // of the seam as the registry constructor is.
      pipeline: PipelineSpec
      pipelineStep: PipelineStepSpec
      stepOptions: StepOptions
      binaryOutput: BinaryOutputConfig
      variant: AgentKindVariantDefinition
    }
  | undefined = undefined

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

  it('keeps the deployment-registered artifact STORE per-process, with no source beside it', () => {
    // The store registry looks like the generative one and is deliberately routed differently:
    // there is no `binaryStoreSource`, because a store is a live client holding credentials and
    // only the process about to write the bytes can construct one. A source would let a node be
    // pointed at another process's answer to a question that process cannot act on.
    expect(SEAM_ROUTES.binaryStoreRegistry).toBe('option')
    expect(BOOT_ROUTES.binaryStoreRegistry).toBe('entry-point')
    expect(Object.keys(SEAM_ROUTES)).not.toContain('binaryStoreSource')
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

  it('exports a way to CONSTRUCT every seam it lets a deployment inject', () => {
    const exported = new Set(Object.keys(facade))
    const missing = Object.entries(SEAM_CONSTRUCTORS).flatMap(([seam, names]) =>
      names.filter((name) => !exported.has(name)).map((name) => `${seam}: ${name}`),
    )
    // Naming every gap at once rather than failing on the first: these arrive in batches (five did),
    // and a guard that reports one per run trains the reader to fix one per run.
    expect(missing).toEqual([])
  })

  it('re-exports every built-in pipeline id kernel publishes', () => {
    // DERIVED from kernel, not listed: this set grows whenever the platform ships a pipeline, and a
    // hand-copied list is how two of them (`pl_spike`, `pl_ralph`) came to be missing from all three
    // facades at once, leaving a deployment pinning one to hard-code the string. Counting instead
    // would fail on the next ordinary addition while naming nothing about what broke.
    const published = Object.keys(kernel).filter((name) => name.endsWith('_PIPELINE_ID'))
    expect(published.length).toBeGreaterThan(0)
    const exported = new Set(Object.keys(facade))
    expect(published.filter((name) => !exported.has(name))).toEqual([])
  })

  it('names the authoring vocabulary a registration literal is typed against', () => {
    // Carried by the type annotation on `_authoringVocabulary`; the assertion exists so a missing
    // export fails a test rather than only a typecheck job the reader has to go find.
    expect(_authoringVocabulary).toBeUndefined()
  })
})
