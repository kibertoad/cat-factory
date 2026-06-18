import { describe, expect, it } from 'vitest'
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import {
  ContainerInstanceRegistry,
  type LiveContainerRecord,
  type LiveContainerStore,
} from '../../src/infrastructure/containers/ContainerInstanceRegistry'
import type { ExecutionContainer } from '../../src/infrastructure/containers/ExecutionContainer'

// Pure-logic coverage for the instance-level reaper: it must enumerate the live
// inventory by age, SIGKILL each stale container through the EXEC_CONTAINER binding,
// and clear its row — leaving fresh containers untouched. No workerd/D1 needed; the
// store + namespace are faked, mirroring the sweeper specs.

/** In-memory LiveContainerStore. */
class FakeStore implements LiveContainerStore {
  readonly rows = new Map<string, LiveContainerRecord>()
  async add(record: LiveContainerRecord): Promise<void> {
    // ON CONFLICT DO NOTHING: preserve the first started_at for a key.
    if (!this.rows.has(record.containerKey)) this.rows.set(record.containerKey, record)
  }
  async remove(containerKey: string): Promise<void> {
    this.rows.delete(containerKey)
  }
  async listStartedBefore(epochMs: number): Promise<LiveContainerRecord[]> {
    return [...this.rows.values()].filter((r) => r.startedAt < epochMs)
  }
}

/** Fake EXEC_CONTAINER namespace recording which keys were SIGKILLed. */
function fakeNamespace(killed: string[]): DurableObjectNamespace<ExecutionContainer> {
  return {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      shutdown: async () => {
        killed.push(id.name)
      },
    }),
  } as unknown as DurableObjectNamespace<ExecutionContainer>
}

const at = (now: number) => ({ now: () => now })

describe('ContainerInstanceRegistry: reaper', () => {
  it('register preserves the earliest started_at across replayed dispatches', async () => {
    const store = new FakeStore()
    const reg = new ContainerInstanceRegistry(fakeNamespace([]), store, at(100))
    await reg.register('job-1', 'run')
    const second = new ContainerInstanceRegistry(fakeNamespace([]), store, at(500))
    await second.register('job-1', 'run')
    expect(store.rows.get('job-1')?.startedAt).toBe(100)
  })

  it('release SIGKILLs the container and clears its inventory row', async () => {
    const store = new FakeStore()
    const killed: string[] = []
    const reg = new ContainerInstanceRegistry(fakeNamespace(killed), store, at(100))
    await reg.register('job-1', 'bootstrap', 'ws-1')
    await reg.release('job-1')
    expect(killed).toEqual(['job-1'])
    expect(store.rows.has('job-1')).toBe(false)
  })

  it('reaps only containers older than the ceiling and returns the count', async () => {
    const store = new FakeStore()
    const killed: string[] = []
    const reg = new ContainerInstanceRegistry(fakeNamespace(killed), store, at(10_000))
    // started_at: old ones are stale; the fresh one is within the window.
    await new ContainerInstanceRegistry(fakeNamespace([]), store, at(1_000)).register('old-a', 'run')
    await new ContainerInstanceRegistry(fakeNamespace([]), store, at(1_500)).register(
      'old-b',
      'bootstrap',
    )
    await new ContainerInstanceRegistry(fakeNamespace([]), store, at(9_900)).register('fresh', 'run')

    const { reaped } = await reg.reapStaleBefore(5_000)

    expect(reaped).toBe(2)
    expect(killed.sort()).toEqual(['old-a', 'old-b'])
    // The fresh container is left running and still recorded.
    expect(store.rows.has('fresh')).toBe(true)
    expect(store.rows.has('old-a')).toBe(false)
    expect(store.rows.has('old-b')).toBe(false)
  })

  it('reaps nothing when every container is within its lifetime', async () => {
    const store = new FakeStore()
    const killed: string[] = []
    const reg = new ContainerInstanceRegistry(fakeNamespace(killed), store, at(10_000))
    await new ContainerInstanceRegistry(fakeNamespace([]), store, at(9_000)).register('a', 'run')

    const { reaped } = await reg.reapStaleBefore(5_000)

    expect(reaped).toBe(0)
    expect(killed).toEqual([])
    expect(store.rows.has('a')).toBe(true)
  })
})
