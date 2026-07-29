import { computed, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { useBoardStore } from '~/stores/board'
import { useExecutionStore } from '~/stores/execution'
import { useInitiativesStore } from '~/stores/initiative'
import { usePipelinesStore } from '~/stores/pipelines'
import { useUiStore } from '~/stores/ui'
import { agentKindMeta } from '~/utils/catalog'
import { selectPlanApproval, type InitiativeAttentionKind } from '~/utils/initiative'
import { interviewGatePhase } from '~/utils/interviewGate'

/**
 * What an initiative's planning run needs from a human right now: which kind of park it is (the
 * card + inspector resolve its icon/label from the shared `INITIATIVE_ATTENTION_*` maps, so the
 * two surfaces word one park identically), and the action that opens the surface which can
 * RESOLVE it — the step's own dedicated window, via `dispatchStepView`.
 */
export interface InitiativeAttention {
  kind: InitiativeAttentionKind
  open: () => void
}

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
  const interviewPhase = computed(() =>
    interviewGatePhase(
      initiative.value?.interview?.status,
      execution.getByBlock(toValue(blockId))?.status,
    ),
  )

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

  /** An interviewer pass is running — the human is waiting on the planner, not the reverse. */
  const interviewing = computed(() => interviewPhase.value === 'working')

  /**
   * The planner's parked plan-approval gate, or undefined. `pl_initiative` gates the planner step
   * (`{ kind: 'initiative-planner', gate: true }`), so a finished planning pass PARKS the run on a
   * pending `step.approval` until a human accepts the plan — the state this composable's other
   * flags deliberately do NOT cover (the interview has converged, and the run is `blocked`, so
   * `awaitingAnswers` and `interviewing` are both false and the card would otherwise sit on a
   * disabled, spinning "Run planning").
   *
   * The interviewer's own park is excluded by the window its step routes to (see
   * {@link selectPlanApproval}), not by the interview phase, so the two affordances can never both
   * claim one park.
   */
  const planApproval = computed(() =>
    selectPlanApproval(
      execution.approvalsByBlock.get(toValue(blockId)) ?? [],
      (kind) => agentKindMeta(kind).resultView,
    ),
  )

  /** An agent-raised decision on the planning run (the analyst is an ordinary agent step). */
  const pendingDecision = computed(() => execution.decisionsByBlock.get(toValue(blockId))?.[0])

  /**
   * The single thing a human has to act on, or null — the initiative dual of a task card's
   * `attention`. A decision outranks an approval (a step never holds both; this is just a stable
   * order). Opening always goes through the step-view dispatch, so the park lands in the window
   * that can RESOLVE it (the plan gate → the tracker window's plan-review rail) rather than a
   * generic panel that would refuse it.
   */
  const attention = computed<InitiativeAttention | null>(() => {
    const id = toValue(blockId)
    const decision = pendingDecision.value
    if (decision) {
      return {
        kind: 'decision',
        open: () => {
          ui.select(id)
          ui.openDecision(decision.instanceId, decision.decision.id)
        },
      }
    }
    const approval = planApproval.value
    if (approval) {
      return {
        kind: 'approval',
        open: () => {
          ui.select(id)
          ui.openApprovalDetail(approval.instanceId, approval.approval.id)
        },
      }
    }
    return null
  })

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
    planApproval,
    pendingDecision,
    attention,
    starting,
    runPlanning,
    openPlanning,
    openTracker,
  }
}
