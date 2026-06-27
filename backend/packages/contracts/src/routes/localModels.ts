import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  localModelEndpointSchema,
  localModelEndpointTestResultSchema,
  testLocalModelEndpointSchema,
  upsertLocalModelEndpointSchema,
} from '../localModels.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Per-user local-runner endpoint route contracts. The
// LocalModelEndpointController is mounted at `/`, so the paths are absolute and
// carry no workspace param; endpoints are scoped to the signed-in user. See
// LocalModelEndpointController in @cat-factory/server.
// ---------------------------------------------------------------------------

// Response wrapper that exists only inline in the controller today.
const localModelEndpointListSchema = v.object({
  endpoints: v.array(localModelEndpointSchema),
})

// The `:provider` segment is re-validated against `localRunnerSchema` in the handler.
const providerParams = withObjectKeys(v.object({ provider: v.string() }))

export const listLocalModelEndpointsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/local-model-endpoints',
  responsesByStatusCode: { 200: localModelEndpointListSchema, ...errorResponses },
})

export const upsertLocalModelEndpointContract = defineApiContract({
  method: 'put',
  requestPathParamsSchema: providerParams,
  pathResolver: ({ provider }) => `/local-model-endpoints/${provider}`,
  requestBodySchema: upsertLocalModelEndpointSchema,
  responsesByStatusCode: { 201: localModelEndpointSchema, ...errorResponses },
})

export const removeLocalModelEndpointContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: providerParams,
  pathResolver: ({ provider }) => `/local-model-endpoints/${provider}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

export const testLocalModelEndpointContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/local-model-endpoints/test',
  requestBodySchema: testLocalModelEndpointSchema,
  responsesByStatusCode: { 200: localModelEndpointTestResultSchema, ...errorResponses },
})
