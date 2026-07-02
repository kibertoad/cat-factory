import { CustomManifestTypeRegistry } from './environments/custom-manifest-types.js'
import {
  defaultEnvironmentBackendRegistry,
  type EnvironmentBackendRegistry,
} from './environments/environment-backends.js'
import {
  defaultRunnerBackendRegistry,
  type RunnerBackendRegistry,
} from './runners/runner-backends.js'
import {
  defaultUserSecretKindRegistry,
  type UserSecretKindRegistry,
} from './providers/userSecretKinds.js'

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
  /**
   * The code-defined `custom` provision-type catalog. A deployment/provider package registers a
   * custom manifest type by reference (`registries.customManifestTypeRegistry.register(...)`) the
   * same way it registers a custom backend; the connection service merges these with the
   * workspace-defined rows (`listCustomTypes`) so a programmatically-registered type surfaces in
   * the infrastructure custom-type editor AND the per-service provisioning picker. Starts empty
   * (the built-ins are the `manifest`/`kubernetes` BACKENDS, not custom manifest types).
   */
  customManifestTypeRegistry: CustomManifestTypeRegistry
  /**
   * The app-owned registry of per-USER secret kinds (a GitHub PAT today; each kind declares
   * its config fields + optional connection test). Pre-loaded with the built-in `github_pat`
   * kind; a deployment registers a custom kind by reference
   * (`registries.userSecretKindRegistry.register(...)`). Injected into `UserSecretService` by
   * each facade so a registered kind is seen regardless of module identity.
   */
  userSecretKindRegistry: UserSecretKindRegistry
}

/** Build the backend registries pre-loaded with the built-in (`manifest` + `kubernetes`) kinds. */
export function createBackendRegistries(): BackendRegistries {
  return {
    environmentBackendRegistry: defaultEnvironmentBackendRegistry(),
    runnerBackendRegistry: defaultRunnerBackendRegistry(),
    customManifestTypeRegistry: new CustomManifestTypeRegistry(),
    userSecretKindRegistry: defaultUserSecretKindRegistry(),
  }
}
