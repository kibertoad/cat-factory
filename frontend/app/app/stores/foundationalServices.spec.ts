import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  useFoundationalServices,
  useFoundationalServicesStore,
} from '~/stores/foundationalServices'
import { useWorkspaceStore } from '~/stores/workspace'

// The two store rules that the surface's correctness rests on, and that neither the backend
// tests nor a component test would catch:
//
//  - opening the catalog must transfer NO contract document. The whole two-table split exists so
//    a catalog read costs identity + operation names, and a store that eagerly hydrated bodies
//    would quietly undo it on the one surface a human uses to check what an agent sees.
//  - a suppress/restore must refresh the OPT-OUT list as well as the catalog. The two are
//    complements — an entry leaves one exactly as it enters the other — so refreshing only the
//    catalog leaves the way BACK stale, which is the failure the pair exists to prevent.
//  - the ACCOUNT scope has an opt-out list too (it inherits the deployment's `builtin` tier), and
//    it has no merged catalog to piggyback on — so the read must not be gated on that catalog.

const SERVICE = {
  id: 'file-storage',
  name: 'File Storage',
  summary: 'Stores uploads.',
  description: '',
  capabilities: [],
  contracts: [
    {
      contractId: 'openapi',
      format: 'openapi',
      title: 'HTTP API',
      size: 42,
      path: null,
      operations: ['GET /files'],
      omittedOperations: 0,
    },
  ],
}

function api(over: Record<string, unknown> = {}) {
  return {
    listFoundationalServices: vi.fn(() => Promise.resolve([])),
    getResolvedFoundationalServices: vi.fn(() =>
      Promise.resolve([{ ...SERVICE, tier: 'account' }]),
    ),
    listFoundationalServiceSuppressions: vi.fn(() => Promise.resolve([])),
    listFoundationalSources: vi.fn(() => Promise.resolve([])),
    getFoundationalServiceContracts: vi.fn(() =>
      Promise.resolve([{ ...SERVICE.contracts[0], body: 'openapi: 3.0.3' }]),
    ),
    suppressFoundationalService: vi.fn(() => Promise.resolve(undefined)),
    restoreFoundationalService: vi.fn(() => Promise.resolve(undefined)),
    ...over,
  }
}

describe('foundational-services store', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('probes the catalog without fetching a single contract document', async () => {
    const client = api()
    vi.stubGlobal('useApi', () => client)
    const store = useFoundationalServicesStore()
    await store.probe()

    expect(store.resolved).toHaveLength(1)
    // The manifest rode the catalog read — the body did not.
    expect(store.resolved[0]?.contracts[0]?.operations).toEqual(['GET /files'])
    expect(client.getFoundationalServiceContracts).not.toHaveBeenCalled()
    expect(store.contractBodies).toEqual({})
  })

  it('fetches a document only on demand, then serves it from the session cache', async () => {
    const client = api()
    vi.stubGlobal('useApi', () => client)
    const store = useFoundationalServicesStore()
    await store.probe()

    await store.contractsFor('file-storage')
    await store.contractsFor('file-storage')
    expect(client.getFoundationalServiceContracts).toHaveBeenCalledTimes(1)
    expect(store.contractBodies['file-storage']?.[0]?.body).toBe('openapi: 3.0.3')
  })

  it('resets the repo-source flag too when a re-probe finds the catalog gone', async () => {
    // `sourcesAvailable` gates an affordance rather than content, so a probe that leaves it at a
    // previous `true` would offer repo-source linking against an owner whose catalog is now
    // unreachable. Every view the probe owns has to come back down together.
    const client = api()
    vi.stubGlobal('useApi', () => client)
    const store = useFoundationalServicesStore()
    await store.probe()
    expect(store.sourcesAvailable).toBe(true)

    client.listFoundationalServices.mockRejectedValueOnce(new Error('503'))
    useWorkspaceStore().workspaceId = 'ws2'
    await store.probe()

    expect(store.available).toBe(false)
    expect(store.sourcesAvailable).toBe(false)
    expect(store.sources).toEqual([])
  })

  it('refreshes the opt-out list alongside the catalog on suppress and restore', async () => {
    const client = api()
    vi.stubGlobal('useApi', () => client)
    const store = useFoundationalServicesStore()
    await store.probe()
    const afterProbe = client.listFoundationalServiceSuppressions.mock.calls.length

    await store.suppress('file-storage')
    await store.restore('file-storage')

    // Once per write: a suppression that only refreshed the catalog would leave the restore
    // control missing for the very service just hidden.
    expect(client.listFoundationalServiceSuppressions.mock.calls.length).toBe(afterProbe + 2)
    expect(client.getResolvedFoundationalServices.mock.calls.length).toBe(afterProbe + 2)
  })
})

describe('foundational-services store at the ACCOUNT scope', () => {
  it('loads and refreshes the opt-out list even with no merged catalog to read', async () => {
    // An account inherits the deployment's code-registered services, so it can suppress one — but
    // it has no `resolved` read of its own. Gating the suppression list on that read (as it was
    // while only a board inherited anything) leaves an account able to opt out and unable to see,
    // or lift, what it opted out of.
    const client = api()
    vi.stubGlobal('useApi', () => client)
    const store = useFoundationalServices('account', 'acct1')
    await store.probe()
    expect(client.listFoundationalServiceSuppressions).toHaveBeenCalledWith('account', 'acct1')
    expect(client.getResolvedFoundationalServices).not.toHaveBeenCalled()

    await store.suppress('file-storage')
    expect(client.suppressFoundationalService).toHaveBeenCalledWith(
      'account',
      'acct1',
      'file-storage',
    )
    expect(client.listFoundationalServiceSuppressions).toHaveBeenCalledTimes(2)
  })
})
