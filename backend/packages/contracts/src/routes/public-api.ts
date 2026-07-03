import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import {
  createPublicApiKeySchema,
  createdPublicApiKeySchema,
  publicApiKeyListResultSchema,
} from '../public-api-keys.js'
import {
  createInitiativeJobSchema,
  initiativeAcceptedSchema,
  publicJobSchema,
} from '../public-api.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Public-API route contracts. Two surfaces:
//
//  1. Key management — session-authed, mounted under `/workspaces/:workspaceId`
//     (so paths are relative). A workspace owner mints/lists/revokes the keys an
//     external system will present. Note the path is `/public-api-keys` — the bare
//     `/api-keys` is the direct-provider (outbound) key pool.
//
//  2. The external surface — `/api/v1/*`, authenticated in-controller by the
//     public-API key (not the session gate), scoped to the key's workspace.
// ---------------------------------------------------------------------------

const idParams = singleStringParam('id')

// ---- key management (relative to `/workspaces/:workspaceId`) ---------------

export const listPublicApiKeysContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/public-api-keys',
  responsesByStatusCode: { 200: publicApiKeyListResultSchema, ...errorResponses },
})

export const createPublicApiKeyContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/public-api-keys',
  requestBodySchema: createPublicApiKeySchema,
  responsesByStatusCode: { 201: createdPublicApiKeySchema, ...errorResponses },
})

export const revokePublicApiKeyContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: idParams,
  pathResolver: ({ id }) => `/public-api-keys/${id}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

// ---- the external `/api/v1` surface (absolute paths, key-authenticated) ----

export const createInitiativeJobContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/api/v1/initiatives',
  requestBodySchema: createInitiativeJobSchema,
  responsesByStatusCode: { 202: initiativeAcceptedSchema, ...errorResponses },
})

export const getPublicJobContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: idParams,
  pathResolver: ({ id }) => `/api/v1/jobs/${id}`,
  responsesByStatusCode: { 200: publicJobSchema, ...errorResponses },
})
