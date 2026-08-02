import { defaultAgentKindRegistry, defaultInitiativePresetRegistry } from '@cat-factory/agents'
import {
  NoopEventPublisher,
  NoopWorkRunner,
  defaultGateRegistry,
  defaultJudgeRegistry,
  defaultPipelineRegistry,
  defaultProviderRegistry,
  defaultStepResolverRegistry,
  defaultFoundationalServiceRegistry,
  defaultTaskTypeRegistry,
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
  return {
    agentKindRegistry: dependencies.agentKindRegistry ?? defaultAgentKindRegistry(),
    gateRegistry: dependencies.gateRegistry ?? defaultGateRegistry(),
    judgeRegistry: dependencies.judgeRegistry ?? defaultJudgeRegistry(),
    stepResolverRegistry: dependencies.stepResolverRegistry ?? defaultStepResolverRegistry(),
    providerRegistry: dependencies.providerRegistry ?? defaultProviderRegistry(),
    pipelineRegistry: dependencies.pipelineRegistry ?? defaultPipelineRegistry(),
    taskTypeRegistry: dependencies.taskTypeRegistry ?? defaultTaskTypeRegistry(),
    foundationalServiceRegistry:
      dependencies.foundationalServiceRegistry ?? defaultFoundationalServiceRegistry(),
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
