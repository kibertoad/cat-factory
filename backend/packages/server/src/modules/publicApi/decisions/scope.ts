import type {
  BrainstormSession,
  BrainstormStage,
  ClarityReview,
  ExecutionInstance,
  RequirementReview,
} from '@cat-factory/contracts'
import type { GateActor } from '@cat-factory/kernel'
import type { PublicApiKeyAuth } from '@cat-factory/integrations'
import type { Context } from 'hono'
import { findParkedInterviewStep } from '@cat-factory/orchestration'
import type {
  BrainstormModule,
  ClarityModule,
  InterviewGateController,
  RequirementsModule,
} from '@cat-factory/orchestration'
import type { AppEnv } from '../../../http/env.js'
import { authorize } from '../publicApiAuth.js'

// Resolution + authorization for the public parked-decision surface: the preamble every route in
// `../PublicDecisionController.ts` shares, and the per-module gates the iterative-review routes
// add on top of it.
//
// `PublicDecisionController` keeps HAND-BUILT error envelopes on purpose (failures are DATA there,
// so each contract handler stays typed against its declared response union), which is why every
// gate here returns its rejection as a {@link GateFailure} rather than throwing a `DomainError` or
// returning a built `Response`.

/** A run resolved for the caller's key, with the block it is anchored on. */
export interface ScopedRun {
  execution: ExecutionInstance
  /** The run's anchor block id — a board task, or a headless job anchor. */
  blockId: string
}

/**
 * Load a run by id for an authenticated key, scoped to the key's workspace. Accepts BOTH shapes the
 * public surface can create: a headless job anchor (`getInternalTask`) and an ordinary board
 * task (`getServiceTask`) — their union is exactly the set of runs this key may already read
 * through `GET /api/v1/jobs/:id` and `GET /api/v1/tasks/:taskId/run`, so nothing new is exposed.
 * Anything else in the workspace (or in another workspace) is a 404.
 *
 * WHY A RESOLVED RUN IS SAFE TO ANSWER THROUGH A BLOCK-SCOPED SERVICE METHOD. The three iterative
 * reviews and both human-verdict gates delegate to methods keyed by BLOCK, not by run (the SPA
 * drives them from the task's window), so the `runId` in the path names a run nothing downstream
 * reads. That would be a misaddressing hazard (answer with a stale id, act on whatever run the
 * block now holds), except the engine makes the two the same question: `insertLive` claims a
 * block's live run under a partial unique index and DELETES that block's terminal rows in the same
 * transaction, and a cancel / `stop-reset` deletes the run row outright. So a run that is no
 * longer its block's live run is not resolvable AT ALL, and this 404 is already the refusal. That
 * is an invariant of the execution repositories rather than of this file, so it is pinned by a
 * conformance assertion (`refuses a block-scoped answer once the task has moved on`) instead of
 * re-checked per request here. A runtime re-check would be an unreachable branch, and an
 * unreachable branch in four published SDK error vocabularies.
 */
export async function loadScopedRun<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
  runId: string,
): Promise<ScopedRun | null> {
  const container = c.get('container')
  const execution = await container.executionRepository.get(workspaceId, runId)
  if (!execution) return null
  const task = await container.boardService.getServiceTask(workspaceId, execution.blockId)
  if (task) return { execution, blockId: execution.blockId }
  const anchor = await container.boardService.getInternalTask(workspaceId, execution.blockId)
  return anchor ? { execution, blockId: execution.blockId } : null
}

/** The error a gate rejected with, kept as DATA so each handler emits its own typed `c.json`. */
export type GateFailure = { fail: { status: 401 | 403 | 404 | 503; code: string; message: string } }

/**
 * Emit a gate's rejection as the surface's standard error body.
 *
 * The `c.json` call stays INSIDE each handler's closure (rather than this returning a built
 * `Response`) so `buildHonoRoute` keeps type-checking every handler against its contract's declared
 * response union — a bare `Response` would erase that. This just removes the identical copies
 * of the body/status shuffle, which is where an inconsistent error envelope would eventually creep
 * in between two routes of the same surface.
 */
export function failureBody(fail: GateFailure['fail']): {
  error: { code: string; message: string }
} {
  return { error: { code: fail.code, message: fail.message } }
}

/**
 * Resolve the run + require the answering scope, then hand the handler a settled context — or the
 * failure to emit. Every mutating route shares exactly this preamble, and duplicating it per route
 * is how two surfaces drift apart.
 *
 * The failure is returned as DATA rather than a built `Response` (mirroring `authorize`) because
 * `buildHonoRoute` types each handler against its contract's declared response union: a bare
 * `Response` would erase that and stop the compiler checking the success payload.
 */
export async function gateDecisionAction<E extends AppEnv>(
  c: Context<E>,
  runId: string,
): Promise<{ workspaceId: string; scoped: ScopedRun; auth: PublicApiKeyAuth } | GateFailure> {
  // `decide` — the same rung that admits a parking pipeline in the first place. Answering injects
  // caller-supplied prose into the requirements every downstream agent then implements, so it sits
  // above ordinary `write` task authoring.
  const gate = await authorize(c, 'decide')
  if ('fail' in gate) return gate
  const { workspaceId } = gate.auth
  const scoped = await loadScopedRun(c, workspaceId, runId)
  if (!scoped) {
    return { fail: { status: 404, code: 'not_found', message: 'Run not found' } }
  }
  return { workspaceId, scoped, auth: gate.auth }
}

/**
 * The gate-resolving IDENTITY behind a public-API call: the key itself, never a person.
 *
 * That distinction is the whole point rather than a limitation. A step whose gate NAMES its
 * approvers cannot be cleared by a shared credential — `refuseGateResolution` refuses any
 * non-user actor against a policy — and a key that clears an unpoliced gate occupies exactly one
 * quorum slot, so a key cannot satisfy a two-person checkpoint by calling twice either.
 */
export function publicApiGateActor(auth: PublicApiKeyAuth): GateActor {
  return { id: auth.keyId, kind: 'api-key', role: null }
}

/** The settled context an iterative-review route acts on, for one review kind. */
export interface ReviewAction<TReview> {
  workspaceId: string
  scoped: ScopedRun
  review: TReview
}

/** The settled context a requirements route acts on. */
export interface RequirementsAction extends ReviewAction<RequirementReview> {
  requirements: RequirementsModule
}

/**
 * Gate a requirements action: the shared {@link gateDecisionAction} preamble, plus the opt-in
 * requirements module and the run's LIVE review. Every requirements route needs exactly this
 * quartet (key + scope, run, module, review), and hand-rolling it per route is how two surfaces
 * end up disagreeing about which review a run's answer applies to.
 */
export async function gateRequirementsAction<E extends AppEnv>(
  c: Context<E>,
  runId: string,
): Promise<RequirementsAction | GateFailure> {
  const gated = await gateDecisionAction(c, runId)
  if ('fail' in gated) return gated
  const requirements = c.get('container').requirements
  if (!requirements) {
    return moduleUnavailable('Requirements review is not configured')
  }
  const { workspaceId, scoped } = gated
  const review = await requirements.service.getForBlock(workspaceId, scoped.blockId)
  if (!review) {
    return noReview('This run has no requirements review')
  }
  return { workspaceId, scoped, requirements, review }
}

/** The settled context a clarity route acts on. */
export interface ClarityAction extends ReviewAction<ClarityReview> {
  clarity: ClarityModule
}

/**
 * Gate a clarity action — the requirements gate's twin, over the clarity module. Kept as a
 * separate function rather than parameterised over the module because the two 503/404 messages
 * have to NAME their own subject: a bug-triage caller told "requirements review is not configured"
 * has been handed the wrong thing to go and wire.
 */
export async function gateClarityAction<E extends AppEnv>(
  c: Context<E>,
  runId: string,
): Promise<ClarityAction | GateFailure> {
  const gated = await gateDecisionAction(c, runId)
  if ('fail' in gated) return gated
  const clarity = c.get('container').clarity
  if (!clarity) {
    return moduleUnavailable('Clarity review is not configured')
  }
  const { workspaceId, scoped } = gated
  const review = await clarity.service.getForBlock(workspaceId, scoped.blockId)
  if (!review) {
    return noReview('This run has no clarity review')
  }
  return { workspaceId, scoped, clarity, review }
}

/** The settled context a brainstorm route acts on, for ONE stage. */
export interface BrainstormAction extends ReviewAction<BrainstormSession> {
  brainstorm: BrainstormModule
  stage: BrainstormStage
}

/**
 * Gate a brainstorm action. Keyed by `(block, stage)` rather than block alone, because a block may
 * hold one live `requirements` session and one live `architecture` session at once — resolving
 * "the run's brainstorm" without the stage would answer whichever the store returned first.
 */
export async function gateBrainstormAction<E extends AppEnv>(
  c: Context<E>,
  runId: string,
  stage: BrainstormStage,
): Promise<BrainstormAction | GateFailure> {
  const gated = await gateDecisionAction(c, runId)
  if ('fail' in gated) return gated
  const brainstorm = c.get('container').brainstorm
  if (!brainstorm) {
    return moduleUnavailable('Brainstorm is not configured')
  }
  const { workspaceId, scoped } = gated
  const review = await brainstorm.services[stage].getForBlock(workspaceId, scoped.blockId)
  if (!review) {
    return noReview(`This run has no ${stage} brainstorm`)
  }
  return { workspaceId, scoped, brainstorm, stage, review }
}

/** The settled context an interview route acts on: which gate, and the run it is parked on. */
export interface InterviewAction {
  workspaceId: string
  scoped: ScopedRun
  gate: InterviewGateController<unknown>
  /** The parked step's kind, so a refusal can name the interviewer the caller reached for. */
  stepKind: string
}

/**
 * Gate an interview action: the shared {@link gateDecisionAction} preamble, plus the run's PARKED
 * interview step and the gate wired for its kind.
 *
 * Which interviewer is asking is resolved from the RUN rather than taken from the caller, which is
 * what lets one route set serve every interview gate. Two distinct refusals fall out of that, and
 * keeping them apart is the point: a run parked on no interview is a 404 (there is nothing to
 * answer), while a run parked on an interviewer this deployment never wired is a 503 naming the
 * kind (there is something to answer and this deployment cannot). Collapsing them would tell an
 * operator staring at a stopped run that it is not stopped.
 */
export async function gateInterviewAction<E extends AppEnv>(
  c: Context<E>,
  runId: string,
): Promise<InterviewAction | GateFailure> {
  const gated = await gateDecisionAction(c, runId)
  if ('fail' in gated) return gated
  const { workspaceId, scoped } = gated
  const container = c.get('container')
  const parked = findParkedInterviewStep(scoped.execution, container.agentKindRegistry)
  if (!parked) {
    return {
      fail: { status: 404, code: 'no_interview', message: 'This run has no live interview' },
    }
  }
  const stepKind = parked.step.agentKind
  const gate = container.executionService.interviewGateFor(stepKind)
  if (!gate) {
    return moduleUnavailable(`The ${stepKind} interviewer is not configured`)
  }
  return { workspaceId, scoped, gate, stepKind }
}

/** A deployment that never wired the module behind a park cannot answer it: 503, naming what. */
function moduleUnavailable(message: string): GateFailure {
  return { fail: { status: 503, code: 'unavailable', message } }
}

/**
 * The run exists and the key may answer it, but the entity the route addresses does not exist.
 * A 404 rather than a 409: there is nothing on this run to act on, which is a different fact from
 * "the park moved on" (the service methods raise that themselves).
 */
function noReview(message: string): GateFailure {
  return { fail: { status: 404, code: 'no_review', message } }
}
