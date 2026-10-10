import { describe, expect, it, vi } from 'vitest'

// `useCopyToClipboard` wraps VueUse's clipboard; mock it so `copyAction` can be exercised
// without a real clipboard. The global `useToast`/`useI18n` stubs come from test/setup.ts
// (`t` echoes the key), so the default label resolves to its i18n key.
const { writeClipboard } = vi.hoisted(() => ({ writeClipboard: vi.fn(async () => {}) }))
vi.mock('@vueuse/core', () => ({
  useClipboard: () => ({ copy: writeClipboard, isSupported: { value: true } }),
}))

import { useCopyToClipboard } from '~/composables/useCopyToClipboard'

describe('copyAction', () => {
  it('builds a Copy-details toast action that copies the given text', async () => {
    const action = useCopyToClipboard().copyAction('diagnostic report')
    expect(action.label).toBe('common.copyDetails')
    expect(action.icon).toBe('i-lucide-clipboard')

    action.onClick()
    await Promise.resolve()
    expect(writeClipboard).toHaveBeenCalledWith('diagnostic report')
  })

  it('honours a custom label', () => {
    expect(useCopyToClipboard().copyAction('x', 'Custom label').label).toBe('Custom label')
  })
})
