import type {
  ContentStorageBackend,
  ContentStorageConfig,
  ContentStorageFsConfig,
  ContentStorageS3Config,
  S3CredentialsSecret,
} from '@cat-factory/contracts'
import type {
  BinaryArtifactMetadataStore,
  BinaryArtifactStorageKind,
  BinaryArtifactStore,
  BinaryBlobBackend,
  Clock,
  IdGenerator,
  ResolveBinaryArtifactStore,
} from '@cat-factory/kernel'
import { createBinaryArtifactStore } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Per-account binary-artifact store resolution. The blob backend (filesystem / S3 / R2 /
// Postgres) is configured per-account in the UI, so the store is composed at request/run
// time from the account's settings rather than wired once at boot. This mirrors the
// `makeResolveRunRepoContext` seam: a runtime-neutral composer parameterised by the
// runtime's own blob-backend factory + the runtime's metadata store.
// ---------------------------------------------------------------------------

/** The non-secret + decrypted content-storage settings the resolver needs (structural). */
export interface ContentStorageSettingsResolver {
  resolve(accountId: string): Promise<{
    config: { contentStorage?: ContentStorageConfig }
    s3Credentials?: S3CredentialsSecret
  }>
}

/** Connection settings handed to a runtime's blob-backend factory for one resolved account. */
export interface BuildBlobBackendOptions {
  fs?: ContentStorageFsConfig
  s3?: ContentStorageS3Config
  /** Decrypted S3 access keys (the secret half of an `s3` backend's config). */
  s3Credentials?: S3CredentialsSecret
}

/**
 * Build the blob backend a runtime can serve for `kind`, or `null` when the runtime does
 * not support it (e.g. `fs` on Cloudflare, `r2` on Node) — `null` ⇒ storage unavailable.
 * `kind` is never `'off'` (the resolver short-circuits that before calling the factory).
 */
export type BuildBlobBackend = (
  kind: BinaryArtifactStorageKind,
  opts: BuildBlobBackendOptions,
) => BinaryBlobBackend | null

export interface MakeResolveBinaryArtifactStoreDeps {
  /**
   * Resolves an account's decrypted content-storage settings (the AccountSettingsService).
   * Absent (no encryption key) ⇒ no per-account override; every workspace uses the runtime
   * {@link defaultBackend} (e.g. R2 on a stock Cloudflare deployment).
   */
  accountSettings?: ContentStorageSettingsResolver
  /** Maps a workspace to its owning account id (null = legacy unscoped board). */
  accountOf: (workspaceId: string) => Promise<string | null | undefined>
  /** The runtime's metadata store (D1 ⇄ Drizzle) — bytes live in the resolved blob backend. */
  metadata: BinaryArtifactMetadataStore
  idGenerator: IdGenerator
  clock: Clock
  /** Builds the blob backend for a resolved backend kind; `null` ⇒ unsupported on this runtime. */
  buildBlobBackend: BuildBlobBackend
  /** Backend used when an account has no content-storage config (the runtime default). */
  defaultBackend: ContentStorageBackend
  /** Optional structural logger, forwarded to the composed store to surface partial reclaims. */
  logger?: { warn(obj: Record<string, unknown>, msg?: string): void }
}

/**
 * A stable, non-reversible fingerprint of the decrypted S3 credentials, folded into the
 * cache signature so ROTATING the keys (their presence is unchanged, but the values differ)
 * rebuilds the composed store — otherwise the S3 client memoised inside the `s3` backend
 * would keep using the old keys until the process restarted. A tiny FNV-1a hash keeps the
 * raw secret out of the in-memory signature string.
 */
function credentialFingerprint(creds?: S3CredentialsSecret): string | null {
  if (!creds) return null
  const material = `${creds.accessKeyId}|${creds.secretAccessKey}`
  let hash = 0x811c9dc5
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/**
 * Compose a {@link ResolveBinaryArtifactStore}: workspace → owning account → that account's
 * configured backend (or the runtime default when unconfigured) → a composed
 * {@link BinaryArtifactStore}. Returns `null` when the effective backend is `off` or the
 * runtime cannot serve it (every consumer treats `null` as "storage unavailable"). The
 * composed store is cached per account keyed by a config signature (which includes a
 * fingerprint of the S3 credentials), so switching an account's backend OR rotating its S3
 * keys rebuilds it — and the S3 client memoised inside an `s3` backend survives across
 * requests until the config actually changes.
 */
export function makeResolveBinaryArtifactStore(
  deps: MakeResolveBinaryArtifactStoreDeps,
): ResolveBinaryArtifactStore {
  const cache = new Map<string, { signature: string; store: BinaryArtifactStore }>()

  return async (workspaceId) => {
    const accountId = (await deps.accountOf(workspaceId)) ?? null

    let backend: ContentStorageBackend = deps.defaultBackend
    let fs: ContentStorageFsConfig | undefined
    let s3: ContentStorageS3Config | undefined
    let s3Credentials: S3CredentialsSecret | undefined
    if (accountId && deps.accountSettings) {
      const resolved = await deps.accountSettings.resolve(accountId)
      const cs = resolved.config.contentStorage
      if (cs) {
        backend = cs.backend
        fs = cs.fs
        s3 = cs.s3
        s3Credentials = resolved.s3Credentials
      }
    }

    if (backend === 'off') return null

    const cacheKey = accountId ?? '__default__'
    const signature = JSON.stringify({
      backend,
      fs,
      s3,
      creds: credentialFingerprint(s3Credentials),
    })
    const cached = cache.get(cacheKey)
    if (cached && cached.signature === signature) return cached.store

    const blob = deps.buildBlobBackend(backend, { fs, s3, s3Credentials })
    if (!blob) return null
    const store = createBinaryArtifactStore({
      metadata: deps.metadata,
      blob,
      idGenerator: deps.idGenerator,
      clock: deps.clock,
      ...(deps.logger ? { logger: deps.logger } : {}),
    })
    cache.set(cacheKey, { signature, store })
    return store
  }
}
