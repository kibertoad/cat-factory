import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useProvisioningLogsStore } from '~/stores/provisioningLogs'
import { useWorkspaceStore } from '~/stores/workspace'
import type { ProvisioningLogEntry } from '~/types/provisioningLogs'

/** Minimal attempt-row factory — only the fields the store passes through. */
function entry(over: Partial<ProvisioningLogEntry> = {}): ProvisioningLogEntry {
  return {
    id: 'p1',
    workspaceId: 'ws1',
    subsystem: 'container',
    operation: 'dispatch',
    outcome: 'success',
    targetId: 'job1',
    providerId: null,
    blockId: null,
    executionId: 'exec1',
    error: null,
    detail: null,
    createdAt: 1,
    ...over,
  } as ProvisioningLogEntry
}

describe('provisioningLogs store — loadForExecution', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('a visible load flips the loading spinner and stores the entries', async () => {
    let resolveFetch!: (r: { entries: ProvisioningLogEntry[] }) => void
    const pending = new Promise<{ entries: ProvisioningLogEntry[] }>((res) => {
      resolveFetch = res
    })
    vi.stubGlobal('useApi', () => ({ listProvisioningLogs: () => pending }))

    const store = useProvisioningLogsStore()
    const load = store.loadForExecution('exec1')
    // In flight: the button spinner is on.
    expect(store.byExecution.exec1!.loading).toBe(true)

    resolveFetch({ entries: [entry()] })
    await load

    expect(store.byExecution.exec1!.loading).toBe(false)
    expect(store.byExecution.exec1!.entries).toHaveLength(1)
  })

  it('a silent poll never flips the loading spinner', async () => {
    vi.stubGlobal('useApi', () => ({
      listProvisioningLogs: () => Promise.resolve({ entries: [entry({ operation: 'release' })] }),
    }))

    const store = useProvisioningLogsStore()
    await store.loadForExecution('exec1', { silent: true })

    // Never went truthy — a background poll must not show a "refreshing" spinner.
    expect(store.byExecution.exec1!.loading).toBe(false)
    // But it still updates the timeline (the tear-down row now shows).
    expect(store.byExecution.exec1!.entries[0]!.operation).toBe('release')
  })

  it('a silent poll failure keeps the last-good entries and surfaces no error', async () => {
    const store = useProvisioningLogsStore()

    // Seed a good snapshot via a visible load.
    vi.stubGlobal('useApi', () => ({
      listProvisioningLogs: () => Promise.resolve({ entries: [entry()] }),
    }))
    await store.loadForExecution('exec1')
    expect(store.byExecution.exec1!.entries).toHaveLength(1)

    // A background poll then blips — the drawer must keep showing what it had.
    vi.stubGlobal('useApi', () => ({
      listProvisioningLogs: () => Promise.reject(new Error('network')),
    }))
    await store.loadForExecution('exec1', { silent: true })

    expect(store.byExecution.exec1!.entries).toHaveLength(1)
    expect(store.byExecution.exec1!.error).toBeNull()
  })

  it('a visible load failure clears entries and reports the error', async () => {
    vi.stubGlobal('useApi', () => ({
      listProvisioningLogs: () => Promise.reject(new Error('503')),
    }))

    const store = useProvisioningLogsStore()
    await store.loadForExecution('exec1')

    expect(store.byExecution.exec1!.loading).toBe(false)
    expect(store.byExecution.exec1!.entries).toHaveLength(0)
    expect(store.byExecution.exec1!.error).toBe('503')
  })

  it('a slower stale load never clobbers a newer one (monotonic guard)', async () => {
    // Two loads race: the FIRST-issued resolves LAST with a stale timeline. Without the guard its
    // `s.entries = entries` would overwrite the fresher second result — a card/row would vanish.
    const deferred: Array<(r: { entries: ProvisioningLogEntry[] }) => void> = []
    vi.stubGlobal('useApi', () => ({
      listProvisioningLogs: () =>
        new Promise<{ entries: ProvisioningLogEntry[] }>((res) => deferred.push(res)),
    }))

    const store = useProvisioningLogsStore()
    const first = store.loadForExecution('exec1', { silent: true }) // issued #1 (stale)
    const second = store.loadForExecution('exec1', { silent: true }) // issued #2 (fresh)

    // Resolve NEWEST first, then the older/staler one.
    deferred[1]!({ entries: [entry({ id: 'fresh', operation: 'release' })] })
    deferred[0]!({ entries: [entry({ id: 'stale', operation: 'dispatch' })] })
    await Promise.all([first, second])

    // The fresher result survives — the stale late-resolver was discarded.
    expect(store.byExecution.exec1!.entries).toHaveLength(1)
    expect(store.byExecution.exec1!.entries[0]!.id).toBe('fresh')
  })

  it('a superseding visible load owns the final entries and clears the spinner', async () => {
    // A visible load in flight, then a newer visible load; the OLDER resolves last and must neither
    // clobber the entries nor leave a stuck spinner.
    const deferred: Array<(r: { entries: ProvisioningLogEntry[] }) => void> = []
    vi.stubGlobal('useApi', () => ({
      listProvisioningLogs: () =>
        new Promise<{ entries: ProvisioningLogEntry[] }>((res) => deferred.push(res)),
    }))

    const store = useProvisioningLogsStore()
    const first = store.loadForExecution('exec1')
    const second = store.loadForExecution('exec1')

    deferred[1]!({ entries: [entry({ id: 'fresh' })] })
    deferred[0]!({ entries: [entry({ id: 'stale' })] })
    await Promise.all([first, second])

    expect(store.byExecution.exec1!.entries[0]!.id).toBe('fresh')
    expect(store.byExecution.exec1!.loading).toBe(false)
  })

  it("evict drops a run's accumulated state (map does not grow unbounded)", async () => {
    vi.stubGlobal('useApi', () => ({
      listProvisioningLogs: () => Promise.resolve({ entries: [entry()] }),
    }))

    const store = useProvisioningLogsStore()
    await store.loadForExecution('exec1')
    expect(store.byExecution.exec1).toBeDefined()

    store.evict('exec1')
    expect(store.byExecution.exec1).toBeUndefined()

    // After eviction a fresh load re-seeds cleanly (the drawer re-fetches on re-mount) — and the
    // per-execution ticket record was dropped too, so the guard still holds for the new lifecycle.
    await store.loadForExecution('exec1')
    expect(store.byExecution.exec1!.entries).toHaveLength(1)
  })

  it('a load in flight when evict runs cannot resurrect stale state after the drawer re-opens', async () => {
    // Close-then-reopen while the pre-close fetch is still pending: the drawer unmounts (evict), then
    // re-mounts and issues a fresh load, then the OLD pre-evict fetch finally resolves. With a global
    // (never-reset) load ticket the re-opened load out-ranks the straggler, so the stale result is
    // discarded rather than clobbering the fresh timeline (a per-execution counter reset on evict
    // would let the two collide on the same seq and the straggler would win).
    const deferred: Array<(r: { entries: ProvisioningLogEntry[] }) => void> = []
    vi.stubGlobal('useApi', () => ({
      listProvisioningLogs: () =>
        new Promise<{ entries: ProvisioningLogEntry[] }>((res) => deferred.push(res)),
    }))

    const store = useProvisioningLogsStore()
    const preEvict = store.loadForExecution('exec1', { silent: true }) // issued before close
    store.evict('exec1') // drawer unmounts mid-flight
    const reopened = store.loadForExecution('exec1', { silent: true }) // drawer re-opens, fresh load

    // The re-opened load resolves first (fresh), then the stale pre-evict straggler.
    deferred[1]!({ entries: [entry({ id: 'fresh', operation: 'release' })] })
    deferred[0]!({ entries: [entry({ id: 'stale', operation: 'dispatch' })] })
    await Promise.all([preEvict, reopened])

    expect(store.byExecution.exec1!.entries).toHaveLength(1)
    expect(store.byExecution.exec1!.entries[0]!.id).toBe('fresh')
  })
})
