import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useTaskLaneClassifier } from '~/composables/useTaskLaneClassifier'
import {
  assembleQueue,
  QUEUE_SECTION_BY_REASON,
  type QueueAssembly,
  type QueueEntry,
} from '~/utils/queueSections'

/**
 * Every task on the board, across every service, classified and filed into queue sections.
 *
 * The store-facing half of `utils/queueSections.ts`, and a STORE rather than a composable for the
 * reason the swimlane README gives: a workspace-wide derivation belongs on one owner, never on each
 * consumer. The queue view and the sidebar's attention counter both read it, and a composable
 * would walk the whole board once per reader on every change.
 *
 * It walks the service frames rather than `board.allTasks` so it holds exactly the tasks the
 * frames' own swimlanes hold (direct tasks plus those inside modules): a task the canvas shows
 * nowhere is not one the queue may claim needs you.
 */
export const useWorkspaceQueueStore = defineStore('workspaceQueue', () => {
  const board = useBoardStore()
  const { classify } = useTaskLaneClassifier()

  /** Narrow the queue to one service; null means all of them. Session-only, like a search box. */
  const serviceFilter = ref<string | null>(null)

  /** The service frames, for the filter. Board order, which is the order the canvas lays out. */
  const services = computed(() => board.frames.map((f) => ({ id: f.id, title: f.title })))

  /** Every task, classified, before the filter. The attention counter reads this, unfiltered. */
  const entries = computed<QueueEntry[]>(() => {
    const out: QueueEntry[] = []
    let order = 0
    for (const frame of board.frames) {
      const service = { id: frame.id, title: frame.title }
      for (const task of board.allTasksUnder(frame.id)) {
        out.push({ ...classify(task, order++).entry, service })
      }
    }
    return out
  })

  // `Date.now()` is read non-reactively, as the frame's Done lane does: the window is
  // re-evaluated on every board or run change, which on a live board is constantly.
  const queue = computed<QueueAssembly>(() =>
    assembleQueue(
      serviceFilter.value
        ? entries.value.filter((e) => e.service?.id === serviceFilter.value)
        : entries.value,
      Date.now(),
    ),
  )

  /**
   * The ONE attention count the preview shows: tasks a human must act on before an agent can
   * continue, across every service and regardless of the filter. A pull request waiting to merge
   * is not in it, because nothing is stalled behind it (see `utils/queueSections.ts`).
   */
  const needsYouCount = computed(
    () => entries.value.filter((e) => QUEUE_SECTION_BY_REASON[e.reason] === 'needs_you').length,
  )

  return { serviceFilter, services, queue, needsYouCount }
})
