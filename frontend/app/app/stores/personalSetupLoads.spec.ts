import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '~/composables/api/errors'
import { useLocalModelsStore } from '~/stores/localModels'
import { usePersonalSubscriptionsStore } from '~/stores/personalSubscriptions'
import { useUserSecretsStore } from '~/stores/userSecrets'

// The three user-scoped stores behind "My setup" each wire their list API into
// `createUserScopedLoad` (whose own spec pins the rule). This pins the wiring: a failure sets
// `loadFailed` and empties the list, and a later refusal meaning "nothing to show" clears it.

/** Each store, with the API method its `load()` calls and the list a successful read fills. */
const stores = [
  {
    name: 'userSecrets',
    method: 'listUserSecrets',
    open: () => {
      const store = useUserSecretsStore()
      return { store, rows: () => store.secrets }
    },
  },
  {
    name: 'localModels',
    method: 'listLocalModelEndpoints',
    open: () => {
      const store = useLocalModelsStore()
      return { store, rows: () => store.endpoints }
    },
  },
  {
    name: 'personalSubscriptions',
    method: 'listPersonalSubscriptions',
    open: () => {
      const store = usePersonalSubscriptionsStore()
      return { store, rows: () => store.subscriptions }
    },
  },
]

describe.each(stores)('$name load()', ({ method, open }) => {
  it('records a failure, then clears it on a module-off refusal', async () => {
    // The store reads `useApi()` once at setup, so the stub's answer is switched in place.
    let answer: () => Promise<unknown> = () => Promise.reject(new ApiError(500, {}))
    vi.stubGlobal('useApi', () => ({ [method]: vi.fn(() => answer()) }))
    const { store, rows } = open()
    await store.load()
    expect(store.loadFailed).toBe(true)
    expect(rows()).toEqual([])

    answer = () =>
      Promise.reject(
        new ApiError(503, { error: { code: 'unavailable', message: 'Not configured' } }),
      )
    await store.load()
    expect(store.loadFailed).toBe(false)
    expect(store.loading).toBe(false)
  })
})
