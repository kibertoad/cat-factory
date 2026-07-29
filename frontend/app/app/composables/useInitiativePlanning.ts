import { computed, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { useBoardStore } from '~/stores/board'
import { useExecutionStore } from '~/stores/execution'
import { useInitiativesStore } from '~/stores/initiative'
import { usePipelinesStore } from '~/stores/pipelines'
import { useUiStore } from '~/stores/ui'
import {
  INITIATIVE_INTERVIEWER_KIND,
  interviewGatePhase,
  interviewStepReached,
} from '~/utils/interviewGate'
import { parkedPlanReviewStepIndex } from '~/utils/initiative'

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
   * The live interview phase, derived from the entity AND the planning run (see
   * {@link interviewGatePhase} for why the run status is load-bearing).
   */
  const interviewPhase = computed(() => {
    const run = execution.getByBlock(toValue(blockId))
    return interviewGatePhase(
      initiative.value?.interview?.status,
      run?.status,
      interviewStepReached(run, INITIATIVE_INTERVIEWER_KIND),
    )
  })

  /**
   * The interviewer has PARKED the planning run for the human. NOT keyed on whether individual
   * questions are still blank — the "Answer planning questions" affordance must stay available
   * after every question is filled but before the human resumes, or the only path back to the
   * interview window disappears and the still-parked run is stranded.
   *
   * It IS keyed on the run not being mid-pass: after a continue/proceed the entity still reads
   * `awaiting` for the whole (slow) interviewer pass, so an entity-only reading keeps the card
   * pulsing and offering "Answer planning questions" over a question set that is already
   * submitted and about to be replaced. {@link interviewing} covers that window instead, and a
   * pass that fails takes the run out of `running`, so this comes back rather than stranding.
   */
  const awaitingAnswers = computed(() => interviewPhase.value === 'awaiting')

  /**
   * The planning run is mid-flight with nothing for the human to answer — either an interviewer
   * pass is running (`working`) or the run has not reached the interview yet (`preparing`, the
   * codebase analysis that now leads). BOTH phases, deliberately: this drives the card's and
   * inspector's "Planning in progress" button, which is the only route into the planning window
   * while a run owns the block. Narrowing it to `working` would drop that route for the whole of
   * the analysis and fall through to a "Run planning" button for a run already running.
   *
   * The two phases are distinguished INSIDE the window, where there is room to say which is which;
   * the affordance is the same either way.
   */
  const interviewing = computed(
    () => interviewPhase.value === 'working' || interviewPhase.value === 'preparing',
  )

  /**
   * The planning run parked on the PLANNER's human approval gate (`gate: true` on
   * `initiative-planner` in every planning pipeline) — the second thing a planning run asks a
   * human for, after the interview. Resolved as the run's parked planner step so both surfaces
   * can offer the review from the board, exactly as {@link awaitingAnswers} offers the interview.
   *
   * Without it the gate's only in-SPA route was the global notifications inbox, whose card is
   * dismissible and block-agnostic — so an initiative whose plan was waiting looked, on the board
   * and in its own inspector, exactly like one still thinking. Keyed on the planner kind rather
   * than "any pending approval" because the interviewer parks on `step.approval` too and is
   * already served by `awaitingAnswers`; routing it here would open the generic reader over an
   * interview the backend refuses to resolve that way.
   */
  const planReview = computed(() => {
    const instance = execution.getByBlock(toValue(blockId))
    if (!instance) return null
    const stepIndex = parkedPlanReviewStepIndex(instance.steps)
    return stepIndex === null ? null : { instanceId: instance.id, stepIndex }
  })

  /** Whether the drafted plan is waiting on the human's approve / request-changes / reject. */
  const awaitingPlanReview = computed(() => planReview.value !== null)

  /** Open the parked planner step's review surface (selecting the block so the inspector follows). */
  function reviewPlan() {
    const parked = planReview.value
    if (!parked) return
    ui.select(toValue(blockId))
    ui.openStepDetail(parked.instanceId, parked.stepIndex)
  }

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
    interviewPhase,
    awaitingAnswers,
    interviewing,
    awaitingPlanReview,
    starting,
    runPlanning,
    openPlanning,
    openTracker,
    reviewPlan,
  }
}
