import * as v from 'valibot'
import type { AgentFailureKind } from './agent-failure-kinds.js'
import type { BootstrapJob } from './bootstrap.js'
import type { AdoptionPlan } from './monorepo-adoption.js'

// ---------------------------------------------------------------------------
// A bootstrap run's STEPS: what the run is made of, where it got to, and where a
// retry re-enters.
//
// A "bootstrap repo" run is one row with a `phase` field, but it is not one move: a
// monorepo run surveys both repositories, parks on a human's adoption decisions, and only
// then writes the service and opens the pull request. Rendering that as a single
// "bootstrapping…" bar hides which of the three a stopped run actually reached, and a
// "Retry" button over it reads as "start again" when what the service does is resume.
//
// The rule lives here because the SPA and the backend must AGREE about it: the board
// renders the steps and names the one a retry resumes from, while `BootstrapService.retry`
// BRANCHES on that same answer. Stated twice, the button and the behaviour drift.
// ---------------------------------------------------------------------------

/**
 * The moves a bootstrap run is made of.
 *
 *  - `scaffold`: the whole of a new-repo run. It clones or scaffolds, then force-pushes the
 *    initial commit: one step, because there is no park in it.
 *  - `survey` / `review` / `apply`: the monorepo flow's three, the middle one a human's.
 */
export const bootstrapStepIdSchema = v.picklist(['scaffold', 'survey', 'review', 'apply'])
export type BootstrapStepId = v.InferOutput<typeof bootstrapStepIdSchema>

/**
 * A step's state. A derived projection, never a stored value, which is why it is a type and
 * not a picklist: no request or response carries one, so there is nothing to parse.
 *
 * `awaiting_review` is its own value rather than a flavour of `running`: nothing is
 * executing and nothing will until a person answers, which is the opposite of what a
 * spinner claims.
 *
 * `stopped` is its own value for a related reason. A run someone stopped is STORED as
 * `failed` (with a `cancelled` failure kind), and painting the step they stopped in red
 * reports their own decision back to them as a fault: on a monorepo run, a fault in the review
 * step whose only actor is the reviewer.
 *
 * `unknown` is the one that is not a lifecycle position: `status` is a CLOSED vocabulary that
 * is also PERSISTED, so a row written before a member was retired still holds that value, and
 * the reader that meets it is a rendered surface. It renders as the unreadable state it is
 * rather than as `pending`, which would present a stopped run as one that never started.
 */
export type BootstrapStepState =
  | 'pending'
  | 'running'
  | 'awaiting_review'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'unknown'

export interface BootstrapRunStep {
  id: BootstrapStepId
  state: BootstrapStepState
}

/**
 * What the rule READS off a run, and nothing more.
 *
 * Declared structurally rather than as a `Pick<BootstrapJob, …>` so the backend's own record type
 * satisfies it without a conversion, and so what the answer actually depends on is visible at a
 * glance: the presence of a monorepo target and of a settled review, the phase, the run status,
 * the PLAN'S OWN status (the field a retry keeps or drops), and the failure KIND, which is what
 * separates a run that broke from one a person stopped.
 */
export interface BootstrapRunShape {
  monorepo: object | null
  phase: BootstrapJob['phase']
  status: BootstrapJob['status']
  adoptionPlan: { status: AdoptionPlan['status'] } | null
  adoptionReview: object | null
  /**
   * The structured failure a terminal run recorded, of which only the KIND is read. `cancelled`
   * is a stop, by a person or by the orphan sweep, and a stop is stored as a `failed` status
   * without being a fault. Null on a run that has not faulted.
   */
  failure: { kind: AgentFailureKind } | null
}

/** The steps a run of this shape is made of, in order. */
export function bootstrapStepIds(job: Pick<BootstrapRunShape, 'monorepo'>): BootstrapStepId[] {
  return job.monorepo ? ['survey', 'review', 'apply'] : ['scaffold']
}

/**
 * The step the run REACHED: the one it is in, or the one it stopped in.
 *
 * Read off the record's own state rather than a stored cursor, because the record already
 * says: `phase` is written when the apply dispatches, a recorded plan is what the survey
 * produces, and `awaiting_review` is the park itself. A stored step would be a fourth thing
 * to keep in step with those three.
 */
export function bootstrapReachedStep(job: BootstrapRunShape): BootstrapStepId {
  if (!job.monorepo) return 'scaffold'
  if (job.phase === 'apply' && job.adoptionReview) return 'apply'
  // A parked run is at the review whatever its plan says: an `unavailable` plan still leaves
  // the decisions to a human, so the run got as far as asking. Where a RETRY re-enters is a
  // different question, and `bootstrapResume` below answers it differently for exactly that
  // case.
  if (job.status === 'awaiting_review' || job.adoptionPlan) return 'review'
  return 'survey'
}

/**
 * Where a retry re-enters, and what it re-enters WITH: the `apply` arm carries the settled
 * review, because that is the state the re-dispatch needs and asking for it a second time is
 * how a caller ends up re-stating the rule.
 */
export type BootstrapResume<Review> =
  | { step: 'scaffold' | 'survey' | 'review' }
  | { step: 'apply'; review: Review }

/**
 * The step a retry re-enters at: what `BootstrapService.retry` does, in one place both it
 * and the button that offers it read.
 *
 * It differs from {@link bootstrapReachedStep} on one case, deliberately: a run parked on an
 * `unavailable` plan (no model, an unreadable repository, an exhausted budget) resumes at the
 * SURVEY, because the retry drops a non-ready plan so the fixed deployment can produce a real
 * one. Presenting that as "resume from review" would promise the human their pending decision
 * is what the run picks up from, when the suggestion is about to be recomputed.
 *
 * The run's own review type rides through, so the caller that re-dispatches the apply gets it
 * back at the type it stored rather than as the bare `object` this rule reads.
 */
export function bootstrapResume<T extends BootstrapRunShape>(
  job: T,
): BootstrapResume<NonNullable<T['adoptionReview']>> {
  if (!job.monorepo) return { step: 'scaffold' }
  const review = job.adoptionReview
  if (job.phase === 'apply' && review) return { step: 'apply', review }
  if (job.adoptionPlan?.status === 'ready') return { step: 'review' }
  return { step: 'survey' }
}

/** Just the step a retry re-enters at, for the surfaces that only name it. */
export function bootstrapResumeStep(job: BootstrapRunShape): BootstrapStepId {
  return bootstrapResume(job).step
}

/**
 * The run projected onto its steps: everything before the reached step is done, everything
 * after it is pending, and the reached step carries the run's own state.
 *
 * A terminal run's LATER steps stay `pending` rather than becoming `failed`: a monorepo run
 * that died in its survey never attempted the apply, and colouring it as a failure would
 * report three broken moves where one broke.
 */
export function bootstrapRunSteps(job: BootstrapRunShape): BootstrapRunStep[] {
  const reached = bootstrapReachedStep(job)
  const ids = bootstrapStepIds(job)
  const reachedAt = ids.indexOf(reached)
  return ids.map((id, index) => ({
    id,
    state: index < reachedAt ? 'done' : index > reachedAt ? 'pending' : stateOfReachedStep(job),
  }))
}

/** The reached step wears the run's own status; `pending` means nothing has started yet. */
function stateOfReachedStep(job: BootstrapRunShape): BootstrapStepState {
  switch (job.status) {
    case 'succeeded':
      return 'done'
    case 'failed':
      // A stop is stored as a failure, and it is the one terminal state that is nobody's fault:
      // it gets its own state so the step a reviewer stopped in is not reported back to them as
      // broken. The KIND is what separates the two; the status cannot.
      return job.failure?.kind === 'cancelled' ? 'stopped' : 'failed'
    case 'awaiting_review':
      return 'awaiting_review'
    case 'running':
      return 'running'
    case 'pending':
      return 'pending'
    default:
      return retiredStatusState(job.status)
  }
}

/**
 * A stored status this build no longer defines. Typed `never`, so retiring a member still fails
 * the build here, and answered at runtime so a row the database still holds renders as a state
 * nobody can read rather than as whichever of the five this build happens to list first.
 */
function retiredStatusState(status: never): BootstrapStepState {
  void status
  return 'unknown'
}
