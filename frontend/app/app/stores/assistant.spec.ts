import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAssistantStore } from '~/stores/assistant'
import { useWorkspaceStore } from '~/stores/workspace'
import { ApiError } from '~/composables/api/errors'
import type { AssistantCapability } from '~/types/domain'

// What the modal reads to decide whether it may offer the prompt box. The capability's own ANSWER
// is one bit ("is a model wired"), and on its own that bit cannot say whether anyone asked: the
// modal is mounted only while it is open, so its first render happens before the read resolves.

/**
 * Stub `useApi` ONCE, behind a handler the test can swap. The store resolves `useApi()` at setup,
 * so re-stubbing after `useAssistantStore()` would leave it holding the first stub for ever.
 */
function stubApi(): {
  store: ReturnType<typeof useAssistantStore>
  serve: (fn: () => Promise<AssistantCapability>) => void
} {
  let handler: () => Promise<AssistantCapability> = () =>
    Promise.resolve({ available: true, actions: [] })
  vi.stubGlobal('useApi', () => ({
    getAssistantCapability: (_ws: string) => handler(),
  }))
  return {
    store: useAssistantStore(),
    serve: (fn) => {
      handler = fn
    },
  }
}

describe('assistant store: the capability read', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('starts unread, which is not the same fact as unavailable', () => {
    const { store } = stubApi()

    expect(store.capabilityRead).toBe('unread')
    expect(store.available).toBe(false)
  })

  it('holds `reading` while the read is in flight', async () => {
    const { store, serve } = stubApi()
    let answer!: (capability: AssistantCapability) => void
    serve(() => new Promise((resolve) => (answer = resolve)))

    const inFlight = store.loadCapability()
    expect(store.capabilityRead).toBe('reading')

    answer({ available: true, actions: ['declare-service-dependency'] })
    await inFlight

    expect(store.capabilityRead).toBe('read')
    expect(store.actions).toEqual(['declare-service-dependency'])
  })

  it('records a wired deployment as READ, not merely as available', async () => {
    const { store, serve } = stubApi()
    serve(() => Promise.resolve({ available: true, actions: [] }))

    await store.loadCapability()

    expect(store.capabilityRead).toBe('read')
    expect(store.available).toBe(true)
  })

  it('records a read that answered "no model" as read, so it can be told from an outage', async () => {
    const { store, serve } = stubApi()
    serve(() => Promise.resolve({ available: false, actions: [] }))

    await store.loadCapability()

    expect(store.capabilityRead).toBe('read')
    expect(store.available).toBe(false)
  })

  it('marks a FAILED read as failed and re-throws, so the funnel still gets the reason', async () => {
    const { store, serve } = stubApi()
    serve(() =>
      Promise.reject(new ApiError(503, { error: { code: 'unavailable', message: 'nope' } })),
    )

    await expect(store.loadCapability()).rejects.toBeInstanceOf(ApiError)

    expect(store.capabilityRead).toBe('failed')
    expect(store.available).toBe(false)
  })

  it('drops a previous answer when a later read fails', async () => {
    // A retry that fails must not leave the box open on the strength of the read before it: the
    // deployment's model may have gone away with whatever took the endpoint down.
    const { store, serve } = stubApi()
    serve(() => Promise.resolve({ available: true, actions: ['add-service-from-repo'] }))
    await store.loadCapability()

    serve(() => Promise.reject(new ApiError(500, { error: { code: 'internal', message: 'x' } })))
    await expect(store.loadCapability()).rejects.toBeInstanceOf(ApiError)

    expect(store.capability).toBeNull()
    expect(store.actions).toEqual([])
  })

  it('recovers on a retry that answers', async () => {
    const { store, serve } = stubApi()
    serve(() => Promise.reject(new ApiError(502, { error: { code: 'upstream', message: 'x' } })))
    await expect(store.loadCapability()).rejects.toBeInstanceOf(ApiError)

    serve(() => Promise.resolve({ available: true, actions: ['create-task-from-issue'] }))
    await store.loadCapability()

    expect(store.capabilityRead).toBe('read')
    expect(store.available).toBe(true)
  })
})
