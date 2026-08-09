import { defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { binaryCandidateStepStateSchema, keepBinaryCandidatesSchema } from '../binary-candidates.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Generated-candidate comparison route contracts. Mounted under `/workspaces/:workspaceId`, so
// the paths here are relative to that prefix. The read returns the run's active candidate state
// (or null when no step carries one); `keep` records which candidates survive, under which
// alternate ids, and re-runs the step to deliver exactly those. See BinaryCandidatesController in
// @cat-factory/server.
//
// Two verbs rather than three: there is no `discard`, because keeping nothing is not a decision
// this surface can carry out. A step whose every candidate is bad is retried or reworked through
// the surfaces that already exist for that, and answering it here would re-run the step to store
// nothing while recording a completed choice.
// ---------------------------------------------------------------------------

const executionIdParams = singleStringParam('executionId')

export const getBinaryCandidatesContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/binary-candidates`,
  responsesByStatusCode: { 200: v.nullable(binaryCandidateStepStateSchema), ...errorResponses },
})

export const keepBinaryCandidatesContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/binary-candidates/keep`,
  requestBodySchema: keepBinaryCandidatesSchema,
  responsesByStatusCode: { 200: binaryCandidateStepStateSchema, ...errorResponses },
})
