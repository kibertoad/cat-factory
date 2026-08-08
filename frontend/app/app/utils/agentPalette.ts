import {
  type AgentTier,
  agentTierVisibleAt,
  type PipelinePurpose,
  purposeSuggestsAgentCategory,
} from '@cat-factory/contracts'
import type { AgentArchetype } from '~/types/domain'

/**
 * The pipeline builder's palette narrows the agent catalog on TWO dials, and the pair is the
 * reason this reduction is one function rather than two chained filters at the call site.
 *
 * The dials are independent (the pipeline's PURPOSE says which categories the work has any use
 * for, the agent TIER says how deep into the catalog to look), but their hints are not, because
 * each hint is an invitation to reach for that dial. Chaining the filters and subtracting the
 * lengths gives the second dial an honest count and the first one the whole rest of the catalog,
 * so at the default `basic` tier a `planning` pipeline reported thirteen kinds hidden for its
 * purpose when switching back to Build revealed three: the other ten were tier-hidden either way.
 * That is exactly the "chasing a control that cannot help them" the ordering was meant to avoid,
 * just pointed at the other dial.
 *
 * So each count is measured against what the OTHER dial already admits, which makes both of them
 * the same promise: relax THIS dial alone and you get n more. A kind both dials hide is counted
 * by neither, and correctly: relaxing either one alone would not reveal it.
 */
export interface NarrowedAgentPalette<T> {
  /** The archetypes both dials admit: what the palette renders, in input order. */
  offered: T[]
  /** How many more the CURRENT tier would show if the purpose narrowed nothing. */
  hiddenByPurpose: number
  /** How many more the CURRENT purpose would show at the widest tier. */
  hiddenByTier: number
}

/**
 * Reduce `archetypes` to what the palette offers at `purpose` + `tier`, with each dial's hint
 * count (see {@link NarrowedAgentPalette} for what the counts promise).
 *
 * An archetype carrying no `category` has nothing for the purpose dial to judge, so it is always
 * relevant; an absent `tier` is `DEFAULT_AGENT_TIER`. Both are how a deployment-registered kind
 * that declares neither behaves, and neither is a reason to drop it from the catalog.
 */
export function narrowAgentPalette<T extends Pick<AgentArchetype, 'tier' | 'category'>>(
  archetypes: readonly T[],
  purpose: PipelinePurpose | null | undefined,
  tier: AgentTier,
): NarrowedAgentPalette<T> {
  const relevant = (a: T) => !a.category || purposeSuggestsAgentCategory(purpose, a.category)
  const inTier = (a: T) => agentTierVisibleAt(a.tier, tier)
  return {
    offered: archetypes.filter((a) => relevant(a) && inTier(a)),
    hiddenByPurpose: archetypes.filter((a) => inTier(a) && !relevant(a)).length,
    hiddenByTier: archetypes.filter((a) => relevant(a) && !inTier(a)).length,
  }
}
