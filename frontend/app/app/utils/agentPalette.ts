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
  purpose: PipelinePurpose,
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

/** One rendered palette section: an ordered category, or the trailing custom bucket. */
export interface AgentPaletteGroup<T> {
  id: string
  label: string
  agents: T[]
}

/**
 * Group what the palette offers into `sections` in their given order, with everything left over
 * in a trailing bucket under `customLabel`. Empty sections are dropped.
 *
 * The leftover bucket is what no section CLAIMED, not what carries no `category`, and the two are
 * different populations: an archetype whose category has no section here belongs to neither, so
 * testing for the absent one alone silently DELETED it from the palette. A `presentation.category`
 * comes from a kind a DEPLOYMENT registered and `sections` is the SPA's own mirror of the schema,
 * so the gap opens from either side, and the save gate accepts such a kind either way. Showing it
 * under "custom" says what is true: nothing here knows where to file it.
 */
export function groupAgentPalette<T extends Pick<AgentArchetype, 'category'>>(
  offered: readonly T[],
  sections: readonly { id: string; label: string }[],
  customLabel: string,
): AgentPaletteGroup<T>[] {
  const claimed = new Set<string>(sections.map((s) => s.id))
  const groups: AgentPaletteGroup<T>[] = sections.map((s) => ({
    id: s.id,
    label: s.label,
    agents: offered.filter((a) => a.category === s.id),
  }))
  const custom = offered.filter((a) => !a.category || !claimed.has(a.category))
  if (custom.length) groups.push({ id: 'custom', label: customLabel, agents: custom })
  return groups.filter((g) => g.agents.length)
}
