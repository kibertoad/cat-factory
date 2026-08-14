import { describe, expect, it } from 'vitest'
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import {
  ContainerInstanceRegistry,
  type LiveContainerRecord,
  type LiveContainerStore,
} from '../../src/infrastructure/containers/ContainerInstanceRegistry'
import type { ExecutionContainer } from '../../src/infrastructure/containers/ExecutionContainer'
import type { ResolveRunContainerNamespace } from '../../src/infrastructure/containers/runContainerNamespace'

// Pure-logic coverage for the instance-level reaper: it must enumerate the live
// inventory by age, SIGKILL each stale container through the container class that HOLDS it,
// and clear its row, leaving fresh containers untouched. No workerd/D1 needed; the
// store + namespaces are faked, mirroring the sweeper specs.

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

/** Fake container namespace recording which keys were SIGKILLed, tagged with its class. */
function fakeNamespace(killed: string[], tag = 'exec'): DurableObjectNamespace<ExecutionContainer> {
  return {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      shutdown: async () => {
        killed.push(`${tag}:${id.name}`)
      },
    }),
  } as unknown as DurableObjectNamespace<ExecutionContainer>
}

/** A resolver over ONE namespace, for the cases that never touch a second image variant. */
function fixed(killed: string[]): ResolveRunContainerNamespace {
  return () => fakeNamespace(killed)
}

const at = (now: number) => ({ now: () => now })

describe('ContainerInstanceRegistry: reaper', () => {
  it('register preserves the earliest started_at across replayed dispatches', async () => {
    const store = new FakeStore()
    const reg = new ContainerInstanceRegistry(fixed([]), store, at(100))
    await reg.register({ containerKey: 'job-1', kind: 'run' })
    const second = new ContainerInstanceRegistry(fixed([]), store, at(500))
    await second.register({ containerKey: 'job-1', kind: 'run' })
    expect(store.rows.get('job-1')?.startedAt).toBe(100)
  })

  it('release SIGKILLs the container and clears its inventory row', async () => {
    const store = new FakeStore()
    const killed: string[] = []
    const reg = new ContainerInstanceRegistry(fixed(killed), store, at(100))
    await reg.register({ containerKey: 'job-1', kind: 'bootstrap', workspaceId: 'ws-1' })
    await reg.release('job-1')
    expect(killed).toEqual(['exec:job-1'])
    expect(store.rows.has('job-1')).toBe(false)
  })

  it('reaps only containers older than the ceiling and returns the count', async () => {
    const store = new FakeStore()
    const killed: string[] = []
    const reg = new ContainerInstanceRegistry(fixed(killed), store, at(10_000))
    // started_at: old ones are stale; the fresh one is within the window.
    await new ContainerInstanceRegistry(fixed([]), store, at(1_000)).register({
      containerKey: 'old-a',
      kind: 'run',
    })
    await new ContainerInstanceRegistry(fixed([]), store, at(1_500)).register({
      containerKey: 'old-b',
      kind: 'bootstrap',
    })
    await new ContainerInstanceRegistry(fixed([]), store, at(9_900)).register({
      containerKey: 'fresh',
      kind: 'run',
    })

    const { reaped } = await reg.reapStaleBefore(5_000)

    expect(reaped).toBe(2)
    expect(killed.sort()).toEqual(['exec:old-a', 'exec:old-b'])
    // The fresh container is left running and still recorded.
    expect(store.rows.has('fresh')).toBe(true)
    expect(store.rows.has('old-a')).toBe(false)
    expect(store.rows.has('old-b')).toBe(false)
  })

  it('reaps nothing when every container is within its lifetime', async () => {
    const store = new FakeStore()
    const killed: string[] = []
    const reg = new ContainerInstanceRegistry(fixed(killed), store, at(10_000))
    await new ContainerInstanceRegistry(fixed([]), store, at(9_000)).register({
      containerKey: 'a',
      kind: 'run',
    })

    const { reaped } = await reg.reapStaleBefore(5_000)

    expect(reaped).toBe(0)
    expect(killed).toEqual([])
    expect(store.rows.has('a')).toBe(true)
  })

  // The regression this column exists for: a run with a `tester-ui` step holds a SECOND
  // container, in the UI class. The reaper kills through a namespace, and `idFromName` returns a
  // usable stub in ANY namespace, so a UI container reaped through the executor class SIGKILLs
  // an instance that was never started, drops the row, and reports success while the browser
  // container keeps running to its own idle timeout. Nothing throws, which is why it needs a
  // test rather than a type.
  it('reaps each container through the class that holds it', async () => {
    const store = new FakeStore()
    const killed: string[] = []
    const byVariant: ResolveRunContainerNamespace = (variant) =>
      variant === 'ui' ? fakeNamespace(killed, 'ui') : fakeNamespace(killed, 'exec')
    const reg = new ContainerInstanceRegistry(byVariant, store, at(10_000))
    await new ContainerInstanceRegistry(byVariant, store, at(1_000)).register({
      containerKey: 'run-1',
      kind: 'run',
    })
    await new ContainerInstanceRegistry(byVariant, store, at(1_000)).register({
      containerKey: 'ui:run-1',
      kind: 'run',
      image: 'ui',
    })

    const { reaped } = await reg.reapStaleBefore(5_000)

    expect(reaped).toBe(2)
    expect(killed.sort()).toEqual(['exec:run-1', 'ui:ui:run-1'])
    expect(store.rows.size).toBe(0)
  })
})
