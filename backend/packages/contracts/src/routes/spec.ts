import { defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { serviceSpecViewSchema } from '../spec.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Service-spec read route contract. See ServiceSpecController in
// @cat-factory/server. Mounted under `/workspaces/:workspaceId`, so the path here
// is relative to that prefix and `workspaceId` is NOT a contract param (the
// handler reads it via `param(c, 'workspaceId')`).
// ---------------------------------------------------------------------------

export const getServiceSpecContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: withObjectKeys(v.object({ blockId: v.string() })),
  pathResolver: ({ blockId }) => `/blocks/${blockId}/spec`,
  responsesByStatusCode: { 200: serviceSpecViewSchema, ...errorResponses },
})
