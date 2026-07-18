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
 * A CONSUMER-namespaced result-view id: `<ns>:<name>`, each segment a lowercase
 * `a-z0-9` dash-separated token (e.g. `acme:security-report`). The colon distinguishes a
 * deployment-provided view id from a bare built-in one. The SINGLE source of truth for the
 * rule, shared by `agentPresentationSchema` (wire validation) and the backend registration
 * validator so they can't drift.
 */
export const NAMESPACED_RESULT_VIEW_ID_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Whether `id` is a well-formed consumer-namespaced result-view id (`<ns>:<name>`). */
export function isNamespacedResultViewId(id: string): boolean {
  return NAMESPACED_RESULT_VIEW_ID_PATTERN.test(id)
}

/**
 * Whether `id` is an acceptable `presentation.resultView`: a canonical BUILT-IN id, or a
 * consumer-namespaced one. A bare id that is not a built-in is rejected (the typo guardrail).
 */
export function isValidResultViewId(id: string): boolean {
  return RESULT_VIEW_ID_SET.has(id) || isNamespacedResultViewId(id)
}
