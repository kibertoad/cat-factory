import { setActivePinia, createPinia } from 'pinia'
import { beforeEach, vi } from 'vitest'

// The Pinia stores call Nuxt auto-imported composables at setup time (e.g.
// `useApi()`, `useToast()`). Under plain Vitest those globals don't exist, so stub
// them with inert defaults — the pure read getters under test never touch the API or
// surface a toast, and any mutation that would is out of scope for these unit tests.
vi.stubGlobal('useApi', () => ({}))
vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
vi.stubGlobal('usePipelineErrorToast', () => ({ present: vi.fn() }))
// Some stores resolve translations through the Nuxt app's global i18n instance (they run
// outside a component `setup`, so `useI18n()` isn't available). Stub it with a passthrough
// `$i18n.t` that echoes the key.
vi.stubGlobal('useNuxtApp', () => ({ $i18n: { t: (key: string) => key } }))

// @nuxtjs/i18n auto-imports `useI18n`. Under plain Vitest the module isn't booted, so
// stub it with a passthrough: `t` echoes the key and `n`/`d` stringify. `te` reports NO key
// as present — the inert stub loads no catalog, so claiming every key exists would mask a
// missing-key bug in any code that branches on `te`. Specs asserting i18n behaviour override
// this with their own spies (e.g. a real catalog lookup).
vi.stubGlobal('useI18n', () => ({
  t: (key: string) => key,
  te: () => false,
  n: (value: number) => String(value),
  d: (value: unknown) => String(value),
}))

// A fresh Pinia per test keeps store state isolated.
beforeEach(() => {
  setActivePinia(createPinia())
})
