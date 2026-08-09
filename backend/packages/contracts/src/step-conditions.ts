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
// build preset carry both testers and be right on a frontend task and on a backend
// task, instead of the two near-identical presets it used to take. (A task in BOTH
// scopes at once is what {@link RunServiceScope} would express; see the note there
// for why no board state produces one yet.)
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
 *
 * A MIXED scope (both halves true) is what this reduction exists to express, but no board state
 * produces one today, and that is a property of the CONNECTION model rather than of this file: a
 * run's frames are its own service frame plus the task's involved services, involved services must
 * be connection neighbours, and only a `service`-type frame may declare a connection or be named as
 * one (`serviceConnectionsError`, and the narrowing that drops the field on every other frame type).
 * So a frontend frame has no neighbours in either direction, a frontend task can name no involved
 * service, and every involved service is a non-frontend. Both halves stay because the reduction is
 * the honest statement of "what does this run change" and it is the connection model, not this
 * function, that would have to change to widen it. Do NOT re-derive the mixed case in a test by
 * hand-building a board with a service connected to a frontend: that board cannot be saved.
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
 * Why a run step finished as `skipped` rather than running — the three axes that can skip one,
 * as a member the SPA maps to translated copy rather than prose the backend composed:
 *
 *  - `gated`      — the step's estimate gate was not met (the task scored below its thresholds).
 *  - `condition`  — the step's {@link stepRunConditionSchema} did not match the run's service
 *                   scope. The step still carries the condition, so a reader wanting the specific
 *                   sentence ("no frontend in scope") reads `serviceScope` off it; this says only
 *                   which axis fired, so the two can never disagree about the scope.
 *  - `producer_skipped` — a COMPANION whose producer was itself skipped, so there is nothing for
 *                   it to grade. Distinct from `gated` because the fix is different: the reader
 *                   has to look at the producer, not at this step's own thresholds.
 *  - `run_complete` — an earlier step ENDED the run (a `bug-intake` fire that found nothing to
 *                   adopt), so everything after it was closed out untouched. Nothing about THIS
 *                   step decided it, which is why it cannot borrow any of the three above.
 *
 * PERSISTED and CLOSED, so retiring a member does not remove it from stored runs: read it with
 * {@link isStepSkipReason} and render an unrecognised value as "skipped" rather than crashing or
 * guessing onto a current member.
 */
export const stepSkipReasonSchema = v.picklist([
  'gated',
  'condition',
  'producer_skipped',
  'run_complete',
])
export type StepSkipReason = v.InferOutput<typeof stepSkipReasonSchema>

/**
 * Narrow a persisted `skipReason` to a member this build still knows, DERIVED from the picklist's
 * own options so adding a member cannot leave this behind. A stored run may name a member since
 * retired, and a browser may hold a bundle older than the member it reads.
 */
export function isStepSkipReason(value: unknown): value is StepSkipReason {
  return (
    typeof value === 'string' && (stepSkipReasonSchema.options as readonly string[]).includes(value)
  )
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
