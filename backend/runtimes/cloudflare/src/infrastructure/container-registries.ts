import {
  defaultProviderRegistry,
  defaultStepResolverRegistry,
  defaultVcsRegistry,
} from '@cat-factory/kernel'
import { defaultAgentKindRegistry, defaultInitiativePresetRegistry } from '@cat-factory/agents'
import { createBackendRegistries } from '@cat-factory/integrations'
import { gateRegistryWithBuiltins } from '@cat-factory/gates'
import { eksEnvironmentBackend, eksRunnerBackend } from '@cat-factory/eks'
import type { CoreDependencies } from '@cat-factory/orchestration'

/** The app-owned registries the Worker facade resolves once per build. */
type WorkerRegistries = Required<
  Pick<
    CoreDependencies,
    | 'environmentBackendRegistry'
    | 'runnerBackendRegistry'
    | 'customManifestTypeRegistry'
    | 'userSecretKindRegistry'
    | 'agentKindRegistry'
    | 'gateRegistry'
    | 'stepResolverRegistry'
    | 'initiativePresetRegistry'
    | 'vcsRegistry'
    | 'providerRegistry'
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
    stepResolverRegistry,
    initiativePresetRegistry,
    vcsRegistry,
    providerRegistry,
  }
}
