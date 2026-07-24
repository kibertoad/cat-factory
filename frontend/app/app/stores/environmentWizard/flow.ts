import type { WizardContext } from './context'
import { cloneRecipe } from './context'

/**
 * The wizard's per-frame lifecycle + recommendation actions: reset/target a frame, (re)seed the
 * working recipe from the merged recommendation, run checkout-free detection, fire the analyst
 * pipeline, and fold a ready analyst draft in. Closes over the shared {@link WizardContext};
 * behaviour is identical to the former in-closure functions (a size-only extraction). The internal
 * `resetFlowState` / `seedFromMerged` helpers are not exposed (they were never part of the public
 * store shape).
 */
export function createFlowActions(ctx: WizardContext) {
  const {
    github,
    infra,
    execution,
    frameId,
    detecting,
    detectError,
    recommendation,
    analysisRequested,
    analysisError,
    recipe,
    composeService,
    preflightRunning,
    preflightResults,
    preflightError,
    handlerLabel,
    exposedPort,
    saving,
    saveError,
    saved,
    trialing,
    trialError,
    trialStarted,
    repoContext,
    analysisPipeline,
    merged,
  } = ctx

  /**
   * Clear all per-frame flow state (detection, working recipe, preflight, save, trial). Shared by
   * `beginForFrame` so re-targeting the wizard at a different frame can't leave a prior frame's
   * `saved`/`composeService`/`exposedPort`/results behind (which would make an unsaved frame render
   * the green "saved" confirmation + offer a trial provision).
   */
  function resetFlowState() {
    detecting.value = false
    detectError.value = false
    recommendation.value = null
    analysisRequested.value = false
    analysisError.value = false
    recipe.value = {}
    composeService.value = ''
    preflightRunning.value = false
    preflightResults.value = null
    preflightError.value = null
    handlerLabel.value = 'Docker Compose'
    exposedPort.value = 80
    saving.value = false
    saveError.value = null
    saved.value = false
    trialing.value = false
    trialError.value = null
    trialStarted.value = false
  }

  /** Re-seed the working recipe from the current merge (detector-only, or +analyst after apply). */
  function seedFromMerged() {
    if (merged.value) recipe.value = cloneRecipe(merged.value.recipe)
    // Default the exposed service to the detector's recommended compose service, when known.
    const recommended = recommendation.value?.composeServiceCandidates?.find((c) => c.recommended)
    if (recommended && !composeService.value) composeService.value = recommended.service
  }

  /** Run checkout-free detection for the frame's repo (non-binding; seeds the working recipe). */
  async function detect() {
    const target = repoContext.value
    if (!target) {
      detectError.value = true
      return
    }
    const repo = github.repoFor(target.githubId)
    if (!repo) {
      detectError.value = true
      return
    }
    detecting.value = true
    detectError.value = false
    try {
      const rec = await infra.detectProvisioning({
        owner: repo.owner,
        repo: repo.name,
        ...(target.directory ? { directory: target.directory } : {}),
        prefer: 'docker-compose',
      })
      recommendation.value = rec
      // Seed the exposed port + build flag from the detected provisioning where present.
      seedFromMerged()
    } catch {
      detectError.value = true
    } finally {
      detecting.value = false
    }
  }

  /**
   * Seed the data layer for a frame the journey's review step is entering. The journey owns
   * navigation, so this is idempotent by frame: it (re)seeds + detects only when the target frame
   * actually changes, so back-navigating to the review step (or a resume) does NOT clobber the
   * operator's in-progress recipe edits. Selecting a different frame resets the flow for it.
   */
  function beginForFrame(id: string | null) {
    if (frameId.value === id) return
    frameId.value = id
    resetFlowState()
    if (id) void detect()
  }

  /** Fire the analyst-only pipeline against the frame (mirrors how bootstrap runs pl_blueprint). */
  async function startAnalysis() {
    const id = frameId.value
    const pipeline = analysisPipeline.value
    if (!id || !pipeline) {
      analysisError.value = true
      return
    }
    analysisError.value = false
    try {
      await execution.start(id, pipeline)
      analysisRequested.value = true
    } catch {
      analysisError.value = true
    }
  }

  /** Fold the (now-ready) analyst draft into the working recipe (re-seed from the merge). */
  function applyAnalystDraft() {
    seedFromMerged()
  }

  return { beginForFrame, detect, startAnalysis, applyAnalystDraft }
}
