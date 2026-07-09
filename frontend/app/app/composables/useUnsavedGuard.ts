import { watch } from 'vue'
import type { Ref } from 'vue'

/**
 * Guard a content-heavy modal against silently discarding unsaved input when the user
 * dismisses it (Escape, backdrop click, or a Cancel button). Wire it into a controlled
 * `UModal` whose `open` is a store-backed writable computed: route the setter's close and
 * the Cancel button through `requestClose()` instead of closing directly.
 *
 * `snapshot()` returns a serialisable view of the user-facing form state. The baseline is
 * captured every time the modal opens, so register this AFTER the component's own reset
 * watcher — it then snapshots the *seeded* form (a prefill or an existing edit is the
 * clean baseline, not a spurious change). A close request only prompts when the current
 * snapshot diverges from that baseline; when nothing changed — or a submit is in flight —
 * the close proceeds immediately, so the common path is unchanged.
 *
 * Keep `snapshot()` to stable, user-owned values: exclude fields mutated by async loads
 * (they would read as dirty the instant a background fetch settles) and prefer stable ids
 * over objects that a best-effort resolve rewrites in place.
 */
export function useUnsavedGuard(opts: {
  /** The modal's open state (the writable computed's underlying getter). */
  open: Ref<boolean>
  /** A serialisable view of the current form state. */
  snapshot: () => unknown
  /** Actually close the modal (the store close action). */
  close: () => void
  /** True while a submit is in flight — a close is then a no-op (the submit closes itself). */
  saving?: () => boolean
}) {
  const { confirm } = useConfirm()
  const { t } = useI18n()

  let baseline = serialize(opts.snapshot())
  watch(opts.open, (isOpen) => {
    if (isOpen) baseline = serialize(opts.snapshot())
  })

  function isDirty(): boolean {
    return serialize(opts.snapshot()) !== baseline
  }

  async function requestClose(): Promise<void> {
    // A submit in flight closes itself on success — don't interrupt it or prompt.
    if (opts.saving?.()) return
    if (!isDirty()) {
      opts.close()
      return
    }
    const discard = await confirm({
      title: t('common.discard.title'),
      description: t('common.discard.body'),
      confirmLabel: t('common.discard.confirm'),
      cancelLabel: t('common.discard.keep'),
      variant: 'destructive',
      icon: 'i-lucide-triangle-alert',
    })
    if (discard) opts.close()
  }

  return { requestClose, isDirty }
}

function serialize(value: unknown): string {
  return JSON.stringify(value ?? null)
}
