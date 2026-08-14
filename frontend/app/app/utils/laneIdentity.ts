import type { LaneGroup, LaneTaskEntry } from '~/utils/laneSort'
import type { RenderedLane } from '~/composables/useFrameLanes'

// ---------------------------------------------------------------------------
// Structural sharing for the swimlane output.
//
// WHY. The lane assembly (`useFrameLanes`) is a chain of computeds over the board blocks, both
// pending-gate indexes, the coarse agent-run summary and the open notifications. Any ONE execution
// event invalidates the whole chain for EVERY mounted frame, and the chain rebuilds every entry,
// every group and every lane as fresh objects. Vue then sees new identities all the way down, so
// `TaskLane` / `LaneGroup` re-render and every card diff re-runs — even for the (common) case where
// the event changed one run's progress and moved nothing.
//
// WHAT THIS DOES. Compare the freshly built value against the previous one field by field and hand
// BACK the previous object wherever nothing changed, so `===` holds for the parts that did not
// move. Reuse cascades: unchanged entries let a group be reused, unchanged groups let a lane be
// reused, unchanged lanes let the whole array be reused.
//
// THE CORRECTNESS RULE. Reuse is only sound when the reused object is observationally identical to
// the fresh one, so the comparison must cover EVERY field the renderer can read. `task` is compared
// by REFERENCE, which is what makes that hold for the whole `Block` behind it: the board store
// replaces a block object on every write to it, so a changed task is a changed reference. A field
// added to `LaneTaskEntry` must be added to {@link sameEntry} in the same change, which is why that
// function destructures rather than reading through a loop over keys.
// ---------------------------------------------------------------------------

function sameEntry(a: LaneTaskEntry, b: LaneTaskEntry): boolean {
  return (
    a.task === b.task &&
    a.reason === b.reason &&
    a.order === b.order &&
    a.activityAt === b.activityAt &&
    a.waitingSince === b.waitingSince &&
    a.moduleName === b.moduleName &&
    a.initiativeName === b.initiativeName &&
    a.epicName === b.epicName
  )
}

/** Element-wise reuse: the previous array when every member matched, else the fresh one. */
function shareList<T>(
  previous: readonly T[] | undefined,
  next: T[],
  same: (a: T, b: T) => boolean,
  reuse?: (previous: T, next: T) => T,
): T[] {
  if (!previous || previous.length !== next.length) return next
  let changed = false
  const shared = next.map((item, i) => {
    const prior = previous[i]!
    if (same(prior, item)) return prior
    const merged = reuse ? reuse(prior, item) : item
    if (merged !== prior) changed = true
    return merged
  })
  return changed ? shared : (previous as T[])
}

function sameGroup(a: LaneGroup, b: LaneGroup): boolean {
  return a.id === b.id && a.label === b.label && a.entries === b.entries
}

function reuseGroup(previous: LaneGroup, next: LaneGroup): LaneGroup {
  if (previous.id !== next.id || previous.label !== next.label) return next
  const entries = shareList(previous.entries, next.entries, sameEntry)
  return entries === previous.entries ? previous : { ...next, entries }
}

function sameLane(a: RenderedLane, b: RenderedLane): boolean {
  return a.lane === b.lane && a.total === b.total && a.groups === b.groups
}

function reuseLane(previous: RenderedLane, next: RenderedLane): RenderedLane {
  if (previous.lane !== next.lane || previous.total !== next.total) return next
  const groups = shareList(previous.groups, next.groups, sameGroup, reuseGroup)
  return groups === previous.groups ? previous : { ...next, groups }
}

/**
 * A per-frame memo that hands back the previously rendered lanes wherever the freshly assembled
 * ones are identical.
 *
 * Holds ONE generation, not a cache: the previous result is the only thing a recompute can share
 * with, so there is nothing to evict and nothing to bound. Created per `useFrameLanes` instance, so
 * it lives and dies with the frame that owns it.
 */
export function createLaneMemo(): (next: RenderedLane[]) => RenderedLane[] {
  let previous: RenderedLane[] | undefined
  return (next) => {
    previous = shareList(previous, next, sameLane, reuseLane)
    return previous
  }
}
