import { describe, expect, it } from 'vitest'
import { ValidationError } from '@cat-factory/kernel'
import type {
  EnvironmentProvider,
  EnvironmentRecord,
  EnvironmentRegistryRepository,
  ProvisionEnvironmentRequest,
  ProvisionedEnvironment,
  SecretCipher,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import { EnvironmentProvisioningService } from './EnvironmentProvisioningService.js'
import type { EnvironmentConnectionService } from './EnvironmentConnectionService.js'

// EnvironmentProvisioningService is the seam an in-house adapter (e.g. a PR-environment
// platform) plugs into: it receives the typed provisionContext + the flattened inputs and
// owns the returned `fields`. These tests assert that contract + the returned-URL policy,
// independent of any HTTP provider.

const MANIFEST = {
  providerId: 'acme',
  label: 'Acme',
  baseUrl: 'https://envs.test/api',
  auth: { type: 'none' as const },
  provision: { method: 'POST' as const, pathTemplate: '/envs' },
  response: {},
}

/** A passthrough cipher: persistence round-trips JSON without real crypto. */
const fakeCipher: SecretCipher = {
  encrypt: async (plaintext: string) => `enc:${plaintext}`,
  decrypt: async (cipher: string) => cipher.replace(/^enc:/, ''),
}

/** In-memory registry repo capturing inserts. */
function fakeRegistry(): EnvironmentRegistryRepository & { records: EnvironmentRecord[] } {
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
function recordingProvider(
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

function makeService(
  provider: EnvironmentProvider,
  registry: EnvironmentRegistryRepository,
  urlPolicy?: UrlSafetyPolicy,
) {
  const connectionService = {
    requireConnection: async () => ({ record: {} as never, manifest: MANIFEST }),
    resolveSecrets: async () => () => undefined,
  } as unknown as EnvironmentConnectionService
  let n = 0
  return new EnvironmentProvisioningService({
    connectionService,
    environmentProvider: provider,
    environmentRegistryRepository: registry,
    secretCipher: fakeCipher,
    idGenerator: { next: (prefix: string) => `${prefix}_${++n}` },
    clock: { now: () => 1_700_000_000_000 },
    ...(urlPolicy ? { urlPolicy } : {}),
  })
}

const READY: ProvisionedEnvironment = {
  externalId: 'env-123',
  url: 'https://app.public.example/preview',
  status: 'ready',
  expiresAt: null,
  access: null,
  fields: { externalId: 'env-123', ref: 'feat/login' },
}

describe('EnvironmentProvisioningService — provision context', () => {
  it('passes the typed provisionContext to the provider and flattens it into inputs', async () => {
    const provider = recordingProvider(READY)
    const service = makeService(provider, fakeRegistry())

    await service.provision({
      workspaceId: 'ws1',
      blockId: 'blk1',
      context: {
        blockId: 'blk1',
        branch: 'feat/login',
        pullNumber: 42,
        pullUrl: 'https://github.com/acme/web/pull/42',
        repoOwner: 'acme',
        repoName: 'web',
      },
    })

    const req = provider.lastProvision!
    // Typed context reaches a code adapter verbatim.
    expect(req.provisionContext?.branch).toBe('feat/login')
    expect(req.provisionContext?.repoOwner).toBe('acme')
    expect(req.provisionContext?.pullNumber).toBe(42)
    // ...and is flattened to `{{input.*}}` strings for the manifest path.
    expect(req.inputs.branch).toBe('feat/login')
    expect(req.inputs.repoOwner).toBe('acme')
    expect(req.inputs.pullNumber).toBe('42')
    expect(req.inputs.blockId).toBe('blk1')
  })

  it('lets explicit inputs win over the derived context', async () => {
    const provider = recordingProvider(READY)
    const service = makeService(provider, fakeRegistry())

    await service.provision({
      workspaceId: 'ws1',
      blockId: 'blk1',
      inputs: { branch: 'override-branch' },
      context: { branch: 'feat/login' },
    })

    expect(provider.lastProvision!.inputs.branch).toBe('override-branch')
  })

  it('persists the provider-owned fields for later status/teardown', async () => {
    const registry = fakeRegistry()
    const service = makeService(recordingProvider(READY), registry)
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    // The provider's arbitrary `fields` (here a Kargo-style ref) round-trip encrypted.
    expect(registry.records[0]!.provisionFieldsCipher).toBe(
      `enc:${JSON.stringify(READY.fields)}`,
    )
  })
})

describe('EnvironmentProvisioningService — returned URL policy', () => {
  const internalEnv: ProvisionedEnvironment = { ...READY, url: 'https://prenv.kargo.internal' }

  it('rejects an internal returned URL under the strict default', async () => {
    const service = makeService(recordingProvider(internalEnv), fakeRegistry())
    await expect(service.provision({ workspaceId: 'ws1', blockId: 'blk1' })).rejects.toThrow(
      ValidationError,
    )
  })

  it('accepts an internal returned URL when the policy exempts the host', async () => {
    const registry = fakeRegistry()
    const service = makeService(recordingProvider(internalEnv), registry, {
      schemes: ['https'],
      allowHosts: ['.internal'],
    })
    const handle = await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    expect(handle.url).toBe('https://prenv.kargo.internal')
    expect(registry.records).toHaveLength(1)
  })
})
