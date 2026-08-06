import { describe, it, expect, vi } from 'vitest'
import type { ModelOption } from '~/types/domain'
import { useModelsStore } from '~/stores/models'

/** Minimal catalog entry: only the fields the store's own reads touch. */
function model(over: Partial<ModelOption> = {}): ModelOption {
  return {
    id: 'qwen3',
    label: 'Qwen3',
    description: '',
    flavor: 'cloudflare',
    providerLabel: 'Cloudflare',
    provider: 'cloudflare',
    model: 'qwen3',
    available: true,
    ...over,
  } as ModelOption
}

// The boot-time catalog load runs against the PERSISTED PIN, before `workspace.init()` has
// validated it against the board list. A pin can name a board that was deleted, or one whose
// access was revoked while the browser held it, and the RBAC gate answers both with a 404, so
// the load has to tolerate a miss. Left bare it was an uncaught rejection in the page (the
// `Workspace not found` a removed member's browser threw on their next visit).
describe('models store: the speculative load of an unvalidated pin', () => {
  it('drops a pin that 404s and leaves the catalog retryable for the board init resolves', async () => {
    const get = vi
      .fn<(workspaceId: string) => Promise<ModelOption[]>>()
      .mockRejectedValueOnce(Object.assign(new Error('Workspace not found'), { statusCode: 404 }))
      .mockResolvedValueOnce([model()])
    vi.stubGlobal('useApi', () => ({ getWorkspaceModels: get }))

    const store = useModelsStore()
    // The revoked pin. Resolves rather than rejects: nothing in the page catches it.
    await expect(store.prefetchForBoard('ws_revoked')).resolves.toBeUndefined()

    // Nothing was latched, so this reads as UNRESOLVED rather than as a board with no models
    // (`useAiReadiness().ready` is `loaded && loadedWorkspaceId === workspaceId`, which is what
    // keeps the no-AI onboarding prompt from firing off a catalog that never landed).
    expect(store.loaded).toBe(false)
    expect(store.loadedWorkspaceId).toBeNull()
    expect(store.models).toEqual([])

    // ...and the board `init()` resolves instead still loads, on the same store.
    await store.ensureLoaded('ws_reachable')
    expect(store.loaded).toBe(true)
    expect(store.loadedWorkspaceId).toBe('ws_reachable')
    expect(store.models).toHaveLength(1)
  })

  it('a pin that IS reachable loads the catalog once, and the later caller reuses it', async () => {
    const get = vi.fn(() => Promise.resolve([model()]))
    vi.stubGlobal('useApi', () => ({ getWorkspaceModels: get }))

    const store = useModelsStore()
    await store.prefetchForBoard('ws1')
    // What the cold open pays for: `init()` hydrating the same board finds the catalog already
    // there, so the prefetch is one request rather than a duplicate of the one that follows it.
    await store.ensureLoaded('ws1')

    expect(get).toHaveBeenCalledTimes(1)
    expect(store.hasUsableModel).toBe(true)
  })
})
