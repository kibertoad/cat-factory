import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { Block } from '~/types/domain'
import { useTaskLaneClassifier, type ClassifiedEntry } from '~/composables/useTaskLaneClassifier'
import {
  assembleQueue,
  QUEUE_SECTION_BY_REASON,
  type QueueAssembly,
  type QueueEntry,
} from '~/utils/queueSections'

/**
 * Every task on the board, across every service, classified ONCE and filed into queue sections.
 *
 * The store-facing half of `utils/queueSections.ts`, and a STORE rather than a composable for the
 * reason the swimlane README gives: a workspace-wide derivation belongs on one owner, never on each
 * consumer. The queue view, the sidebar's attention counter AND every frame's swimlanes
 * (`useFrameLanes`) read the one classification here, so a board pays for each task's verdict once
 * per change, however many surfaces show it.
 *
 * It walks the service frames rather than `board.allTasks` so it holds exactly the tasks the
 * frames' own swimlanes hold (direct tasks plus those inside modules): a task the canvas shows
 * nowhere is not one the queue may claim needs you.
 */
export const useWorkspaceQueueStore = defineStore('workspaceQueue', () => {
  const board = useBoardStore()
  const execution = useExecutionStore()
  const workspace = useWorkspaceStore()
  const settings = useWorkspaceSettingsStore()
  const reviews = useReviewStage()
  const { classify } = useTaskLaneClassifier()

  /**
   * Each task's lane verdict, keyed by id. `order` is the task's position in its OWN frame, which
   * is the tiebreak the frame's lanes sort by.
   */
  const classified = computed(() => {
    const byId = new Map<string, ClassifiedEntry>()
    for (const frame of board.frames) {
      board
        .allTasksUnder(frame.id)
        .forEach((task, order) => byId.set(task.id, classify(task, order)))
    }
    return byId
  })

  /** Narrow the queue to one service; null means all of them. Session-only, like a search box. */
  const serviceFilter = ref<string | null>(null)
  // A filter belongs to the board it was set on: another board's service id matches nothing there.
  watch(
    () => workspace.workspaceId,
    () => (serviceFilter.value = null),
  )

  /** The service frames, for the filter. Board order, which is the order the canvas lays out. */
  const services = computed(() => board.frames.map((f) => ({ id: f.id, title: f.title })))

  /** The filter in force: a service deleted since it was picked narrows to nothing, so it lapses. */
  const activeFilter = computed(() =>
    serviceFilter.value && services.value.some((s) => s.id === serviceFilter.value)
      ? serviceFilter.value
      : null,
  )

  /** Show every service. The surfaces that send a person to the queue call it, so a filter set
   * earlier cannot hide the work they were sent to see. */
  function clearFilter() {
    serviceFilter.value = null
  }

  /**
   * A decision or approval on a block that is not a task in a service: an initiative's planning
   * run, or a frame-level run. The swimlanes have no lane for it, but it waits on a person all the
   * same, and the toolbar's decision count includes it, so the queue lists it under Needs you.
   */
  const parkedElsewhere = computed<QueueEntry[]>(() => {
    const ids = new Set<string>()
    for (const d of execution.openDecisions) ids.add(d.blockId)
    for (const a of execution.openApprovals) {
      if (!reviews.isBackground(a.agentKind, a.blockId)) ids.add(a.blockId)
    }
    const out: QueueEntry[] = []
    for (const id of ids) {
      if (classified.value.has(id)) continue
      const block = board.getBlock(id)
      if (!block) continue
      out.push(parkEntry(block, out.length))
    }
    return out
  })

  function parkEntry(block: Block, order: number): QueueEntry {
    const { entry } = classify(block, order)
    const service = board.serviceOf(block)
    return {
      ...entry,
      reason: execution.decisionsByBlock.has(block.id) ? 'decision' : 'approval',
      service: service ? { id: service.id, title: service.title } : null,
    }
  }

  /** Everything the queue lists, before the filter. The attention counter reads this, unfiltered. */
  const entries = computed<QueueEntry[]>(() => {
    const out: QueueEntry[] = []
    for (const frame of board.frames) {
      const service = { id: frame.id, title: frame.title }
      // `classified` walks these same frames and tasks, so every one of them has a verdict.
      for (const task of board.allTasksUnder(frame.id)) {
        out.push({ ...classified.value.get(task.id)!.entry, service })
      }
    }
    return out.concat(parkedElsewhere.value)
  })

  // `Date.now()` is read non-reactively, as the frame's Done lane does: the window is
  // re-evaluated on every board or run change, which on a live board is constantly.
  const queue = computed<QueueAssembly>(() =>
    assembleQueue(
      activeFilter.value
        ? entries.value.filter((e) => e.service?.id === activeFilter.value)
        : entries.value,
      Date.now(),
      {
        maxItems: settings.settings.doneLaneMaxItems,
        retentionDays: settings.settings.doneLaneRetentionDays,
      },
    ),
  )

  /**
   * The ONE attention count the queue view shows: what a human must act on before an agent can
   * continue, across every service and regardless of the filter. A pull request waiting to merge
   * is not in it, because nothing is stalled behind it (see `utils/queueSections.ts`).
   */
  const needsYouCount = computed(
    () => entries.value.filter((e) => QUEUE_SECTION_BY_REASON[e.reason] === 'needs_you').length,
  )

  return {
    classified,
    serviceFilter,
    activeFilter,
    clearFilter,
    services,
    queue,
    needsYouCount,
  }
})
