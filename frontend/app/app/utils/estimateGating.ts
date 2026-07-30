/**
 * The three axes a `task-estimator` step scores a task on, and the presentation vocabulary every
 * surface that lets a human gate work on them shares.
 *
 * Deliberately NOT `RISK_POLICY_AXES`: those are the axes a `merger` scores a finished pull
 * request on, and although the three names coincide, the two are produced by different agents at
 * different points in a run and mean different things to a reader. Folding them together would
 * make a rename in one silently retitle the other.
 */
export const ESTIMATE_AXES = ['complexity', 'risk', 'impact'] as const

export type EstimateAxis = (typeof ESTIMATE_AXES)[number]

/**
 * Axis → label key. Exhaustive over the union with LITERAL catalog keys, so the typed-message-key
 * check sees them and a new axis fails the typecheck rather than rendering a raw key.
 */
export const ESTIMATE_AXIS_LABEL_KEYS: Record<EstimateAxis, string> = {
  complexity: 'pipeline.builder.complexityThreshold',
  risk: 'pipeline.builder.riskThreshold',
  impact: 'pipeline.builder.impactThreshold',
}

/**
 * Axis → the `StepGating`/`ConsensusGating` field carrying its floor. Both schemas spell the
 * three the same way, which is what lets one editor serve every gate in the builder.
 */
export const ESTIMATE_AXIS_FIELD: Record<EstimateAxis, 'minComplexity' | 'minRisk' | 'minImpact'> =
  {
    complexity: 'minComplexity',
    risk: 'minRisk',
    impact: 'minImpact',
  }

/** Axis → the tooltip explaining what the axis measures and on what scale. Same discipline. */
export const ESTIMATE_AXIS_HINT_KEYS: Record<EstimateAxis, string> = {
  complexity: 'pipeline.builder.complexityThresholdHint',
  risk: 'pipeline.builder.riskThresholdHint',
  impact: 'pipeline.builder.impactThresholdHint',
}

/**
 * Read one axis threshold field back into a stored floor.
 *
 * An emptied or unparseable field CLEARS the axis rather than storing `0`, which is the whole
 * reason this is a function: the two are opposites. An unset axis is not considered at all,
 * where a floor of `0` is cleared by every estimate there is — so a user who deletes the number
 * to stop gating on risk would, under a `?? 0`, have gated on it permanently instead.
 *
 * The scale is the estimator's 0..1, and a value outside it is CLAMPED rather than rejected, so
 * a fat-fingered `10` lands on the ceiling instead of silently failing the pipeline save with a
 * 422 from the contract's score bounds.
 */
export function parseAxisThreshold(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const parsed = Number.parseFloat(trimmed)
  if (!Number.isFinite(parsed)) return undefined
  return Math.min(1, Math.max(0, parsed))
}
