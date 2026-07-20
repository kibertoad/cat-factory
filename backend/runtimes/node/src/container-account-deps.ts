import {
  ACCOUNT_SETTINGS_CIPHER_INFO,
  AccountSettingsService,
  INCIDENT_ENRICHMENT_CIPHER_INFO,
  OBSERVABILITY_CIPHER_INFO,
  RegistryReleaseHealthProvider,
  WorkspaceIncidentEnrichmentProvider,
  defaultObservabilityRegistry,
} from '@cat-factory/integrations'
import { wireIncidentEnrichment, wireReleaseHealthProvider } from '@cat-factory/gates'
import type { CoreDependencies } from '@cat-factory/orchestration'
import type { AppCaches, Clock, IdGenerator, ProviderRegistry } from '@cat-factory/kernel'
import {
  type AppConfig,
  type BuildBlobBackend,
  WebCryptoSecretCipher,
  logger,
  makeResolveBinaryArtifactStore,
} from '@cat-factory/server'
import type { ContentStorageBackend, ContentStorageCapability } from '@cat-factory/contracts'
import { S3BinaryBlobBackend } from '@cat-factory/provider-s3'
import type { DrizzleDb } from './db/client.js'
import { FilesystemBinaryBlobBackend } from './storage/FilesystemBinaryBlobBackend.js'
import { PostgresBinaryBlobBackend } from './storage/PostgresBinaryBlobBackend.js'
import type { createDrizzleRepositories } from './repositories/drizzle.js'

type NodeRepositories = ReturnType<typeof createDrizzleRepositories>

/** Inputs {@link buildNodeAccountDeps} needs from the composition root. */
export interface NodeAccountDepsInput {
  env: NodeJS.ProcessEnv
  config: AppConfig
  db: DrizzleDb
  repos: NodeRepositories
  idGenerator: IdGenerator
  clock: Clock
  /** The app-owned provider registry the observability/incident gate providers wire onto. */
  providerRegistry: ProviderRegistry
  /** The package-registry cipher built by {@link buildNodeRunServices} (management-API side). */
  packageRegistrySecretCipher: CoreDependencies['packageRegistrySecretCipher']
  contentStorageDefaultBackend?: ContentStorageBackend
  caches?: AppCaches
}

/**
 * The per-account settings + binary-artifact storage + observability/incident gate wiring of
 * the Node composition root, lifted out of `buildNodeContainer` so that root stays within the
 * file-size budget. Wires the release-health + incident-enrichment gate providers onto the
 * app-owned `providerRegistry` (a side effect — call BEFORE `applyGateProviders`), and builds
 * the per-account settings service + the content-storage blob backend factory it resolves the
 * binary-artifact store from.
 */
export function buildNodeAccountDeps(input: NodeAccountDepsInput) {
  const {
    env,
    config,
    db,
    repos,
    idGenerator,
    clock,
    providerRegistry,
    packageRegistrySecretCipher,
    contentStorageDefaultBackend,
    caches,
  } = input

  // Binary-artifact storage (UI screenshots + reference design images) for the
  // visual-confirmation gate. The backend is configured PER ACCOUNT in the UI (no env vars):
  // the metadata always lives in Postgres; the bytes go to the account's chosen blob backend
  // (`fs` → the local filesystem; `db` → a Postgres `bytea` table; `s3` → an S3 bucket).
  const contentStorageCapability: ContentStorageCapability = {
    supportedBackends: ['off', 'fs', 's3', 'db'],
    defaultBackend: contentStorageDefaultBackend ?? 'off',
  }
  const buildBlobBackend: BuildBlobBackend = (kind, opts) => {
    switch (kind) {
      case 'fs':
        // NOTE: the filesystem backend is local-disk only. It is correct for the local facade
        // and a single-instance Node deployment with a persistent volume, but NOT for a scaled
        // (multi-replica) or ephemeral-disk deployment — bytes written on one replica are
        // invisible to the others and lost on redeploy. Scaled deployments should pick `s3`.
        return new FilesystemBinaryBlobBackend({ basePath: opts.fs?.basePath })
      case 'db':
        return new PostgresBinaryBlobBackend(db)
      case 's3':
        if (!opts.s3) return null
        // Omitting credentials is intentional: the S3 client then falls back to the ambient AWS
        // credential chain (instance role / `AWS_*` env), which is the right behaviour for a
        // deployment running on AWS with an attached role. The UI requires explicit keys, so this
        // path is only reached by a config written through another channel.
        return new S3BinaryBlobBackend({
          ...opts.s3,
          ...(opts.s3Credentials ? { credentials: opts.s3Credentials } : {}),
        })
      default:
        // `r2`/`memory` are not served on Node/local — null ⇒ storage unavailable.
        return null
    }
  }

  // Observability post-release-health: wire the gate + the release-health settings module
  // when enabled (+ ENCRYPTION_KEY), mirroring the Worker's `selectReleaseHealthDeps`. Off →
  // the `post-release-health` gate is a pass-through and the module isn't assembled.
  const releaseHealthDeps: Partial<CoreDependencies> = {}
  if (config.releaseHealth.enabled && config.releaseHealth.encryptionKey) {
    const observabilitySecretCipher = new WebCryptoSecretCipher({
      masterKeyBase64: config.releaseHealth.encryptionKey,
      info: OBSERVABILITY_CIPHER_INFO,
    })
    releaseHealthDeps.observabilityConnectionRepository = repos.observabilityConnectionRepository
    releaseHealthDeps.releaseHealthConfigRepository = repos.releaseHealthConfigRepository
    releaseHealthDeps.observabilitySecretCipher = observabilitySecretCipher
    // The post-release-health gate + on-call escalation now live in `@cat-factory/gates`; wire
    // their providers into the gate suite. The observability repos/cipher above stay on
    // CoreDependencies — they power the management API (ReleaseHealthService), not the gate.
    wireReleaseHealthProvider(
      providerRegistry,
      new RegistryReleaseHealthProvider({
        observabilityConnectionRepository: repos.observabilityConnectionRepository,
        releaseHealthConfigRepository: repos.releaseHealthConfigRepository,
        blockRepository: repos.blockRepository,
        secretCipher: observabilitySecretCipher,
        registry: defaultObservabilityRegistry,
      }),
    )
  }

  // Per-workspace incident-enrichment (PagerDuty + incident.io): credentials moved out of
  // env into a sealed per-workspace row, resolved + decrypted at enrichment time. Wired
  // whenever the shared ENCRYPTION_KEY is present (independent of the release-health gate).
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  // Per-workspace private package registries (npm private orgs, GitHub Packages): the
  // management API over the same repo + cipher the dispatch resolver rides.
  const packageRegistryDeps: Partial<CoreDependencies> = packageRegistrySecretCipher
    ? {
        packageRegistryConnectionRepository: repos.packageRegistryConnectionRepository,
        packageRegistrySecretCipher,
      }
    : {}
  const incidentEnrichmentDeps: Partial<CoreDependencies> = {}
  if (encryptionKey) {
    const incidentEnrichmentSecretCipher = new WebCryptoSecretCipher({
      masterKeyBase64: encryptionKey,
      info: INCIDENT_ENRICHMENT_CIPHER_INFO,
    })
    incidentEnrichmentDeps.incidentEnrichmentConnectionRepository =
      repos.incidentEnrichmentConnectionRepository
    incidentEnrichmentDeps.incidentEnrichmentSecretCipher = incidentEnrichmentSecretCipher
    // The on-call enrichment provider now lives in `@cat-factory/gates`; wire the
    // workspace-backed provider into the gate suite. The connection repo + cipher above
    // stay on CoreDependencies to power the management API.
    wireIncidentEnrichment(
      providerRegistry,
      new WorkspaceIncidentEnrichmentProvider({
        incidentEnrichmentConnectionRepository: repos.incidentEnrichmentConnectionRepository,
        secretCipher: incidentEnrichmentSecretCipher,
      }),
    )
  }

  // Per-account deployment settings (Slack OAuth + web-search keys + content-storage), built
  // once so the service's short-TTL cache spans requests; the Slack OAuth + content-storage
  // resolvers derive from it.
  const accountSettings = encryptionKey
    ? new AccountSettingsService({
        accountSettingsRepository: repos.accountSettingsRepository,
        secretCipher: new WebCryptoSecretCipher({
          masterKeyBase64: encryptionKey,
          info: ACCOUNT_SETTINGS_CIPHER_INFO,
        }),
        clock,
        contentStorageCapability,
        ...(caches ? { settingsCache: caches.accountSettings } : {}),
      })
    : undefined

  // Resolve the binary-artifact store for a workspace's account from its content-storage
  // settings (the blob backend is per-account; the metadata is the shared Postgres store).
  // Without `accountSettings` (no encryption key) there is no per-account override, so every
  // workspace falls back to the runtime default — which on Node is `off`, so the resolver then
  // returns null and the controllers 503 / the gate passes through. Caches per account, so a
  // backend switch rebuilds and the many workspaces under one account share a store.
  const resolveBinaryArtifactStore = makeResolveBinaryArtifactStore({
    accountSettings,
    accountOf: (workspaceId) => repos.workspaceRepository.accountOf(workspaceId),
    metadata: repos.binaryArtifactMetadataStore,
    idGenerator,
    clock,
    buildBlobBackend,
    defaultBackend: contentStorageCapability.defaultBackend,
    logger,
  })

  return {
    releaseHealthDeps,
    packageRegistryDeps,
    incidentEnrichmentDeps,
    accountSettings,
    resolveBinaryArtifactStore,
  }
}
