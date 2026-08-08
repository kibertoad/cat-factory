import type {
  ContentStorageBackend,
  ContentStorageCapability,
  ContentStorageConfig,
  ContentStorageCustomConfig,
  ContentStorageFsConfig,
  ContentStorageS3Config,
  S3CredentialsSecret,
} from '@cat-factory/contracts'
import type {
  BinaryArtifactMetadataStore,
  BinaryArtifactStorageKind,
  BinaryArtifactStore,
  BinaryBlobBackend,
  BinaryStoreRegistry,
  Clock,
  IdGenerator,
  Logger,
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
 * `kind` is never `'off'` and never `'custom'`: the resolver short-circuits the first and serves
 * the second from the app-owned {@link BinaryStoreRegistry}, which is runtime-neutral, so
 * neither facade's factory has to learn about deployment-registered stores at all.
 */
export type BuildBlobBackend = (
  kind: BinaryArtifactStorageKind,
  opts: BuildBlobBackendOptions,
) => BinaryBlobBackend | null

/**
 * Fold the deployment's registered stores into a runtime's declared content-storage capability:
 * the `custom` option appears in the picker exactly when at least one store is registered.
 *
 * Shared rather than done per facade because it is the answer to one question ("what may an
 * account select here"), and a facade that assembled it itself is a facade that can offer
 * `custom` with nothing behind it, or register stores nothing offers.
 */
export function withRegisteredBinaryStores(
  capability: ContentStorageCapability,
  registry?: BinaryStoreRegistry,
): ContentStorageCapability {
  const customStores = registry?.views() ?? []
  return {
    ...capability,
    supportedBackends: customStores.length
      ? [...capability.supportedBackends, 'custom']
      : capability.supportedBackends,
    customStores,
  }
}

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
  /**
   * The deployment's own binary artifact stores, registered in code. Consulted only when an
   * account selects `backend: 'custom'`; absent ⇒ this deployment registers none, and such an
   * account resolves to no storage (named in the log, since the alternative is an account that
   * reads as configured and silently retains nothing).
   */
  binaryStoreRegistry?: BinaryStoreRegistry
  /** Backend used when an account has no content-storage config (the runtime default). */
  defaultBackend: ContentStorageBackend
  /** Optional structural logger, forwarded to the composed store to surface partial reclaims. */
  logger?: Logger
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
 * Build the blob backend for an account that selected a DEPLOYMENT-REGISTERED store.
 *
 * Every failure lands on the same `null` the built-in backends use for "this runtime cannot
 * serve it", because that is the disposition every consumer already implements (the artifact
 * controllers 503, the visual-confirmation gate passes through). What it does NOT share with them
 * is silence: an unregistered id is a deployment whose build no longer carries a store its
 * accounts still point at, and nothing else in the system would ever say so. The account's
 * settings page shows exactly what was saved, and the artifacts simply stop being retained.
 */
function buildRegisteredStore(
  deps: MakeResolveBinaryArtifactStoreDeps,
  accountId: string | null,
  custom: ContentStorageCustomConfig | undefined,
): BinaryBlobBackend | null {
  const storeId = custom?.storeId
  if (!storeId) {
    // Only reachable through a config written outside the settings API, which refuses this shape.
    deps.logger?.warn('content storage: custom backend selected with no store named', { accountId })
    return null
  }
  const definition = deps.binaryStoreRegistry?.get(storeId)
  if (!definition) {
    deps.logger?.warn('content storage: no binary store registered under the configured id', {
      accountId,
      storeId,
      registered: deps.binaryStoreRegistry?.ids() ?? [],
    })
    return null
  }
  const blob = definition.create({
    accountId,
    ...(deps.logger ? { logger: deps.logger } : {}),
  })
  if (!blob) {
    // The store's own "not right now" (an unset credential, an un-provisioned bucket). It said so
    // deliberately, so this is a lower-severity line than the two above and still not silent.
    deps.logger?.info('content storage: registered binary store declined to build', {
      accountId,
      storeId,
    })
    return null
  }
  // The persisted `storage` value is the REGISTERED id, not whatever the implementation declares.
  // The column's only job is to say which store to ask for these bytes, and the registry is the
  // only party that knows the answer: an implementation reused under two registrations (one bucket
  // per region, say) declares one `kind` for both, and one stamping `s3` would make its rows read
  // as the platform's own S3 backend's. Wrapped rather than spread so a class instance keeps its
  // `this`.
  return {
    kind: definition.id,
    put: (key, bytes, contentType) => blob.put(key, bytes, contentType),
    get: (key) => blob.get(key),
    delete: (key) => blob.delete(key),
  }
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
    let custom: ContentStorageCustomConfig | undefined
    let s3Credentials: S3CredentialsSecret | undefined
    if (accountId && deps.accountSettings) {
      const resolved = await deps.accountSettings.resolve(accountId)
      const cs = resolved.config.contentStorage
      if (cs) {
        backend = cs.backend
        fs = cs.fs
        s3 = cs.s3
        custom = cs.custom
        s3Credentials = resolved.s3Credentials
      }
    }

    if (backend === 'off') return null

    const cacheKey = accountId ?? '__default__'
    const signature = JSON.stringify({
      backend,
      fs,
      s3,
      // The store id joins the signature for the same reason the S3 fingerprint does: switching
      // an account between two registered stores changes nothing else here, and a cached store
      // would keep writing into the one it was pointed at when it was built.
      custom,
      creds: credentialFingerprint(s3Credentials),
    })
    const cached = cache.get(cacheKey)
    if (cached && cached.signature === signature) return cached.store

    const blob =
      backend === 'custom'
        ? buildRegisteredStore(deps, accountId, custom)
        : deps.buildBlobBackend(backend, { fs, s3, s3Credentials })
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
