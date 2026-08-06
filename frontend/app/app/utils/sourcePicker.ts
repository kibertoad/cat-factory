/**
 * Pure source-selection logic shared by every surface that picks an integration source: which
 * one is selected, what its menu offers, and how that menu renders.
 *
 * The menu is deliberately two-tier (pick a source the workspace already has, or go and add one)
 * because a source-picking surface is exactly where a user discovers the source they want is
 * missing, and sending them off to the Integrations hub loses whatever they had in progress.
 * Today `<ContextIssuePicker>` (attach a context issue) and `<BugHuntModal>` (scan a board for
 * bugs) render it over TRACKERS, and `<ContextDocumentPicker>` (attach a context document) over
 * DOCUMENT sources.
 *
 * The two integrations describe availability differently, so each gets its own CHOICE builder and
 * they share one RENDERER. A tracker carries `available` plus a per-workspace `enabled` toggle, so
 * it can be connected-but-off and its add entry has to say "enable" rather than "connect"; a
 * document source is either connected or not, so `buildConnectionSourceChoices` cannot produce an
 * `enable` choice at all. That is a fact about its RETURN TYPE rather than a convention, which is
 * why these are two builders instead of one taking a flag: `sourceMenuItems` derives its wording
 * map from what the choices can actually carry, so a document surface is not asked for wording it
 * can never use, and a document source that one day GAINS a toggle fails the typecheck at every
 * surface that renders it.
 */
import type { DropdownMenuItem } from '@nuxt/ui'

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

/** A source whose only state is "connected or not", with no per-workspace toggle behind it. */
export interface ConnectableSource<S extends string> {
  source: S
  label: string
  icon: string
}

/** The two ways a source that is not on offer yet can be added from a menu. */
export type AddAction = 'connect' | 'enable'

/** A source the surface can use right now. */
interface SelectChoice<S extends string> {
  action: 'select'
  source: S
  label: string
  icon: string
  active: boolean
}

/**
 * A configured source that is not offered yet, so it can be added from here. `connect` has no
 * credential/App behind it; `enable` is connected but toggled off for the workspace. Both open the
 * same connect modal, which serves either case: only the wording differs, so the user isn't told
 * to "connect" something already connected.
 */
interface AddChoice<S extends string, A extends AddAction> {
  action: A
  source: S
  label: string
  icon: string
}

/** One row of a source menu over an integration that has a per-workspace enable toggle. */
export type SourceChoice<S extends string> = SelectChoice<S> | AddChoice<S, AddAction>

/** One row of a source menu over an integration that is simply connected or not. */
export type ConnectionSourceChoice<S extends string> = SelectChoice<S> | AddChoice<S, 'connect'>

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
 * The sources the acting user could add right now: those the workspace has not connected, and
 * NONE when the integration is unavailable to this deployment or the user may not connect one.
 *
 * The single answer to "which document sources could I connect", so the picker's add tier and the
 * hosts' connect shortcuts cannot drift. Both terms matter and neither implies the other: an
 * unavailable integration has nothing to connect TO, and connecting stores a workspace credential,
 * which is admin-tier while ATTACHING what it holds is member-tier. Offering a member an add entry
 * would open a connect modal, take a token and 403, so what they see is what they can use.
 *
 * `available` is the store's probe result, so `null` (not probed yet) offers nothing: we do not know
 * that there is anything to connect to, and a menu entry is a claim that there is.
 */
export function connectableSources<S extends string, T extends { source: S }>(
  sources: readonly T[],
  opts: { isConnected: (source: S) => boolean; canConnect: boolean; available: boolean | null },
): T[] {
  if (opts.available !== true || !opts.canConnect) return []
  return sources.filter((s) => !opts.isConnected(s.source))
}

/**
 * A source menu for an integration that is either connected or not (document sources). Same two
 * groups as {@link buildSourceChoices}, but the add tier can only ever be `connect`.
 */
export function buildConnectionSourceChoices<S extends string>(
  sources: readonly ConnectableSource<S>[],
  opts: {
    isConnected: (source: S) => boolean
    canConnect: boolean
    available: boolean | null
    selected: S | undefined
  },
): ConnectionSourceChoice<S>[][] {
  const connected: ConnectionSourceChoice<S>[] = sources
    .filter((s) => opts.isConnected(s.source))
    .map((s) => ({
      action: 'select',
      source: s.source,
      label: s.label,
      icon: s.icon,
      active: s.source === opts.selected,
    }))
  const addable: ConnectionSourceChoice<S>[] = connectableSources(sources, opts).map((s) => ({
    action: 'connect',
    source: s.source,
    label: s.label,
    icon: s.icon,
  }))
  return [connected, addable].filter((group) => group.length > 0)
}

/**
 * Wording for each way a source can be ADDED, as an exhaustive `Record` over exactly the add
 * actions the menu's own choices can carry. A tracker surface owes both spellings; a document
 * surface owes only `connect`, and gains a typecheck failure rather than the wrong wording if that
 * ever stops being true.
 */
export type AddSourceLabels<A extends AddAction> = Record<A, (label: string) => string>

/**
 * Render source choices as dropdown items. The ONE place the two-tier menu's presentation lives:
 * the selected source is a CHECKED item rather than one carrying a decorative glyph, so a screen
 * reader announces which source is in use instead of just naming it, and every add entry carries
 * the plug icon that distinguishes "go and set this up" from "use this".
 */
export function sourceMenuItems<S extends string, A extends AddAction>(
  groups: readonly (readonly (SelectChoice<S> | AddChoice<S, A>)[])[],
  opts: {
    onSelect: (source: S) => void
    onAdd: (source: S) => void
    addLabel: AddSourceLabels<A>
  },
): DropdownMenuItem[][] {
  return groups.map((group) =>
    group.map((choice) =>
      isAddChoice(choice)
        ? {
            label: opts.addLabel[choice.action](choice.label),
            icon: 'i-lucide-plug',
            onSelect: () => opts.onAdd(choice.source),
          }
        : {
            label: choice.label,
            icon: choice.icon,
            type: 'checkbox' as const,
            checked: choice.active,
            onSelect: () => opts.onSelect(choice.source),
          },
    ),
  )
}

/**
 * Whether a choice is an ADD entry. A hand-written predicate because the add member's `action` is
 * the type parameter `A` rather than a literal, and TypeScript will not narrow a generic discriminant
 * on its own: without this, reading `.active` off the select half fails to compile.
 */
function isAddChoice<S extends string, A extends AddAction>(
  choice: SelectChoice<S> | AddChoice<S, A>,
): choice is AddChoice<S, A> {
  return choice.action !== 'select'
}

/**
 * The ADD half of a menu's choices, flattened: what a surface renders as buttons when nothing is
 * offered yet and there is no selection to make. Narrowed here rather than at each call site so the
 * wording map stays exhaustive over what actually arrives, and so a `select` choice cannot leak into
 * a row that offers to connect a source the workspace already has.
 */
export function addChoicesOf<S extends string, A extends AddAction>(
  groups: readonly (readonly (SelectChoice<S> | AddChoice<S, A>)[])[],
): AddChoice<S, A>[] {
  return groups.flat().filter((choice) => isAddChoice(choice))
}

/**
 * Whether a source menu has anything to decide. With a single entry the trigger can only re-pick
 * what is already selected, so a surface names the source as a LABEL instead: a chevron opening a
 * one-item menu promises a choice that isn't there. The state is reached most often by a member,
 * whose add tier is withheld (see {@link connectableSources}), which is exactly the reader least
 * able to tell a dead control from a broken one.
 */
export function menuIsPickable(groups: readonly (readonly unknown[])[]): boolean {
  return groups.reduce((total, group) => total + group.length, 0) > 1
}

/**
 * The source a surface should hold once the offered set changes: after a connect, a disconnect, or
 * the per-workspace toggle flipping elsewhere.
 *
 * `awaiting` is the source the user just left to connect: the moment it becomes offered it wins, so
 * they land back on the source they went to add rather than on whatever was selected before.
 * Otherwise a still-offered selection is kept, and a selection that stopped being offered falls
 * back to the first one (reading a source the workspace no longer offers only yields errors).
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
