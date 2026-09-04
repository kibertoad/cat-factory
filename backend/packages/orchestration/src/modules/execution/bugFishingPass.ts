import {
  BUG_FISHING_TERRITORY_CONTEXT_FILE,
  renderBugFishingTerritoryContext,
} from '@cat-factory/agents'
import type { BugFishingPhase, BugFishingStepState, InjectedContextFile } from '@cat-factory/kernel'
import type { BugFishingPassScope } from './bugFishing.logic.js'
import type { CodebaseSurveyResult } from './bugFishingSurvey.js'

// ---------------------------------------------------------------------------
// What ONE pass of an expedition is handed, and held to.
//
// The dispatch path and the completion path both need it, and they must not compute it
// separately: the manifest a pass was briefed with is the same manifest its findings are scoped
// against and its coverage measured against. So this joins a planned phase to the survey once,
// and both paths call it.
// ---------------------------------------------------------------------------

/** What a pass is handed (the manifest as a context file) and held to (the scope). */
export interface BugFishingPass {
  /** The territory to name in the phase brief, or null for a whole-codebase pass. */
  territory: { label: string; roots: readonly string[] } | null
  /** The `.cat-context/territory.md` manifest, or null when there is no territory to describe. */
  contextFile: InjectedContextFile | null
  /**
   * What the platform holds the pass to: findings outside the territory are dropped and counted,
   * and the coverage share is computed against the manifest. Undefined for a whole-codebase pass,
   * which owns everything and is therefore scoped by nothing.
   */
  scope: BugFishingPassScope | undefined
}

/**
 * Resolve the pass a planned phase describes against the survey.
 *
 * A phase with no `territoryId` is the PASS-THROUGH: a codebase small enough to fish whole, or an
 * expedition planned before territories existed, or one whose survey could not read the
 * repository. All three get no manifest, no scope and no territory in the brief, which is
 * byte-for-byte the dispatch that shipped before this feature.
 *
 * A phase whose territory the CURRENT survey no longer produces (the tree moved between passes,
 * or a fix merged and re-shaped a directory) falls back to the roots the run itself recorded, and
 * gets no file manifest. That is deliberate: the run's own record is the better witness of what
 * it planned, and a manifest re-derived from a different partition would describe a territory
 * this pass was never given.
 */
export function bugFishingPassScope(
  state: BugFishingStepState,
  phase: BugFishingPhase,
  survey: CodebaseSurveyResult,
): BugFishingPass {
  const territoryId = phase.territoryId
  if (!territoryId) return { territory: null, contextFile: null, scope: undefined }
  const recorded = (state.territories ?? []).find((t) => t.id === territoryId)
  const roots = recorded?.roots ?? []
  const label = phase.territoryLabel || recorded?.label || territoryId
  const files = (survey.filesByTerritory.get(territoryId) ?? []).map((file) => file.path)
  const scope: BugFishingPassScope = { territoryId, roots, manifest: new Set(files) }
  if (files.length === 0) {
    // The survey has no manifest for this territory any more. The pass still owns the roots (the
    // brief says so, and the scope enforces it); it just gets no map, which costs it the
    // orientation saving rather than its correctness.
    return { territory: { label, roots }, contextFile: null, scope }
  }
  const contextFile: InjectedContextFile = {
    path: BUG_FISHING_TERRITORY_CONTEXT_FILE,
    content: renderBugFishingTerritoryContext({
      territory: {
        label,
        roots,
        ...(recorded?.approxTokens !== undefined ? { approxTokens: recorded.approxTokens } : {}),
      },
      files,
      neighbours: (state.territories ?? []).filter((t) => t.id !== territoryId).map((t) => t.label),
    }),
  }
  return { territory: { label, roots }, contextFile, scope }
}
