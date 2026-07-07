import { computed, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { useBoardStore } from '~/stores/board'
import { useExecutionStore } from '~/stores/execution'
import { useInitiativesStore } from '~/stores/initiative'
import { usePipelinesStore } from '~/stores/pipelines'
import { useUiStore } from '~/stores/ui'

/**
 * Shared planning affordances for an `initiative`-level block, used by BOTH the board card
 * (`InitiativeCard`) and the inspector (`InitiativeInspector`) so the two surfaces can never drift
 * on WHICH pipeline "Run planning" starts, WHEN the interview is awaiting the human, or the
 * optimistic start state. Keyed by the anchor block id; every value is reactive to the
 * board/initiative stores. Mirrors the repo's other extracted per-block composables
 * (`useReviewStage`, `useBlockQueries`).
 */
export function useInitiativePlanning(blockId: MaybeRefOrGetter<string>) {
  const board = useBoardStore()
  const initiatives = useInitiativesStore()
  const pipelines = usePipelinesStore()
  const execution = useExecutionStore()
  const ui = useUiStore()

  const block = computed(() => board.getBlock(toValue(blockId)))
  const initiative = computed(() => initiatives.forBlock(toValue(blockId)))

  // The planning pipeline runnable on this block: its preset descriptor's `planningPipelineId`
  // (the generic preset keeps `pl_initiative`). `planningPipelineIdFor` returns null for a named
  // preset that hasn't hydrated, so "Run planning" stays disabled rather than launching the wrong
  // (generic interviewer) pipeline. The engine's runnable guard still enforces that only an
  // initiative-shaped pipeline runs here.
  const planningPipeline = computed(() => {
    const id = initiatives.planningPipelineIdFor(initiative.value)
    return id ? pipelines.pipelines.find((p) => p.id === id) : undefined
  })

  /** A run already owns this block (its planning run's id lingers on the block). */
  const running = computed(() => !!block.value?.executionId)

  /**
   * The interviewer has PARKED the planning run for the human. Keyed purely on the interview's
   * parked `status` (`awaiting`) — NOT on whether individual questions are still blank — so the
   * "Answer planning questions" affordance stays available even after every question is filled but
   * before the human resumes. Gating on unanswered questions would hide the only path back to the
   * interview window once all are answered, stranding the still-parked run.
   */
  const awaitingAnswers = computed(() => initiative.value?.interview?.status === 'awaiting')

  /**
   * Optimistic start flag: flip true the instant "Run planning" is clicked, before the stream
   * pushes the block's `executionId` back. Cleared the moment `running` takes over (success) or the
   * start is refused/cancelled — never left dangling, which would otherwise strand the button
   * spinning once `running` later clears (e.g. after a cancel returns the block to `planned`).
   */
  const starting = ref(false)
  watch(running, (isRunning) => {
    if (isRunning) starting.value = false
  })

  async function runPlanning() {
    if (!planningPipeline.value || running.value || starting.value) return
    starting.value = true
    const started = await execution.start(toValue(blockId), planningPipeline.value)
    // On success `running` flips true and the watcher clears `starting`; on refusal/cancel the
    // store surfaces its own toast, so just revert the optimistic state here.
    if (!started) starting.value = false
  }

  /** Open the planning/interview window (selecting the block first so the inspector follows). */
  function openPlanning() {
    const id = toValue(blockId)
    ui.select(id)
    ui.openInitiativePlanning(id)
  }

  /** Open the initiative's tracker window (selecting the block first). */
  function openTracker() {
    const id = toValue(blockId)
    ui.select(id)
    ui.openInitiativeTracker(id)
  }

  return {
    planningPipeline,
    running,
    awaitingAnswers,
    starting,
    runPlanning,
    openPlanning,
    openTracker,
  }
}
