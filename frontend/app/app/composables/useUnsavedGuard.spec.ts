import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { useUnsavedGuard } from '~/composables/useUnsavedGuard'

// Control the shared confirm dialog: `confirm()` resolves to the user's choice (discard
// vs keep). `useI18n` is already stubbed to a passthrough in test/setup.ts.
function stubConfirm(result: boolean) {
  const confirm = vi.fn().mockResolvedValue(result)
  vi.stubGlobal('useConfirm', () => ({ confirm }))
  return confirm
}

describe('useUnsavedGuard', () => {
  it('closes immediately without prompting when the form is unchanged', async () => {
    const confirm = stubConfirm(true)
    const close = vi.fn()
    const value = ref('hello')
    const { requestClose } = useUnsavedGuard({
      open: ref(true),
      close,
      snapshot: () => ({ value: value.value }),
    })

    await requestClose()

    expect(confirm).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('prompts and closes when dirty and the user confirms discard', async () => {
    const confirm = stubConfirm(true)
    const close = vi.fn()
    const value = ref('hello')
    const { requestClose, isDirty } = useUnsavedGuard({
      open: ref(true),
      close,
      snapshot: () => ({ value: value.value }),
    })

    value.value = 'changed'
    expect(isDirty()).toBe(true)
    await requestClose()

    expect(confirm).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('prompts and keeps the modal open when the user cancels discard', async () => {
    const confirm = stubConfirm(false)
    const close = vi.fn()
    const value = ref('hello')
    const { requestClose } = useUnsavedGuard({
      open: ref(true),
      close,
      snapshot: () => ({ value: value.value }),
    })

    value.value = 'changed'
    await requestClose()

    expect(confirm).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()
  })

  it('never prompts or closes while a submit is in flight', async () => {
    const confirm = stubConfirm(true)
    const close = vi.fn()
    const value = ref('hello')
    const { requestClose } = useUnsavedGuard({
      open: ref(true),
      close,
      saving: () => true,
      snapshot: () => ({ value: value.value }),
    })

    value.value = 'changed'
    await requestClose()

    expect(confirm).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('re-baselines the seeded form each time the modal opens', async () => {
    stubConfirm(true)
    const open = ref(false)
    const value = ref('')
    const { isDirty } = useUnsavedGuard({
      open,
      close: vi.fn(),
      snapshot: () => ({ value: value.value }),
    })

    // A reset watcher seeds a prefill; the guard re-snapshots on open, so the seeded value
    // is the clean baseline rather than a spurious edit.
    value.value = 'seeded prefill'
    open.value = true
    await nextTick()
    expect(isDirty()).toBe(false)

    // A genuine edit after the modal is open is dirty.
    value.value = 'user typed more'
    expect(isDirty()).toBe(true)
  })
})
