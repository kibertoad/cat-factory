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
})
