import { agentFailureKindSchema } from '@cat-factory/contracts'
import type { AgentFailureKind, PlatformFailureKindRule } from '~/types/execution'

// ---------------------------------------------------------------------------
// Shared presentation for the run FAILURE TAXONOMY — the vocabulary the operator dashboard
// renders as a breakdown and the alert settings panel offers as the subject of a per-kind
// rule. Two surfaces answering about the same set, so the enum→key map lives here once: a
// second copy is a map that drifts, and the surface that drifts is the one where an operator
// picks the kind a page is wired to.
//
// The map is an exhaustive `Record<AgentFailureKind, …>`, so adding a kind to the contract
// fails the typecheck here rather than rendering a raw code in either place.
// ---------------------------------------------------------------------------

/** i18n key per failure kind. */
export const FAILURE_KIND_KEYS: Record<AgentFailureKind, string> = {
  preflight: 'platformObservability.failureKind.preflight',
  dispatch: 'platformObservability.failureKind.dispatch',
  environment: 'platformObservability.failureKind.environment',
  evicted: 'platformObservability.failureKind.evicted',
  timeout: 'platformObservability.failureKind.timeout',
  agent: 'platformObservability.failureKind.agent',
  job_failed: 'platformObservability.failureKind.job_failed',
  rejected: 'platformObservability.failureKind.rejected',
  companion_rejected: 'platformObservability.failureKind.companion_rejected',
  stalled: 'platformObservability.failureKind.stalled',
  cancelled: 'platformObservability.failureKind.cancelled',
  unknown: 'platformObservability.failureKind.unknown',
}

/**
 * The kinds a human may be OFFERED, in the contract's own declared order.
 *
 * Read off the picklist rather than restated, so the choices a rule can be written against are
 * the choices the backend recognises. The DISPLAYED set is deliberately not the same thing as
 * the set of values that may ARRIVE: a stored rule or a persisted run row can still name a kind
 * a later release retired, which {@link isKnownFailureKind} is for.
 */
export const AGENT_FAILURE_KINDS = agentFailureKindSchema.options as readonly AgentFailureKind[]

/**
 * Whether a string is a failure kind this build knows about.
 *
 * Derived from the picklist, so it stays true as the vocabulary grows, and needed because a
 * retired kind is not a hypothetical: it survives in stored rules and in run rows written
 * before the release that dropped it. A reader that assumed membership would splice `undefined`
 * into the label; one that guessed a current member would rename somebody's alert rule.
 */
export function isKnownFailureKind(kind: string): kind is AgentFailureKind {
  return (AGENT_FAILURE_KINDS as readonly string[]).includes(kind)
}

/**
 * The 1-based positions of per-kind alert rules the backend would refuse
 * (`platformFailureKindRuleSchema`), so the editor can name them and the save path can stop.
 *
 * One implementation for both, because they are the same question asked twice: a row the editor
 * flags but the save path does not is a save that fails on the WHOLE settings blob, for a reason
 * the sheet never showed and about a sibling setting the admin never touched.
 *
 * Deliberately mirrors the contract rather than re-deciding anything: a share in (0, 1], a whole
 * minimum count of 1 or more when one is set, and at most one rule per kind.
 */
export function invalidFailureKindRuleRows(rules: readonly PlatformFailureKindRule[]): number[] {
  const counts = new Map<string, number>()
  for (const rule of rules) counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1)
  return rules.flatMap((rule, index) => {
    const shareOk = rule.maxShare > 0 && rule.maxShare <= 1
    const countOk =
      rule.minCount === undefined || (Number.isInteger(rule.minCount) && rule.minCount >= 1)
    const unique = (counts.get(rule.kind) ?? 0) === 1
    return shareOk && countOk && unique ? [] : [index + 1]
  })
}
