import { defineApiContract } from '@toad-contracts/valibot'
import { serviceSpecViewSchema } from '../spec.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Service-spec read route contract. See ServiceSpecController in
// @cat-factory/server. Mounted under `/workspaces/:workspaceId`, so the path here
// is relative to that prefix and `workspaceId` is NOT a contract param (the
// handler reads it via `param(c, 'workspaceId')`).
// ---------------------------------------------------------------------------

export const getServiceSpecContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: singleStringParam('blockId'),
  pathResolver: ({ blockId }) => `/blocks/${blockId}/spec`,
  responsesByStatusCode: { 200: serviceSpecViewSchema, ...errorResponses },
})

/**
 * The spec as ONE RUN was judged against it, read from the branch that run pushed its work to.
 *
 * A sibling of {@link getServiceSpecContract} rather than a flag on it, because the two answer
 * different questions: "what does this service require" (the default branch, the inspector's
 * requirements window) and "what did this run rule on" (the run's branch, the outcome card). The
 * SPA's outcome card asked the first and used the answer for the second, so while a pull request
 * was open every verdict against a requirement the run itself added landed as "not checked".
 */
export const getRunSpecContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: singleStringParam('executionId'),
  pathResolver: ({ executionId }) => `/executions/${executionId}/spec`,
  responsesByStatusCode: { 200: serviceSpecViewSchema, ...errorResponses },
})
