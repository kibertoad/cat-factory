import {
  defaultJudgeRegistry,
  defaultProviderRegistry,
  defaultStepResolverRegistry,
  defaultVcsRegistry,
} from '@cat-factory/kernel'
import { defaultAgentKindRegistry, defaultInitiativePresetRegistry } from '@cat-factory/agents'
import { createBackendRegistries } from '@cat-factory/integrations'
import { gateRegistryWithBuiltins } from '@cat-factory/gates'
import { promptFragmentRegistryWithBuiltins } from '@cat-factory/prompt-fragments'
import { eksEnvironmentBackend, eksRunnerBackend } from '@cat-factory/eks'
import { registeredBinaryStoreRegistry } from './binaryStores'
import type { CoreDependencies } from '@cat-factory/orchestration'

/** The app-owned registries the Worker facade resolves once per build. */
export type WorkerRegistries = Required<
  Pick<
    CoreDependencies,
    | 'environmentBackendRegistry'
    | 'runnerBackendRegistry'
    | 'customManifestTypeRegistry'
    | 'userSecretKindRegistry'
    | 'agentKindRegistry'
    | 'gateRegistry'
    | 'judgeRegistry'
    | 'stepResolverRegistry'
    | 'initiativePresetRegistry'
    | 'vcsRegistry'
    | 'providerRegistry'
    | 'promptFragmentRegistry'
    | 'binaryStoreRegistry'
  >
>

/**
 * Resolve the app-owned backend registries (env + runner kind → provider, agent-kind, gate,
 * step-resolver, initiative-preset, VCS, gate-provider): the injected instance via `overrides`,
 * else the built-in default. Extracted from {@link buildContainer} to keep its cyclomatic
 * complexity down — the many `overrides.X ?? default()` fallbacks are behaviour-neutral here, and
 * the opt-in AWS EKS backends are registered by reference exactly as before (`register` is
 * idempotent, so a re-used injected registry from the conformance harness is safe).
 */
export function resolveWorkerRegistries(overrides: Partial<CoreDependencies>): WorkerRegistries {
  const defaultRegistries = createBackendRegistries()
  const environmentBackendRegistry =
    overrides.environmentBackendRegistry ?? defaultRegistries.environmentBackendRegistry
  const runnerBackendRegistry =
    overrides.runnerBackendRegistry ?? defaultRegistries.runnerBackendRegistry
  const customManifestTypeRegistry =
    overrides.customManifestTypeRegistry ?? defaultRegistries.customManifestTypeRegistry
  const userSecretKindRegistry =
    overrides.userSecretKindRegistry ?? defaultRegistries.userSecretKindRegistry
  // The app-owned agent-kind registry (built-ins + any a deployment registered by reference).
  const agentKindRegistry = overrides.agentKindRegistry ?? defaultAgentKindRegistry()
  // The app-owned gate registry: the injected instance, else a fresh one with the built-in
  // `@cat-factory/gates` suite installed — so a container built directly for a scheduled/cron sweep
  // (no overrides) still has the gates its re-driven runs need.
  const gateRegistry = overrides.gateRegistry ?? gateRegistryWithBuiltins()
  // The app-owned step-resolver registry: the injected instance else an empty default (the built-in
  // `merger` resolver is a privileged engine built-in, not a registry entry).
  const stepResolverRegistry = overrides.stepResolverRegistry ?? defaultStepResolverRegistry()
  // The app-owned JUDGE registry (the fourth step-taxonomy bucket): the injected instance, else an
  // empty default — the platform ships no built-in judges, so every entry is a deployment's own.
  const judgeRegistry = overrides.judgeRegistry ?? defaultJudgeRegistry()
  // The app-owned initiative-preset registry (built-in generic / docs-refresh / tech-migration +
  // any a deployment registered by reference).
  const initiativePresetRegistry =
    overrides.initiativePresetRegistry ?? defaultInitiativePresetRegistry()
  // The app-owned VCS provider registry: a fresh instance per build (the injected one via
  // `overrides`, else empty). The GitLab provider is registered onto it by the caller when configured.
  const vcsRegistry = overrides.vcsRegistry ?? defaultVcsRegistry()
  // The app-owned provider registry the built-in gates probe through: a fresh instance per build
  // (the injected one via `overrides`, else empty), wired by the caller when a gate is configured.
  const providerRegistry = overrides.providerRegistry ?? defaultProviderRegistry()
  // The app-owned best-practice standards pool: the injected instance, else a fresh one carrying
  // the shipped `@cat-factory/prompt-fragments` catalog and its per-task-type default sets. The
  // default belongs HERE for the same reason the gate registry's does: the engine's own default is
  // deliberately empty, and a container built directly (a cron sweep, a Workflow step, a Durable
  // Object) takes no overrides, so defaulting only at the `createWorker` entry point would fold no
  // standards into exactly the runs nobody is watching.
  const promptFragmentRegistry =
    overrides.promptFragmentRegistry ?? promptFragmentRegistryWithBuiltins()
  // The app-owned registry of the deployment's OWN binary artifact stores: the injected instance,
  // else the PROCESS-WIDE registration (empty when a deployment registered none; the platform's
  // R2 backend is this facade's own wiring, not an entry).
  //
  // The fallback differs in kind from every other one here, and the difference is the whole
  // point. The others fall back to a default the PLATFORM ships, so a container built with no
  // overrides is still correct. This registry has no platform default: its entire content is a
  // deployment's own, so falling back to a fresh empty one leaves the override-less builders
  // (the `ExecutionWorkflow` wake that stores a visual-confirmation screenshot, the queue
  // consumers, the Durable Objects) resolving NO store for an account that selected one. The gate
  // passes through when no store resolves, so nothing fails: the run completes having captured
  // nothing. `infrastructure/binaryStores.ts` holds the registration this reads.
  const binaryStoreRegistry = overrides.binaryStoreRegistry ?? registeredBinaryStoreRegistry()

  // Register the opt-in AWS EKS backends by reference (symmetric with the Node facade; a
  // pass-through until a workspace connects an `eks` backend). `register` is idempotent (keyed
  // by `kind`), so a re-used injected registry (the conformance harness) is safe.
  runnerBackendRegistry.register(eksRunnerBackend)
  environmentBackendRegistry.register(eksEnvironmentBackend)

  return {
    environmentBackendRegistry,
    runnerBackendRegistry,
    customManifestTypeRegistry,
    userSecretKindRegistry,
    agentKindRegistry,
    gateRegistry,
    judgeRegistry,
    stepResolverRegistry,
    initiativePresetRegistry,
    vcsRegistry,
    providerRegistry,
    promptFragmentRegistry,
    binaryStoreRegistry,
  }
}
