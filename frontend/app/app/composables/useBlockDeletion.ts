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
  const { confirm } = useConfirm()
  const { t } = useI18n()

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
    execution.cancel(block.id)
    void board.removeBlock(block.id)
    return true
  }

  return { deleteBlock }
}
