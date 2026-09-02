import type {
  Clock,
  EnvironmentProvider,
  EnvironmentRecord,
  EnvironmentRegistryRepository,
  Logger,
  ProvisionEnvironmentRequest,
  ProvisionedEnvironment,
  RouteProbe,
  SecretCipher,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import { EnvironmentProvisioningService } from '../EnvironmentProvisioningService.js'
import type { EnvironmentConnectionService } from '../EnvironmentConnectionService.js'
import type {
  ProvisioningLogEvent,
  ProvisioningLogRecorder,
} from '../../provisioning-logs/ProvisioningLogService.js'

// The in-memory doubles the environment-provisioning suites are built on, shared by
// `EnvironmentProvisioningService.test.ts` (the lifecycle: provision, supersede, the pre-flight
// gate, the URL policy) and `environmentStatusPoll.test.ts` (ONE poll, whose rules are all about
// what a second look may overwrite) so each file describes only its own behaviour.
//
// The service is what both drive rather than the poller directly: `refreshStatus` is a thin
// delegate onto it, and going through the owner is what keeps the seams it binds (sealing, the URL
// policy, the expiry rule) in the assertion rather than stubbed out of it.

export const MANIFEST = {
  providerId: 'acme',
  label: 'Acme',
  baseUrl: 'https://envs.test/api',
  auth: { type: 'none' as const },
  provision: { method: 'POST' as const, pathTemplate: '/envs' },
  response: {},
}

/** A passthrough cipher: persistence round-trips JSON without real crypto. */
export const fakeCipher: SecretCipher = {
  encrypt: async (plaintext: string) => `enc:${plaintext}`,
  decrypt: async (cipher: string) => cipher.replace(/^enc:/, ''),
}

/** In-memory registry repo capturing inserts. */
export function fakeRegistry(): EnvironmentRegistryRepository & { records: EnvironmentRecord[] } {
  const records: EnvironmentRecord[] = []
  return {
    records,
    async insert(record) {
      records.push(record)
    },
    async update(workspaceId, id, patch) {
      const i = records.findIndex((r) => r.id === id)
      if (i >= 0) records[i] = { ...records[i]!, ...patch }
    },
    async get(_workspaceId, id) {
      return records.find((r) => r.id === id) ?? null
    },
    async getByBlock(_workspaceId, blockId) {
      return records.find((r) => r.blockId === blockId && !r.deletedAt) ?? null
    },
    async getByBlockAndFrame(_workspaceId, blockId, frameId) {
      return (
        records.find((r) => r.blockId === blockId && r.frameId === frameId && !r.deletedAt) ?? null
      )
    },
    async getFramelessByBlock(_workspaceId, blockId) {
      return (
        [...records]
          .reverse()
          .find((r) => r.blockId === blockId && r.frameId == null && !r.deletedAt) ?? null
      )
    },
    async listByWorkspace() {
      return records
    },
    async listExpired() {
      return []
    },
    async softDelete(_workspaceId, id, at) {
      const r = records.find((x) => x.id === id)
      if (r) r.deletedAt = at
    },
  }
}

/** A recording provider returning a fixed environment; captures the request it saw. */
export function recordingProvider(
  returns: ProvisionedEnvironment,
): EnvironmentProvider & { lastProvision?: ProvisionEnvironmentRequest } {
  const provider: EnvironmentProvider & { lastProvision?: ProvisionEnvironmentRequest } = {
    async provision(req) {
      provider.lastProvision = req
      return returns
    },
    async status() {
      return returns
    },
    async teardown() {
      return { status: 'torn_down' }
    },
  }
  return provider
}

export function makeService(
  provider: EnvironmentProvider,
  registry: EnvironmentRegistryRepository,
  urlPolicy?: UrlSafetyPolicy,
  /** What a poll needs beyond the lifecycle: a socket to re-prove a route with, and a clock. */
  extras: {
    routeProbe?: RouteProbe
    clock?: Clock
    provisioningLog?: ProvisioningLogRecorder
    secretCipher?: SecretCipher
    logger?: Logger
  } = {},
) {
  const connectionService = {
    resolveProvider: async () => ({ provider, manifest: MANIFEST }),
    resolveProviderForRecord: async () => ({
      provider,
      manifest: MANIFEST,
      resolveSecret: () => undefined,
    }),
    resolveSecrets: async () => () => undefined,
  } as unknown as EnvironmentConnectionService
  let n = 0
  return new EnvironmentProvisioningService({
    connectionService,
    environmentRegistryRepository: registry,
    secretCipher: extras.secretCipher ?? fakeCipher,
    idGenerator: { next: (prefix: string) => `${prefix}_${++n}` },
    clock: extras.clock ?? { now: () => 1_700_000_000_000 },
    ...(urlPolicy ? { urlPolicy } : {}),
    ...(extras.routeProbe ? { routeProbe: extras.routeProbe } : {}),
    ...(extras.provisioningLog ? { provisioningLog: extras.provisioningLog } : {}),
    ...(extras.logger ? { logger: extras.logger } : {}),
  })
}

/**
 * A provisioning log that keeps every row, or REFUSES to keep any.
 *
 * Cast, because the shipped recorder is a class holding private state and swallowing its own
 * append failures. That is exactly why the swallow at the poll site has to leave evidence rather
 * than be silent: what can still reject there is the recorder itself going missing (a repository
 * method not allow-listed for a mothership node, say), and the caller believes it cannot.
 */
export function fakeProvisioningLog(
  options: { refuse?: { operation: string; error: Error } } = {},
) {
  const rows: ProvisioningLogEvent[] = []
  const record = async (row: ProvisioningLogEvent) => {
    // Refused per OPERATION, because the provision path calls the recorder bare (it may not
    // reject, by the class's own contract) and a fake that refuses everything would fail the
    // setup instead of the assertion.
    if (options.refuse && row.operation === options.refuse.operation) throw options.refuse.error
    rows.push(row)
  }
  return { rows, recorder: { record } as unknown as ProvisioningLogRecorder }
}

export const READY: ProvisionedEnvironment = {
  externalId: 'env-123',
  url: 'https://app.public.example/preview',
  status: 'ready',
  expiresAt: null,
  access: null,
  fields: { externalId: 'env-123', ref: 'feat/login' },
}
