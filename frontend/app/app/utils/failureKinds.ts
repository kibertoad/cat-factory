// ---------------------------------------------------------------------------
// Shared presentation for the run FAILURE TAXONOMY — the vocabulary the operator dashboard
// renders as a breakdown and the alert settings panel offers as the subject of a per-kind
// rule. Two surfaces answering about the same set, so the enum→key map lives here once: a
// second copy is a map that drifts, and the surface that drifts is the one where an operator
// picks the kind a page is wired to.
//
// The map is an exhaustive `Record<AgentFailureKind, …>`, so adding a kind to the contract
// fails the typecheck here rather than rendering a raw code in either place.
//
// What is PRESENTATION lives here; what is a RULE comes from `@cat-factory/contracts` and is
// re-exported so a component has one import. `isAgentFailureKind` in particular is not the
// SPA's to own: the backend asks the identical question of an operator-typed kind in
// `PLATFORM_ALERTS_FAILURE_KIND_RATES`, and two copies of "which kinds exist" is the pair that
// drifts the moment one is retired.
// ---------------------------------------------------------------------------

import { agentFailureKindSchema, MAX_FAILURE_KIND_RULES } from '@cat-factory/contracts'
import type { AgentFailureKind, PlatformFailureKindRule } from '~/types/execution'

export { isAgentFailureKind, MAX_FAILURE_KIND_RULES } from '@cat-factory/contracts'

/** i18n key per failure kind. */
export const FAILURE_KIND_KEYS: Record<AgentFailureKind, string> = {
  preflight: 'platformObservability.failureKind.preflight',
  dispatch: 'platformObservability.failureKind.dispatch',
  environment: 'platformObservability.failureKind.environment',
  evicted: 'platformObservability.failureKind.evicted',
  harness_shutdown: 'platformObservability.failureKind.harness_shutdown',
  timeout: 'platformObservability.failureKind.timeout',
  agent: 'platformObservability.failureKind.agent',
  job_failed: 'platformObservability.failureKind.job_failed',
  rejected: 'platformObservability.failureKind.rejected',
  companion_rejected: 'platformObservability.failureKind.companion_rejected',
  stalled: 'platformObservability.failureKind.stalled',
  state_unreadable: 'platformObservability.failureKind.state_unreadable',
  cancelled: 'platformObservability.failureKind.cancelled',
  unknown: 'platformObservability.failureKind.unknown',
}

/**
 * The kinds a human may be OFFERED, in the contract's own declared order.
 *
 * Read off the picklist rather than restated, so the choices a rule can be written against are
 * the choices the backend recognises. The DISPLAYED set is deliberately not the same thing as
 * the set of values that may ARRIVE: a stored rule or a persisted run row can still name a kind
 * a later release retired, which `isAgentFailureKind` is for.
 */
export const AGENT_FAILURE_KINDS = agentFailureKindSchema.options as readonly AgentFailureKind[]

/**
 * Whether a stored per-kind rule list would be REFUSED by the contract, and why.
 *
 * One implementation shared by the editor and the save path, because they are the same question
 * asked twice: a fault the editor flags but the save path does not is a save that fails on the
 * WHOLE settings blob, for a reason the sheet never showed and about a sibling setting the admin
 * never touched.
 *
 * The two faults are kept APART rather than folded into one list of bad rows, because they need
 * different fixes and one of them belongs to no row in particular: "row 3 is malformed" is fixed
 * in row 3, while "there are more rules than the contract allows" is fixed by deleting any of
 * them. Reporting the second as a row number would point at a row that is perfectly fine.
 *
 * Deliberately mirrors the contract rather than re-deciding anything: a share in (0, 1], a whole
 * minimum count of 1 or more when one is set, at most one rule per kind, and at most
 * {@link MAX_FAILURE_KIND_RULES} rules.
 */
export interface FailureKindRuleFaults {
  /** 1-based positions of individual rules the contract would refuse. */
  rows: number[]
  /** Whether the LIST is over the contract's cap, which is no single row's fault. */
  tooMany: boolean
}

export function failureKindRuleFaults(
  rules: readonly PlatformFailureKindRule[],
): FailureKindRuleFaults {
  const counts = new Map<string, number>()
  for (const rule of rules) counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1)
  const rows = rules.flatMap((rule, index) => {
    const shareOk = rule.maxShare > 0 && rule.maxShare <= 1
    const countOk =
      rule.minCount === undefined || (Number.isInteger(rule.minCount) && rule.minCount >= 1)
    const unique = (counts.get(rule.kind) ?? 0) === 1
    return shareOk && countOk && unique ? [] : [index + 1]
  })
  return { rows, tooMany: rules.length > MAX_FAILURE_KIND_RULES }
}

/** Whether a list is savable at all — the one question both call sites actually branch on. */
export function hasFailureKindRuleFaults(faults: FailureKindRuleFaults): boolean {
  return faults.rows.length > 0 || faults.tooMany
}
