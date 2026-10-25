import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '~/composables/api/errors'
import { useLocalModelsStore } from '~/stores/localModels'
import { usePersonalSubscriptionsStore } from '~/stores/personalSubscriptions'
import { useUserSecretsStore } from '~/stores/userSecrets'

// The three user-scoped stores behind "My setup". A refusal that means "nothing to show" (401
// signed out or auth off, 503 module not configured) reads as an empty list; any other failure
// sets `loadFailed`, so the hub's row can say it did not load instead of "Not connected".

/** Each store, with the API method its `load()` calls and a successful empty answer. */
const stores = [
  {
    name: 'userSecrets',
    method: 'listUserSecrets',
    empty: { secrets: [], descriptors: [] },
    use: useUserSecretsStore,
  },
  {
    name: 'localModels',
    method: 'listLocalModelEndpoints',
    empty: { endpoints: [] },
    use: useLocalModelsStore,
  },
  {
    name: 'personalSubscriptions',
    method: 'listPersonalSubscriptions',
    empty: { subscriptions: [] },
    use: usePersonalSubscriptionsStore,
  },
] as const

function withApi(method: string, impl: () => Promise<unknown>) {
  vi.stubGlobal('useApi', () => ({ [method]: vi.fn(impl) }))
}

describe.each(stores)('$name load()', ({ method, empty, use }) => {
  it.each([401, 503])('treats a %i refusal as nothing to show', async (status) => {
    withApi(method, () => Promise.reject(new ApiError(status, {})))
    const store = use()
    await store.load()
    expect(store.loadFailed).toBe(false)
  })

  it.each([
    ['a 500', new ApiError(500, {})],
    ['a network error', new TypeError('Failed to fetch')],
  ])('records %s as a failed load', async (_label, error) => {
    withApi(method, () => Promise.reject(error))
    const store = use()
    await store.load()
    expect(store.loadFailed).toBe(true)
  })

  it('clears the failure once a later load succeeds', async () => {
    // The store reads `useApi()` once at setup, so the stub's answer is switched in place.
    let answer: () => Promise<unknown> = () => Promise.reject(new ApiError(500, {}))
    withApi(method, () => answer())
    const store = use()
    await store.load()
    expect(store.loadFailed).toBe(true)
    answer = () => Promise.resolve(empty)
    await store.load()
    expect(store.loadFailed).toBe(false)
  })
})
