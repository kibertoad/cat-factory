import { AGENT_TIERS, agentTierVisibleAt, type AgentTier } from '@cat-factory/contracts'
import type { AgentArchetype } from '~/types/domain'

/**
 * Agent-tier filtering for the two catalog surfaces — the pipeline builder's palette and the
 * model preset's per-agent override list.
 *
 * The tier vocabulary, the default and the cumulative predicate live in `@cat-factory/contracts`
 * (beside `purposeAllowsAgentCategory`) so a deployment-registered kind's declared tier and the
 * SPA's own built-ins are read by ONE rule. This module holds only the frontend-shaped helpers
 * built on it.
 *
 * Deliberately NOT the interface mode (`utils/uiMode.ts`). That tier says which SURFACES the
 * whole SPA offers; this one says how deep into the agent catalog a given surface reaches. They
 * are independent axes — an advanced-mode user still starts on the basic agent tier — and the
 * control for this one is visible in both interface modes, since it is the only way to reach
 * the kinds it hides.
 */

/** The default agent tier a surface opens on: the everyday delivery loop, nothing else. */
export const DEFAULT_AGENT_TIER_LEVEL: AgentTier = 'basic'

/** Whether an untrusted (persisted / hand-edited) value is one of the known tiers. */
export function isAgentTier(value: unknown): value is AgentTier {
  return typeof value === 'string' && (AGENT_TIERS as readonly string[]).includes(value)
}

/**
 * Keep the archetypes visible at `level`, PLUS any the caller marks as pinned — the model
 * preset editor's kinds that already carry an override. An entity can hold a setting written
 * by a teammate, by the API, or by this user at a wider tier; hiding the row would leave them
 * unable to see or clear it, which is the same failure the interface mode's `showOverrideField`
 * exists to prevent. Order follows the input, so a pinned kind stays where the catalog puts it.
 */
export function filterByAgentTierKeeping<T extends Pick<AgentArchetype, 'tier' | 'kind'>>(
  archetypes: readonly T[],
  level: AgentTier,
  isPinned: (archetype: T) => boolean,
): T[] {
  return archetypes.filter((a) => agentTierVisibleAt(a.tier, level) || isPinned(a))
}
