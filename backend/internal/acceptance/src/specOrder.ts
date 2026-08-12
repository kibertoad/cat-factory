// The ORDER the five spec files run in, which is the suite's premise rather than a preference.
//
// The specs are ONE narrative: spec 01 adopts the two services spec 02 ships a feature across, spec
// 03 investigates the defect that feature left, and spec 04 delivers an issue against the same
// board. Each one reads what the previous recorded, through the on-disk ledger, so a spec that runs
// before its predecessor cannot do anything but fail on a ledger key nobody has written yet.
//
// **`fileParallelism: false` and `maxWorkers: 1` do NOT give that order.** They prevent two specs
// from running AT ONCE, which is a different property, and the config carried both while believing
// they carried this one. Vitest's default `BaseSequencer.sort()` reorders the files it is handed by
// a cache of the PREVIOUS run: previously-failed files first, then longest-duration first, falling
// back to largest-file-first when it has no result for one of them. Every rule there is right for an
// ordinary suite, where reordering is free and finding the failure sooner is the whole point.
//
// Here it is the opposite. Paired with `bail: 1`, whichever spec was SLOWEST last time runs first,
// fails on an empty ledger in two milliseconds, and stops the run before the spec that would have
// populated that ledger has started. The suite then reports the LAST spec as the failure of a pass
// in which nothing else ran at all, which reads as leftover state rather than as a misordering, and
// the remedy it prints ("run the suite from the start") is the thing that just happened.
//
// So the order is pinned to the FILE NAME, which is what the numeric prefixes have always claimed
// and nothing enforced. The rule is a pure function so the property can be asserted without vitest
// internals, and the sequencer below is the two-line adapter that hands it to vitest.

import { BaseSequencer, type TestSpecification } from 'vitest/node'

/**
 * Sort spec module ids into the order the narrative requires: by FILE NAME, ascending.
 *
 * The basename rather than the whole path, because the numeric prefix is what carries the narrative
 * and a directory component would sort ahead of it. Plain relational comparison rather than
 * `localeCompare`, which is locale-sensitive: the ICU collation for a locale that treats digits
 * specially is not something a test running on one machine can see and a pass running on another
 * cannot. Zero-padded prefixes make lexicographic order numeric order, which is why they are padded.
 *
 * The full id breaks ties, so two files with one basename in different directories still land in a
 * fixed order rather than one the input happened to have.
 */
export function orderSpecModuleIds(moduleIds: readonly string[]): readonly string[] {
  return [...moduleIds].sort(compareSpecModuleIds)
}

/** The comparator itself, exported so the sequencer and the test share one rule. */
export function compareSpecModuleIds(a: string, b: string): number {
  const nameA = basename(a)
  const nameB = basename(b)
  if (nameA !== nameB) return nameA < nameB ? -1 : 1
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * The file name, from either separator.
 *
 * Hand-rolled rather than `node:path`'s, because a `moduleId` is a Vite module id and is
 * forward-slashed even on Windows, where `path.basename` splits on the platform separator and would
 * hand back the whole path. That failure is invisible on POSIX and total on Windows, which is the
 * machine this suite is being run from.
 */
function basename(moduleId: string): string {
  const cut = Math.max(moduleId.lastIndexOf('/'), moduleId.lastIndexOf('\\'))
  return cut === -1 ? moduleId : moduleId.slice(cut + 1)
}

/**
 * Vitest's sequencer, with `sort` replaced by the rule above and `shard` left alone.
 *
 * Only `sort` is overridden: sharding this suite is meaningless (one worker, one narrative) but the
 * base implementation is harmless, and replacing a method nothing calls would be a second thing to
 * keep correct.
 */
export class NarrativeSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => compareSpecModuleIds(a.moduleId, b.moduleId))
  }
}
