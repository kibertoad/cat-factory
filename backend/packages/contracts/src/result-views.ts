// ---------------------------------------------------------------------------
// The canonical set of dedicated result-view ids — the components the SPA's
// `StepResultViewHost.vue` can mount for an agent step (`presentation.resultView`).
//
// This is the SHARED source of truth across the wire boundary: the frontend's
// `STEP_RESULT_VIEWS` map is keyed by exactly these ids, and `agentPresentationSchema`'s
// `resultView` is a `picklist` of them — so a custom kind that declares an unknown view id
// fails validation at registration / snapshot time (a typed picklist) instead of silently
// falling back to the prose panel. Adding a NEW bespoke view is a two-step contract:
//   1. add its id here, and
//   2. register `'<id>': <Component>` in `StepResultViewHost.vue`.
//
// A custom structured agent that doesn't ship its own component uses `generic-structured`
// (the shared read-only JSON viewer) and needs no frontend change at all.
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
] as const

export type ResultViewId = (typeof RESULT_VIEW_IDS)[number]

/** Set form, for `O(1)` membership checks (e.g. boot-time registration validation). */
export const RESULT_VIEW_ID_SET: ReadonlySet<string> = new Set(RESULT_VIEW_IDS)
