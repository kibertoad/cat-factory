import type { RiskPolicy } from '~/types/merge'

/**
 * The three axes a `merger` agent scores a pull request on. Presentation order is
 * risk → impact → complexity: what the PR could break first, then how far it reaches, then
 * how hard it was to write.
 *
 * This array IS the order — every surface that shows the three axes iterates it rather than
 * hard-coding a sequence, so the picker's preview, the inspector's summary line and the
 * settings editor cannot drift into three different orders (which is exactly what they had).
 */
export const RISK_POLICY_AXES = ['risk', 'impact', 'complexity'] as const

export type RiskPolicyAxis = (typeof RISK_POLICY_AXES)[number]

/**
 * Which `RiskPolicy` field carries each axis's auto-merge ceiling. Exhaustive over the axis
 * union, so adding an axis fails the typecheck here rather than silently rendering two.
 */
export const RISK_POLICY_CEILING_FIELD: Record<
  RiskPolicyAxis,
  'maxRisk' | 'maxImpact' | 'maxComplexity'
> = {
  risk: 'maxRisk',
  impact: 'maxImpact',
  complexity: 'maxComplexity',
}

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
  return RISK_POLICY_AXES.map((axis) => ({ axis, max: p[RISK_POLICY_CEILING_FIELD[axis]] }))
}
