import { defaultAgentKindRegistry, defaultInitiativePresetRegistry } from '@cat-factory/agents'
import {
  NoopEventPublisher,
  NoopWorkRunner,
  defaultBinaryGeneratorRegistry,
  defaultGateRegistry,
  defaultJudgeRegistry,
  defaultPipelineRegistry,
  defaultProviderRegistry,
  defaultStepResolverRegistry,
  defaultFoundationalServiceRegistry,
  defaultTaskTypeRegistry,
  registryBuiltinSource,
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
  // second `defaultFoundationalServiceRegistry()` call would hand the catalog a different empty
  // instance from the one a deployment registered on — silently, since both read as empty until
  // someone registers.
  const foundationalServiceRegistry =
    dependencies.foundationalServiceRegistry ?? defaultFoundationalServiceRegistry()
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
    binaryGeneratorRegistry:
      dependencies.binaryGeneratorRegistry ?? defaultBinaryGeneratorRegistry(),
    // Where the catalog's `builtin` tier is READ from. Defaults to this process's own registry
    // (the same instance, so the engine and the boot validation can never disagree); a
    // mothership-mode node injects the REMOTE source instead, because the estate is org state
    // its own build can only hold a second, drifting copy of.
    foundationalBuiltins:
      dependencies.foundationalBuiltinSource ?? registryBuiltinSource(foundationalServiceRegistry),
    initiativePresetRegistry:
      dependencies.initiativePresetRegistry ?? defaultInitiativePresetRegistry(),
    workRunner: dependencies.workRunner ?? new NoopWorkRunner(),
    executionEventPublisher: dependencies.executionEventPublisher ?? new NoopEventPublisher(),
    caches: dependencies.caches ?? createAppCaches(),
    // Required on `CoreDependencies` (a facade that forgets it fails to typecheck), so unlike
    // its neighbours there is nothing to fall back to — it is re-listed here purely so every
    // service is threaded the SAME instance out of one resolution point.
    logger: dependencies.logger,
  }
}
