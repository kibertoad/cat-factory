import { RISK_POLICY_NAME_MAX_LENGTH, WORKSPACE_ROLES } from '@cat-factory/contracts'
import type { RiskPolicy, WorkspaceRole } from '~/types/merge'

/**
 * The name a CLONE of an inherited policy is created under, guaranteed to satisfy the contract's
 * length limit.
 *
 * The label is composed here because the backend does not localize prose, which puts the contract's
 * ceiling on this side of the wire too: a source name near the limit plus whatever the locale's
 * template adds is over it, and the clone action then failed with a 422 against a name the operator
 * had no field to shorten. The SOURCE name is what gets trimmed rather than the composed string, so
 * the copy marker (the informative half) always survives.
 *
 * `compose` is passed in rather than `t` so this stays a pure function with no i18n dependency.
 */
export function riskPolicyCopyName(sourceName: string, compose: (name: string) => string): string {
  const full = compose(sourceName)
  if (full.length <= RISK_POLICY_NAME_MAX_LENGTH) return full
  // What the template itself costs, so the trim leaves room for it rather than guessing.
  const overhead = full.length - sourceName.length
  const room = Math.max(1, RISK_POLICY_NAME_MAX_LENGTH - overhead)
  // The final slice is the backstop for a template long enough to blow the budget on its own,
  // where no source name would fit: better a truncated label than an action that cannot be used.
  return compose(sourceName.slice(0, room).trimEnd()).slice(0, RISK_POLICY_NAME_MAX_LENGTH)
}

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

/** What a policy's ROLE layer does, for the surfaces that explain a policy rather than edit it. */
export interface RolePolicySummary {
  /** Roles whose runs are sandboxed: they open a pull request and merge nothing. */
  sandboxed: WorkspaceRole[]
  /**
   * Roles held to stricter per-class rules than the base map. A sandboxed role is NOT listed
   * here even when it also carries class rules: the sandbox already outranks them, so naming
   * both would read as two limits where the second changes nothing.
   */
  narrowed: WorkspaceRole[]
  /**
   * Roles allowlisted to a subset of change classes they may LAND. Same suppression rule as
   * `narrowed` and for the same reason, and listed SEPARATELY from it because the two are not
   * degrees of one setting: this one bars landing outright, including through the manual merge.
   */
  scoped: WorkspaceRole[]
}

/**
 * A policy's role layer, in the shared role order so every surface names the tiers the same way.
 * Both lists are empty on a policy that treats every initiator alike, which is every built-in, so
 * a surface can render the whole section conditionally on that.
 */
export function rolePolicySummary(p: RiskPolicy): RolePolicySummary {
  const sandboxed = WORKSPACE_ROLES.filter((role) => p.dryRunRoles.includes(role))
  return {
    sandboxed: [...sandboxed],
    narrowed: WORKSPACE_ROLES.filter(
      (role) => !sandboxed.includes(role) && Object.keys(p.classRulesByRole[role] ?? {}).length > 0,
    ),
    // Scoped-ness is the PRESENCE of an entry, never its length: a role allowlisted to nothing
    // is the most restrictive policy this setting can express, and reading it as "no allowlist"
    // would drop the one summary line a reader most needs to see.
    scoped: WORKSPACE_ROLES.filter(
      (role) => !sandboxed.includes(role) && p.submissionClassesByRole[role] !== undefined,
    ),
  }
}
