import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  publicChooseForkSchema,
  publicResolveInputGateSchema,
  publicResolveJudgeSchema,
  publicDecisionListSchema,
  publicIncorporateSchema,
  publicReplyFindingSchema,
  publicResolveExceededSchema,
  publicSetFindingStatusSchema,
} from '../public-decisions.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Public-API route contracts for a run's PARKED HUMAN DECISIONS — the external counterpart of
// the SPA's requirements-review window and fork-decision window, so a headless caller can drive
// the clarification loop it previously could not even start.
//
// Keyed by RUN id, not task id: the same surface then serves BOTH a headless initiative job
// (`POST /api/v1/jobs`, anchored on an internal block with no board task) and an ordinary
// board task run (`POST /api/v1/tasks/:taskId/start`). Every route is workspace-scoped by the
// caller's key.
//
// Reading a run's decisions needs `read`; ANSWERING one needs the `decide` rung of the scope
// ladder — the same rung that admits a parking pipeline in the first place (see
// `docs/initiatives/headless-clarification-loop.md`, D1).
// ---------------------------------------------------------------------------

const runIdParams = singleStringParam('runId')
const runItemParams = withObjectKeys(v.object({ runId: v.string(), itemId: v.string() }))

/** List a run's currently-parked decisions (findings, fork options) — `read`. */
export const listPublicRunDecisionsContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: runIdParams,
  pathResolver: ({ runId }) => `/api/v1/runs/${runId}/decisions`,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

// ---- requirements review ---------------------------------------------------

/** Answer one reviewer finding. */
export const replyPublicRunFindingContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runItemParams,
  pathResolver: ({ runId, itemId }) =>
    `/api/v1/runs/${runId}/decisions/requirements/findings/${itemId}/reply`,
  requestBodySchema: publicReplyFindingSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Dismiss a finding as not applicable, or reopen one dismissed by mistake. */
export const setPublicRunFindingStatusContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: runItemParams,
  pathResolver: ({ runId, itemId }) =>
    `/api/v1/runs/${runId}/decisions/requirements/findings/${itemId}`,
  requestBodySchema: publicSetFindingStatusSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/**
 * Fold the recorded answers into the standardized requirements document. ASYNCHRONOUS — the
 * durable driver folds and re-reviews in the background, so the response shows the review
 * `incorporating`; poll (or watch the SSE stream) for the next round or convergence.
 */
export const incorporatePublicRunRequirementsContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runIdParams,
  pathResolver: ({ runId }) => `/api/v1/runs/${runId}/decisions/requirements/incorporate`,
  requestBodySchema: publicIncorporateSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Run one more reviewer pass over the incorporated document. */
export const reReviewPublicRunRequirementsContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runIdParams,
  pathResolver: ({ runId }) => `/api/v1/runs/${runId}/decisions/requirements/re-review`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Settle the requirements phase and advance the parked run (used when nothing is outstanding). */
export const proceedPublicRunRequirementsContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runIdParams,
  pathResolver: ({ runId }) => `/api/v1/runs/${runId}/decisions/requirements/proceed`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Resolve a review that hit its iteration cap (extra round / proceed / stop and reset). */
export const resolvePublicRunRequirementsExceededContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runIdParams,
  pathResolver: ({ runId }) => `/api/v1/runs/${runId}/decisions/requirements/resolve-exceeded`,
  requestBodySchema: publicResolveExceededSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

// ---- implementation fork ---------------------------------------------------

/** Choose an implementation approach (a proposed fork id or a custom approach). */
export const choosePublicRunForkContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runIdParams,
  pathResolver: ({ runId }) => `/api/v1/runs/${runId}/decisions/fork/choose`,
  requestBodySchema: publicChooseForkSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

// ---- judge ------------------------------------------------------------------

/** Resolve a parked judge verdict: proceed anyway / bounce for rework / stop the run. */
export const resolvePublicRunJudgeContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runIdParams,
  pathResolver: ({ runId }) => `/api/v1/runs/${runId}/decisions/judge/resolve`,
  requestBodySchema: publicResolveJudgeSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

// ---- pre-token input gate ---------------------------------------------------

/**
 * Resolve a run parked on the PRE-TOKEN INPUT GATE: `recheck` re-evaluates the task as it now
 * stands, `proceed` waives the findings.
 *
 * The one park that is a property of the TASK rather than the pipeline, so unlike the three above
 * it can hold a run whose pipeline `canParkOnHuman` calls unparking. Without this route such a run
 * reported `parked: true` with nothing to answer and `POST /api/v1/jobs/:id/cancel` as its only
 * exit. A caller that means to FIX the task edits it over `PATCH /api/v1/tasks/:taskId` first;
 * `recheck` then verifies rather than takes the claim on trust, and a still-blocked verdict comes
 * back as an ordinary 200 with refreshed findings, because nothing went wrong.
 */
export const resolvePublicRunInputGateContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runIdParams,
  pathResolver: ({ runId }) => `/api/v1/runs/${runId}/decisions/input-gate/resolve`,
  requestBodySchema: publicResolveInputGateSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})
