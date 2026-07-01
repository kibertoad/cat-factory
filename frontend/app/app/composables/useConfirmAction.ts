/**
 * Confirm-gate + success-toast for the recurring destructive actions that aren't board
 * blocks (disconnect a connection, remove/revoke a credential, clear a config, destroy an
 * environment). Built on the same `useConfirm()` singleton + `useToast()` the board delete
 * path uses, so every destructive affordance across the settings/connection surfaces routes
 * through ONE confirm-then-mutate + toast path rather than each re-inventing its own copy.
 *
 * A call site becomes:
 *
 *   const { confirmAction, toastDone } = useConfirmAction()
 *   async function disconnect() {
 *     if (!(await confirmAction('disconnect', providerName))) return
 *     await store.remove()
 *     toastDone('disconnect', providerName)
 *   }
 *
 * The copy is generic (`common.confirm.*` / `common.toast.*`) with the target's name
 * interpolated, so the irreversibility warning is translated once per locale — not re-worded
 * per surface. `name` is a short noun for the target (a brand like "Slack", a data value like
 * the invite email, or a feature noun like "the test environment").
 */
type ConfirmShape = 'disconnect' | 'remove' | 'revoke' | 'clear' | 'destroy'

/**
 * Per-shape copy + iconography. An exhaustive `Record<ConfirmShape, …>` (not an inline
 * template key) so adding a shape without wiring its copy is a typecheck failure — the
 * sanctioned guard for enum→message-key lookups the tier-1 typed-keys check can't see.
 */
const SHAPE_META: Record<
  ConfirmShape,
  { titleKey: string; bodyKey: string; labelKey: string; icon: string; toastKey: string }
> = {
  disconnect: {
    titleKey: 'common.confirm.titles.disconnect',
    bodyKey: 'common.confirm.reconnectHint',
    labelKey: 'common.disconnect',
    icon: 'i-lucide-unplug',
    toastKey: 'common.toast.disconnected',
  },
  remove: {
    titleKey: 'common.confirm.titles.remove',
    bodyKey: 'common.confirm.irreversible',
    labelKey: 'common.remove',
    icon: 'i-lucide-trash-2',
    toastKey: 'common.toast.removed',
  },
  revoke: {
    titleKey: 'common.confirm.titles.revoke',
    bodyKey: 'common.confirm.irreversible',
    labelKey: 'common.revoke',
    icon: 'i-lucide-ban',
    toastKey: 'common.toast.revoked',
  },
  clear: {
    titleKey: 'common.confirm.titles.clear',
    bodyKey: 'common.confirm.irreversible',
    labelKey: 'common.clear',
    icon: 'i-lucide-eraser',
    toastKey: 'common.toast.cleared',
  },
  destroy: {
    titleKey: 'common.confirm.titles.destroy',
    bodyKey: 'common.confirm.irreversible',
    labelKey: 'common.destroy',
    icon: 'i-lucide-trash-2',
    toastKey: 'common.toast.destroyed',
  },
}

export function useConfirmAction() {
  const { confirm } = useConfirm()
  const toast = useToast()
  const { t } = useI18n()

  /** Prompt before a destructive action against `name`. Resolves `true` only if confirmed. */
  async function confirmAction(shape: ConfirmShape, name: string): Promise<boolean> {
    const meta = SHAPE_META[shape]
    return confirm({
      title: t(meta.titleKey, { name }),
      description: t(meta.bodyKey),
      variant: 'destructive',
      confirmLabel: t(meta.labelKey),
      icon: meta.icon,
    })
  }

  /** Toast the completed destructive action (call only on real success). */
  function toastDone(shape: ConfirmShape, name: string): void {
    const meta = SHAPE_META[shape]
    toast.add({ title: t(meta.toastKey, { name }), color: 'success', icon: 'i-lucide-check' })
  }

  return { confirmAction, toastDone }
}
