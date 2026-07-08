import type { CommitFilesInput, Initiative } from '@cat-factory/contracts'
import { parseInitiativePlanDraft } from '@cat-factory/contracts'
import type { RepoContentEntry, RepoFiles } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  canonicalInitiativeJson,
  coerceInitiativePlan,
  commitInitiativeTracker,
  hashInitiative,
  renderInitiativeFiles,
  renderInitiativeTrackerMarkdown,
} from './initiative.js'

// The initiative tracker helpers: lenient coercion of the planner's JSON, the
// deterministic (golden) rendering of the in-repo tracker files, and the
// hash-short-circuited idempotent commit (REPLAY-safe inside recordStepResult).

/** A tiny in-memory RepoFiles that APPLIES commits, so idempotency can be tested end-to-end. */
class FakeRepo implements RepoFiles {
  readonly commits: CommitFilesInput[] = []
  constructor(private readonly fileMap: Map<string, string> = new Map()) {}

  async getFile(path: string) {
    const content = this.fileMap.get(path)
    return content === undefined ? null : { content, sha: 'sha' }
  }

  async listDirectory(): Promise<RepoContentEntry[]> {
    return []
  }

  async headSha() {
    return 'head'
  }
  async createBranch() {}

  async commitFiles(input: CommitFilesInput) {
    this.commits.push(input)
    for (const f of input.files) this.fileMap.set(f.path, f.content)
    for (const d of input.deletions ?? []) this.fileMap.delete(d)
    return { sha: 'commit' }
  }

  async openPullRequest(): Promise<never> {
    throw new Error('not used')
  }
}

const PLAN = {
  goal: 'Migrate registries to DI',
  constraints: ['keep runtimes symmetric'],
  analysisSummary: 'Registries live in kernel.',
  phases: [{ id: 'pilot', title: 'Pilot', goal: 'Convert one registry' }, { title: 'Roll out' }],
  items: [
    {
      id: 'gate-registry',
      phaseId: 'pilot',
      title: 'Convert the gate registry',
      description: 'Move registerGate to DI.',
      estimate: { complexity: 0.4, risk: 0.2, impact: 0.6, rationale: 'contained' },
    },
    {
      // No id + phase referenced by TITLE slug: coercion resolves both.
      phaseId: 'Roll out',
      title: 'Convert the resolver registry',
      dependsOn: ['gate-registry'],
    },
  ],
  policy: {
    maxConcurrent: 3,
    rules: [{ pipelineId: 'pl_quick', minComplexity: 0.1 }],
    defaultPipelineId: 'pl_full',
  },
  decisions: [{ title: 'One registry per PR', detail: 'Keeps reviews small.' }],
  caveats: ['conformance must stay green'],
}

function entityFromPlan(): Initiative {
  const draft = parseInitiativePlanDraft(coerceInitiativePlan(PLAN))
  return {
    id: 'initv-1',
    blockId: 'blk-1',
    slug: 'registry-di',
    title: 'Registry DI migration',
    goal: draft.goal ?? '',
    constraints: draft.constraints ?? [],
    nonGoals: [],
    qa: [],
    analysisSummary: draft.analysisSummary ?? '',
    phases: draft.phases.map((p) => ({ id: p.id!, title: p.title, goal: p.goal ?? '' })),
    items: draft.items.map((i) => ({
      id: i.id!,
      phaseId: i.phaseId,
      title: i.title,
      description: i.description ?? '',
      dependsOn: i.dependsOn ?? [],
      ...(i.estimate ? { estimate: i.estimate } : {}),
      status: 'pending' as const,
    })),
    policy: draft.policy,
    decisions: (draft.decisions ?? []).map((d, n) => ({
      id: `dec-${n}`,
      at: 1,
      title: d.title,
      detail: d.detail ?? '',
      source: 'planning' as const,
    })),
    deviations: [],
    followUps: [],
    caveats: draft.caveats ?? [],
    status: 'awaiting_approval',
    rev: 3,
    createdAt: 1,
    updatedAt: 99,
  }
}

describe('coerceInitiativePlan', () => {
  it('coerces a plan, assigning slug ids and resolving phase/dependency references', () => {
    const plan = coerceInitiativePlan(PLAN)
    expect(plan).not.toBeNull()
    expect(plan!.phases.map((p) => p.id)).toEqual(['pilot', 'roll-out'])
    const second = plan!.items[1]!
    expect(second.id).toBe('convert-the-resolver-registry')
    expect(second.phaseId).toBe('roll-out')
    expect(second.dependsOn).toEqual(['gate-registry'])
    // The strict contract schema accepts the coerced draft (the ingest trust boundary).
    expect(() => parseInitiativePlanDraft(plan)).not.toThrow()
  })

  it('drops an item whose phase cannot be resolved, and returns null for garbage', () => {
    const plan = coerceInitiativePlan({
      phases: [{ title: 'Only' }],
      items: [
        { phaseId: 'only', title: 'kept' },
        { phaseId: 'nope', title: 'dropped' },
      ],
      policy: {},
    })
    expect(plan!.items.map((i) => i.title)).toEqual(['kept'])
    // Policy fallbacks: a missing defaultPipelineId falls back to pl_full, concurrency to 1.
    expect(plan!.policy).toMatchObject({ maxConcurrent: 1, defaultPipelineId: 'pl_full' })

    expect(coerceInitiativePlan(null)).toBeNull()
    expect(coerceInitiativePlan({ items: [] })).toBeNull()
  })
})

describe('renderInitiativeFiles', () => {
  it('renders deterministic bytes (same entity → identical files)', async () => {
    const entity = entityFromPlan()
    const meta = { version: 1, generatedAt: '2026-07-03T00:00:00.000Z' }
    const a = await renderInitiativeFiles(entity, meta)
    const b = await renderInitiativeFiles(entity, meta)
    expect(a).toEqual(b)
    expect(a.map((f) => f.path)).toEqual([
      'docs/initiatives/registry-di/initiative.json',
      'docs/initiatives/registry-di/tracker.md',
      'docs/initiatives/registry-di/version.json',
    ])
  })

  it('excludes the volatile bookkeeping (rev/updatedAt/doc) from the canonical content', async () => {
    const entity = entityFromPlan()
    const bumped: Initiative = {
      ...entity,
      rev: 42,
      updatedAt: 12345,
      doc: { version: 9, hash: 'x', committedAt: 1 },
    }
    expect(canonicalInitiativeJson(entity)).toBe(canonicalInitiativeJson(bumped))
    expect(await hashInitiative(entity)).toBe(await hashInitiative(bumped))
  })

  it('renders the tracker markdown with the per-item checklist + policy + logs', () => {
    const md = renderInitiativeTrackerMarkdown(entityFromPlan())
    expect(md).toContain('# Initiative: Registry DI migration')
    expect(md).toContain('**Status:** awaiting_approval')
    expect(md).toContain('## Phase: Pilot')
    expect(md).toContain('| `gate-registry` | Convert the gate registry | ⬜ pending | — | — |')
    expect(md).toContain('`convert-the-resolver-registry`')
    expect(md).toContain('- Max concurrent tasks: 3')
    expect(md).toContain('- Default pipeline: `pl_full`')
    expect(md).toContain('**One registry per PR** (planning)')
    expect(md).toContain('## Known caveats')
  })

  it('annotates a checkpoint phase (pending vs cleared) in the tracker markdown (D2)', () => {
    const entity = entityFromPlan()
    const withCheckpoints: Initiative = {
      ...entity,
      phases: [
        { ...entity.phases![0]!, checkpoint: true },
        { ...entity.phases![1]!, checkpoint: true, checkpointClearedAt: Date.parse('2026-07-04') },
      ],
    }
    const md = renderInitiativeTrackerMarkdown(withCheckpoints)
    expect(md).toContain(
      '> 🛑 Checkpoint — the initiative pauses for human review once every item in this phase settles.',
    )
    expect(md).toContain(
      '> 🛑 Checkpoint cleared 2026-07-04 — the initiative resumed past this phase.',
    )
  })
})

describe('commitInitiativeTracker', () => {
  it('commits the tracker files once, then short-circuits on unchanged content (replay-safe)', async () => {
    const repo = new FakeRepo()
    const entity = entityFromPlan()
    const now = new Date('2026-07-03T00:00:00.000Z')

    const doc = await commitInitiativeTracker(repo, 'main', entity, now)
    expect(doc).toEqual({ version: 1, hash: await hashInitiative(entity) })
    expect(repo.commits).toHaveLength(1)

    // A REPLAY (or a no-op tick) re-renders identical content ⇒ no second commit.
    const replay = await commitInitiativeTracker(repo, 'main', entity, now)
    expect(replay).toBeNull()
    expect(repo.commits).toHaveLength(1)

    // A real change (an item settled) bumps the version and commits again.
    const settled: Initiative = {
      ...entity,
      items: entity.items!.map((i) =>
        i.id === 'gate-registry'
          ? {
              ...i,
              status: 'done' as const,
              pr: { url: 'https://github.com/o/r/pull/7', number: 7 },
            }
          : i,
      ),
    }
    const next = await commitInitiativeTracker(repo, 'main', settled, now)
    expect(next?.version).toBe(2)
    expect(repo.commits).toHaveLength(2)
    const tracker = await repo.getFile('docs/initiatives/registry-di/tracker.md')
    expect(tracker!.content).toContain('[#7](https://github.com/o/r/pull/7)')
    expect(tracker!.content).toContain('✅ done')
  })
})
