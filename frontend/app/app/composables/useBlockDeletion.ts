import type { Block } from '~/types/domain'

/**
 * The single, confirm-gated block deletion used by BOTH the inspector's Delete button and
 * the global keyboard shortcut, so the two paths can never drift (one safe, one not). It
 * mirrors the ordering the inspector always used — close the inspector, cancel any run, then
 * optimistically delete (the store restores + toasts on backend failure via `RemovalSnapshot`)
 * — and only inserts the confirmation prompt in front of the mutation.
 *
 * A recurring-pipeline task owns its reused block + run history, so removing the schedule
 * deletes them server-side; that case deletes the schedule rather than orphaning it.
 */
export function useBlockDeletion() {
  const board = useBoardStore()
  const execution = useExecutionStore()
  const ui = useUiStore()
  const recurring = useRecurringPipelinesStore()
  const toast = useToast()
  const { confirm } = useConfirm()
  const { t } = useI18n()

  /** A service is any top-level frame; only services are archivable. */
  function isService(block: Block): boolean {
    return block.level === 'frame' && block.parentId === null
  }

  /** Unfinished (`status !== 'done'`) task descendants of a service — the delete blocker. */
  function unfinishedTaskCount(block: Block): number {
    return board.descendantsOf(block.id).filter((b) => b.level === 'task' && b.status !== 'done')
      .length
  }

  /**
   * Archive a service: hide it (restorable with no expiry) instead of deleting. Used both as the
   * explicit inspector action and as the automatic fallback when a service that still has
   * unfinished work can't be deleted.
   */
  async function archiveBlock(block: Block | undefined | null): Promise<boolean> {
    if (!block || !isService(block)) return false
    const ok = await confirm({
      title: t('panels.inspector.confirmArchive.title'),
      description: t('panels.inspector.confirmArchive.body', { name: block.title }),
      confirmLabel: t('panels.inspector.archiveService'),
      icon: 'i-lucide-archive',
    })
    if (!ok) return false
    ui.select(null)
    try {
      await board.archiveService(block.id)
      toast.add({
        title: t('board.toast.archived', { name: block.title }),
        icon: 'i-lucide-archive',
        color: 'neutral',
      })
    } catch (e) {
      toast.add({
        title: t('board.toast.archiveFailed'),
        description: e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
    }
    return true
  }

  /** Resolve the confirm title/body for a block, matching the inspector's delete-label kinds. */
  function copyFor(block: Block): { title: string; body: string } {
    const schedule = recurring.byBlock(block.id)
    const kind = schedule
      ? 'recurring'
      : block.level === 'task'
        ? 'task'
        : block.level === 'module'
          ? 'module'
          : 'service'
    const title = t(`panels.inspector.confirmDelete.${kind}.title`)
    // For a container (service/module) state the exact cascade size so the blast radius is
    // explicit — "and everything inside it" hides how many tasks/modules go with it.
    if (kind === 'module' || kind === 'service') {
      const count = board.descendantsOf(block.id).length
      if (count > 0) {
        return {
          title,
          body: t(
            'panels.inspector.confirmDelete.containerBodyWithCount',
            { name: block.title, count },
            count,
          ),
        }
      }
    }
    return { title, body: t(`panels.inspector.confirmDelete.${kind}.body`, { name: block.title }) }
  }

  async function deleteBlock(block: Block | undefined | null): Promise<boolean> {
    if (!block) return false
    // A service with unfinished work can't be deleted (the backend rejects it) — archive it
    // instead. Route straight to the archive flow so the user is never handed a dead-end error.
    if (isService(block) && unfinishedTaskCount(block) > 0) return archiveBlock(block)
    const { title, body } = copyFor(block)
    const ok = await confirm({
      title,
      description: body,
      variant: 'destructive',
      confirmLabel: t('common.delete'),
      icon: 'i-lucide-trash-2',
    })
    if (!ok) return false

    // Close the inspector right away; the stores hide the block optimistically and restore
    // it (with a toast) only if the backend delete fails.
    ui.select(null)
    const schedule = recurring.byBlock(block.id)
    if (schedule) {
      void recurring.remove(schedule.id)
      return true
    }
    // Cancelling the run is irreversible, so defer it into the delete's commit: it fires only
    // once the (deferred) delete actually lands, so an undo within the window leaves a running
    // pipeline intact rather than restoring a block whose run was already torn down. Target the
    // workspace the block was deleted from in case the user switched mid-window.
    void board.removeBlock(block.id, { onCommit: (wsId) => execution.cancel(block.id, wsId) })
    return true
  }

  return { deleteBlock, archiveBlock }
}
