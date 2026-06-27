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
