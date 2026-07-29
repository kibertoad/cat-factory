import type { TaskSourceKind, TaskSourceState } from '~/types/domain'

/**
 * Pure tracker-selection logic shared by every surface that picks a task source: which
 * tracker is selected, and what its menu offers. Kept out of the components so their
 * `computed`s and the unit spec call the same code.
 *
 * The menu is deliberately two-tier — pick an already-offered tracker, or go and add
 * one — because a tracker-picking surface is exactly where a user discovers the tracker
 * they want is missing, and sending them off to the Integrations hub loses whatever they
 * had in progress. Today `<ContextIssuePicker>` (attach a context issue) and
 * `<BugHuntModal>` (scan a board for bugs) both render it.
 */

/** One row of a tracker menu. */
export type SourceChoice =
  /** An offered tracker the surface can use right now. */
  | { action: 'select'; source: TaskSourceKind; label: string; icon: string; active: boolean }
  /**
   * A configured tracker that is not offered yet, so it can be added from here. `connect`
   * has no credential/App behind it; `enable` is connected but toggled off for the
   * workspace. Both open the same connect modal, which serves either case — only the
   * wording differs, so the user isn't told to "connect" something already connected.
   */
  | { action: 'connect' | 'enable'; source: TaskSourceKind; label: string; icon: string }

/**
 * A tracker menu, as non-empty groups (the offered trackers, then the ones the user could
 * add). Empty groups are dropped so the menu never renders a stray separator.
 */
export function buildSourceChoices(
  sources: TaskSourceState[],
  selected: TaskSourceKind | undefined,
): SourceChoice[][] {
  const offered: SourceChoice[] = []
  const addable: SourceChoice[] = []
  for (const s of sources) {
    if (s.available && s.enabled) {
      offered.push({
        action: 'select',
        source: s.source,
        label: s.label,
        icon: s.icon,
        active: s.source === selected,
      })
    } else {
      addable.push({
        action: s.available ? 'enable' : 'connect',
        source: s.source,
        label: s.label,
        icon: s.icon,
      })
    }
  }
  return [offered, addable].filter((group) => group.length > 0)
}

/**
 * The source a surface should hold once the offered set changes — after a connect, a
 * disconnect, or the per-workspace toggle flipping elsewhere.
 *
 * `awaiting` is the tracker the user just left to connect: the moment it becomes offered
 * it wins, so they land back on the source they went to add rather than on whatever was
 * selected before. Otherwise a still-offered selection is kept, and a selection that
 * stopped being offered falls back to the first one (reading a tracker the workspace no
 * longer offers only yields errors).
 */
export function reconcileSource(
  offered: TaskSourceKind[],
  selected: TaskSourceKind | undefined,
  awaiting: TaskSourceKind | null,
): TaskSourceKind | undefined {
  if (awaiting && offered.includes(awaiting)) return awaiting
  if (selected && offered.includes(selected)) return selected
  return offered[0]
}
