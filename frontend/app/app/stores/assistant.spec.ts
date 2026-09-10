import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAssistantStore } from '~/stores/assistant'
import { useWorkspaceStore } from '~/stores/workspace'
import { usePersonalSubscriptionsStore } from '~/stores/personalSubscriptions'
import { ApiError } from '~/composables/api/errors'
import type { AssistantCapability } from '~/types/domain'

// What the modal reads to decide whether it may offer the prompt box, and whether that box may be
// submitted. The capability's own ANSWER is two independent bits (is a model wired, and is there
// anything for it to do); on their own they cannot say whether anyone has asked yet, which is a
// third fact the modal has to render differently from both.

/**
 * Stub `useApi` ONCE, behind a handler the test can swap. The store resolves `useApi()` at setup,
 * so re-stubbing after `useAssistantStore()` would leave it holding the first stub for ever.
 *
 * The handler is given the abort signal the store attaches its deadline to, so a test can assert
 * on what a timed-out read does to the request as well as to the state.
 */
function stubApi(): {
  store: ReturnType<typeof useAssistantStore>
  serve: (fn: (signal: AbortSignal) => Promise<AssistantCapability>) => void
} {
  let handler: (signal: AbortSignal) => Promise<AssistantCapability> = () =>
    Promise.resolve({ available: true, actions: ['declare-service-dependency'] })
  vi.stubGlobal('useApi', () => ({
    getAssistantCapability: (_ws: string, signal: AbortSignal) => handler(signal),
  }))
  return {
    store: useAssistantStore(),
    serve: (fn) => {
      handler = fn
    },
  }
}

const failing = (status = 503) =>
  Promise.reject(new ApiError(status, { error: { code: 'unavailable', message: 'nope' } }))

describe('assistant store: the capability read', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('starts idle, which is not the same fact as unavailable', () => {
    const { store } = stubApi()

    expect(store.capabilityRead).toBe('idle')
    expect(store.capability).toBeNull()
    expect(store.available).toBe(false)
  })

  it('holds `loading` while the read is in flight', async () => {
    const { store, serve } = stubApi()
    let answer!: (capability: AssistantCapability) => void
    serve(() => new Promise((resolve) => (answer = resolve)))

    const inFlight = store.loadCapability()
    expect(store.capabilityRead).toBe('loading')

    answer({ available: true, actions: ['declare-service-dependency'] })
    await inFlight

    expect(store.capabilityRead).toBe('ready')
    expect(store.actions).toEqual(['declare-service-dependency'])
  })

  it('KEEPS the answer it holds while a re-read is in flight', async () => {
    // Re-opening the modal re-reads. Clearing the answer for the duration would replace the box
    // with a waiting state on every open, for a fact the store can already state.
    const { store, serve } = stubApi()
    await store.loadCapability()

    serve(() => new Promise(() => {}))
    void store.loadCapability()

    expect(store.capabilityRead).toBe('loading')
    expect(store.available).toBe(true)
    expect(store.actions).toEqual(['declare-service-dependency'])
  })

  it('records a read that answered "no model" as read, so it can be told from an outage', async () => {
    const { store, serve } = stubApi()
    serve(() => Promise.resolve({ available: false, actions: [] }))

    await store.loadCapability()

    expect(store.capabilityRead).toBe('ready')
    expect(store.available).toBe(false)
  })

  it('marks a FAILED read as failed and does not throw', async () => {
    // The failure is REPORTED by the panel this state puts on screen, which is where the retry
    // lives too. Throwing it as well would have the modal toast a second, non-dismissing copy of
    // the same sentence over that panel, once per retry.
    const { store, serve } = stubApi()
    serve(() => failing())

    await expect(store.loadCapability()).resolves.toBeUndefined()

    expect(store.capabilityRead).toBe('error')
    expect(store.capability).toBeNull()
    expect(store.available).toBe(false)
  })

  it('drops a previous answer when a later read fails', async () => {
    // A retry that fails must not leave the box open on the strength of the read before it: the
    // deployment's model may have gone away with whatever took the endpoint down.
    const { store, serve } = stubApi()
    serve(() => Promise.resolve({ available: true, actions: ['add-service-from-repo'] }))
    await store.loadCapability()

    serve(() => failing(500))
    await store.loadCapability()

    expect(store.capability).toBeNull()
    expect(store.actions).toEqual([])
  })

  it('recovers on a retry that answers', async () => {
    const { store, serve } = stubApi()
    serve(() => failing(502))
    await store.loadCapability()

    serve(() => Promise.resolve({ available: true, actions: ['create-task-from-issue'] }))
    await store.loadCapability()

    expect(store.capabilityRead).toBe('ready')
    expect(store.available).toBe(true)
  })

  it('settles overlapping reads in the order they STARTED, not the order they answer', async () => {
    // A slow success that lands after the fast failure which superseded it would otherwise
    // re-offer the box on an answer older than the failure that replaced it.
    const { store, serve } = stubApi()
    let answerSlow!: (capability: AssistantCapability) => void
    serve(() => new Promise((resolve) => (answerSlow = resolve)))
    const slow = store.loadCapability()

    serve(() => failing())
    await store.loadCapability()
    expect(store.capabilityRead).toBe('error')

    answerSlow({ available: true, actions: ['declare-service-dependency'] })
    await slow

    expect(store.capabilityRead).toBe('error')
    expect(store.capability).toBeNull()
  })
})

describe('assistant store: the capability read deadline', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fails a read that never settles, and ABORTS the request it gave up on', async () => {
    // The shared client sets no timeout, so a connection accepted and never answered would leave
    // the modal waiting for ever: no answer, no failure, and so no retry either, since the retry
    // is what a failed read puts on screen.
    const { store, serve } = stubApi()
    let aborted = false
    serve(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('aborted'))
          })
        }),
    )

    const read = store.loadCapability()
    await vi.advanceTimersByTimeAsync(10_000)
    await read

    expect(aborted).toBe(true)
    expect(store.capabilityRead).toBe('error')
  })
})

// The credential half of a turn: a workspace whose preset pins an individual-usage subscription
// runs this surface on it, which means the turn has to be able to ASK for the password and to
// survive being refused one.
describe('assistant store: the personal-credential flow', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  function stubTurn(
    withCredential: (action: (password?: string) => Promise<void>) => Promise<boolean>,
  ) {
    const calls: (string | undefined)[] = []
    vi.stubGlobal('useApi', () => ({
      getAssistantCapability: async () => ({ available: true, actions: ['add-service-from-repo'] }),
      runAssistantTurn: async (_ws: string, _prompt: string, password?: string) => {
        calls.push(password)
        return { outcome: { status: 'declined', reason: 'no_matching_action' }, model: null }
      },
    }))
    usePersonalSubscriptionsStore().withCredential = withCredential as unknown as ReturnType<
      typeof usePersonalSubscriptionsStore
    >['withCredential']
    return { store: useAssistantStore(), calls }
  }

  it('carries the password the credential flow supplies into the turn', async () => {
    // Without it a workspace pinned to a personal subscription could only ever be answered by
    // some other model, which is the failure this whole path exists to close.
    const { store, calls } = stubTurn(async (action) => {
      await action('correct horse')
      return true
    })

    const turn = await store.run('add the payments repo')

    expect(calls).toEqual(['correct horse'])
    expect(turn).not.toBeNull()
  })

  it('answers null when the person cancels the password prompt', async () => {
    // A cancel is not a failed turn and not a declined one: nothing ran, so there is no outcome
    // to render. Reporting it as either would put a refusal on screen that nobody caused.
    const { store, calls } = stubTurn(async () => false)

    expect(await store.run('add the payments repo')).toBeNull()
    expect(calls).toEqual([])
    expect(store.turn).toBeNull()
  })
})
