import { setActivePinia, createPinia } from 'pinia'
import { beforeEach, vi } from 'vitest'

// The Pinia stores call Nuxt auto-imported composables at setup time (e.g.
// `useApi()`, `useToast()`). Under plain Vitest those globals don't exist, so stub
// them with inert defaults — the pure read getters under test never touch the API or
// surface a toast, and any mutation that would is out of scope for these unit tests.
vi.stubGlobal('useApi', () => ({}))
vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
vi.stubGlobal('usePipelineErrorToast', () => ({ present: vi.fn() }))

// @nuxtjs/i18n auto-imports `useI18n`. Under plain Vitest the module isn't booted, so
// stub it with a passthrough: `t` echoes the key, `te` reports every key as present, and
// `n`/`d` stringify. Specs that assert i18n behaviour override this with their own spies.
vi.stubGlobal('useI18n', () => ({
  t: (key: string) => key,
  te: () => true,
  n: (value: number) => String(value),
  d: (value: unknown) => String(value),
}))

// A fresh Pinia per test keeps store state isolated.
beforeEach(() => {
  setActivePinia(createPinia())
})
