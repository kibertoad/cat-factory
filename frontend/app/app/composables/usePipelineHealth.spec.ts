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
    agentKinds,
    builtin: true,
    version: 1,
    ...over,
  }
}

/** Seed the store with pipelines + their current catalog versions, then scan. */
function scan(pipelines: Pipeline[], versions: Record<string, number> = {}) {
  const store = usePipelinesStore()
  const catalogVersions = {
    ...Object.fromEntries(pipelines.filter((p) => p.builtin).map((p) => [p.id, p.version ?? 0])),
    ...versions,
  }
  store.hydrate(pipelines, catalogVersions)
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
  'tester',
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
        'tester',
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
})
