import { describe, expect, it } from 'vitest'
import type { PipelinePurpose } from '@cat-factory/contracts'
import type { AgentArchetype } from '~/types/domain'
import { groupAgentPalette, narrowAgentPalette } from '~/utils/agentPalette'

const archetype = (
  kind: string,
  category?: AgentArchetype['category'],
  tier?: AgentArchetype['tier'],
  purposes?: AgentArchetype['purposes'],
): AgentArchetype => ({
  kind: kind as AgentArchetype['kind'],
  label: kind,
  icon: 'i-lucide-bot',
  color: '#fff',
  description: kind,
  ...(category ? { category } : {}),
  ...(tier ? { tier } : {}),
  ...(purposes ? { purposes } : {}),
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

describe('narrowAgentPalette — internal kinds', () => {
  // An INTERNAL kind is one the platform dispatches for a flow of its own (the environment
  // analyst, which hands its draft to the setup wizard). It is not hidden by a dial, it is not a
  // palette block at all.
  const internal: AgentArchetype = {
    ...archetype('environment-analyst', 'design', 'basic'),
    internal: true,
  }
  const catalog = [archetype('architect', 'design', 'basic'), internal]

  it('never offers one, at any purpose or tier', () => {
    for (const tier of ['basic', 'intermediate', 'advanced'] as const) {
      const { offered } = narrowAgentPalette(catalog, 'build', tier)
      expect(offered.map((a) => a.kind)).toEqual(['architect'])
    }
  })

  it('counts one against NEITHER dial, so no hint promises a control that would reveal it', () => {
    // The whole point of the counts is "relax THIS dial and you get n more". An internal kind is
    // revealed by neither, so counting it would send a reader chasing a control that cannot help.
    const { hiddenByPurpose, hiddenByTier } = narrowAgentPalette(catalog, 'review', 'basic')
    expect(hiddenByPurpose).toBe(1) // the architect alone: a review pipeline designs nothing
    expect(hiddenByTier).toBe(0)
  })
})

describe('narrowAgentPalette', () => {
  it('narrows nothing for a build pipeline at the widest tier', () => {
    const { offered, hiddenByPurpose, hiddenByTier } = narrowAgentPalette(
      CATALOG,
      'build',
      'advanced',
    )
    expect(offered.map((a) => a.kind)).toEqual(CATALOG.map((a) => a.kind))
    expect(hiddenByPurpose).toBe(0)
    expect(hiddenByTier).toBe(0)
  })

  it('accumulates the tiers when the purpose narrows nothing', () => {
    expect(narrowAgentPalette(CATALOG, 'build', 'basic').offered.map((a) => a.kind)).toEqual([
      'coder',
      'architect',
      'documenter',
    ])
    expect(narrowAgentPalette(CATALOG, 'build', 'intermediate').offered.map((a) => a.kind)).toEqual(
      [
        'coder',
        'architect',
        'documenter',
        // An undeclared tier defaults to intermediate, so it appears here.
        'acme-auditor',
      ],
    )
    expect(narrowAgentPalette(CATALOG, 'build', 'basic').hiddenByTier).toBe(3)
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

  it('narrows WITHIN a category when a kind declares the purposes it is for', () => {
    // The reason relevance is asked of the KIND: a category is a shelf label, so `documenter` and
    // `doc-reviewer` sit on the same shelf while only one of them belongs in a pipeline that
    // reviews someone else's pull request. Both dials still apply to the declaring kind.
    const catalog = [
      archetype('documenter', 'docs', 'basic', ['build', 'document']),
      archetype('doc-reviewer', 'docs', 'basic', ['build', 'review']),
      archetype('house-style', 'docs', 'basic'),
    ]
    const offered = (purpose: PipelinePurpose) =>
      narrowAgentPalette(catalog, purpose, 'advanced').offered.map((a) => a.kind)
    expect(offered('review')).toEqual(['doc-reviewer', 'house-style'])
    expect(offered('document')).toEqual(['documenter', 'house-style'])
    // `planning` drops the whole `docs` category, and the declarations do not override that for
    // the kinds that named it: a declared list is the kind's own answer, not an exemption.
    expect(offered('planning')).toEqual([])
    expect(narrowAgentPalette(catalog, 'review', 'advanced').hiddenByPurpose).toBe(1)
  })

  it('falls back to the category when a declared list names nothing this build knows', () => {
    // The mirror of the unknown-purpose rule: a kind whose entire list was retired has told this
    // build nothing, so its section decides rather than the kind vanishing from every palette.
    const stale = archetype('acme-doc', 'docs', 'basic', ['acme-migration' as never])
    expect(narrowAgentPalette([stale], 'document', 'advanced').offered).toEqual([stale])
    expect(narrowAgentPalette([stale], 'planning', 'advanced').offered).toEqual([])
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

// The rendered sections, mirroring `utils/catalog.ts` shape (id + display label).
const SECTIONS = [
  { id: 'design', label: 'Design & research' },
  { id: 'build', label: 'Implementation' },
  { id: 'test', label: 'Testing' },
  { id: 'docs', label: 'Documentation' },
]

describe('groupAgentPalette', () => {
  it('fills the sections in their given order and drops the empty ones', () => {
    const groups = groupAgentPalette(CATALOG, SECTIONS, 'Custom agents')
    expect(groups.map((g) => [g.id, g.agents.map((a) => a.kind)])).toEqual([
      ['design', ['architect', 'researcher']],
      ['build', ['coder']],
      ['test', ['tester']],
      ['docs', ['documenter']],
      // The uncategorized kind, in the trailing bucket. `review` and `gates` have no members
      // here, so neither section is rendered at all.
      ['custom', ['acme-auditor']],
    ])
  })

  it('files a kind whose category has no section under custom rather than deleting it', () => {
    // The regression: every section filter misses it AND so does a bare `!a.category`, so it
    // vanished from a palette whose save gate accepts it. Reachable from both sides (a
    // deployment-registered kind naming a category this build retired, and this list drifting
    // behind the schema), which is why the leftover bucket is derived from the sections.
    const registered = archetype('acme-auditor', 'observability' as never, 'basic')
    const groups = groupAgentPalette([registered], SECTIONS, 'Custom agents')
    expect(groups).toEqual([{ id: 'custom', label: 'Custom agents', agents: [registered] }])
  })

  it('renders no custom section when every kind was claimed', () => {
    const claimed = CATALOG.filter((a) => a.category)
    const groups = groupAgentPalette(claimed, SECTIONS, 'Custom agents')
    expect(groups.map((g) => g.id)).not.toContain('custom')
    expect(groups.flatMap((g) => g.agents)).toHaveLength(claimed.length)
  })
})
