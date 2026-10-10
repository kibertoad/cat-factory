import { defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  addressBugFishingFindingsSchema,
  bugFishingStepStateSchema,
  resolveBugFishingSchema,
} from '../bugFishing.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Bug-fishing expedition route contracts. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. The read returns the run's active
// expedition state (or null when no `bug-fisher` step carries one); `address` marks
// findings and spawns a bug-fix task per marked finding; `dismiss` drops one from
// triage; `resolve` finishes a parked expedition. See BugFishingController in
// @cat-factory/server.
// ---------------------------------------------------------------------------

const executionIdParams = singleStringParam('executionId')
const findingParams = withObjectKeys(v.object({ executionId: v.string(), findingId: v.string() }))

export const getBugFishingContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/bug-fishing`,
  responsesByStatusCode: { 200: v.nullable(bugFishingStepStateSchema), ...errorResponses },
})

/**
 * Mark findings to be addressed: each spawns its own bug-fix task linked to the expedition.
 *
 * Deliberately accepted while the expedition is STILL FISHING later phases as well as once it
 * parks: a completed phase's findings are actionable the moment they land, and making a human
 * wait for the last angle is exactly the delay running the angles separately is meant to avoid.
 */
export const addressBugFishingFindingsContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/bug-fishing/address`,
  requestBodySchema: addressBugFishingFindingsSchema,
  responsesByStatusCode: { 200: bugFishingStepStateSchema, ...errorResponses },
})

/** Dismiss a finding: it stays on the expedition's record, struck through, and is not spawnable. */
export const dismissBugFishingFindingContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: findingParams,
  pathResolver: ({ executionId, findingId }) =>
    `/executions/${executionId}/bug-fishing/findings/${findingId}/dismiss`,
  requestBodySchema: resolveBugFishingSchema,
  responsesByStatusCode: { 200: bugFishingStepStateSchema, ...errorResponses },
})

/** Finish a parked expedition (the human is done triaging); the run advances past the step. */
export const resolveBugFishingContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/bug-fishing/resolve`,
  requestBodySchema: resolveBugFishingSchema,
  responsesByStatusCode: { 200: bugFishingStepStateSchema, ...errorResponses },
})
