// Shared clipboard-with-feedback primitive. Wraps VueUse's `useClipboard` with a toast that
// confirms the copy actually landed (or reports failure) — the pattern first written inline in
// `StepContainerStatus.vue`, extracted here so every copy affordance behaves the same.
//
// UX-38: several copy handlers called `navigator.clipboard?.writeText(...)` directly with no
// feedback and no catch, so in an insecure context or when permission was denied the copy was a
// silent no-op the user couldn't tell apart from success. Routing every copy through this seam
// makes the outcome always visible.
import { useClipboard } from '@vueuse/core'

export function useCopyToClipboard() {
  const { t } = useI18n()
  const toast = useToast()
  const { copy: writeClipboard, isSupported } = useClipboard()

  async function copy(text: string) {
    // Only claim success once the write actually landed — a failed/unsupported clipboard
    // (insecure context, denied permission) must not show a misleading "Copied" toast.
    try {
      if (!isSupported.value) throw new Error('clipboard unsupported')
      await writeClipboard(text)
      toast.add({ title: t('common.copied'), color: 'success', icon: 'i-lucide-check' })
    } catch {
      toast.add({ title: t('common.copyFailed'), color: 'error', icon: 'i-lucide-x' })
    }
  }

  /**
   * A ready-made toast action that copies `text` (through {@link copy}, so it shows the
   * same "Copied" / "Copy failed" feedback). Drop it into a toast's `actions` so any
   * error/warning toast can offer a one-click "Copy details" — the message + context the
   * user would otherwise have to retype into a bug report.
   */
  function copyAction(text: string, label?: string) {
    return {
      label: label ?? t('common.copyDetails'),
      icon: 'i-lucide-clipboard',
      onClick: () => {
        void copy(text)
      },
    }
  }

  return { copy, copyAction, isSupported }
}
