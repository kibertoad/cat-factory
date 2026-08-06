/**
 * Pure source-selection logic shared by every surface that picks an integration source: which
 * one is selected, and what its menu offers. Kept out of the components so their `computed`s
 * and the unit spec call the same code.
 *
 * The menu is deliberately two-tier — pick a source the workspace already has, or go and add
 * one — because a source-picking surface is exactly where a user discovers the source they want
 * is missing, and sending them off to the Integrations hub loses whatever they had in progress.
 * Today `<ContextIssuePicker>` (attach a context issue) and `<BugHuntModal>` (scan a board for
 * bugs) render it over TRACKERS, and `<ContextDocumentPicker>` (attach a context document) over
 * DOCUMENT sources.
 *
 * It is generic over the source union rather than pinned to trackers because the two
 * integrations describe availability differently (a tracker carries `available` plus a
 * per-workspace `enabled` toggle; a document source is either connected or not) while the menu
 * they owe the user is the same. Each caller normalises its own state into
 * {@link SourceAvailability}, so the rendering rule lives in exactly one place.
 */

/** What a menu needs to know about one configured source, whatever integration it belongs to. */
export interface SourceAvailability<S extends string> {
  source: S
  label: string
  icon: string
  /** A credential / installation is in place, so the source can be read right now. */
  available: boolean
  /**
   * The workspace offers it. A tracker carries a per-workspace toggle that can be off while its
   * credential is in place; an integration with no such toggle passes `true`.
   */
  enabled: boolean
}

/** One row of a source menu. */
export type SourceChoice<S extends string> =
  /** A source the surface can use right now. */
  | { action: 'select'; source: S; label: string; icon: string; active: boolean }
  /**
   * A configured source that is not offered yet, so it can be added from here. `connect`
   * has no credential/App behind it; `enable` is connected but toggled off for the
   * workspace. Both open the same connect modal, which serves either case — only the
   * wording differs, so the user isn't told to "connect" something already connected.
   */
  | { action: 'connect' | 'enable'; source: S; label: string; icon: string }

/**
 * A source menu, as non-empty groups (the sources on offer, then the ones the user could add).
 * Empty groups are dropped so the menu never renders a stray separator.
 */
export function buildSourceChoices<S extends string>(
  sources: readonly SourceAvailability<S>[],
  selected: S | undefined,
): SourceChoice<S>[][] {
  const offered: SourceChoice<S>[] = []
  const addable: SourceChoice<S>[] = []
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
 * {@link SourceAvailability} rows for an integration whose only state is "connected or not"
 * (document sources, which carry no per-workspace enable toggle), with the sources the acting
 * user may not connect WITHHELD.
 *
 * That withholding is the permission split the two document surfaces already apply: attaching a
 * document is member-tier, while connecting a source stores a workspace credential and stays
 * admin-tier. Offering a member an add entry would open a connect modal, take a token and 403,
 * so what they see is what they can use.
 */
export function connectionSourceRows<S extends string>(
  sources: readonly { source: S; label: string; icon: string }[],
  opts: { isConnected: (source: S) => boolean; canConnect: boolean },
): SourceAvailability<S>[] {
  return sources
    .map((s) => ({
      source: s.source,
      label: s.label,
      icon: s.icon,
      available: opts.isConnected(s.source),
      enabled: true,
    }))
    .filter((row) => row.available || opts.canConnect)
}

/**
 * The source a surface should hold once the offered set changes — after a connect, a
 * disconnect, or the per-workspace toggle flipping elsewhere.
 *
 * `awaiting` is the source the user just left to connect: the moment it becomes offered
 * it wins, so they land back on the source they went to add rather than on whatever was
 * selected before. Otherwise a still-offered selection is kept, and a selection that
 * stopped being offered falls back to the first one (reading a source the workspace no
 * longer offers only yields errors).
 */
export function reconcileSource<S extends string>(
  offered: readonly S[],
  selected: S | undefined,
  awaiting: S | null,
): S | undefined {
  if (awaiting && offered.includes(awaiting)) return awaiting
  if (selected && offered.includes(selected)) return selected
  return offered[0]
}
