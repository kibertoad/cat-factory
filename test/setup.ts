import { setActivePinia, createPinia } from 'pinia'
import { beforeEach, vi } from 'vitest'

// The Pinia stores call Nuxt auto-imported composables at setup time (e.g.
// `useApi()`). Under plain Vitest those globals don't exist, so stub them with
// inert defaults — the pure read getters under test never touch the API, and any
// mutation that would hit it is out of scope for these unit tests.
vi.stubGlobal('useApi', () => ({}))

// A fresh Pinia per test keeps store state isolated.
beforeEach(() => {
  setActivePinia(createPinia())
})
