import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useToolServersStore } from '~/stores/toolServers'
import { useWorkspaceStore } from '~/stores/workspace'
import type { ToolServerProbeResult, ToolServerView } from '~/types/toolServers'

/**
 * Three behaviours carry this store, each about not losing an answer:
 *
 *   - the availability probe. A 403 ("you may not manage secrets") is an ANSWER and resolves
 *     normally, hiding the surface; anything else propagates, because the panel is what can tell a
 *     reader the list could not be fetched. There is deliberately no 503 case, unlike the
 *     credential store: projecting a registry needs no encryption key.
 *   - a probe result is kept for every VERDICT, failures included. A failure is exactly the answer
 *     the operator asked for, and a store that only kept successes would leave the row looking
 *     untouched after a dead endpoint was reported.
 *   - results survive a re-read of the inventory, because a result describes the SERVER rather than
 *     the list it arrived in.
 */
function server(over: Partial<ToolServerView> = {}): ToolServerView {
  return {
    id: 'issues',
    label: 'Issue tracker',
    transport: 'http',
    target: 'https://mcp.example/rpc',
    declaredBy: ['coder'],
    servableHarnesses: ['claude-code'],
    credentials: [],
    probeable: true,
    ...over,
  }
}

describe('toolServers store', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('load stores the inventory and marks the surface available', async () => {
    vi.stubGlobal('useApi', () => ({
      listToolServers: () => Promise.resolve({ servers: [server()] }),
    }))

    const store = useToolServersStore()
    await store.load()

    expect(store.available).toBe(true)
    expect(store.hasSurface).toBe(true)
    expect(store.loading).toBe(false)
  })

  it('shares one read between concurrent callers', async () => {
    let reads = 0
    vi.stubGlobal('useApi', () => ({
      listToolServers: () => {
        reads++
        return Promise.resolve({ servers: [server()] })
      },
    }))

    const store = useToolServersStore()
    // Both callers fire on the same interaction: the Infrastructure window asks `ensureLoaded` whether
    // the tab exists at all, and the panel refreshes on mount so a redeploy shows up without a reload.
    // A read that started microseconds ago IS that refresh, so it is shared rather than duplicated.
    await Promise.all([store.ensureLoaded(), store.load()])

    expect(reads).toBe(1)
    expect(store.hasSurface).toBe(true)
  })

  it('a 403 latches the surface unavailable without throwing', async () => {
    vi.stubGlobal('useApi', () => ({
      listToolServers: () => Promise.reject({ statusCode: 403 }),
    }))

    const store = useToolServersStore()
    await expect(store.load()).resolves.toBeUndefined()

    expect(store.available).toBe(false)
    expect(store.hasSurface).toBe(false)
  })

  it('a transient failure propagates and latches nothing', async () => {
    vi.stubGlobal('useApi', () => ({
      listToolServers: () => Promise.reject({ statusCode: 500 }),
    }))

    const store = useToolServersStore()
    await expect(store.load()).rejects.toBeDefined()

    // `available` stays null so `ensureLoaded` remains retryable, and an already-loaded surface is
    // not hidden by one bad read.
    expect(store.available).toBeNull()
  })

  it('reports no surface for a deployment that registers no tool server', async () => {
    vi.stubGlobal('useApi', () => ({ listToolServers: () => Promise.resolve({ servers: [] }) }))

    const store = useToolServersStore()
    await store.load()

    // An answer rather than possibly an outage: the inventory is read off this process's own
    // registry, which is why there is no `declarationsIncomplete` counterpart here.
    expect(store.available).toBe(true)
    expect(store.hasSurface).toBe(false)
  })

  it('keeps a FAILING probe result, and keeps it across a re-read of the inventory', async () => {
    const failure: ToolServerProbeResult = {
      serverId: 'issues',
      status: 'unreachable',
      error: 'TypeError: fetch failed',
    }
    vi.stubGlobal('useApi', () => ({
      listToolServers: () => Promise.resolve({ servers: [server()] }),
      probeToolServer: () => Promise.resolve(failure),
    }))

    const store = useToolServersStore()
    await store.load()
    await store.probe('issues')

    expect(store.results.issues).toEqual(failure)
    expect(store.probing).toBeNull()

    await store.load()
    expect(store.results.issues).toEqual(failure)
  })

  it('propagates a THROWN probe failure without storing a verdict', async () => {
    // A 404 for a server the deployment has since dropped, or a transient 5xx: not a verdict, so the
    // row must not claim the probe answered.
    vi.stubGlobal('useApi', () => ({
      probeToolServer: () => Promise.reject({ statusCode: 404 }),
    }))

    const store = useToolServersStore()
    await expect(store.probe('ghost')).rejects.toBeDefined()

    expect(store.results.ghost).toBeUndefined()
    expect(store.probing).toBeNull()
  })
})
