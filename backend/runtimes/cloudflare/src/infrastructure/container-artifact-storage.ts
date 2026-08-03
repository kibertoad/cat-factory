import type { Clock, IdGenerator, ResolveBinaryArtifactStore } from '@cat-factory/kernel'
import type { ContentStorageCapability } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { type BuildBlobBackend, makeResolveBinaryArtifactStore } from '@cat-factory/server'
import { R2BinaryBlobBackend } from './storage/R2BinaryBlobBackend'
import { D1BinaryArtifactMetadataStore } from './repositories/D1BinaryArtifactMetadataStore'
import { D1WorkspaceRepository } from './repositories/D1WorkspaceRepository'
import { buildAccountSettings } from './container-account-settings'
import type { Env } from './env'

// The Worker's binary-artifact (UI screenshot / reference-design) storage wiring, split out of
// `container.ts` when that file hit its size ratchet. A cohesive unit: what backends this
// runtime can serve, and the per-account store resolver built from them — which the retention
// cron also needs OUTSIDE the full container, which is why it was already a standalone pair.

export function cloudflareContentStorage(env: Env): {
  capability: ContentStorageCapability
  buildBlobBackend: BuildBlobBackend
} {
  const capability: ContentStorageCapability = {
    supportedBackends: env.ARTIFACT_BUCKET ? ['off', 'r2'] : ['off'],
    defaultBackend: env.ARTIFACT_BUCKET ? 'r2' : 'off',
  }
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
): ResolveBinaryArtifactStore {
  const { capability, buildBlobBackend } = cloudflareContentStorage(env)
  return makeResolveBinaryArtifactStore({
    accountSettings: buildAccountSettings(env, db, clock, capability),
    accountOf: (workspaceId) => new D1WorkspaceRepository({ db }).accountOf(workspaceId),
    metadata: new D1BinaryArtifactMetadataStore({ db }),
    idGenerator,
    clock,
    buildBlobBackend,
    defaultBackend: capability.defaultBackend,
  })
}
