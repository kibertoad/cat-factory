import type { NavGates } from '~/modular/nav-contributions'

/**
 * In-app tutorial tours: the pure data model + geometry, shared by the tour catalog
 * (`modular/tutorial-tours.ts`), the tutorial store, and the coach-mark overlay
 * (`components/tutorial/TutorialOverlay.vue`).
 *
 * A tour is DATA, not components: an ordered list of steps, each pointing at an existing
 * on-screen control by its `data-testid` and carrying i18n keys for what to tell the user.
 * That keeps tours declarative (a consumer deployment contributes its own through the
 * `tutorialTours` slot via `registerAppModule`, exactly like nav items) and keeps the whole
 * runtime — anchor tracking, tooltip placement, advance handling — in ONE overlay component
 * that every tour shares.
 */

/** How a step advances to the next one. */
export type TutorialAdvance =
  /** The user reads and presses the tooltip's Next button (the default). */
  | 'next'
  /**
   * The user clicks the highlighted control itself — the "now click this" steps. The
   * tooltip shows a click hint instead of a Next button, so the app reacts to the real
   * click (opening the real modal, creating the real task) and the tour follows along.
   */
  | 'target-click'

/** Preferred tooltip side relative to the anchor; the overlay falls back when it can't fit. */
export type TutorialPlacement = 'top' | 'bottom' | 'left' | 'right'

export interface TutorialStep {
  /** Stable id, unique within the tour (progress display + specs key off it). */
  id: string
  /**
   * `data-testid` of the control this step points at. Absent = a centered card (intro /
   * wrap-up steps). Reusing the e2e anchor vocabulary is deliberate: those ids are already
   * the stable, behaviour-neutral way to name a control, and a tour stop is the same kind
   * of consumer as a spec.
   *
   * A target names a KIND of control, not one instance: where several are on screen (one
   * `task-card` per task, one `frame-add-task` per service) the first VISIBLE match wins,
   * which may not be the one the user just produced. That is accepted rather than worked
   * around — a tour teaches an affordance, and every match demonstrates the same one — so
   * step copy must read correctly against any of them ("this is a task card", not "this is
   * the task you just made").
   */
  target?: string
  /**
   * Fallback `data-testid`s tried in order when {@link target} is absent from the DOM —
   * for controls that render under a different id in some states (e.g. a frame's add-task
   * button on an empty frame).
   */
  altTargets?: readonly string[]
  titleKey: string
  bodyKey: string
  /**
   * Interpolation values for {@link bodyKey}'s `{named}` placeholders.
   *
   * The reason this exists rather than the value living in the catalogs: a step that names
   * something FIXED and untranslatable — the sample repository a tour tells you to search
   * for — would otherwise be spelled out in `en.json` and copied into nine other locales,
   * where it reads as prose to translate and drifts the moment the value changes. Declared
   * here it is written once, in code, beside the tour that needs it.
   *
   * Prose still belongs in the catalog: this is for proper nouns and code-shaped literals,
   * the same split `frontend/app/README.md` states for inline placeholders in components.
   */
  bodyParams?: Record<string, string | number>
  placement?: TutorialPlacement
  /** Defaults to `'next'`. */
  advanceOn?: TutorialAdvance
  /**
   * How long the overlay waits for the target to appear before SKIPPING the step
   * (ms, default {@link DEFAULT_TARGET_WAIT_MS}). A missing anchor is expected, not an
   * error: the control may be RBAC-hidden, tier-hidden, or simply not part of this
   * deployment, and a tour must degrade to the steps that do apply. Steps whose target
   * only appears after the previous step's click (inside a just-opened modal) may need a
   * longer wait.
   */
  waitForTargetMs?: number
  /**
   * Applicability gate over the same reactive {@link NavGates} the tour's own `when` reads.
   * A step this rejects is DROPPED from the tour before it runs; absent = always included.
   *
   * Deliberately distinct from the anchor skip above, because the two are different facts
   * and only one of them is a defect in the tour. A skip means "this step's control should
   * be here and isn't", which is what the final card reports as an abridged walkthrough. A
   * `when` says "this branch of the flow is not what this board is doing" — a run parked on
   * a decision has no approval gate to point at, and vice versa. Rendering the second as
   * the first would tell a user who saw exactly the right walkthrough that they missed
   * half of it, every single time.
   *
   * Use it only for a step whose ABSENCE is expected on a legitimate board; an anchor that
   * merely might be slow keeps the wait budget instead.
   */
  when?: (gates: NavGates) => boolean
}

/**
 * One named precondition a tour needs before it can be taken — a board write permission, a
 * source-control connection, a service on the board.
 *
 * A DECLARED object rather than the bare `when(gates)` predicate a tour used to carry, because
 * the catalogue has to say why a tour it is showing cannot be started right now. A predicate
 * answers only "no", and a surface that lists what it can offer while silently omitting the
 * rest reads exactly like a deployment that ships four tours instead of six — the "absent and
 * zero must never render the same" rule, applied to a catalog. Pairing the predicate with the
 * i18n key that NAMES it means the reason is computed from the same fact that withheld the
 * tour, rather than restated beside it and left to drift.
 *
 * A consumer deployment writes its own: this is a plain object with its own copy key, so it
 * needs no registration and no entry in a first-party table.
 */
export interface TutorialRequirement {
  /** Stable id, unique within a tour's list; the catalogue keys its reason list on it. */
  id: string
  /** i18n key naming the requirement as a noun phrase ("A service on the board"). */
  labelKey: string
  /** Whether this board/user currently satisfies it. */
  met: (gates: NavGates) => boolean
}

export interface TutorialTour {
  /** Stable id; completion is persisted against it, so renaming one resets its state. */
  id: string
  titleKey: string
  descriptionKey: string
  icon?: string
  /** Sort key in the tour list; ties break on `id` so the order is deterministic. */
  order: number
  /**
   * Whether the LAUNCH PROMPT offers this tour. Absent = offered, so a consumer deployment's
   * own tour appears beside the built-ins with nothing to declare.
   *
   * The prompt is one question a new user is trying to answer in a glance; the catalogue is the
   * library. That split only holds while the prompt stays short, and the catalog does not: the
   * built-ins now cover the platform (the engine, the pipeline builder, the standards library,
   * the integrations) alongside the delivery loop, and every platform tour is startable on a
   * brand-new board, because all it needs is a permission. Offered unfiltered they would put
   * six walkthroughs in front of someone whose board has neither a repository nor a task,
   * burying the two they can act on under four they have no reason to care about yet.
   *
   * This thins an OFFER, never the library — the distinction {@link resolveTourCatalogue} exists
   * to keep. An un-offered tour is listed, startable, counted in the progress line and reachable
   * from the prompt's own "See all tutorials" footer button, so nothing here can make a
   * walkthrough disappear; only `requires` can hold one back, and that is always reported.
   */
  offeredAtLaunch?: boolean
  /**
   * What this board/user must have before the tour can run, over the same reactive
   * {@link NavGates} the nav catalog uses — so a tour about a surface the caller can't reach
   * (no board write, no source control) is never started, and the catalogue can say which of
   * these is the one still missing. Absent = always available.
   */
  requires?: readonly TutorialRequirement[]
  steps: readonly TutorialStep[]
}

/** How long the overlay polls for a step's anchor before auto-skipping the step. */
export const DEFAULT_TARGET_WAIT_MS = 4000

/**
 * How often the overlay re-queries the DOM while it is still HUNTING for a step's anchor.
 * Fast on purpose — the anchor can appear at any moment (a modal mounting, a live event
 * landing a card) and every tick spent waiting is time the user stares at a "looking for
 * it" note — and bounded on purpose, by the step's own {@link DEFAULT_TARGET_WAIT_MS}-ish
 * budget, after which the step is skipped and the hunt stops.
 */
export const TARGET_TRACK_INTERVAL_MS = 150

/**
 * How often the overlay re-queries once it HAS an anchor.
 *
 * Anchored tracking is event-driven (scroll, resize, element resize, canvas pan/zoom), so
 * this interval is only the backstop for movement nothing reports — and it is the tick that
 * runs for the whole length of a tour, where the hunting one above is bounded by a step's
 * wait budget. It also re-RESOLVES the selector rather than re-measuring the cached element,
 * which is what lets a step re-anchor when the control it names is replaced underneath it.
 */
export const TARGET_IDLE_INTERVAL_MS = 400

/**
 * How much of an anchor has to be on screen before the overlay leaves the viewport alone.
 *
 * Measured against `min(anchorArea, viewportArea)`, not against the anchor's own area, because
 * the catalog points at controls of wildly different sizes: `add-task-submit` is a button that
 * must be almost wholly visible to be pointed at, while `board-canvas` and `sidebar` are bigger
 * than the viewport and can NEVER clear a fraction of their own area. Taking the smaller of the
 * two means "mostly visible" for a small control and "filling a good part of the screen" for a
 * large one, which is the same judgement in both cases.
 */
export const MIN_VISIBLE_RATIO = 0.5

/** Deterministic tour-list order: `order`, then `id`. */
export function sortTours(tours: readonly TutorialTour[]): TutorialTour[] {
  return [...tours].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

/**
 * Why a tour is or isn't offered right now.
 *
 * Three values rather than a boolean, because the two unavailable ones need different copy
 * and different action from the reader: `blocked` names things they can go and do (link a
 * repository, start a run), while `not-applicable` is a tour whose every step is about a
 * branch this board isn't on — nothing to fix, and telling someone to fix it would send them
 * looking for a control that was never missing.
 *
 * `blocked` OUTRANKS `not-applicable` when a tour is both, and that order is load-bearing: a
 * step's `when` reads the same gates the requirements do, so under UNMET requirements the step
 * filter is answering a hypothetical — what would apply on a board that, by construction, this
 * one is not. Reporting that as `not-applicable` would tell the reader there is nothing to be
 * done about a tour they can in fact unlock. The cost is the reverse case: a tour can be named
 * as unlockable and still turn out `not-applicable` once the requirement is met. See
 * {@link resolveTourCatalogue} for why a tour should not be authored that way.
 */
export type TutorialAvailability = 'ready' | 'blocked' | 'not-applicable'

/** One tour as this board sees it: the resolved script plus why it can (or can't) run. */
export interface TutorialCatalogueEntry {
  /** The tour with its inapplicable steps already dropped — what a start would run. */
  tour: TutorialTour
  availability: TutorialAvailability
  /** The requirements this board/user does not meet. Empty unless `blocked`. */
  unmet: readonly TutorialRequirement[]
}

/**
 * Resolve the whole catalog against the gates: which tours can run now, and for the rest,
 * exactly what is standing in the way.
 *
 * Per-step `when`s are applied here too, and a tour left with NO applicable steps is
 * `not-applicable` rather than ready. That rule is what makes per-step gating safe to reach
 * for: a tour whose every step is branch-specific (the parked-run tour — some boards have a
 * decision waiting, some an approval) would otherwise open on an empty cursor, which the
 * overlay ends immediately, so the user presses Start and nothing happens.
 *
 * `gates` is nullable for the same reason `navSlotFilter` passes everything through when no
 * gates service is wired (a bare install / dev-open parity): with nothing to gate against,
 * nothing is withheld — including the per-step branches, which must not be silently thinned.
 *
 * AUTHORING RULE, and the reason `blocked` outranks `not-applicable` is safe in practice: give
 * every tour at least one step with NO `when`. An intro and a finish card qualify, which is why
 * every built-in has two (pinned by `tutorial-tours.spec.ts`). Then `steps` can never be empty,
 * `not-applicable` is reachable only for a tour authored as branch-specific END TO END, and a
 * tour named in the catalogue as unlockable can never turn out unstartable after the reader has
 * gone and done the thing it asked for.
 *
 * Pure, total and sorted, so both consumers (the launch prompt's offer list and the
 * catalogue) read one resolution rather than each re-deriving availability, and the rules
 * above are unit-testable without a Vue runtime.
 */
export function resolveTourCatalogue(
  tours: readonly TutorialTour[],
  gates: NavGates | null,
): TutorialCatalogueEntry[] {
  return sortTours(tours).map((tour) => {
    const unmet = gates ? (tour.requires ?? []).filter((r) => !r.met(gates)) : []
    const steps = gates ? tour.steps.filter((s) => (s.when ? s.when(gates) : true)) : tour.steps
    // Reuse the original object when nothing was dropped: both surfaces key their lists on
    // the tour, and a fresh object per gate read would re-render on every unrelated flip.
    const resolved = steps.length === tour.steps.length ? tour : { ...tour, steps }
    const availability: TutorialAvailability =
      unmet.length > 0 ? 'blocked' : steps.length === 0 ? 'not-applicable' : 'ready'
    return { tour: resolved, availability, unmet }
  })
}

/** The tours that can be started right now, resolved — what the overlay may run. */
export function resolveTours(
  tours: readonly TutorialTour[],
  gates: NavGates | null,
): TutorialTour[] {
  return resolveTourCatalogue(tours, gates)
    .filter((entry) => entry.availability === 'ready')
    .map((entry) => entry.tour)
}

/**
 * Does the launch prompt offer this tour? See {@link TutorialTour.offeredAtLaunch} for why the
 * prompt shows a subset while the catalogue shows everything.
 *
 * One function rather than an inline `!== false` at each site, because the DEFAULT is the whole
 * subtlety: a tour that declares nothing is offered, so a reader spelling the check out
 * themselves has to get the polarity of an absent field right.
 */
export function isLaunchOffer(tour: TutorialTour): boolean {
  return tour.offeredAtLaunch !== false
}

/** The ids a catalogue resolution says can be started right now. */
export function readyTourIds(catalogue: readonly TutorialCatalogueEntry[]): Set<string> {
  return new Set(
    catalogue.filter((entry) => entry.availability === 'ready').map((entry) => entry.tour.id),
  )
}

/**
 * The tour that just became takeable, for the contextual offer, or null when nothing did.
 *
 * The catalogue made every walkthrough reachable; this is what reaches the user who needs one
 * WITHOUT going looking. The trigger is deliberately not a per-surface hook ("when a run parks,
 * mention `answer-park`"): every tour already declares, as its `requires`, the exact predicate
 * that means "you can take this now". So one rule over the resolved catalogue covers the whole
 * catalog and inherits `navRequirementDrift` unchanged, where a hand-wired trigger per surface
 * would be a second copy of each requirement to keep in step.
 *
 * Three rules, and the first is the one that is easy to get wrong:
 *
 *  - It fires on a TRANSITION into `ready`, never on the standing state, which is why the caller
 *    must SEED `previouslyReady` from the first resolution without offering anything. Fired on
 *    the standing state it would nudge about everything already available on every board load,
 *    which is the launch prompt with none of its manners. The transition rule also means the
 *    permission-gated platform tours (ready from the first render on any board) naturally never
 *    reach it, and only the board-state tours — a run parked, a run failed, a PR ready to
 *    merge — can.
 *  - Only the launch-offer arc, for the reason `offeredAtLaunch` exists: a tour declared as
 *    reference material someone comes and gets is not one to interrupt them with. Reusing that
 *    declaration rather than inventing a second opt-out keeps a consumer deployment's tour
 *    behaving here exactly as it does in the prompt.
 *  - Never twice for the same tour (`wasNudged`) and never one already completed. A contextual
 *    offer that returns is a nag, and this one is unusually well placed to become one: the gates
 *    it reads flip several times per run.
 *
 * And nothing at all for a user who DECLINED. "No thanks" was an answer about guided tours, not
 * about the startup timing of the question, so a mechanism that goes on offering them anyway is
 * overriding the one explicit preference this feature collects. They keep the catalogue, which is
 * where someone who changed their mind goes; `resetProgress` is the way back to being asked.
 */
export function newlyAvailableTour(input: {
  catalogue: readonly TutorialCatalogueEntry[]
  previouslyReady: ReadonlySet<string>
  declined: boolean
  isCompleted: (tourId: string) => boolean
  wasNudged: (tourId: string) => boolean
}): TutorialTour | null {
  if (input.declined) return null
  const candidate = input.catalogue.find(
    (entry) =>
      entry.availability === 'ready' &&
      isLaunchOffer(entry.tour) &&
      !input.previouslyReady.has(entry.tour.id) &&
      !input.isCompleted(entry.tour.id) &&
      !input.wasNudged(entry.tour.id),
  )
  return candidate?.tour ?? null
}

/**
 * The tour to hand the user off to when they finish `justFinishedId`, or null when there is
 * nothing left to offer.
 *
 * The catalog is a COURSE, not a list: each delivery-loop tour produces the state the next
 * one requires, so finishing one is the single most reliable moment at which another became
 * takeable. Without a handoff the walkthrough that the user's own last action unlocked is
 * reachable only from the catalogue, and the launch prompt cannot bring it up either: starting
 * any tour writes `decision: 'accepted'`, which is what stops the prompt auto-opening for good.
 * So the finish card is the ONLY place the product can still say "and now this one".
 *
 * Two rules make it an offer rather than a list:
 *
 *  - Launch-offer tours come FIRST, whatever their `order` (see {@link TutorialTour.offeredAtLaunch}).
 *    The delivery loop is the arc someone taking a tour is on; a deployment's catalogue-only
 *    tour with a low `order` must not jump in front of it. Ordering alone is not that
 *    guarantee — it only happens to be true of the built-ins' numbering.
 *  - It offers exactly one, and only a READY one. A list is what the catalogue is for, and a
 *    blocked tour named here would ask the user to go and do something at the moment they
 *    finished doing something.
 *
 * Absence is a legitimate answer, unlike in the catalogue: this is an offer, so having nothing
 * to suggest means the card keeps its plain Done. The caller still shows the way to the
 * catalogue, so the card never dead-ends.
 *
 * `ready` is deliberately read LIVE by the caller rather than from the tour's held script,
 * which is the one place the "resolve once and HOLD" rule must not apply: completing
 * `first-task` is exactly what makes `run-task` ready, so a candidate list frozen at tour
 * start would be empty precisely when this exists to be useful.
 */
export function nextTourAfter(
  ready: readonly TutorialTour[],
  input: { justFinishedId: string; isCompleted: (tourId: string) => boolean },
): TutorialTour | null {
  const fresh = sortTours(ready).filter(
    (tour) => tour.id !== input.justFinishedId && !input.isCompleted(tour.id),
  )
  return fresh.find(isLaunchOffer) ?? fresh[0] ?? null
}

/**
 * Where a tour stands for this user: the state the catalogue badges and the action label
 * derive from. Camel-cased because the values ARE the i18n leaf keys
 * (`tutorial.status.<state>`, `tutorial.action.<action>`), which keeps those lookups total.
 */
export type TutorialTourState = 'notStarted' | 'inProgress' | 'paused' | 'completed'

/** What the tour's button does, given that state. */
export type TutorialLaunchAction = 'start' | 'resume' | 'restart' | 'continue'

/**
 * Which state a tour is in, in precedence order: the one RUNNING wins over everything, then a
 * broken-off position, then completion.
 *
 * Paused beating completed is the deliberate half: a tour taken again and broken off is
 * offered where it stopped, rather than being described by the badge it earned last time.
 */
export function tourState(input: {
  active: boolean
  resumable: boolean
  completed: boolean
}): TutorialTourState {
  if (input.active) return 'inProgress'
  if (input.resumable) return 'paused'
  return input.completed ? 'completed' : 'notStarted'
}

/**
 * The action offered for a state. Total, so a new state cannot reach a surface without an
 * action — `continue` exists because the catalogue is reachable DURING a tour (nothing about
 * the overlay blocks the sidebar), and offering "Start" for the walkthrough already on screen
 * would restart it from step one on a click most people would read as "back to it".
 */
export function launchActionFor(state: TutorialTourState): TutorialLaunchAction {
  const actions: Record<TutorialTourState, TutorialLaunchAction> = {
    notStarted: 'start',
    inProgress: 'continue',
    paused: 'resume',
    completed: 'restart',
  }
  return actions[state]
}

/**
 * The copy for each state / action, as exhaustive `Record`s rather than a key assembled at
 * the call site (`t(\`tutorial.action.${action}\`)`).
 *
 * The typed-message-key check only covers keys written as literals, so an assembled one is
 * exactly the drift it cannot see — the i18n guard's tier-2 rule. Declared this way, adding a
 * state without its copy fails the typecheck, and `tutorial.spec.ts` pins every value against
 * the catalog so a RENAMED key fails a test instead of rendering a raw path to the user.
 */
export const TUTORIAL_STATUS_KEYS: Record<TutorialTourState, string> = {
  notStarted: 'tutorial.status.notStarted',
  inProgress: 'tutorial.status.inProgress',
  paused: 'tutorial.status.paused',
  completed: 'tutorial.status.completed',
}

export const TUTORIAL_ACTION_KEYS: Record<TutorialLaunchAction, string> = {
  start: 'tutorial.action.start',
  resume: 'tutorial.action.resume',
  restart: 'tutorial.action.restart',
  continue: 'tutorial.action.continue',
}

/** A DOMRect-shaped box, structurally typed so the geometry below is unit-testable. */
export interface TutorialRect {
  top: number
  left: number
  width: number
  height: number
}

/**
 * How much of `rect` lies inside the viewport, in square pixels. Zero when they don't overlap
 * at all, which is the case that matters: an anchor scrolled or panned off screen.
 */
export function visibleArea(
  rect: TutorialRect,
  viewport: { width: number; height: number },
): number {
  const overlapWidth = Math.min(rect.left + rect.width, viewport.width) - Math.max(rect.left, 0)
  const overlapHeight = Math.min(rect.top + rect.height, viewport.height) - Math.max(rect.top, 0)
  return Math.max(0, overlapWidth) * Math.max(0, overlapHeight)
}

/**
 * Does the overlay have to bring this anchor into view before the step can read correctly?
 *
 * The runtime accepts any element with layout boxes, and an element scrolled out of a panel or
 * panned off the board canvas still HAS them — so without this check the highlight ring is
 * drawn at off-screen coordinates while `computeCoachMarkLayout` clamps the tooltip to a
 * viewport edge, leaving the user reading "click this" beside nothing at all. It bites the
 * most-travelled steps hardest: the two `task-card` steps anchor whichever card is first in
 * the DOM, which on a populated board is the one least likely to be the one on screen.
 *
 * Pure, so the threshold is pinned by unit tests rather than eyeballed against a real board.
 * A zero-area anchor never needs revealing: there is no position to bring anywhere, and
 * treating it as off-screen would make every degenerate rect trigger a canvas pan.
 */
export function needsReveal(
  rect: TutorialRect,
  viewport: { width: number; height: number },
): boolean {
  const area = rect.width * rect.height
  if (area <= 0) return false
  const required = MIN_VISIBLE_RATIO * Math.min(area, viewport.width * viewport.height)
  return visibleArea(rect, viewport) < required
}

export interface CoachMarkLayout {
  top: number
  left: number
  /** The side actually used (a preferred side that doesn't fit falls back), or centered. */
  placement: TutorialPlacement | 'center'
}

/** Gap between the anchor's highlight ring and the tooltip card. */
const TOOLTIP_GAP = 12
/** Minimum distance the tooltip keeps from the viewport edges. */
const VIEWPORT_MARGIN = 8

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max))

/**
 * Where the tooltip card goes for a given anchor. Pure geometry so the fallback rules are
 * pinned by unit tests rather than eyeballed:
 *
 *  - no anchor ⇒ centered (intro / wrap-up steps);
 *  - the preferred side is used when the card fits between anchor and viewport edge,
 *    otherwise sides are tried `bottom → top → right → left`;
 *  - nothing fits (tiny viewport) ⇒ the bottom position, clamped — partially covering the
 *    anchor beats disappearing off-screen;
 *  - the cross-axis is centered on the anchor and clamped to the viewport margin.
 */
export function computeCoachMarkLayout(
  target: TutorialRect | null,
  tooltip: { width: number; height: number },
  viewport: { width: number; height: number },
  preferred?: TutorialPlacement,
): CoachMarkLayout {
  if (!target) {
    return {
      top: Math.max(VIEWPORT_MARGIN, (viewport.height - tooltip.height) / 2),
      left: Math.max(VIEWPORT_MARGIN, (viewport.width - tooltip.width) / 2),
      placement: 'center',
    }
  }

  const fits: Record<TutorialPlacement, boolean> = {
    top: target.top - TOOLTIP_GAP - tooltip.height >= VIEWPORT_MARGIN,
    bottom:
      target.top + target.height + TOOLTIP_GAP + tooltip.height <=
      viewport.height - VIEWPORT_MARGIN,
    left: target.left - TOOLTIP_GAP - tooltip.width >= VIEWPORT_MARGIN,
    right:
      target.left + target.width + TOOLTIP_GAP + tooltip.width <= viewport.width - VIEWPORT_MARGIN,
  }
  const fallbackOrder: TutorialPlacement[] = ['bottom', 'top', 'right', 'left']
  const placement =
    preferred && fits[preferred]
      ? preferred
      : (fallbackOrder.find((side) => fits[side]) ?? 'bottom')

  const centeredLeft = target.left + target.width / 2 - tooltip.width / 2
  const centeredTop = target.top + target.height / 2 - tooltip.height / 2
  const maxLeft = viewport.width - tooltip.width - VIEWPORT_MARGIN
  const maxTop = viewport.height - tooltip.height - VIEWPORT_MARGIN

  switch (placement) {
    case 'top':
      return {
        top: target.top - TOOLTIP_GAP - tooltip.height,
        left: clamp(centeredLeft, VIEWPORT_MARGIN, maxLeft),
        placement,
      }
    case 'bottom':
      return {
        // Clamped: this is also the "nothing fits" fallback, where overlap is accepted.
        top: clamp(target.top + target.height + TOOLTIP_GAP, VIEWPORT_MARGIN, maxTop),
        left: clamp(centeredLeft, VIEWPORT_MARGIN, maxLeft),
        placement,
      }
    case 'left':
      return {
        top: clamp(centeredTop, VIEWPORT_MARGIN, maxTop),
        left: target.left - TOOLTIP_GAP - tooltip.width,
        placement,
      }
    case 'right':
      return {
        top: clamp(centeredTop, VIEWPORT_MARGIN, maxTop),
        left: target.left + target.width + TOOLTIP_GAP,
        placement,
      }
  }
}
