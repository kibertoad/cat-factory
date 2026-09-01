import type {
  ServiceCatalogConnectionRecord,
  ServiceCatalogConnectionRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { ServiceCatalogConnectionService } from './ServiceCatalogConnectionService.js'

// The management surface's view of a workspace's portal connection. What is asserted here is the
// disposal of a TOMBSTONE, which the repository deliberately still returns: the row outlives the
// disconnect so a re-connect can keep the prior verdict and the original `connectedAt`.

const WORKSPACE = 'ws-1'

const record = (
  overrides: Partial<ServiceCatalogConnectionRecord> = {},
): ServiceCatalogConnectionRecord => ({
  workspaceId: WORKSPACE,
  provider: 'backstage',
  baseUrl: 'https://backstage.example.com',
  authMode: 'static-token',
  credentialsCipher: 'v1.sealed',
  entityFilter: ['kind=component'],
  includeApis: true,
  maxServices: 200,
  lastSyncedAt: 4_000,
  lastSyncStatus: 'partial',
  lastSyncMessage: 'Something to fix.',
  createdAt: 1,
  updatedAt: 2,
  deletedAt: null,
  ...overrides,
})

function build(seed: ServiceCatalogConnectionRecord | null) {
  let row = seed
  const repo: ServiceCatalogConnectionRepository = {
    get: async () => row,
    upsert: async (next) => {
      row = next
    },
    updateSyncState: async (_workspaceId, state) => {
      if (row) row = { ...row, ...state }
    },
    softDelete: async (_workspaceId, at) => {
      if (row) row = { ...row, deletedAt: at }
    },
    listStale: async () => [],
  }
  return new ServiceCatalogConnectionService({
    serviceCatalogConnectionRepository: repo,
    secretCipher: { encrypt: async (v) => `sealed:${v}`, decrypt: async (v) => v },
    clock: { now: () => 9_000 },
  })
}

describe('ServiceCatalogConnectionService.get', () => {
  it('serves a live connection', async () => {
    const connection = await build(record()).get(WORKSPACE)
    expect(connection?.baseUrl).toBe('https://backstage.example.com')
    expect(connection?.lastSyncStatus).toBe('partial')
  })

  it('answers NULL for a disconnected workspace, whose row the repository still holds', async () => {
    // The wire shape carries no `deletedAt`, so serving the tombstone would render a disconnected
    // workspace as connected, with an "Import now" that 404s and a Disconnect that does nothing.
    expect(await build(record({ deletedAt: 8_000 })).get(WORKSPACE)).toBeNull()
  })

  it('answers NULL when the workspace never connected one', async () => {
    expect(await build(null).get(WORKSPACE)).toBeNull()
  })

  it('keeps the prior verdict and the original connect time across a re-connect', async () => {
    // Which is WHY the repository read still returns a tombstone: blanking the history would
    // present a workspace with a truncated estate as one that has never imported.
    const service = build(record({ deletedAt: 8_000 }))
    const reconnected = await service.connect(WORKSPACE, {
      baseUrl: 'https://backstage.example.com/',
      auth: { mode: 'static-token', token: 'fresh' },
    })
    expect(reconnected.connectedAt).toBe(1)
    expect(reconnected.lastSyncStatus).toBe('partial')
    expect(await service.get(WORKSPACE)).not.toBeNull()
  })
})
