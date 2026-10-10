import { useExecutionStore } from '~/stores/execution'
import { isTesterKind } from '~/utils/catalog'
import type { ExecutionInstance, PipelineStep } from '~/types/domain'

/**
 * The RUN-SCOPED window openers: entry points that know only which run to open, and have to
 * resolve WHICH step of it the caller means before dispatching.
 *
 * They share one shape (find the step, bail if the run has none, open its window) and one hazard:
 * a pipeline may carry the same agent kind more than once, so "the first matching step" is the
 * wrong answer for every one of them. Each resolver states which of its candidates is the one a
 * human was pointed at (the step parked awaiting a decision, the one that actually reported), and
 * the callers that DO know the index still pass it and skip the resolution entirely.
 *
 * Extracted from `resultViews.ts` when the `test-evidence` opener pushed that factory over its
 * per-function line budget: the budget is a split trigger, and this is the cohesive seam it named.
 * Purely a move plus the new opener; the store's public surface is unchanged.
 */
export interface RunStepOpenerDeps {
  /** Open a step's bespoke window through the universal routing seam. */
  dispatchStepView: (instanceId: string, stepIndex: number) => void
  /** Set the result-view overlay directly, for a window the routing seam does not select. */
  setResultView: (view: string, instance: ExecutionInstance, stepIndex: number) => void
}

/** Index of the first step matching `predicate`, or -1. */
function indexOf(instance: ExecutionInstance, predicate: (step: PipelineStep) => boolean): number {
  return instance.steps.findIndex(predicate)
}

export function createRunStepOpeners(deps: RunStepOpenerDeps) {
  /**
   * Resolve the run, then the step index (the caller's when given, else `resolve`'s), then hand
   * both to `open`. A run the store has not hydrated, or a pipeline with no candidate step, is a
   * silent no-op: these are notification and deep-link entry points, and failing loudly at one
   * would strand a user on a blank overlay.
   */
  function withStep(
    instanceId: string,
    stepIndex: number | null,
    resolve: (instance: ExecutionInstance) => number,
    open: (instance: ExecutionInstance, idx: number) => void,
  ): void {
    const instance = useExecutionStore().getInstance(instanceId)
    if (!instance) return
    const idx = stepIndex ?? resolve(instance)
    if (idx < 0) return
    open(instance, idx)
  }

  // Open the Follow-up companion window for a run's Coder step (the blinking chip + the
  // `followup_pending` notification). Resolves the Coder step index from the run when not
  // given, so callers that only know the run can still open it.
  function openFollowUps(instanceId: string, stepIndex: number | null = null) {
    withStep(
      instanceId,
      stepIndex,
      // A pipeline may carry more than one follow-up-enabled Coder step, so don't blindly pick
      // the first when no index is given: prefer the step that still has undecided items (the
      // one the run is parked on), else the current step, else the first enabled one.
      (instance) => {
        const pending = indexOf(
          instance,
          (s) => !!s.followUps?.enabled && s.followUps.items.some((i) => i.status === 'pending'),
        )
        if (pending >= 0) return pending
        const current = instance.steps[instance.currentStep]
        if (current?.followUps?.enabled) return instance.currentStep
        return indexOf(instance, (s) => !!s.followUps?.enabled)
      },
      (instance, idx) => deps.setResultView('follow-ups', instance, idx),
    )
  }

  // Open the implementation-fork decision window for a run's coder step (from the inspector /
  // pipeline chip / `fork_decision_pending` notification). Resolves the coder step index from
  // the run when not given, preferring the step parked awaiting a choice.
  function openForkDecision(instanceId: string, stepIndex: number | null = null) {
    withStep(
      instanceId,
      stepIndex,
      (instance) => {
        const awaiting = indexOf(
          instance,
          (s) => s.agentKind === 'coder' && s.forkDecision?.status === 'awaiting_choice',
        )
        if (awaiting >= 0) return awaiting
        const current = instance.steps[instance.currentStep]
        if (current?.agentKind === 'coder' && current.forkDecision) return instance.currentStep
        return indexOf(instance, (s) => s.agentKind === 'coder' && !!s.forkDecision)
      },
      (instance, idx) => deps.setResultView('fork-decision', instance, idx),
    )
  }

  // Open the generated-candidate comparison window for a run's binary-output step (from the
  // pipeline chip / inspector rail / step overlay). Resolves the step index from the run when not
  // given, preferring the step parked awaiting a choice.
  //
  // Resolved by the CANDIDATE STATE rather than by an agent kind, unlike its neighbours: any kind
  // carrying the `binary-output` trait can run a comparison, and a deployment's own kinds are
  // exactly the ones a hard-coded kind list here would never name.
  function openBinaryCandidates(instanceId: string, stepIndex: number | null = null) {
    withStep(
      instanceId,
      stepIndex,
      (instance) => {
        const awaiting = indexOf(instance, (s) => s.binaryCandidates?.status === 'awaiting_choice')
        if (awaiting >= 0) return awaiting
        const current = instance.steps[instance.currentStep]
        if (current?.binaryCandidates) return instance.currentStep
        return indexOf(instance, (s) => !!s.binaryCandidates)
      },
      (instance, idx) => deps.setResultView('binary-candidates', instance, idx),
    )
  }

  // Open the PR deep-review window for a run's `pr-reviewer` step (from the `pr_review_ready`
  // notification / the step). Resolves the step index from the run when not given, preferring
  // the step parked awaiting a finding selection.
  function openPrReview(instanceId: string, stepIndex: number | null = null) {
    withStep(
      instanceId,
      stepIndex,
      (instance) => {
        const awaiting = indexOf(
          instance,
          (s) => s.agentKind === 'pr-reviewer' && s.prReview?.status === 'awaiting_selection',
        )
        if (awaiting >= 0) return awaiting
        const current = instance.steps[instance.currentStep]
        if (current?.agentKind === 'pr-reviewer' && current.prReview) return instance.currentStep
        return indexOf(instance, (s) => s.agentKind === 'pr-reviewer' && !!s.prReview)
      },
      (instance, idx) => deps.setResultView('pr-review', instance, idx),
    )
  }

  // Open the BUG-FISHING expedition window for a run's `bug-fisher` step (from the
  // `bug_fishing_triage` notification / the step). Resolves the step index from the run when not
  // given, preferring the step parked awaiting triage.
  function openBugFishing(instanceId: string, stepIndex: number | null = null) {
    withStep(
      instanceId,
      stepIndex,
      (instance) => {
        const awaiting = indexOf(
          instance,
          (s) => s.agentKind === 'bug-fisher' && s.bugFishing?.status === 'awaiting_triage',
        )
        if (awaiting >= 0) return awaiting
        const current = instance.steps[instance.currentStep]
        if (current?.agentKind === 'bug-fisher' && current.bugFishing) return instance.currentStep
        return indexOf(instance, (s) => s.agentKind === 'bug-fisher' && !!s.bugFishing)
      },
      (instance, idx) => deps.setResultView('bug-fishing', instance, idx),
    )
  }

  // Open the Tester's result window for a run, where the screenshots and per-area outcomes it
  // captured are rendered. The entry point is the `test-evidence` deep link the engine puts in
  // every PR verification report's environment-lifecycle section, so the caller only ever knows
  // the run.
  function openTestEvidence(instanceId: string) {
    withStep(
      instanceId,
      null,
      // Prefer the tester step that actually REPORTED: a pipeline may carry more than one, and
      // the later one describes the PR as it stands. Falling back to the first tester step opens
      // the window on its "not run yet" state, which beats the link going nowhere.
      (instance) => {
        const candidates = instance.steps
          .map((s, i) => ({ s, i }))
          .filter(({ s }) => isTesterKind(s.agentKind))
        const reported = candidates.filter(({ s }) => s.test?.lastReport)
        return (reported.at(-1) ?? candidates[0])?.i ?? -1
      },
      // Routed through the universal dispatch rather than a fixed view id: a tester step running
      // as a consensus panel opens the Consensus Session window instead, and this entry point
      // must not override that.
      (_instance, idx) => deps.dispatchStepView(instanceId, idx),
    )
  }

  return {
    openFollowUps,
    openForkDecision,
    openBinaryCandidates,
    openPrReview,
    openBugFishing,
    openTestEvidence,
  }
}
