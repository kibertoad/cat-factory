import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Per-step RUN CONDITIONS — the second axis on which a pipeline step can be
// conditional, beside the task-estimate gating in `stepGatingSchema`.
//
// The two answer different questions and neither can express the other. Estimate
// gating asks "is this task big enough to be worth the step", a judgement about
// SIZE that only exists once a `task-estimator` has run. A run condition asks
// "does this step apply to the kind of change this run makes at all", a fact about
// the SERVICES the run touches that is knowable before the first dispatch and can
// never be recovered from a score: a UI test on a task that changes no frontend is
// not a cheap test, it is a test of nothing.
//
// The first case is the tester pair. A pipeline that wants both `tester-ui` and
// `tester-api` should run the browser pass only where there is a UI in scope and
// the API pass only where there is a service behind it — which is what lets ONE
// build preset cover a frontend, a backend and a full-stack task instead of the
// three near-identical presets it used to take.
// ---------------------------------------------------------------------------

/** The block `type` a service frame carries when it owns a rendered UI. */
export const FRONTEND_BLOCK_TYPE = 'frontend'

/**
 * Which half of a run's service scope a step needs:
 *
 *  - `frontend` — run only when the change touches a service declared as a frontend.
 *  - `backend`  — run only when it touches a service that is NOT a frontend.
 *
 * A full-stack task (a frontend service plus an involved backend service, or vice versa) is in
 * BOTH scopes, so a pipeline carrying both testers runs both on it.
 */
export const stepServiceScopeSchema = v.picklist(['frontend', 'backend'])
export type StepServiceScope = v.InferOutput<typeof stepServiceScopeSchema>

/**
 * A step's run condition: what has to be true of the run for this step to apply at all.
 * Today the only axis is {@link stepServiceScopeSchema}; it is an OBJECT rather than a bare
 * picklist so the next axis is a field beside it rather than a second per-step knob.
 *
 * Absent ⇒ unconditional, which is every step that does not declare one.
 */
export const stepRunConditionSchema = v.object({
  serviceScope: stepServiceScopeSchema,
})
export type StepRunCondition = v.InferOutput<typeof stepRunConditionSchema>

/**
 * The service scope of a run: whether the services it may change include a frontend, a
 * non-frontend, or both.
 *
 * BOTH FALSE is a real and distinct state — the run's services could not be resolved (a task
 * outside any service frame) — and it is deliberately not spelled as an "unknown" flag, because
 * every resolved frame contributes exactly one of the two: a scope with neither can only be an
 * empty one. {@link stepConditionSatisfied} reads that state as "nothing to judge" and runs the
 * step, the same fail-safe-to-thoroughness direction `onMissingEstimate: 'run'` takes.
 */
export interface RunServiceScope {
  /** Some service in scope is declared `type: 'frontend'` — there is a UI to exercise. */
  frontend: boolean
  /** Some service in scope is NOT a frontend — there is an API/service behind it. */
  backend: boolean
}

/**
 * Reduce the service frames a run may change — its own service plus the task's involved
 * services — into the {@link RunServiceScope} the step conditions read.
 *
 * Takes the FRAMES rather than the block, because "what does this run change" is the ancestry
 * walk plus the involved-service resolution, and both already happen in the engine. Frames are
 * deduped by the caller; passing the same frame twice changes nothing here.
 */
export function resolveRunServiceScope(
  frames: readonly { type?: string | null }[],
): RunServiceScope {
  let frontend = false
  let backend = false
  for (const frame of frames) {
    if (frame.type === FRONTEND_BLOCK_TYPE) frontend = true
    else backend = true
  }
  return { frontend, backend }
}

/**
 * Whether a step carrying `condition` applies to a run of `scope`. An absent condition is
 * unconditional; an unresolvable scope (see {@link RunServiceScope}) runs the step rather than
 * silently dropping it.
 */
export function stepConditionSatisfied(
  condition: StepRunCondition | null | undefined,
  scope: RunServiceScope,
): boolean {
  if (!condition) return true
  if (!scope.frontend && !scope.backend) return true
  return condition.serviceScope === 'frontend' ? scope.frontend : scope.backend
}
