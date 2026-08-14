import { defaultAgentKindRegistry, defaultInitiativePresetRegistry } from '@cat-factory/agents'
import {
  NoopEventPublisher,
  NoopWorkRunner,
  defaultBinaryGeneratorRegistry,
  defaultBinaryStoreRegistry,
  defaultGateRegistry,
  defaultJudgeRegistry,
  defaultPipelineRegistry,
  defaultProviderRegistry,
  defaultStepResolverRegistry,
  defaultFoundationalServiceRegistry,
  defaultPromptFragmentRegistry,
  defaultTaskTypeRegistry,
  registryBinaryGeneratorSource,
  registryBuiltinSource,
  registryPromptFragmentSource,
} from '@cat-factory/kernel'
import { createAppCaches } from '@cat-factory/caching'
import type { CoreDependencies } from '../container.js'

/**
 * Resolve the app-owned registries + shared runtime singletons ONCE. Each registry uses the
 * facade's injected instance (so a deployment's custom kinds/gates/resolvers/pipelines/presets/
 * task-types are visible) else a fresh default; the SAME instances are threaded into the engine
 * and re-exposed on `Core` for the HTTP snapshot. `workRunner`/`executionEventPublisher` fall back to no-ops, and `caches` (the caching-initiative slice bag) to bare in-memory loaders — so the
 * cached path, including the services' write-site invalidation, is exercised everywhere. Built
 * up-front so every service in `createCore` can be threaded the same instances. Extracted from
 * `container.ts` as a cohesive collaborator (the file-size ratchet: split, never grow).
 */
export function resolveCoreRuntime(dependencies: CoreDependencies) {
  // Resolved ONCE and shared by the two entries below: the registry itself (which the boot
  // validation and the snapshot read) and the default `builtin`-tier source that wraps it. A
  // second `defaultFoundationalServiceRegistry()` call would hand the catalog a different
  // instance from the one a deployment registered on — silently, since the two are identical
  // until someone registers.
  const foundationalServiceRegistry =
    dependencies.foundationalServiceRegistry ?? defaultFoundationalServiceRegistry()
  // The same pairing for the generative integrations, and for the same reason: the registry the
  // boot validation reads and the default source that wraps it must be ONE instance.
  const binaryGeneratorRegistry =
    dependencies.binaryGeneratorRegistry ?? defaultBinaryGeneratorRegistry()
  // …and the third of the same pairing, for the best-practice fragment pool. The bare default is
  // EMPTY rather than the shipped catalog: the built-ins install through the public seam
  // (`promptFragmentRegistryWithBuiltins()`), which is what a facade injects, so a caller that
  // passes nothing gets no standards rather than a second silently-different pool.
  const promptFragmentRegistry =
    dependencies.promptFragmentRegistry ?? defaultPromptFragmentRegistry()
  return {
    agentKindRegistry: dependencies.agentKindRegistry ?? defaultAgentKindRegistry(),
    gateRegistry: dependencies.gateRegistry ?? defaultGateRegistry(),
    judgeRegistry: dependencies.judgeRegistry ?? defaultJudgeRegistry(),
    stepResolverRegistry: dependencies.stepResolverRegistry ?? defaultStepResolverRegistry(),
    providerRegistry: dependencies.providerRegistry ?? defaultProviderRegistry(),
    pipelineRegistry: dependencies.pipelineRegistry ?? defaultPipelineRegistry(),
    taskTypeRegistry: dependencies.taskTypeRegistry ?? defaultTaskTypeRegistry(),
    foundationalServiceRegistry,
    // The deployment's generative binary integrations (image / music / video generation APIs).
    // Empty by default, exactly like the foundational registry above and for the same reason: a
    // facade injects the one instance it registered on, so the engine, the boot validation and
    // the dispatch brief can never be looking at different sets.
    binaryGeneratorRegistry,
    // The deployment's OWN binary artifact stores (where a screenshot's or a design render's
    // bytes go). Empty by default: the platform's `fs` / `db` / `s3` / `r2` backends are the
    // facades' own wiring, not registry entries, so an empty registry is exactly today's
    // behaviour. No `Source` sibling: see `CoreDependencies.binaryStoreRegistry` for why a
    // store cannot cross a machine API the way a generator definition does.
    binaryStoreRegistry: dependencies.binaryStoreRegistry ?? defaultBinaryStoreRegistry(),
    // Where those integrations are READ from — the exact sibling of `foundationalBuiltins`
    // below, defaulting to this process's own registry and overridden by a mothership-mode node
    // with the REMOTE source. It is a separate entry from the registry above because the two
    // answer different questions on such a node: the registry is what THIS build registers (the
    // boot validation's subject, and what `/internal/binary-generators` serves when this process
    // is the mothership), while the source is what any RUN resolves against.
    binaryGenerators:
      dependencies.binaryGeneratorSource ?? registryBinaryGeneratorSource(binaryGeneratorRegistry),
    // Where the catalog's `builtin` tier is READ from. Defaults to this process's own registry
    // (the same instance, so the engine and the boot validation can never disagree); a
    // mothership-mode node injects the REMOTE source instead, because the estate is org state
    // its own build can only hold a second, drifting copy of.
    foundationalBuiltins:
      dependencies.foundationalBuiltinSource ?? registryBuiltinSource(foundationalServiceRegistry),
    promptFragmentRegistry,
    // The third member of the registry/source pair family, and it answers the same two different
    // questions on a mothership node: the registry is what THIS build registered (the boot
    // validation's subject, and what `/internal/prompt-fragments` serves when this process is the
    // mothership), while the source is the pool any RUN folds its standards from.
    promptFragments:
      dependencies.promptFragmentSource ?? registryPromptFragmentSource(promptFragmentRegistry),
    initiativePresetRegistry:
      dependencies.initiativePresetRegistry ?? defaultInitiativePresetRegistry(),
    workRunner: dependencies.workRunner ?? new NoopWorkRunner(),
    executionEventPublisher: dependencies.executionEventPublisher ?? new NoopEventPublisher(),
    caches: dependencies.caches ?? createAppCaches(),
    // Required on `CoreDependencies` (a facade that forgets it fails to typecheck), so unlike
    // its neighbours there is nothing to fall back to — it is re-listed here purely so every
    // service is threaded the SAME instance out of one resolution point.
    logger: dependencies.logger,
    // Required for the same reason and re-listed here for the same reason as `logger` above:
    // an operational counter nobody increments is indistinguishable from an event that never
    // happened, which is precisely the confusion this seam exists to remove.
    operationalMetrics: dependencies.operationalMetrics,
  }
}
