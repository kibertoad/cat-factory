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

  it('walks from the service directory, and speaks in the frame the AGENT works in', () => {
    // The agent's checkout is rooted at `<clone>/packages/api`, so the manifest it is handed and
    // the paths it reports back are relative to THAT. A repo-relative manifest would list files it
    // cannot open, and every finding it reported would land outside every root.
    const survey = partitionCodebase(
      {
        entries: [
          ...bulk('packages/api/billing', 4, 200_000),
          ...bulk('packages/api/sessions', 4, 200_000),
          ...bulk('packages/web', 4, 200_000),
        ],
        truncated: false,
      },
      { serviceDirectory: 'packages/api' },
    )
    expect(survey.territories.map((t) => t.label).sort()).toEqual(['billing', 'sessions'])
    const files = [...survey.filesByTerritory.values()].flat()
    expect(
      files.every((f) => f.path.startsWith('billing/') || f.path.startsWith('sessions/')),
    ).toBe(true)
    // The subtree sha is still looked up in the TREE's own frame, so the rebase does not cost the
    // "has this territory changed" compare.
    expect(survey.territories.every((t) => t.subtreeShas?.[0]?.startsWith('tree-'))).toBe(true)
  })

  it('gives the files loose at a root their own NAMED territory, owning themselves', () => {
    // A root-level file used to bucket under the survey root itself: an empty id, which every
    // reader treats as "no territory" (so the pass was dispatched unscoped and unbriefed), and an
    // empty root, which as a prefix matches nothing (so every finding on one of those files was
    // dropped as somebody else's ground).
    const survey = partitionCodebase({
      entries: [
        ...bulk('billing', 4, 200_000),
        ...bulk('sessions', 4, 200_000),
        file('README.md', 400_000),
        file('index.ts', 400_000),
      ],
      truncated: false,
    })
    const loose = survey.territories.find((t) => (t.roots ?? []).includes('README.md'))!
    expect(loose.id).not.toBe('')
    expect(loose.label).toBe('Top-level files')
    // Roots and manifest are the SAME list, in the manifest's own order: the roots ARE the files.
    const manifest = survey.filesByTerritory.get(loose.id)?.map((f) => f.path)
    expect(manifest).toEqual(['index.ts', 'README.md'])
    expect(loose.roots).toEqual(manifest)
  })

  it('never gives two territories the same id, however their stems collide', () => {
    // Ids are DERIVED, so they collide: two blueprint modules that share a name (or a first
    // reference) derived one id, and the second then overwrote the first's manifest in a map
    // keyed by it, leaving every lookup resolving both to one set of roots.
    const survey = partitionCodebase(
      {
        entries: [...bulk('src/a', 4, 200_000), ...bulk('src/b', 4, 200_000)],
        truncated: false,
      },
      {
        blueprint: {
          type: 'service',
          name: 'app',
          summary: '',
          references: [],
          modules: [
            { name: 'Core', summary: '', references: ['src/a'] },
            { name: 'Core', summary: '', references: ['src/b'] },
          ],
        },
      },
    )
    const ids = survey.territories.map((t) => t.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(ids.length)
    // Each keeps its OWN manifest, which is the thing the collision actually cost.
    expect(survey.territories.map((t) => survey.filesByTerritory.get(t.id)?.[0]?.path)).toEqual([
      'src/a/f0.ts',
      'src/b/f0.ts',
    ])
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

  it('names the cut angles when the survey produced no territory to name them by', () => {
    // The budget can cut angles on an expedition whose repository nobody could read, and that is
    // exactly the run whose tail a reader would otherwise take for clean. Deriving the tail from
    // the CELLS left it empty, because there was no territory to build a cell from.
    const planned = planTerritoryPasses({ territories: [], angles, passBudget: 1 })
    expect(planned.phases).toHaveLength(1)
    expect(planned.plannedCells).toBe(2)
    expect(planned.unfished.map((cell) => cell.phaseId)).toEqual(['concurrency'])
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
