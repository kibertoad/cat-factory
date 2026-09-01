import type {
  ConnectServiceCatalogInput,
  ConnectionTestResult,
  ServiceCatalogAuth,
  ServiceCatalogConnection,
} from '@cat-factory/contracts'
import {
  DEFAULT_MAX_CATALOG_SERVICES,
  DEFAULT_SERVICE_CATALOG_FILTER,
} from '@cat-factory/contracts'
import type {
  Clock,
  Logger,
  SecretCipher,
  SecretDelegate,
  ServiceCatalogClient,
  ServiceCatalogConnectionRecord,
  ServiceCatalogConnectionRepository,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import { createOrgSecretCipher, noopLogger, orgSecretRef } from '@cat-factory/kernel'
import { assertSafePublicUrl } from '../shared/url-guard.js'
import { BackstageCatalogClient } from './BackstageCatalogClient.js'
import { parseServiceCatalogAuth } from './serviceCatalogAuth.js'

// ---------------------------------------------------------------------------
// The workspace's SERVICE CATALOG connection: connect, read, probe, disconnect, and build the
// client an import reads through.
//
// The credential bag is sealed and opened here and only here, so nothing else in the feature
// (the controller, the importer, the sweeps) ever holds plaintext. The cipher goes through
// `createOrgSecretCipher`, which makes a mothership-mode node open the row by NAMING it over the
// secret delegation rather than with a key it does not have.
// ---------------------------------------------------------------------------

export interface ServiceCatalogConnectionServiceDependencies {
  serviceCatalogConnectionRepository: ServiceCatalogConnectionRepository
  /** The deployment's `cat-factory:service-catalog` cipher. */
  secretCipher: SecretCipher
  /** Present ONLY on a mothership-mode node, where the row was sealed under the org's key. */
  secretDelegate?: SecretDelegate
  clock: Clock
  logger?: Logger
  /**
   * The deployment's URL policy for this integration. A self-hosted portal on `.internal` or a
   * private address is the NORMAL case, so an operator widens this rather than the integration
   * assuming a public host; the strict default refuses one, which is the right default for a URL
   * a workspace admin can type.
   */
  urlPolicy?: UrlSafetyPolicy
  /** Injected for tests. */
  fetchImpl?: typeof fetch
}

export class ServiceCatalogConnectionService {
  private readonly log: Logger

  private readonly orgSecrets: ReturnType<typeof createOrgSecretCipher>

  constructor(private readonly deps: ServiceCatalogConnectionServiceDependencies) {
    this.log = deps.logger ?? noopLogger
    this.orgSecrets = createOrgSecretCipher({
      cipher: deps.secretCipher,
      ...(deps.secretDelegate ? { delegate: deps.secretDelegate } : {}),
    })
  }

  /** The connection as the management surface sees it, or null when there is none. */
  async get(workspaceId: string): Promise<ServiceCatalogConnection | null> {
    const record = await this.deps.serviceCatalogConnectionRepository.get(workspaceId)
    return record ? toWire(record) : null
  }

  /**
   * Connect or replace the workspace's connection.
   *
   * The base URL is validated BEFORE anything is sealed, so a typo or a blocked host is refused
   * while the operator is still looking at the form rather than becoming a stored connection that
   * fails on every import.
   */
  async connect(
    workspaceId: string,
    input: ConnectServiceCatalogInput,
  ): Promise<ServiceCatalogConnection> {
    const baseUrl = this.assertBaseUrl(input.baseUrl)
    const now = this.deps.clock.now()
    const existing = await this.deps.serviceCatalogConnectionRepository.get(workspaceId)
    const record: ServiceCatalogConnectionRecord = {
      workspaceId,
      provider: input.provider ?? 'backstage',
      baseUrl,
      authMode: input.auth.mode,
      credentialsCipher: await this.sealAuth(workspaceId, input.auth),
      entityFilter: normalizeFilter(input.entityFilter),
      includeApis: input.includeApis ?? true,
      maxServices: input.maxServices ?? DEFAULT_MAX_CATALOG_SERVICES,
      // The prior pass's verdict is KEPT rather than cleared. Re-entering a rotated token does not
      // change what the last import found, and blanking it would present a workspace with a
      // truncated estate as one that has never imported.
      lastSyncedAt: existing?.lastSyncedAt ?? null,
      lastSyncStatus: existing?.lastSyncStatus ?? null,
      lastSyncMessage: existing?.lastSyncMessage ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
    }
    await this.deps.serviceCatalogConnectionRepository.upsert(record)
    this.log.info('serviceCatalog.connected', {
      workspaceId,
      provider: record.provider,
      authMode: record.authMode,
    })
    return toWire(record)
  }

  /** Forget the credential. Tombstoning what it imported is the importer's half, called beside. */
  async disconnect(workspaceId: string): Promise<void> {
    await this.deps.serviceCatalogConnectionRepository.softDelete(
      workspaceId,
      this.deps.clock.now(),
    )
    this.log.info('serviceCatalog.disconnected', { workspaceId })
  }

  /**
   * Probe with the SUBMITTED credentials rather than the stored ones.
   *
   * Which is the point of the endpoint: an operator testing a connection is testing what they just
   * typed, and probing the stored row would answer about the credential they are replacing.
   */
  async probe(input: ConnectServiceCatalogInput): Promise<ConnectionTestResult> {
    const baseUrl = this.assertBaseUrl(input.baseUrl)
    return this.buildClient(baseUrl, input.auth).probe()
  }

  /**
   * The client for a workspace's stored connection, or null when it has none.
   *
   * Wired as the `ResolveServiceCatalogClient` port the importer depends on. It REJECTS when a row
   * exists whose bag will not open, because that is a deployment fault with its own remedy
   * (re-enter the credential) and is not the same fact as a workspace that never connected a
   * portal, which the importer treats as nothing to do.
   */
  resolveClient = async (workspaceId: string): Promise<ServiceCatalogClient | null> => {
    const record = await this.deps.serviceCatalogConnectionRepository.get(workspaceId)
    if (!record || record.deletedAt !== null) return null
    const auth = await this.openAuth(record)
    return this.buildClient(record.baseUrl, auth)
  }

  private buildClient(baseUrl: string, auth: ServiceCatalogAuth): ServiceCatalogClient {
    return new BackstageCatalogClient({
      baseUrl,
      auth,
      clock: this.deps.clock,
      logger: this.log,
      ...(this.deps.urlPolicy ? { urlPolicy: this.deps.urlPolicy } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    })
  }

  private assertBaseUrl(baseUrl: string): string {
    const normalized = baseUrl.trim().replace(/\/+$/, '')
    assertSafePublicUrl(normalized, {
      subject: 'Service catalog',
      label: 'base URL',
      ...(this.deps.urlPolicy ? { policy: this.deps.urlPolicy } : {}),
    })
    return normalized
  }

  /**
   * Seal the credential half of the submitted auth.
   *
   * `none` seals NOTHING and stores the empty string, rather than an envelope around an empty
   * object. An unauthenticated portal has no secret, so a deployment whose `ENCRYPTION_KEY`
   * drifted must keep working against it: sealing a placeholder would make the one mode with no
   * credential the one that fails on a key problem.
   */
  private async sealAuth(workspaceId: string, auth: ServiceCatalogAuth): Promise<string> {
    if (auth.mode === 'none') return ''
    return this.orgSecrets.encryptFor(
      orgSecretRef('service_catalog_connection', workspaceId),
      JSON.stringify(auth),
    )
  }

  private async openAuth(record: ServiceCatalogConnectionRecord): Promise<ServiceCatalogAuth> {
    if (record.authMode === 'none') return { mode: 'none' }
    const plaintext = await this.orgSecrets.decryptFor(
      orgSecretRef('service_catalog_connection', record.workspaceId),
      record.credentialsCipher,
    )
    return parseServiceCatalogAuth(plaintext, record.authMode)
  }
}

/** The stored row's non-secret half. */
function toWire(record: ServiceCatalogConnectionRecord): ServiceCatalogConnection {
  return {
    provider: record.provider,
    baseUrl: record.baseUrl,
    authMode: record.authMode,
    entityFilter: record.entityFilter,
    includeApis: record.includeApis,
    maxServices: record.maxServices,
    lastSyncedAt: record.lastSyncedAt,
    lastSyncStatus: record.lastSyncStatus,
    lastSyncMessage: record.lastSyncMessage,
    connectedAt: record.createdAt,
  }
}

/** An empty filter falls back to the default rather than importing the whole estate. */
function normalizeFilter(entityFilter: string[] | undefined): string[] {
  const terms = (entityFilter ?? []).map((term) => term.trim()).filter(Boolean)
  return terms.length > 0 ? terms : [...DEFAULT_SERVICE_CATALOG_FILTER]
}
