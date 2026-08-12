import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { TestSpecification } from 'vitest/node'
import { compareSpecModuleIds, NarrativeSequencer, orderSpecModuleIds } from '../src/specOrder.ts'

// What is pinned here is that the five specs run as a NARRATIVE, in file-name order, whatever order
// vitest hands them over in. The suite's config prevents them running at once and used to claim that
// was the same property; it is not, and the difference is invisible until the day the default
// sequencer reorders them, at which point `bail: 1` turns a misordering into a pass where one spec
// runs and reports the ledger key the spec before it would have written.

const specDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'acceptance')

describe('orderSpecModuleIds', () => {
  it('sorts by file name whatever order it is handed', () => {
    expect(
      orderSpecModuleIds([
        '/repo/acceptance/02-feature-with-defect.acceptance.ts',
        '/repo/acceptance/00-preflight.acceptance.ts',
        '/repo/acceptance/04-issue-intake-to-close.acceptance.ts',
        '/repo/acceptance/01-adopt-and-scaffold.acceptance.ts',
        '/repo/acceptance/03-investigate-and-fix.acceptance.ts',
      ]),
    ).toEqual([
      '/repo/acceptance/00-preflight.acceptance.ts',
      '/repo/acceptance/01-adopt-and-scaffold.acceptance.ts',
      '/repo/acceptance/02-feature-with-defect.acceptance.ts',
      '/repo/acceptance/03-investigate-and-fix.acceptance.ts',
      '/repo/acceptance/04-issue-intake-to-close.acceptance.ts',
    ])
  })

  // The exact input the default sequencer produced on the pass that made this necessary: every spec
  // cached as failed, so it fell through to longest-duration-first and led with the LAST spec.
  it('undoes the longest-duration-first order the default sequencer produced', () => {
    const byPreviousDuration = [
      '/repo/acceptance/04-issue-intake-to-close.acceptance.ts', // 1337ms
      '/repo/acceptance/00-preflight.acceptance.ts', //  798ms
      '/repo/acceptance/03-investigate-and-fix.acceptance.ts', //  732ms
      '/repo/acceptance/02-feature-with-defect.acceptance.ts', //  583ms
      '/repo/acceptance/01-adopt-and-scaffold.acceptance.ts', //  580ms
    ]
    expect(orderSpecModuleIds(byPreviousDuration).map(numericPrefix)).toEqual([0, 1, 2, 3, 4])
  })

  it('is idempotent, so a sorted list survives a second pass unchanged', () => {
    const sorted = orderSpecModuleIds(realSpecModuleIds())
    expect(orderSpecModuleIds(sorted)).toEqual(sorted)
  })

  // Vite module ids are forward-slashed even on Windows, so `node:path`'s basename would hand back
  // the whole path there and sort by the directory instead. The suite is routinely run from Windows,
  // where that failure is total and silent, and never reproduces on the machine CI runs the unit
  // tests on.
  it('reads the file name from either separator, so a directory cannot decide the order', () => {
    expect(
      orderSpecModuleIds([
        'C:/zzz/04-issue-intake-to-close.acceptance.ts',
        'C:\\aaa\\01-adopt-and-scaffold.acceptance.ts',
      ]),
    ).toEqual([
      'C:\\aaa\\01-adopt-and-scaffold.acceptance.ts',
      'C:/zzz/04-issue-intake-to-close.acceptance.ts',
    ])
  })

  it('breaks a tie on the full id, so one basename in two directories still has a fixed order', () => {
    const ids = ['/b/01-adopt-and-scaffold.acceptance.ts', '/a/01-adopt-and-scaffold.acceptance.ts']
    expect(orderSpecModuleIds(ids)).toEqual([
      '/a/01-adopt-and-scaffold.acceptance.ts',
      '/b/01-adopt-and-scaffold.acceptance.ts',
    ])
    expect(compareSpecModuleIds(ids[0]!, ids[0]!)).toBe(0)
  })
})

describe('NarrativeSequencer', () => {
  // The adapter, not the rule: what this catches is the sequencer being wired to something OTHER
  // than the comparator (or vitest's own `sort` surviving an override that renamed itself), which
  // every test above would still pass through.
  it('hands vitest the file-name order rather than the order it was given', async () => {
    const sequencer = new NarrativeSequencer({} as never)
    const given = [
      spec('/repo/acceptance/04-issue-intake-to-close.acceptance.ts'),
      spec('/repo/acceptance/00-preflight.acceptance.ts'),
      spec('/repo/acceptance/02-feature-with-defect.acceptance.ts'),
    ]
    const sorted = await sequencer.sort(given)
    expect(sorted.map((entry) => entry.moduleId)).toEqual([
      '/repo/acceptance/00-preflight.acceptance.ts',
      '/repo/acceptance/02-feature-with-defect.acceptance.ts',
      '/repo/acceptance/04-issue-intake-to-close.acceptance.ts',
    ])
    // The input is not mutated: vitest reuses the array it passed in.
    expect(given[0]?.moduleId).toBe('/repo/acceptance/04-issue-intake-to-close.acceptance.ts')
  })
})

describe('the specs on disk', () => {
  // Derived from the directory rather than a list repeated here: a sixth spec is an ordinary
  // addition, and a test that pinned five would fail on it while naming nothing about ordering.
  it('carry a unique numeric prefix, which is what makes file-name order the narrative order', () => {
    const prefixes = realSpecModuleIds().map(numericPrefix)
    expect(prefixes.every((prefix) => Number.isInteger(prefix))).toBe(true)
    expect(new Set(prefixes).size).toBe(prefixes.length)
  })

  it('come out in ascending prefix order from any starting order', () => {
    const ids = realSpecModuleIds()
    expect(ids.length).toBeGreaterThan(1)
    const ordered = orderSpecModuleIds([...ids].reverse())
    const prefixes = ordered.map(numericPrefix)
    expect(prefixes).toEqual([...prefixes].sort((a, b) => a - b))
    // Every spec accounted for exactly once: an ordering that DROPPED one would still be ascending.
    expect(new Set(ordered)).toEqual(new Set(ids))
    expect(ordered).toHaveLength(ids.length)
  })
})

/** The one field the sequencer reads, which is all a `TestSpecification` needs to be here. */
function spec(moduleId: string): TestSpecification {
  return { moduleId } as TestSpecification
}

function realSpecModuleIds(): readonly string[] {
  return readdirSync(specDir)
    .filter((name) => name.endsWith('.acceptance.ts'))
    .map((name) => `${specDir}/${name}`)
}

function numericPrefix(moduleId: string): number {
  const name = moduleId.split(/[\\/]/).pop() ?? ''
  return Number.parseInt(name.slice(0, name.indexOf('-')), 10)
}
