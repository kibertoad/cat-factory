import { describe, expect, it } from 'vitest'
import type {
  ConnectServiceCatalogInput,
  ServiceCatalogConnection,
  ServiceCatalogSyncResult,
} from '~/types/domain'
import { createServiceCatalogState } from '~/stores/serviceCatalogConnection'

// The half of the service-catalog store worth pinning is the SPLIT between connecting and the
// first import. They fail differently, they have different remedies, and the panel presents them
// under different titles.

const connection: ServiceCatalogConnection = {
  provider: 'backstage',
  baseUrl: 'https://backstage.example.com',
  authMode: 'static-token',
  entityFilter: ['kind=component'],
  includeApis: true,
  maxServices: 200,
  lastSyncedAt: null,
  lastSyncStatus: null,
  lastSyncMessage: null,
  connectedAt: 1,
}

const result: ServiceCatalogSyncResult = {
  upserted: 1,
  tombstoned: 0,
  unchanged: 0,
  contracts: 1,
  coverage: 'complete',
  skippedServices: 0,
  skippedConflicts: 0,
  skippedApis: 0,
  status: 'ok',
}

const input: ConnectServiceCatalogInput = {
  baseUrl: 'https://backstage.example.com',
  auth: { mode: 'static-token', token: 't' },
}

function build(overrides: { syncServiceCatalog?: () => Promise<ServiceCatalogSyncResult> } = {}) {
  const calls: string[] = []
  const state = createServiceCatalogState({
    api: {
      getServiceCatalog: async () => {
        calls.push('get')
        return connection
      },
      connectServiceCatalog: async () => {
        calls.push('connect')
        return connection
      },
      disconnectServiceCatalog: async () => {
        calls.push('disconnect')
        return null
      },
      probeServiceCatalog: async () => ({ ok: true }),
      syncServiceCatalog: async () => {
        calls.push('sync')
        return overrides.syncServiceCatalog ? await overrides.syncServiceCatalog() : result
      },
    },
    requireWorkspaceId: () => 'ws-1',
    isWorkspaceTier: true,
    reloadCatalog: async () => {
      calls.push('reload')
    },
  })
  return { state, calls }
}

describe('createServiceCatalogState', () => {
  it('settles connect() on the CONNECT alone, so an import failure is not a connect failure', async () => {
    // The connection is stored by the time an import runs, so rejecting here would tell the
    // operator the connection failed while the panel renders it connected, and would bury the
    // remedy the real failure names under a title saying the opposite.
    const { state, calls } = build()

    await expect(state.connect(input)).resolves.toEqual(connection)

    expect(calls).toEqual(['connect'])
    expect(state.serviceCatalog.value).toEqual(connection)
  })

  it('re-reads the connection after an import, for the verdict the import stamped there', async () => {
    const { state, calls } = build()

    await expect(state.importNow()).resolves.toEqual(result)

    // The stamped verdict is the only thing that tells a human the estate they are looking at is a
    // PREFIX of the portal's.
    expect(calls).toEqual(['sync', 'get', 'reload'])
  })

  it('propagates an import failure to its own caller', async () => {
    const { state } = build({
      syncServiceCatalog: async () => {
        throw new Error('service catalog unauthorized')
      },
    })

    await expect(state.importNow()).rejects.toThrow('service catalog unauthorized')
  })

  it('clears the connection on disconnect and reloads the catalog views it tombstoned', async () => {
    const { state, calls } = build()
    await state.connect(input)

    await state.disconnect()

    expect(state.serviceCatalog.value).toBeNull()
    expect(calls).toEqual(['connect', 'disconnect', 'reload'])
  })
})
