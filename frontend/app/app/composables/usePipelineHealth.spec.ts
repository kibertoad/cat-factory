import { describe, it, expect } from 'vitest'
import type { Pipeline } from '~/types/domain'
import { isKnownAgentKind } from '~/utils/catalog'
import { usePipelinesStore } from '~/stores/pipelines'
import { usePipelineHealth } from '~/composables/usePipelineHealth'

/**
 * Guards the startup pipeline-health advisory against the failure that bit the first cut: a
 * legitimate built-in agent kind missing from the frontend catalog made `isKnownAgentKind`
 * return false, so a stock seeded pipeline (`pl_tech_debt`, which uses `analysis` + `tracker`)
 * was reported "invalid" in every workspace with a Reseed action that could never fix it.
 *
 * The kind lists below mirror the canonical built-ins in
 * `backend/packages/kernel/src/domain/seed.ts`; keep them in step when a seed pipeline gains a
 * new kind. The `every built-in seed kind is known` test then fails loudly if the catalog drifts.
 */

let nextId = 0
function builtin(agentKinds: string[], over: Partial<Pipeline> = {}): Pipeline {
  return {
    id: `pl_test_${nextId++}`,
    name: 'Test',
    purpose: 'build',
    agentKinds,
    builtin: true,
    version: 1,
    ...over,
  }
}

/**
 * Seed the store with pipelines + their current catalog versions (and any RETIREMENTS), then scan.
 * A retired id is dropped from the derived catalog versions, mirroring the backend where the two
 * sets are disjoint by construction — a test that seeded both would assert against a snapshot the
 * facade cannot produce.
 */
function scan(
  pipelines: Pipeline[],
  versions: Record<string, number> = {},
  retired: { id: string; replacedBy?: string }[] = [],
  names: Record<string, string> = {},
) {
  const store = usePipelinesStore()
  const retiredIds = new Set(retired.map((r) => r.id))
  const catalogVersions = Object.fromEntries(
    Object.entries({
      ...Object.fromEntries(pipelines.filter((p) => p.builtin).map((p) => [p.id, p.version ?? 0])),
      ...versions,
    }).filter(([id]) => !retiredIds.has(id)),
  )
  store.hydrate(pipelines, catalogVersions, retired, names)
  return usePipelineHealth()
}

// Every agent kind any built-in catalog pipeline references (mirror of seed.ts). The advisory's
// validity oracle (`isKnownAgentKind`) must recognise all of them, or a stock pipeline is
// falsely flagged. `analysis`/`tracker` are the two that originally regressed.
const BUILTIN_SEED_KINDS = [
  'requirements-review',
  'spec-writer',
  'architect',
  'coder',
  'reviewer',
  'blueprints',
  'mocker',
  'tester-api',
  'tester-ui',
  'visual-confirmation',
  'conflicts',
  'ci',
  'merger',
  'integrator',
  'documenter',
  'analysis',
  'tracker',
  'human-test',
  'human-review',
]

describe('isKnownAgentKind', () => {
  it('recognises every agent kind used by the built-in seed catalog', () => {
    const unknown = BUILTIN_SEED_KINDS.filter((k) => !isKnownAgentKind(k))
    expect(unknown).toEqual([])
  })

  it('specifically recognises analysis + tracker (the kinds that regressed)', () => {
    expect(isKnownAgentKind('analysis')).toBe(true)
    expect(isKnownAgentKind('tracker')).toBe(true)
  })

  it('returns false for a genuinely unknown kind', () => {
    expect(isKnownAgentKind('totally-made-up-kind')).toBe(false)
  })
})

describe('usePipelineHealth', () => {
  it('does not flag the stock tech-debt built-in (analysis + tracker) as invalid', () => {
    const techDebt = builtin(
      [
        'analysis',
        'tracker',
        'coder',
        'reviewer',
        'blueprints',
        'tester-api',
        'conflicts',
        'ci',
        'merger',
      ],
      { id: 'pl_tech_debt', name: 'Tech debt' },
    )
    const { hasIssues, invalid, outdated } = scan([techDebt])
    expect(hasIssues.value).toBe(false)
    expect(invalid.value).toHaveLength(0)
    expect(outdated.value).toHaveLength(0)
  })

  it('flags a pipeline that references an unknown agent kind', () => {
    const broken = builtin(['coder', 'bogus-kind'])
    const { invalid } = scan([broken])
    expect(invalid.value).toHaveLength(1)
    expect(invalid.value[0]!.problems.some((p) => p.type === 'unknown-kind')).toBe(true)
  })

  it('accepts a valid producer + companion chain', () => {
    const { hasIssues } = scan([builtin(['coder', 'reviewer'])])
    expect(hasIssues.value).toBe(false)
  })

  it('flags a companion with no preceding producer it can review (shape)', () => {
    const { invalid } = scan([builtin(['reviewer'])])
    expect(invalid.value).toHaveLength(1)
    expect(invalid.value[0]!.problems.some((p) => p.type === 'shape')).toBe(true)
  })

  it('flags an estimate-gated companion with no task-estimator before it (shape)', () => {
    const gated = builtin(['coder', 'reviewer'], {
      gating: [null, { enabled: true, minComplexity: 0.5, onMissingEstimate: 'run' }],
    })
    const { invalid } = scan([gated])
    expect(invalid.value).toHaveLength(1)
    expect(invalid.value[0]!.problems.some((p) => p.type === 'shape')).toBe(true)
  })

  // The regression this pins: the advisory carried its own "only a companion may be gated" rule,
  // so when the engine generalised gating to `BUILTIN_GATABLE_KINDS` the shipped `pl_simple`
  // ("Adaptive build" — an estimate-gated `architect`) was reported invalid in EVERY workspace.
  // Because the advisory auto-opens a modal over the board, that made the board unusable rather
  // than merely warning wrongly. Both sides now read the shared contracts constant.
  it('accepts an estimate-gated NON-companion producer that the shared gatable set allows', () => {
    const adaptive = builtin(['task-estimator', 'architect', 'architect-companion', 'coder'], {
      gating: [null, { enabled: true, minComplexity: 0.4, onMissingEstimate: 'run' }, null, null],
    })
    const { hasIssues } = scan([adaptive])
    expect(hasIssues.value).toBe(false)
  })

  it('still flags an estimate-gated kind the shared gatable set excludes (merger)', () => {
    const gatedMerger = builtin(['task-estimator', 'coder', 'merger'], {
      gating: [null, null, { enabled: true, minComplexity: 0.4, onMissingEstimate: 'run' }],
    })
    const { invalid } = scan([gatedMerger])
    expect(invalid.value).toHaveLength(1)
    expect(invalid.value[0]!.problems.some((p) => p.type === 'shape')).toBe(true)
  })

  it('flags a step carrying BOTH a human approval gate and an estimate gate (shape)', () => {
    const both = builtin(['task-estimator', 'architect'], {
      gates: [false, true],
      gating: [null, { enabled: true, minComplexity: 0.4, onMissingEstimate: 'run' }],
    })
    const { invalid } = scan([both])
    expect(invalid.value).toHaveLength(1)
    expect(invalid.value[0]!.problems.some((p) => p.type === 'shape')).toBe(true)
  })

  it('reports a built-in whose catalog version moved ahead as outdated (not invalid)', () => {
    const stale = builtin(['coder', 'reviewer'], { id: 'pl_stale', version: 1 })
    const { invalid, outdated } = scan([stale], { pl_stale: 2 })
    expect(invalid.value).toHaveLength(0)
    expect(outdated.value).toHaveLength(1)
    expect(outdated.value[0]!.problems[0]!.type).toBe('outdated')
  })

  it('keeps an invalid + outdated built-in out of the outdated list (one fix, not two)', () => {
    const both = builtin(['coder', 'bogus-kind'], { id: 'pl_both', version: 1 })
    const { invalid, outdated } = scan([both], { pl_both: 2 })
    expect(invalid.value).toHaveLength(1)
    expect(outdated.value).toHaveLength(0)
  })

  it('surfaces a brand-new built-in the workspace does not have yet (offer to add)', () => {
    // A board seeded before `pl_review` shipped: the catalog versions advertise it, but no stored
    // pipeline has that id — so it must appear as a "new" pipeline the user can add.
    const stored = builtin(['coder', 'reviewer'], { id: 'pl_full', version: 1 })
    const { newPipelines, hasIssues, invalid, outdated } = scan([stored], {
      pl_full: 1,
      pl_review: 4,
    })
    expect(newPipelines.value).toEqual([{ id: 'pl_review', name: 'review' }])
    expect(hasIssues.value).toBe(true)
    // A brand-new built-in is not "invalid" or "outdated" — those only concern STORED pipelines.
    expect(invalid.value).toHaveLength(0)
    expect(outdated.value).toHaveLength(0)
  })

  it("names an un-adopted catalog entry from the catalog's own name map, not its id", () => {
    // The case that made the humanised fallback wrong: a deployment's registered pipeline behind a
    // reusable operation. `pl_org_introduce_api` humanises to "org introduce api", a name that
    // appears nowhere else in the product, and this advisory is shown on exactly the boards that
    // predate the operation. With the map, the offer reads as the pipeline actually is.
    const stored = builtin(['coder', 'reviewer'], { id: 'pl_full', version: 1 })
    const { newPipelines } = scan([stored], { pl_full: 1, pl_org_introduce_api: 1 }, [], {
      pl_full: 'Full build',
      pl_org_introduce_api: 'Introduce API',
    })
    expect(newPipelines.value).toEqual([{ id: 'pl_org_introduce_api', name: 'Introduce API' }])
  })

  it('reports no new pipelines when every catalog id is already stored', () => {
    const stored = builtin(['coder', 'reviewer'], { id: 'pl_full', version: 1 })
    const { newPipelines, hasIssues } = scan([stored], { pl_full: 1 })
    expect(newPipelines.value).toHaveLength(0)
    expect(hasIssues.value).toBe(false)
  })
  it('reports a stored built-in the catalog retired, with no reseed offer', () => {
    const stale = builtin(['coder', 'reviewer'], { id: 'pl_gone', name: 'Old flow', version: 1 })
    const { retired, invalid, outdated, newPipelines, hasIssues } = scan([stale], {}, [
      { id: 'pl_gone' },
    ])
    expect(retired.value).toHaveLength(1)
    expect(retired.value[0]!.pipeline.id).toBe('pl_gone')
    expect(retired.value[0]!.replacement).toBeUndefined()
    expect(hasIssues.value).toBe(true)
    // Retirement is answered by a REMOVAL, so the pipeline must appear in no reseed-shaped list.
    expect(invalid.value).toHaveLength(0)
    expect(outdated.value).toHaveLength(0)
    expect(newPipelines.value).toHaveLength(0)
  })

  it('resolves a retirement replacement to the stored pipeline it names', () => {
    const stale = builtin(['coder'], { id: 'pl_gone', name: 'Old flow', version: 1 })
    const live = builtin(['coder', 'reviewer'], { id: 'pl_simple', name: 'Simple', version: 1 })
    const { retired } = scan([stale, live], {}, [{ id: 'pl_gone', replacedBy: 'pl_simple' }])
    expect(retired.value[0]!.replacement).toEqual({ id: 'pl_simple', name: 'Simple' })
  })

  it('names a replacement that is in the catalog but NOT yet stored on this board', () => {
    // The canonical retirement: an old flow superseded by a NEWLY SHIPPED built-in. The replacement
    // is in `catalogVersions` with no row until someone adds it — it is simultaneously a
    // `newPipelines` entry — so resolving only against stored pipelines silently dropped the
    // "Use X instead" sentence in exactly the case `replacedBy` exists to serve.
    const stale = builtin(['coder'], { id: 'pl_gone', name: 'Old flow', version: 1 })
    const { retired, newPipelines } = scan([stale], { pl_bug_triage: 1 }, [
      { id: 'pl_gone', replacedBy: 'pl_bug_triage' },
    ])
    expect(newPipelines.value.map((p) => p.id)).toContain('pl_bug_triage')
    expect(retired.value[0]!.replacement).toEqual({ id: 'pl_bug_triage', name: 'bug triage' })
  })

  it('leaves the replacement unnamed when the id resolves nowhere', () => {
    // A SPA running against a newer backend can be handed a `replacedBy` it knows nothing about.
    // The advisory falls back to the un-named copy rather than inventing a name for it.
    const stale = builtin(['coder'], { id: 'pl_gone', name: 'Old flow', version: 1 })
    const { retired } = scan([stale], {}, [{ id: 'pl_gone', replacedBy: 'pl_from_the_future' }])
    expect(retired.value[0]!.replacement).toBeUndefined()
  })

  it('keeps an INVALID retired built-in out of the invalid list (its Reseed could only fail)', () => {
    // The regression this pins: a retired pipeline that also references an unknown kind used to
    // land in `invalid` with a built-in Reseed button, and reseed 422s for an id the catalog no
    // longer defines — an advisory offering a fix that cannot work.
    const broken = builtin(['coder', 'bogus-kind'], { id: 'pl_gone', version: 1 })
    const { invalid, retired } = scan([broken], {}, [{ id: 'pl_gone' }])
    expect(invalid.value).toHaveLength(0)
    expect(retired.value).toHaveLength(1)
  })

  it('ignores a retirement for a pipeline this workspace never stored', () => {
    // Nothing to clean up: the board was created after the withdrawal, so it was never seeded.
    const stored = builtin(['coder', 'reviewer'], { id: 'pl_full', version: 1 })
    const { retired, hasIssues } = scan([stored], { pl_full: 1 }, [{ id: 'pl_gone' }])
    expect(retired.value).toHaveLength(0)
    expect(hasIssues.value).toBe(false)
  })
})
