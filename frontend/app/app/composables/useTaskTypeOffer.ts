import { computed, watch, type Ref } from 'vue'
import type { ProjectKindTaskType } from '@cat-factory/contracts'
import type { Block, CreateTaskType } from '~/types/domain'

/** A task type the add-task picker offers; `recurring` is created through the schedule flow. */
export type TaskTypeChoice = CreateTaskType | 'recurring'

const DOC_REPO_TYPES: ReadonlySet<string> = new Set(['document', 'spike'])

/**
 * Which task types a container takes, as the add-task picker offers them, with the selection
 * kept valid as the container changes. Each rule mirrors a server-side refusal:
 *
 *  - a document repository only authors documents and spikes;
 *  - under a project root, the project's kind decides which task types it takes, and never
 *    `recurring`: a schedule attaches to a service frame, which a project is not.
 *
 * `defaultTaskType` is the type a fresh form opens on, and `projectEntry` the project kind's entry
 * for a type, whose `defaultPipelineId` is the pipeline the server starts such a task with.
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

  /** The project kind's entries, in the kind's order, when the container is a project root. */
  const projectEntries = computed<ProjectKindTaskType[] | undefined>(() => {
    const c = container.value
    if (c?.level !== 'project') return undefined
    const kind = projects.kindOf(projects.byRootBlock[c.id])
    return (kind?.taskTypes ?? []).filter((entry) => entry.taskType !== 'recurring')
  })

  /** The task types this container restricts the picker to; undefined offers every one. */
  const offered = computed<ReadonlySet<string> | undefined>(() => {
    const entries = projectEntries.value
    if (entries) return new Set(entries.map((entry) => entry.taskType))
    return isDocRepo.value ? DOC_REPO_TYPES : undefined
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
    const set = offered.value
    return set ? all.filter((k) => set.has(k.value)) : all
  })

  /** Deployment-registered task types, filtered by the same rules as the built-ins. */
  const customTaskTypes = computed(() => {
    const set = offered.value
    return set
      ? taskTypesStore.customTaskTypes.filter((tt) => set.has(tt.taskType))
      : taskTypesStore.customTaskTypes
  })

  /**
   * The type a fresh form opens on: `feature` where everything is offered, `document` in a
   * document repository, and under a project the first of its kind's types the picker can show.
   */
  const defaultTaskType = computed<TaskTypeChoice>(() => {
    const entries = projectEntries.value
    if (entries) {
      const shown = new Set<string>([
        ...taskTypeChoices.value.map((choice) => choice.value),
        ...customTaskTypes.value.map((tt) => tt.taskType),
      ])
      const first = entries.find((entry) => shown.has(entry.taskType))
      return (first?.taskType as TaskTypeChoice | undefined) ?? 'feature'
    }
    return isDocRepo.value ? 'document' : 'feature'
  })

  function projectEntry(type: TaskTypeChoice): ProjectKindTaskType | undefined {
    return projectEntries.value?.find((entry) => entry.taskType === type)
  }

  watch(
    offered,
    (set) => {
      if (set && !set.has(taskType.value)) taskType.value = defaultTaskType.value
    },
    { immediate: true },
  )

  return {
    frame,
    isDocRepo,
    isProject: computed(() => projectEntries.value !== undefined),
    taskTypeChoices,
    customTaskTypes,
    defaultTaskType,
    projectEntry,
  }
}
