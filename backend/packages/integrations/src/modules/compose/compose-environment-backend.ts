import { ValidationError } from '@cat-factory/kernel'
import { ComposeEnvironmentProvider } from './ComposeEnvironmentProvider.js'
import { type ComposeRuntime, parseComposeEnvConfig } from './compose-environment.logic.js'
// Type-only import of the registry seam so there is no runtime cycle (the kubernetes backend
// uses the same pattern): environment-backends.ts imports nothing from here; the facade
// registers this backend by reference.
import type { EnvironmentBackendProvider } from '../environments/environment-backends.js'

// The Docker Compose environment backend. Unlike the built-in `manifest`/`kubernetes` backends,
// it is NOT in the default registry: it needs a host Docker daemon, so the LOCAL facade registers
// it BY REFERENCE, closing over a `ComposeRuntime` that drives the docker CLI. The plain Node
// service (no per-run container runtime) and the Cloudflare Worker (no daemon) never register it
// — the documented runtime-bound asymmetry.
//
// It rides the contract's generic environment-backend manifest member (kind `compose` is not a
// reserved built-in), so it needs no new config variant, no table, and no migration: the flat
// config lives in the stored manifest's `providerConfig`, written by the descriptor-driven
// connect form (`describeConfig`/`describeManifestTemplate`).

/** Build the Compose environment backend over a host `ComposeRuntime` (the docker CLI seam). */
export function composeEnvironmentBackend(runtime: ComposeRuntime): EnvironmentBackendProvider {
  return {
    kind: 'compose',
    displayLabel: 'Docker Compose',
    // The local docker-compose stack is the `local-docker` engine (local facade only).
    engines: () => ['local-docker'],
    // No secrets — a compose stack authenticates via the images themselves.
    referencedSecretKeys: () => [],
    connectionMeta: (config) => ({
      providerId: 'compose',
      label: 'manifest' in config ? config.manifest.label : 'Docker Compose',
      baseUrl: 'manifest' in config ? config.manifest.baseUrl : 'http://localhost',
    }),
    assertConfigSafe: (config) => {
      // The provider only ever returns a localhost URL and never fetches an operator-supplied
      // URL, so there is no SSRF surface. Validate the load-bearing fields (service + port) up
      // front so a bad config fails the connect form (422) instead of deep in a provision.
      if (!('manifest' in config)) return
      try {
        parseComposeEnvConfig(config.manifest)
      } catch (err) {
        throw new ValidationError(err instanceof Error ? err.message : String(err))
      }
    },
    toManifest: (config) => {
      if (!('manifest' in config)) throw new Error('Expected a Docker Compose environment config')
      return config.manifest
    },
    fromManifest: (manifest) => ({ kind: 'compose', manifest }),
    buildProvider: (ctx) => new ComposeEnvironmentProvider(runtime, { urlPolicy: ctx.urlPolicy }),
  }
}
