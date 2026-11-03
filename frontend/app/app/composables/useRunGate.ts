import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { useBoardStore } from '~/stores/board'

/**
 * Whether the signed-in user may start a run on a task now, and if not, why.
 *
 * Shared by the inspector's Run menu and the focus view's picker so both lock on the same facts
 * and name the same reason. A locked trigger must say WHY: a read-only viewer never starts a run
 * (the backend refuses it anyway), and a task runs only once every dependency has merged.
 */
export function useRunGate(blockId: MaybeRefOrGetter<string | undefined>) {
  const board = useBoardStore()
  const access = useWorkspaceAccess()
  const { t } = useI18n()

  const block = computed(() => {
    const id = toValue(blockId)
    return id ? board.getBlock(id) : undefined
  })
  const runnable = computed(() => (block.value ? board.isRunnable(block.value.id) : false))
  const unmetDepTitles = computed(() =>
    block.value?.level === 'task' ? board.unmetDeps(block.value.id).map((b) => b.title) : [],
  )

  const blockedReason = computed(() => {
    if (!access.canExecuteRuns.value) return t('access.noRunExecute')
    return unmetDepTitles.value.length
      ? t(
          'panels.inspector.runBlocked',
          { count: unmetDepTitles.value.length, names: unmetDepTitles.value.join(', ') },
          unmetDepTitles.value.length,
        )
      : null
  })
  const canRun = computed(() => runnable.value && access.canExecuteRuns.value)

  return { canRun, blockedReason }
}
