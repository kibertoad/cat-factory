import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { brainstormStageSchema } from '../brainstorm.js'
import {
  publicApproveStepSchema,
  publicChallengePrReviewFindingSchema,
  publicChooseForkSchema,
  publicRejectStepSchema,
  publicRequestGateFixSchema,
  publicRequestStepChangesSchema,
  publicResolveAgentDecisionSchema,
  publicResolveInputGateSchema,
  publicResolveJudgeSchema,
  publicResolvePrReviewSchema,
  publicResolveStepExceededSchema,
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
const runApprovalParams = withObjectKeys(v.object({ runId: v.string(), approvalId: v.string() }))
const runDecisionParams = withObjectKeys(v.object({ runId: v.string(), decisionId: v.string() }))
const runFindingParams = withObjectKeys(v.object({ runId: v.string(), findingId: v.string() }))
// The brainstorm routes are STAGE-keyed: a block may hold one live `requirements` session and one
// live `architecture` session at once, so the stage is part of the address rather than something
// the server picks. Validated by the contract, so an unknown stage is a shared 400 rather than a
// controller's hand-rolled refusal.
const runStageParams = withObjectKeys(v.object({ runId: v.string(), stage: brainstormStageSchema }))
const runStageItemParams = withObjectKeys(
  v.object({ runId: v.string(), stage: brainstormStageSchema, itemId: v.string() }),
)

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

// ---- pre-dispatch input gate ---------------------------------------------------

/**
 * Resolve a run parked on the PRE-DISPATCH INPUT GATE: `recheck` re-evaluates the task as it now
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

// ---- approval gates ---------------------------------------------------------
//
// Addressed by the gate's own `approvalId`, read from `GET .../decisions`. That is not ceremony
// over a value the caller never chose (the reason the requirements routes deliberately drop the
// review id): the engine ARBITRATES a parked gate by this id, so a call that omitted it would have
// the server pick whichever gate the run has reached by the time it lands — which is precisely how
// a slow integration would approve a step nobody looked at.

/** Approve a parked gate's proposal (optionally replacing it with an edited one). */
export const approvePublicRunStepContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runApprovalParams,
  pathResolver: ({ runId, approvalId }) =>
    `/api/v1/runs/${runId}/decisions/approvals/${approvalId}/approve`,
  requestBodySchema: publicApproveStepSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Request changes on a parked gate: the step re-runs with the supplied guidance. */
export const requestPublicRunStepChangesContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runApprovalParams,
  pathResolver: ({ runId, approvalId }) =>
    `/api/v1/runs/${runId}/decisions/approvals/${approvalId}/request-changes`,
  requestBodySchema: publicRequestStepChangesSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Reject a parked gate: the run stops entirely (a terminal, retryable failure). */
export const rejectPublicRunStepContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runApprovalParams,
  pathResolver: ({ runId, approvalId }) =>
    `/api/v1/runs/${runId}/decisions/approvals/${approvalId}/reject`,
  requestBodySchema: publicRejectStepSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/**
 * Resolve a companion gate parked at its automatic-rework cap (extra round / proceed / stop and
 * reset). Distinct from `approve` on purpose, exactly as in the app: a capped companion gate is
 * asking a different question, and letting the generic approve settle it would ship output the
 * companion never passed.
 */
export const resolvePublicRunStepExceededContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runApprovalParams,
  pathResolver: ({ runId, approvalId }) =>
    `/api/v1/runs/${runId}/decisions/approvals/${approvalId}/resolve-exceeded`,
  requestBodySchema: publicResolveStepExceededSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

// ---- agent-raised decisions -------------------------------------------------

/**
 * Answer a decision an agent raised mid-work. Resolving RE-RUNS the asking step with the choice
 * folded in, rather than advancing past it — the difference from an approval gate.
 */
export const resolvePublicRunAgentDecisionContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runDecisionParams,
  pathResolver: ({ runId, decisionId }) =>
    `/api/v1/runs/${runId}/decisions/questions/${decisionId}/answer`,
  requestBodySchema: publicResolveAgentDecisionSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

// ---- clarity review (bug-report triage) -------------------------------------
//
// The requirements twin, verb for verb, and addressed the same way: by ITEM id, with the live
// review resolved from the run's block. The INTERNAL clarity routes are review-keyed
// (`/clarity-reviews/:reviewId/items/:itemId/reply`); copying that here would make a headless
// caller thread through a review id it never chose.

/** Answer one clarity finding. */
export const replyPublicRunClarityFindingContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runItemParams,
  pathResolver: ({ runId, itemId }) =>
    `/api/v1/runs/${runId}/decisions/clarity/findings/${itemId}/reply`,
  requestBodySchema: publicReplyFindingSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Dismiss a clarity finding as not applicable, or reopen one dismissed by mistake. */
export const setPublicRunClarityFindingStatusContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: runItemParams,
  pathResolver: ({ runId, itemId }) => `/api/v1/runs/${runId}/decisions/clarity/findings/${itemId}`,
  requestBodySchema: publicSetFindingStatusSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Fold the recorded answers into the standardized bug report. ASYNCHRONOUS, as requirements. */
export const incorporatePublicRunClarityContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runIdParams,
  pathResolver: ({ runId }) => `/api/v1/runs/${runId}/decisions/clarity/incorporate`,
  requestBodySchema: publicIncorporateSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Run one more triage pass over the clarified report. */
export const reReviewPublicRunClarityContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runIdParams,
  pathResolver: ({ runId }) => `/api/v1/runs/${runId}/decisions/clarity/re-review`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Settle the clarity phase and advance the parked run. */
export const proceedPublicRunClarityContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runIdParams,
  pathResolver: ({ runId }) => `/api/v1/runs/${runId}/decisions/clarity/proceed`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Resolve a clarity review that hit its iteration cap (extra round / proceed / stop and reset). */
export const resolvePublicRunClarityExceededContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runIdParams,
  pathResolver: ({ runId }) => `/api/v1/runs/${runId}/decisions/clarity/resolve-exceeded`,
  requestBodySchema: publicResolveExceededSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

// ---- brainstorm dialogues ---------------------------------------------------

/** Respond to one proposed option (pick it, or steer it). */
export const replyPublicRunBrainstormOptionContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runStageItemParams,
  pathResolver: ({ runId, stage, itemId }) =>
    `/api/v1/runs/${runId}/decisions/brainstorm/${stage}/options/${itemId}/reply`,
  requestBodySchema: publicReplyFindingSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Dismiss a proposed option, or reopen one dismissed by mistake. */
export const setPublicRunBrainstormOptionStatusContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: runStageItemParams,
  pathResolver: ({ runId, stage, itemId }) =>
    `/api/v1/runs/${runId}/decisions/brainstorm/${stage}/options/${itemId}`,
  requestBodySchema: publicSetFindingStatusSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Fold the picks into one converged direction. ASYNCHRONOUS, as requirements. */
export const incorporatePublicRunBrainstormContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runStageParams,
  pathResolver: ({ runId, stage }) =>
    `/api/v1/runs/${runId}/decisions/brainstorm/${stage}/incorporate`,
  requestBodySchema: publicIncorporateSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Run one more brainstorm pass against the converged direction. */
export const reReviewPublicRunBrainstormContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runStageParams,
  pathResolver: ({ runId, stage }) =>
    `/api/v1/runs/${runId}/decisions/brainstorm/${stage}/re-review`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Settle the brainstorm (the last converged direction wins downstream) and advance the run. */
export const proceedPublicRunBrainstormContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runStageParams,
  pathResolver: ({ runId, stage }) => `/api/v1/runs/${runId}/decisions/brainstorm/${stage}/proceed`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Resolve a brainstorm that hit its iteration cap (extra round / proceed / stop and reset). */
export const resolvePublicRunBrainstormExceededContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runStageParams,
  pathResolver: ({ runId, stage }) =>
    `/api/v1/runs/${runId}/decisions/brainstorm/${stage}/resolve-exceeded`,
  requestBodySchema: publicResolveExceededSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

// ---- PR deep review ---------------------------------------------------------

/**
 * Resolve a parked PR deep review with the curated selection. `fix` and `post` act on the real
 * pull request (a fixer commit, inline review comments), which is the one place this surface has
 * an effect outside the platform — reachable only for a board task run, since a `pr-reviewer` step
 * is container-backed and the jobs surface is inline-only.
 */
export const resolvePublicRunPrReviewContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runIdParams,
  pathResolver: ({ runId }) => `/api/v1/runs/${runId}/decisions/pr-review/resolve`,
  requestBodySchema: publicResolvePrReviewSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Drop one finding from the parked review entirely (curation; the run stays parked). */
export const dismissPublicRunPrReviewFindingContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runFindingParams,
  pathResolver: ({ runId, findingId }) =>
    `/api/v1/runs/${runId}/decisions/pr-review/findings/${findingId}/dismiss`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Challenge one finding: a read-only investigator re-examines it against the full source. */
export const challengePublicRunPrReviewFindingContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runFindingParams,
  pathResolver: ({ runId, findingId }) =>
    `/api/v1/runs/${runId}/decisions/pr-review/findings/${findingId}/challenge`,
  requestBodySchema: publicChallengePrReviewFindingSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

// ---- human-verdict gates ----------------------------------------------------
//
// Only the two VERDICT verbs per gate. The app's environment-management affordances (recreate /
// destroy / pull-main on human-test, recapture on visual-confirmation) are deliberately absent:
// they are things a person does WHILE looking at the environment, not answers to the park, and
// each is an unbounded lever on infrastructure rather than a decision the run is waiting for.
// A caller that needs a fresh environment requests a fix or stops the run.

/** Confirm the change works in the ephemeral environment: tear it down and advance the run. */
export const confirmPublicRunHumanTestContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runIdParams,
  pathResolver: ({ runId }) => `/api/v1/runs/${runId}/decisions/human-test/confirm`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Submit findings against the tested environment and dispatch a fixer. */
export const requestPublicRunHumanTestFixContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runIdParams,
  pathResolver: ({ runId }) => `/api/v1/runs/${runId}/decisions/human-test/request-fix`,
  requestBodySchema: publicRequestGateFixSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Approve the reviewed screenshots and advance the run. */
export const approvePublicRunVisualConfirmContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runIdParams,
  pathResolver: ({ runId }) => `/api/v1/runs/${runId}/decisions/visual-confirmation/approve`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})

/** Submit findings against the reviewed screenshots and dispatch a fixer. */
export const requestPublicRunVisualConfirmFixContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: runIdParams,
  pathResolver: ({ runId }) => `/api/v1/runs/${runId}/decisions/visual-confirmation/request-fix`,
  requestBodySchema: publicRequestGateFixSchema,
  responsesByStatusCode: { 200: publicDecisionListSchema, ...errorResponses },
})
