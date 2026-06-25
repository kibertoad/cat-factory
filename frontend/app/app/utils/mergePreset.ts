import type { MergeThresholdPreset } from '~/types/merge'

/**
 * A compact one-line summary of a merge preset's auto-merge ceilings + CI-fix budget,
 * suitable for a dropdown option label so the user sees each preset's actual thresholds
 * (not just its name) while choosing one. Percentages are the stored 0..1 ratios
 * rendered as whole percents.
 */
export function mergePresetThresholds(p: MergeThresholdPreset): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`
  return `cx ≤${pct(p.maxComplexity)} · risk ≤${pct(p.maxRisk)} · impact ≤${pct(
    p.maxImpact,
  )} · ${p.ciMaxAttempts} CI fixes`
}

/** The preset name followed by its thresholds, for a single-line dropdown option. */
export function mergePresetOptionLabel(p: MergeThresholdPreset): string {
  return `${p.name} — ${mergePresetThresholds(p)}`
}
