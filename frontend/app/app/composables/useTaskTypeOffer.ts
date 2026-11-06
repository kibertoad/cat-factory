import { computed, watch, type Ref } from 'vue'
import type { Block, CreateTaskType } from '~/types/domain'

/** A task type the add-task picker offers; `recurring` is created through the schedule flow. */
export type TaskTypeChoice = CreateTaskType | 'recurring'

/**
 * Which task types a container takes, as the add-task picker offers them, with the selection
 * kept valid as the container changes. Each rule mirrors a server-side refusal:
 *
 *  - a document repository only authors documents and spikes;
 *  - under a project root, the project's kind decides which task types it takes.
 */
export function useTaskTypeOffer(container: Ref<Block | undefined>, taskType: Ref<TaskTypeChoice>) {
  const { t } = useI18n()
  const board = useBoardStore()
  const projects = useProjectsStore()
  const taskTypesStore = useTaskTypesStore()

  /** The enclosing service frame: the container itself, else its parent (a module's). */
  const frame = computed(() => {
    const c = container.value
    if (!c) return undefined
    return c.level === 'frame' ? c : c.parentId ? board.getBlock(c.parentId) : undefined
  })
  const isDocRepo = computed(() => frame.value?.type === 'document')

  const projectOffered = computed<Set<string> | undefined>(() => {
    const c = container.value
    if (c?.level !== 'project') return undefined
    const kind = projects.kindOf(projects.byRootBlock[c.id])
    return new Set(kind?.taskTypes.map((entry) => entry.taskType) ?? [])
  })

  const taskTypeChoices = computed<{ value: TaskTypeChoice; label: string; icon: string }[]>(() => {
    const all: { value: TaskTypeChoice; label: string; icon: string }[] = [
      { value: 'feature', label: t('board.addTask.types.feature'), icon: 'i-lucide-sparkles' },
      { value: 'bug', label: t('board.addTask.types.bug'), icon: 'i-lucide-bug' },
      { value: 'bug-fishing', label: t('board.addTask.types.bugFishing'), icon: 'i-lucide-fish' },
      { value: 'document', label: t('board.addTask.types.document'), icon: 'i-lucide-file-text' },
      { value: 'spike', label: t('board.addTask.types.spike'), icon: 'i-lucide-flask-conical' },
      { value: 'review', label: t('board.addTask.types.review'), icon: 'i-lucide-clipboard-check' },
      { value: 'ralph', label: t('board.addTask.types.ralph'), icon: 'i-lucide-infinity' },
      { value: 'media', label: t('board.addTask.types.media'), icon: 'i-lucide-image-plus' },
      { value: 'recurring', label: t('board.addTask.types.recurring'), icon: 'i-lucide-repeat' },
    ]
    const offered = projectOffered.value
    if (offered) return all.filter((k) => offered.has(k.value))
    return isDocRepo.value ? all.filter((k) => k.value === 'document' || k.value === 'spike') : all
  })

  /** Deployment-registered task types, filtered by the same rules as the built-ins. */
  const customTaskTypes = computed(() => {
    if (isDocRepo.value) return []
    const offered = projectOffered.value
    return offered
      ? taskTypesStore.customTaskTypes.filter((tt) => offered.has(tt.taskType))
      : taskTypesStore.customTaskTypes
  })

  watch(
    isDocRepo,
    (doc) => {
      if (doc && taskType.value !== 'document' && taskType.value !== 'spike') {
        taskType.value = 'document'
      }
    },
    { immediate: true },
  )
  watch(
    projectOffered,
    (offered) => {
      const first = offered && [...offered][0]
      if (first && !offered.has(taskType.value)) taskType.value = first as TaskTypeChoice
    },
    { immediate: true },
  )

  return { frame, isDocRepo, taskTypeChoices, customTaskTypes }
}
