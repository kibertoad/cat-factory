import type {
  BinaryStoreRegistry,
  Clock,
  IdGenerator,
  ResolveBinaryArtifactStore,
} from '@cat-factory/kernel'
import type { ContentStorageCapability } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import {
  type BuildBlobBackend,
  makeResolveBinaryArtifactStore,
  withRegisteredBinaryStores,
} from '@cat-factory/server'
import { R2BinaryBlobBackend } from './storage/R2BinaryBlobBackend'
import { D1BinaryArtifactMetadataStore } from './repositories/D1BinaryArtifactMetadataStore'
import { D1WorkspaceRepository } from './repositories/D1WorkspaceRepository'
import { buildAccountSettings } from './container-account-settings'
import type { Env } from './env'

// The Worker's binary-artifact (UI screenshot / reference-design) storage wiring, split out of
// `container.ts` when that file hit its size ratchet. A cohesive unit: what backends this
// runtime can serve, and the per-account store resolver built from them — which the retention
// cron also needs OUTSIDE the full container, which is why it was already a standalone pair.

export function cloudflareContentStorage(
  env: Env,
  /**
   * The deployment's own binary artifact stores, registered in code (`createWorker({ overrides:
   * { binaryStoreRegistry } })`). They add the `custom` option to the account-settings picker
   * here exactly as they do on Node; the resolver below builds one when an account selects it.
   */
  binaryStoreRegistry?: BinaryStoreRegistry,
): {
  capability: ContentStorageCapability
  buildBlobBackend: BuildBlobBackend
} {
  const capability = withRegisteredBinaryStores(
    {
      supportedBackends: env.ARTIFACT_BUCKET ? ['off', 'r2'] : ['off'],
      defaultBackend: env.ARTIFACT_BUCKET ? 'r2' : 'off',
      customStores: [],
    },
    binaryStoreRegistry,
  )
  const buildBlobBackend: BuildBlobBackend = (kind) => {
    // R2 is the only blob backend the Worker serves; anything else ⇒ storage unavailable.
    return kind === 'r2' && env.ARTIFACT_BUCKET
      ? new R2BinaryBlobBackend({ bucket: env.ARTIFACT_BUCKET })
      : null
  }
  return { capability, buildBlobBackend }
}

/**
 * Build the per-account binary-artifact store resolver outside the full container (the
 * retention cron runs in its own context). Mirrors the container wiring, with its own
 * account-settings instance (a separate short-TTL cache is fine for a periodic sweep).
 */
export function buildCloudflareArtifactStoreResolver(
  env: Env,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
  /**
   * The deployment's registered stores. The retention cron is the caller that most needs them and
   * is furthest from where they are registered: without them a sweep resolves NOTHING for every
   * account on a custom store, so those workspaces' bytes are never reclaimed and their metadata
   * rows never pruned: a silent leak on exactly the deployments that extended the platform.
   */
  binaryStoreRegistry?: BinaryStoreRegistry,
): ResolveBinaryArtifactStore {
  const { capability, buildBlobBackend } = cloudflareContentStorage(env, binaryStoreRegistry)
  return makeResolveBinaryArtifactStore({
    accountSettings: buildAccountSettings(env, db, clock, capability),
    accountOf: (workspaceId) => new D1WorkspaceRepository({ db }).accountOf(workspaceId),
    metadata: new D1BinaryArtifactMetadataStore({ db }),
    idGenerator,
    clock,
    buildBlobBackend,
    defaultBackend: capability.defaultBackend,
    ...(binaryStoreRegistry ? { binaryStoreRegistry } : {}),
  })
}
