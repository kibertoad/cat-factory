// The pure half of `ProviderPreferenceEditor.vue`: what a reordering COMMITS, and what the
// control has to say about a route order the run path may still override. Extracted so both can
// be pinned without mounting Vue — the "equals the default is stored as absent" normalisation in
// particular, which the backend's whole "a preset keeps tracking the shipped order" property rests
// on and which no backend test can see (the SPA is the only thing that performs it).

import {
  DEFAULT_MODEL_FLAVOR_ORDER,
  type ModelFlavor,
  orderedModelFlavorPreference,
} from '@cat-factory/contracts'

/**
 * Whether an order is today's shipped default, position for position.
 *
 * The length check is not redundant: `every` is vacuously true for a PREFIX, so without it a
 * partial order that happens to start like the default would be read as "no preference" and
 * silently cleared. The editor only ever produces full permutations, which is exactly why the
 * guard belongs here rather than in the caller — it is what keeps that a property of this
 * function instead of a property of its one current caller.
 */
export function isDefaultFlavorOrder(next: readonly ModelFlavor[]): boolean {
  return (
    next.length === DEFAULT_MODEL_FLAVOR_ORDER.length &&
    next.every((flavor, i) => DEFAULT_MODEL_FLAVOR_ORDER[i] === flavor)
  )
}

/**
 * What a reordering stores: the new order, or UNSET when it lands back on the shipped default.
 *
 * "No preference" and "an order that happens to match today's default" are different states, and
 * only the first keeps following the shipped order as the product changes it. Storing a copy would
 * silently pin today's wording of a list that is itself scheduled to be reordered.
 */
export function commitFlavorOrder(next: readonly ModelFlavor[]): ModelFlavor[] | undefined {
  return isDefaultFlavorOrder(next) ? undefined : [...next]
}

/** Swap the entry at `index` with its neighbour `delta` away; undefined when the move is a no-op. */
export function moveFlavor(
  order: readonly ModelFlavor[],
  index: number,
  delta: number,
): ModelFlavor[] | undefined {
  const next = [...order]
  const target = index + delta
  const moved = next[index]
  const displaced = next[target]
  if (!moved || !displaced) return undefined
  next[index] = displaced
  next[target] = moved
  return next
}

/**
 * Whether to warn that a connected subscription will still win over this order.
 *
 * "Subscriptions always win" is applied by the ENGINE on top of the route this order resolves: a
 * dual-mode model (Kimi/DeepSeek/GLM) switches to its subscription flavour whenever the workspace
 * or the run initiator holds a token, whatever the preset asked for. So the override does not
 * merely re-rank the subscription route within this list — it sits OUTSIDE the list — and the only
 * order it cannot contradict is one that already puts `subscription` first.
 *
 * That is why the test is "is subscription first", not "was subscription demoted": `subscription`
 * is last in today's shipped order, so a demotion test could never fire, and the case that actually
 * bites is the opposite one — a compliance preset promoting `bedrock` and being silently overruled.
 * Until the override moves into this order, the control has to say so, because copy promising a
 * residency-guaranteed route that a connected plan quietly overrules is the one thing a compliance
 * preset must never do.
 *
 * Only when the preset actually states an order (nothing is promised otherwise) AND the workspace
 * has a connected subscription (no token, no override).
 */
export function subscriptionOverridesOrder(input: {
  preference: readonly ModelFlavor[] | undefined
  hasSubscription: boolean
}): boolean {
  if (!input.preference?.length || !input.hasSubscription) return false
  return orderedModelFlavorPreference(input.preference)[0] !== 'subscription'
}
