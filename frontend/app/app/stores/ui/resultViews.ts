import { ref } from 'vue'
import { useExecutionStore } from '~/stores/execution'
import { agentKindMeta } from '~/utils/catalog'

/**
 * The step-inspection / result-view slice of the UI store: the dedicated result-view overlay
 * (`resultView`, driven by the universal `dispatchStepView` seam), the generic step-detail
 * panel (`stepDetail`), the LLM per-call observability panel, and the Kaizen screen — plus the
 * open/close actions every board + inspector entry point uses. Split out of the modal + nav
 * state per refactoring candidate #4; the `dispatchStepView`/`ui.resultView` seam is preserved
 * intact, so adding a bespoke window for a new agent is still just declaring `resultView` +
 * registering a component. Composed into {@link useUiStore} with the same public names.
 */
export function createUiResultViews() {
  // Dedicated result-view overlay: a step whose agent kind declares a bespoke
  // visualization (via the archetype's `resultView`) opens here instead of the generic
  // prose step-detail panel. `view` is the registry id (e.g. 'requirements-review');
  // `blockId` is always set; `instanceId`/`stepIndex` are present on the pipeline path and
  // null for an off-path open (e.g. the inspector's pre-start requirements review).
  const resultView = ref<{
    view: string
    blockId: string
    instanceId: string | null
    stepIndex: number | null
    // The brainstorm dialogue stage, set only when `view === 'brainstorm'` (its two agent
    // kinds share one window). Derived from the step's agent kind on the pipeline path, or
    // passed explicitly on an off-path open.
    stage?: 'requirements' | 'architecture'
  } | null>(null)

  // Agent step-detail overlay: which pipeline step (a run instance + step index)
  // a human is inspecting, or null when closed. The overlay resolves the step
  // from the execution store so it stays live; it shows the step's metadata
  // (model, state, progress, subtasks, …) and — when the agent produced prose —
  // a reader for it (ToC + collapsible sections).
  const stepDetail = ref<{ instanceId: string; stepIndex: number } | null>(null)

  // LLM observability panel: which run (execution instance) a human is inspecting
  // the per-call model activity for, or null when closed. The panel loads the full
  // per-call detail from the observability store on open.
  const observabilityInstanceId = ref<string | null>(null)

  // The Kaizen screen (grading history + verified-combo library), a full-panel overlay
  // opened from the sidebar. Distinct from the per-run grading status shown in run details.
  const kaizenScreenOpen = ref(false)

  /**
   * Open a pending approval gate in the conclusions reader (approval mode). Resolves
   * the step index from the gate id so every board/inspector entry point can keep
   * passing the approval id it already has.
   */
  function openApprovalDetail(instanceId: string, approvalId: string) {
    const execution = useExecutionStore()
    const instance = execution.getInstance(instanceId)
    const idx = instance?.steps.findIndex((s) => s.approval?.id === approvalId) ?? -1
    if (idx >= 0) dispatchStepView(instanceId, idx)
  }

  /**
   * Open a pipeline step: route it to its agent kind's DEDICATED result window when the
   * archetype declares one (the universal `resultView` seam), else the generic prose
   * step-detail panel. This is the single dispatch every board/inspector entry point uses,
   * so adding a bespoke window for a new agent is just declaring `resultView` + registering
   * a component — no caller changes.
   */
  function dispatchStepView(instanceId: string, stepIndex: number) {
    const execution = useExecutionStore()
    const instance = execution.getInstance(instanceId)
    const step = instance?.steps[stepIndex]
    // A step that actually ran the consensus mechanism opens the dedicated Consensus
    // Session window, regardless of its kind's normal result view — consensus is an
    // execution MODE on a kind, not a kind, so it can't be a static archetype `resultView`.
    const view = step?.consensus?.enabled
      ? 'consensus-session'
      : step
        ? agentKindMeta(step.agentKind).resultView
        : undefined
    if (view && instance) {
      // The brainstorm window is shared by both stages; carry which one from the step's kind.
      const stage =
        view === 'brainstorm'
          ? step?.agentKind === 'architecture-brainstorm'
            ? 'architecture'
            : 'requirements'
          : undefined
      resultView.value = {
        view,
        blockId: instance.blockId,
        instanceId,
        stepIndex,
        ...(stage ? { stage } : {}),
      }
      return
    }
    stepDetail.value = { instanceId, stepIndex }
  }

  function openRequirementReview(blockId: string) {
    resultView.value = { view: 'requirements-review', blockId, instanceId: null, stepIndex: null }
  }
  function openClarityReview(blockId: string) {
    resultView.value = { view: 'clarity-review', blockId, instanceId: null, stepIndex: null }
  }
  function openBrainstorm(blockId: string, stage: 'requirements' | 'architecture') {
    resultView.value = { view: 'brainstorm', blockId, instanceId: null, stepIndex: null, stage }
  }
  // Open the service-spec window for a service frame (the inspector's "View Requirements").
  function openServiceSpec(blockId: string) {
    resultView.value = { view: 'service-spec', blockId, instanceId: null, stepIndex: null }
  }
  // Open the initiative tracker window for an initiative block (board card / inspector).
  function openInitiativeTracker(blockId: string) {
    resultView.value = { view: 'initiative-tracker', blockId, instanceId: null, stepIndex: null }
  }
  // Open the interactive-planning Q&A window for an initiative block (inspector / card,
  // when the interviewer has parked the planning run with pending questions).
  function openInitiativePlanning(blockId: string) {
    resultView.value = { view: 'initiative-planning', blockId, instanceId: null, stepIndex: null }
  }
  // Open the Follow-up companion window for a run's Coder step (the blinking chip + the
  // `followup_pending` notification). Resolves the Coder step index from the run when not
  // given, so callers that only know the run can still open it.
  function openFollowUps(instanceId: string, stepIndex: number | null = null) {
    const execution = useExecutionStore()
    const instance = execution.getInstance(instanceId)
    if (!instance) return
    // A pipeline may carry more than one follow-up-enabled Coder step, so don't blindly pick
    // the first when no index is given: prefer the step that still has undecided items (the
    // one the run is parked on), else the current step, else the first enabled one.
    const resolveIdx = () => {
      const pending = instance.steps.findIndex(
        (s) => s.followUps?.enabled && s.followUps.items.some((i) => i.status === 'pending'),
      )
      if (pending >= 0) return pending
      const current = instance.steps[instance.currentStep]
      if (current?.followUps?.enabled) return instance.currentStep
      return instance.steps.findIndex((s) => s.followUps?.enabled)
    }
    const idx = stepIndex ?? resolveIdx()
    if (idx < 0) return
    resultView.value = {
      view: 'follow-ups',
      blockId: instance.blockId,
      instanceId,
      stepIndex: idx,
    }
  }
  // Open the implementation-fork decision window for a run's coder step (from the inspector /
  // pipeline chip / `fork_decision_pending` notification). Resolves the coder step index from
  // the run when not given, preferring the step parked awaiting a choice.
  function openForkDecision(instanceId: string, stepIndex: number | null = null) {
    const execution = useExecutionStore()
    const instance = execution.getInstance(instanceId)
    if (!instance) return
    const resolveIdx = () => {
      const awaiting = instance.steps.findIndex(
        (s) => s.agentKind === 'coder' && s.forkDecision?.status === 'awaiting_choice',
      )
      if (awaiting >= 0) return awaiting
      const current = instance.steps[instance.currentStep]
      if (current?.agentKind === 'coder' && current.forkDecision) return instance.currentStep
      return instance.steps.findIndex((s) => s.agentKind === 'coder' && s.forkDecision)
    }
    const idx = stepIndex ?? resolveIdx()
    if (idx < 0) return
    resultView.value = {
      view: 'fork-decision',
      blockId: instance.blockId,
      instanceId,
      stepIndex: idx,
    }
  }
  // Open the PR deep-review window for a run's `pr-reviewer` step (from the `pr_review_ready`
  // notification / the step). Resolves the step index from the run when not given, preferring
  // the step parked awaiting a finding selection.
  function openPrReview(instanceId: string, stepIndex: number | null = null) {
    const execution = useExecutionStore()
    const instance = execution.getInstance(instanceId)
    if (!instance) return
    const resolveIdx = () => {
      const awaiting = instance.steps.findIndex(
        (s) => s.agentKind === 'pr-reviewer' && s.prReview?.status === 'awaiting_selection',
      )
      if (awaiting >= 0) return awaiting
      const current = instance.steps[instance.currentStep]
      if (current?.agentKind === 'pr-reviewer' && current.prReview) return instance.currentStep
      return instance.steps.findIndex((s) => s.agentKind === 'pr-reviewer' && s.prReview)
    }
    const idx = stepIndex ?? resolveIdx()
    if (idx < 0) return
    resultView.value = {
      view: 'pr-review',
      blockId: instance.blockId,
      instanceId,
      stepIndex: idx,
    }
  }
  function closeResultView() {
    resultView.value = null
  }
  // Kept name for the requirements window's close handler.
  const closeRequirementReview = closeResultView
  function openStepDetail(instanceId: string, stepIndex: number) {
    dispatchStepView(instanceId, stepIndex)
  }
  function closeStepDetail() {
    stepDetail.value = null
  }
  function openObservability(instanceId: string) {
    observabilityInstanceId.value = instanceId
  }
  function closeObservability() {
    observabilityInstanceId.value = null
  }
  function openKaizen() {
    kaizenScreenOpen.value = true
  }
  function closeKaizen() {
    kaizenScreenOpen.value = false
  }

  return {
    resultView,
    stepDetail,
    observabilityInstanceId,
    kaizenScreenOpen,
    openApprovalDetail,
    openRequirementReview,
    openClarityReview,
    openBrainstorm,
    openServiceSpec,
    openInitiativeTracker,
    openInitiativePlanning,
    openFollowUps,
    openForkDecision,
    openPrReview,
    closeResultView,
    closeRequirementReview,
    openStepDetail,
    closeStepDetail,
    openObservability,
    closeObservability,
    openKaizen,
    closeKaizen,
  }
}
