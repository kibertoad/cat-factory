import type { InfrastructureScrollTarget } from '~/types/providerConnections'

// The deep-link SECTION anchor the `cat-factory k3s` hand-off lands on, as a plain function so the
// rule is testable: the component half is a `watch` plus an `onMounted` retry, and neither is
// reachable from a spec (this SPA has no component-mounting harness).
//
// The rule that needed pinning is the three-way outcome, not the scroll. The anchor is one-shot and
// is consumed only once the section is actually IN the DOM, but the section renders behind an async
// probe, so an attempt that finds nothing must leave the anchor ARMED for the next attempt rather
// than clear it. Clearing on a miss silently swallows the hand-off on a slow probe; never clearing
// leaves a dead anchor, which is why "scrolled" is the only outcome the caller acts on and why
// closing the window drops whatever is left (`closeProviderConnection`).

/** The minimum of an element this needs, so a spec can pass a recorder instead of a DOM node. */
export interface ScrollableSection {
  scrollIntoView: (options: ScrollIntoViewOptions) => void
}

export interface ScrollAnchorAttempt {
  /** The store's pending anchor, or null when there is nothing to land on. */
  target: InfrastructureScrollTarget | null
  /** The infra-probe gate the sections render behind; null while it is still resolving. */
  available: boolean | null
  /** The section element, or null when it has not rendered yet. */
  section: ScrollableSection | null
}

/**
 * - `scrolled`: the anchor was honoured and the CALLER must now clear it.
 * - `not-anchored`: nothing is pending for this section (or the panel is not showing yet).
 * - `not-rendered`: it IS pending, but the section is not in the DOM, so the anchor stays armed.
 */
export type ScrollAnchorOutcome = 'scrolled' | 'not-anchored' | 'not-rendered'

/** Honour a pending Kubernetes-section anchor, reporting which of the three cases this was. */
export function consumeKubernetesScrollAnchor(attempt: ScrollAnchorAttempt): ScrollAnchorOutcome {
  if (attempt.target !== 'kubernetes' || attempt.available !== true) return 'not-anchored'
  if (!attempt.section) return 'not-rendered'
  attempt.section.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return 'scrolled'
}
