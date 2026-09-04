import type { BugFishingPhase, BugFishingTerritory, RepoContentEntry } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  isFishablePath,
  partitionCodebase,
  planTerritoryPasses,
  prioritiseTerritories,
} from './bugFishingTerritories.logic.js'

// The pure half of the large-codebase design: how a repository tree becomes territories, and how
// territories x angles becomes the pass list a budget bounds. Everything here is a total function
// of its inputs, so the rules that decide what an expedition covers are pinned without a run.

/** A file entry of `bytes` bytes. Sizes are what the partition is driven by. */
function file(path: string, bytes: number): RepoContentEntry {
  return { path, name: path.split('/').pop()!, type: 'file', sha: `sha-${path}`, size: bytes }
}

function dir(path: string): RepoContentEntry {
  return { path, name: path.split('/').pop()!, type: 'dir', sha: `tree-${path}` }
}

/** `count` files of `bytes` bytes each under `root`. */
function bulk(root: string, count: number, bytes: number): RepoContentEntry[] {
  return [dir(root), ...Array.from({ length: count }, (_, i) => file(`${root}/f${i}.ts`, bytes))]
}

const angle = (id: string, title: string): BugFishingPhase => ({
  id,
  title,
  goal: `goal ${id}`,
  status: 'pending',
})

const territory = (id: string, label: string, tokens: number): BugFishingTerritory => ({
  id,
  label,
  roots: [label],
  fileCount: 1,
  approxTokens: tokens,
  source: 'directory',
  subtreeShas: [`tree-${label}`],
})

describe('isFishablePath', () => {
  it('keeps source and drops generated, vendored and lockfile paths', () => {
    expect(isFishablePath('src/session.ts')).toBe(true)
    expect(isFishablePath('node_modules/left-pad/index.js')).toBe(false)
    expect(isFishablePath('packages/api/dist/index.js')).toBe(false)
    expect(isFishablePath('pnpm-lock.yaml')).toBe(false)
    expect(isFishablePath('src/api.generated.ts')).toBe(false)
    expect(isFishablePath('test/__snapshots__/a.snap')).toBe(false)
  })

  it('keeps tests, because they answer whether an invariant is already pinned', () => {
    // The finding bar's fourth test ("has something else already handled it?") is answered by a
    // test as often as by a guard, so a partition that dropped tests would make it unanswerable.
    expect(isFishablePath('src/session.test.ts')).toBe(true)
  })
})

describe('partitionCodebase', () => {
  it('fishes a small codebase as ONE whole-codebase territory, which is the pass-through', () => {
    const survey = partitionCodebase({ entries: bulk('src', 5, 2_000), truncated: false })
    expect(survey.territories).toHaveLength(1)
    expect(survey.territories[0]!.source).toBe('whole-codebase')
    expect(survey.territories[0]!.roots).toEqual([])
    expect(survey.territories[0]!.fileCount).toBe(5)
  })

  it('splits a large codebase along its top-level directories', () => {
    const survey = partitionCodebase({
      entries: [...bulk('billing', 4, 200_000), ...bulk('sessions', 4, 200_000)],
      truncated: false,
    })
    expect(survey.territories.map((t) => t.label).sort()).toEqual(['billing', 'sessions'])
    // The subtree sha comes free with the tree read; it is what a later run compares against.
    expect(survey.territories.every((t) => t.subtreeShas?.[0]?.startsWith('tree-'))).toBe(true)
    expect(survey.filesByTerritory.get(survey.territories[0]!.id)).toHaveLength(4)
  })

  it('excludes generated and vendored trees from the sizing as well as the manifest', () => {
    const survey = partitionCodebase({
      entries: [...bulk('src', 3, 2_000), ...bulk('node_modules/x', 400, 200_000)],
      truncated: false,
    })
    // Sized on `src` alone, so the whole thing still fits one territory. Counting the vendored
    // tree would have split a five-file repository into territories nobody should fish.
    expect(survey.territories).toHaveLength(1)
    expect(survey.territories[0]!.fileCount).toBe(3)
  })

  it('walks from the service directory, so a sibling service is out of scope', () => {
    const survey = partitionCodebase(
      {
        entries: [...bulk('packages/api', 4, 200_000), ...bulk('packages/web', 4, 200_000)],
        truncated: false,
      },
      { serviceDirectory: 'packages/api' },
    )
    expect(survey.territories.flatMap((t) => t.roots ?? []).join(' ')).not.toContain('packages/web')
    const files = [...survey.filesByTerritory.values()].flat()
    expect(files.every((f) => f.path.startsWith('packages/api/'))).toBe(true)
  })

  it("prefers the blueprint's own modules, and drops references the tree no longer has", () => {
    const survey = partitionCodebase(
      {
        entries: [...bulk('billing', 4, 200_000), ...bulk('sessions', 4, 200_000)],
        truncated: false,
      },
      {
        blueprint: {
          type: 'service',
          name: 'app',
          summary: '',
          references: [],
          modules: [
            { name: 'Billing', summary: '', references: ['billing'] },
            // Written against an older tree: the path is gone, so the module claims nothing and
            // its part of the tree falls through to the directory rule rather than being guessed
            // onto a new home.
            { name: 'Ghost', summary: '', references: ['does/not/exist'] },
          ],
        },
      },
    )
    const billing = survey.territories.find((t) => (t.roots ?? []).includes('billing'))!
    expect(billing.source).toBe('blueprint')
    // `sessions` was claimed by no module, so the directory rule covered it: a partial blueprint
    // narrows the heuristic rather than replacing it.
    const sessions = survey.territories.find((t) => (t.roots ?? []).includes('sessions'))!
    expect(sessions.source).toBe('directory')
  })

  it('carries the provider truncation flag through, because a cut tree is not a manifest', () => {
    const survey = partitionCodebase({ entries: bulk('src', 2, 1_000), truncated: true })
    expect(survey.treeTruncated).toBe(true)
  })
})

describe('planTerritoryPasses', () => {
  const angles = [angle('control-flow', 'Logic'), angle('concurrency', 'Concurrency')]

  it('leaves a whole-codebase expedition field-for-field as it was', () => {
    const whole: BugFishingTerritory = {
      id: 'whole-codebase',
      label: 'Whole codebase',
      roots: [],
      fileCount: 3,
      approxTokens: 100,
      source: 'whole-codebase',
      subtreeShas: [],
    }
    const planned = planTerritoryPasses({ territories: [whole], angles, passBudget: 24 })
    expect(planned.phases).toEqual(angles)
    expect(planned.phases.every((p) => p.territoryId === undefined)).toBe(true)
    expect(planned.plannedCells).toBe(2)
    expect(planned.unfished).toEqual([])
  })

  it('plans territory-major, so one territory has a complete answer early', () => {
    const territories = [territory('a', 'billing', 10), territory('b', 'sessions', 10)]
    const planned = planTerritoryPasses({ territories, angles, passBudget: 24 })
    expect(planned.phases.map((p) => `${p.territoryId}/${p.id}`)).toEqual([
      'a/control-flow',
      'a/concurrency',
      'b/control-flow',
      'b/concurrency',
    ])
  })

  it('records every cell the pass budget cut, rather than trimming silently', () => {
    const territories = [territory('a', 'billing', 10), territory('b', 'sessions', 10)]
    const planned = planTerritoryPasses({ territories, angles, passBudget: 3 })
    expect(planned.phases).toHaveLength(3)
    expect(planned.plannedCells).toBe(4)
    // A cap silent about its tail teaches the reader that the tail was clean, so the one cell
    // nobody will fish is named by territory AND angle.
    expect(planned.unfished).toEqual([
      {
        territoryId: 'b',
        territoryLabel: 'sessions',
        phaseId: 'concurrency',
        phaseTitle: 'Concurrency',
      },
    ])
  })
})

describe('prioritiseTerritories', () => {
  const billing = territory('a', 'billing', 10_000)
  const sessions = territory('b', 'sessions', 90_000)

  it('sizes territories when nothing was focused', () => {
    expect(prioritiseTerritories([billing, sessions], null).map((t) => t.id)).toEqual(['b', 'a'])
  })

  it('puts a focused territory first, even when it is the smallest', () => {
    // Naming a subsystem is the deliberate act; a budget that cut it would be cutting the one
    // thing the person asked for.
    expect(prioritiseTerritories([billing, sessions], 'the billing flow').map((t) => t.id)).toEqual(
      ['a', 'b'],
    )
  })

  it('ignores focus words too short to mean a directory', () => {
    expect(prioritiseTerritories([billing, sessions], 'a an the').map((t) => t.id)).toEqual([
      'b',
      'a',
    ])
  })
})
