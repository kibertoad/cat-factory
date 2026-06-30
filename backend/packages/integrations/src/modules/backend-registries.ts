import {
  defaultEnvironmentBackendRegistry,
  type EnvironmentBackendRegistry,
} from './environments/environment-backends.js'
import {
  defaultRunnerBackendRegistry,
  type RunnerBackendRegistry,
} from './runners/runner-backends.js'

// The single "unified" construction entry for the app-owned backend registries. A facade's
// composition root calls this ONCE, optionally registers any deployment-custom backends
// (`registries.runnerBackendRegistry.register(myBackend)`), then spreads the result into
// `CoreDependencies`. This is the seam that replaces the old import-side-effect registration:
// the app owns the storage and hands the same instances to every consumer, so a custom
// backend is seen regardless of module identity. See `docs/initiatives/registry-di-migration.md`.

/** The set of app-owned backend registries the composition root builds and injects. */
export interface BackendRegistries {
  environmentBackendRegistry: EnvironmentBackendRegistry
  runnerBackendRegistry: RunnerBackendRegistry
}

/** Build the backend registries pre-loaded with the built-in (`manifest` + `kubernetes`) kinds. */
export function createBackendRegistries(): BackendRegistries {
  return {
    environmentBackendRegistry: defaultEnvironmentBackendRegistry(),
    runnerBackendRegistry: defaultRunnerBackendRegistry(),
  }
}
