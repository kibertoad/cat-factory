import { describe, expect, it } from 'vitest'
import type { AgentArchetype } from '~/types/domain'
import { narrowAgentPalette } from '~/utils/agentPalette'

const archetype = (
  kind: string,
  category?: AgentArchetype['category'],
  tier?: AgentArchetype['tier'],
): AgentArchetype => ({
  kind: kind as AgentArchetype['kind'],
  label: kind,
  icon: 'i-lucide-bot',
  color: '#fff',
  description: kind,
  ...(category ? { category } : {}),
  ...(tier ? { tier } : {}),
})

// Spread across both dials on purpose: every combination of relevant/irrelevant to a `planning`
// pipeline (which keeps `review` + `design` and drops `build` / `test` / `docs` / `gates`) and
// visible/hidden at the `basic` tier, so the two counts cannot both be right by coincidence.
const CATALOG: AgentArchetype[] = [
  archetype('coder', 'build', 'basic'), // irrelevant, in tier
  archetype('tester', 'test', 'advanced'), // irrelevant AND out of tier
  archetype('architect', 'design', 'basic'), // relevant, in tier
  archetype('researcher', 'design', 'advanced'), // relevant, out of tier
  archetype('documenter', 'docs', 'basic'), // irrelevant, in tier
  // A deployment-registered kind declaring neither: no category to judge (always relevant) and an
  // absent tier, which defaults to `intermediate` and so is out of the basic tier.
  archetype('acme-auditor'),
]

describe('narrowAgentPalette', () => {
  it('narrows nothing for an unclassified pipeline at the widest tier', () => {
    const { offered, hiddenByPurpose, hiddenByTier } = narrowAgentPalette(CATALOG, null, 'advanced')
    expect(offered.map((a) => a.kind)).toEqual(CATALOG.map((a) => a.kind))
    expect(hiddenByPurpose).toBe(0)
    expect(hiddenByTier).toBe(0)
  })

  it('accumulates the tiers when the purpose narrows nothing', () => {
    expect(narrowAgentPalette(CATALOG, null, 'basic').offered.map((a) => a.kind)).toEqual([
      'coder',
      'architect',
      'documenter',
    ])
    expect(narrowAgentPalette(CATALOG, null, 'intermediate').offered.map((a) => a.kind)).toEqual([
      'coder',
      'architect',
      'documenter',
      // An undeclared tier defaults to intermediate, so it appears here.
      'acme-auditor',
    ])
    expect(narrowAgentPalette(CATALOG, null, 'basic').hiddenByTier).toBe(3)
  })

  it('counts each dial against what the OTHER already admits', () => {
    // The regression this shape exists for: measuring the purpose count over the whole catalog
    // reported 3 here (coder, tester, documenter) while switching back to Build at this tier
    // reveals only 2: `tester` is tier-hidden either way, so naming it under the purpose control
    // sends the reader to a dial that cannot produce it.
    const { offered, hiddenByPurpose, hiddenByTier } = narrowAgentPalette(
      CATALOG,
      'planning',
      'basic',
    )
    expect(offered.map((a) => a.kind)).toEqual(['architect'])
    expect(hiddenByPurpose).toBe(2)
    expect(hiddenByTier).toBe(2)
  })

  it('states the full purpose narrowing once the tier stops hiding anything', () => {
    const { offered, hiddenByPurpose, hiddenByTier } = narrowAgentPalette(
      CATALOG,
      'planning',
      'advanced',
    )
    // The uncategorized kind has nothing for the purpose dial to judge, so it stays offered.
    expect(offered.map((a) => a.kind)).toEqual(['architect', 'researcher', 'acme-auditor'])
    expect(hiddenByPurpose).toBe(3)
    expect(hiddenByTier).toBe(0)
  })

  it('leaves a kind both dials hide out of both counts', () => {
    // Each count promises "relax THIS dial alone and you get n more", and relaxing either alone
    // would not reveal `tester`. So the four buckets partition the catalog with it in none of the
    // three the palette names, which is the property that keeps the two hints from double-counting.
    const { offered, hiddenByPurpose, hiddenByTier } = narrowAgentPalette(
      CATALOG,
      'planning',
      'basic',
    )
    const hiddenByBoth = CATALOG.length - offered.length - hiddenByPurpose - hiddenByTier
    expect(hiddenByBoth).toBe(1)
  })

  it('keeps a purpose this build does not recognise from narrowing anything', () => {
    // A stored `purpose` from a build that shipped a member this one has not (or has retired):
    // unknown is not a licence to guess, so the palette offers what the tier admits and says so.
    const purpose = 'acme-migration' as never
    const { offered, hiddenByPurpose } = narrowAgentPalette(CATALOG, purpose, 'advanced')
    expect(offered.map((a) => a.kind)).toEqual(CATALOG.map((a) => a.kind))
    expect(hiddenByPurpose).toBe(0)
  })
})
