// ---------------------------------------------------------------------------
// The canonical set of BUILT-IN dedicated result-view ids — the windows the SPA's
// `StepResultViewHost.vue` mounts for an agent step (`presentation.resultView`).
//
// This is the SHARED source of truth for the built-ins across the wire boundary: the
// frontend's first-party `resultViews`-slot module (`app/modular/result-views.ts`)
// contributes exactly these ids, and `agentPresentationSchema`'s `resultView` accepts one of
// them OR a consumer-namespaced id (`<ns>:<name>`). A BARE id that is not a built-in still
// fails validation at registration / snapshot time (the typo guardrail), while a NAMESPACED
// consumer id is trusted to the deployment and paired on the frontend against its own
// `registerAppModule`-contributed component. Adding a NEW built-in bespoke view is a two-step
// contract:
//   1. add its id here, and
//   2. contribute `{ id: '<id>', component }` to the first-party `resultViews` slot.
//
// A custom structured agent that doesn't ship its own component uses `generic-structured`
// (the shared read-only JSON viewer) and needs no frontend change at all. A consumer that
// DOES ship its own window registers both the agent kind and the view component through the
// modular `agentKinds` / `resultViews` slots — no built-in id needed here.
// ---------------------------------------------------------------------------

import { NAMESPACED_ID_PATTERN, isNamespacedId } from './primitives.js'

export const RESULT_VIEW_IDS = [
  'requirements-review',
  'clarity-review',
  'brainstorm',
  'tester',
  'human-test',
  'visual-confirm',
  'gate',
  'consensus-session',
  'generic-structured',
  'service-spec',
  'follow-ups',
  'merger',
  'initiative-tracker',
  'initiative-planning',
  'doc-interview',
  'fork-decision',
  'pr-review',
  'ralph-loop',
] as const

export type ResultViewId = (typeof RESULT_VIEW_IDS)[number]

/** Set form, for `O(1)` membership checks (e.g. boot-time registration validation). */
export const RESULT_VIEW_ID_SET: ReadonlySet<string> = new Set(RESULT_VIEW_IDS)

/**
 * A CONSUMER-namespaced result-view id (`<ns>:<name>`) — the generalized
 * {@link NAMESPACED_ID_PATTERN} rule, re-exported under its result-view name for the
 * existing consumers (`agentPresentationSchema`, the registration validator). The rule is
 * now shared across every extension surface (task types, form panels, …) via `primitives.ts`
 * so they can't drift.
 */
export const NAMESPACED_RESULT_VIEW_ID_PATTERN = NAMESPACED_ID_PATTERN

/** Whether `id` is a well-formed consumer-namespaced result-view id (`<ns>:<name>`). */
export function isNamespacedResultViewId(id: string): boolean {
  return isNamespacedId(id)
}

/**
 * Whether `id` is an acceptable `presentation.resultView`: a canonical BUILT-IN id (drawn from
 * `builtInIds`, defaulting to {@link RESULT_VIEW_ID_SET}) OR a consumer-namespaced one. A bare id
 * that is not a built-in is rejected (the typo guardrail).
 *
 * This is the SINGLE composed rule the backend registration validator (`validateRegistrations`)
 * checks against — it must not re-open-code `has(id) || isNamespacedResultViewId(id)`. The wire
 * schema (`agentPresentationSchema.resultView`) expresses the SAME rule as a valibot union
 * (`picklist ∪ namespaced`) rather than calling this, because the union keeps the built-in
 * picklist's literal-type narrowing that a boolean predicate would erase. Both sides share the
 * underlying atoms — {@link RESULT_VIEW_ID_SET} and {@link NAMESPACED_RESULT_VIEW_ID_PATTERN} —
 * so they can't drift. The `builtInIds` parameter lets the validator inject its (overridable)
 * known-id set while keeping the composition here.
 */
export function isValidResultViewId(
  id: string,
  builtInIds: ReadonlySet<string> = RESULT_VIEW_ID_SET,
): boolean {
  return builtInIds.has(id) || isNamespacedResultViewId(id)
}
