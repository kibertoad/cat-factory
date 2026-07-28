import type { TaskSourceKind, TaskSourceState } from '~/types/domain'

/**
 * Pure source-selection logic for `<ContextIssuePicker>`: which tracker the picker is
 * searching, and what the source menu offers. Kept out of the component so both the
 * template's `computed`s and the unit spec call the same code.
 *
 * The menu is deliberately two-tier — pick an already-offered tracker, or go and add
 * one — because "attach a context issue" is where a user first discovers a tracker is
 * missing, and sending them to the Integrations hub loses their in-progress task.
 */

/** One row of the picker's source menu. */
export type SourceChoice =
  /** An offered tracker the picker can search right now. */
  | { action: 'select'; source: TaskSourceKind; label: string; icon: string; active: boolean }
  /**
   * A configured tracker that is not offered yet, so it can be added from here. `connect`
   * has no credential/App behind it; `enable` is connected but toggled off for the
   * workspace. Both open the same connect modal, which serves either case — only the
   * wording differs, so the user isn't told to "connect" something already connected.
   */
  | { action: 'connect' | 'enable'; source: TaskSourceKind; label: string; icon: string }

/**
 * The picker's source menu, as non-empty groups (the offered trackers, then the ones the
 * user could add). Empty groups are dropped so the menu never renders a stray separator.
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
 * The source the picker should hold once the offered set changes — after a connect, a
 * disconnect, or the per-workspace toggle flipping elsewhere.
 *
 * `awaiting` is the tracker the user just left to connect: the moment it becomes offered
 * it wins, so they land back on the source they went to add rather than on whatever was
 * selected before. Otherwise a still-offered selection is kept, and a selection that
 * stopped being offered falls back to the first one (searching a tracker the workspace no
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
