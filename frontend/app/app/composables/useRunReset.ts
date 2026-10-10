/**
 * The confirm-gated "discard this run" action, shared by every surface that offers it so they
 * can't drift on what it does or how loudly it asks first.
 *
 * Destructive and distinct from a STOP: stop halts a run but keeps it readable and retryable,
 * while this deletes it outright and returns the block to `planned`. That is what makes it the
 * escape hatch for a WEDGED run — a run whose driver will never settle can't be waited out, and
 * until the block's `executionId` clears nothing else may start on it.
 *
 * Two callers today: the inspector's execution panel (tasks and initiatives alike) and the
 * initiative planning window, which needs it in-place because a human whose interview stalled is
 * looking at that window, not at the inspector behind it.
 */
export function useRunReset() {
  const execution = useExecutionStore()
  const access = useWorkspaceAccess()
  const { confirm } = useConfirm()
  const { t } = useI18n()

  /** True while a discard is in flight (drives the button spinner). */
  const resetting = ref(false)

  /**
   * Confirm, then discard the block's run. Resolves `true` only when the run was actually
   * discarded, so a caller can act on it (the planning window closes itself). A read-only viewer
   * no-ops — every button binding this is disabled for them, and this guards the rest.
   */
  async function resetRun(blockId: string): Promise<boolean> {
    if (resetting.value || !access.canExecuteRuns.value) return false
    const ok = await confirm({
      title: t('inspector.execution.resetConfirm.title'),
      description: t('inspector.execution.resetConfirm.body'),
      variant: 'destructive',
      confirmLabel: t('inspector.execution.resetConfirm.confirm'),
      icon: 'i-lucide-trash-2',
    })
    if (!ok) return false
    resetting.value = true
    try {
      await execution.cancel(blockId)
      return true
    } finally {
      resetting.value = false
    }
  }

  return { resetting, resetRun }
}
