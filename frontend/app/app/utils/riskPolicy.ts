import type { RiskPolicy } from '~/types/merge'

/**
 * The three axes a `merger` agent scores a pull request on, each carrying an auto-merge
 * ceiling on a risk policy. Presentation order is risk → impact → complexity: what the PR
 * could break first, then how far it reaches, then how hard it was to write.
 */
export type RiskPolicyAxis = 'risk' | 'impact' | 'complexity'

/** One axis of a policy, with the ceiling a score must stay at or below to auto-merge. */
export interface RiskPolicyCeiling {
  axis: RiskPolicyAxis
  /** The stored 0..1 ratio. Render it through the `percent` number format, never raw. */
  max: number
}

/**
 * A policy's auto-merge ceilings, one entry per axis in presentation order, so every
 * surface that explains a policy groups the three axes the same way.
 */
export function riskPolicyCeilings(p: RiskPolicy): RiskPolicyCeiling[] {
  return [
    { axis: 'risk', max: p.maxRisk },
    { axis: 'impact', max: p.maxImpact },
    { axis: 'complexity', max: p.maxComplexity },
  ]
}
