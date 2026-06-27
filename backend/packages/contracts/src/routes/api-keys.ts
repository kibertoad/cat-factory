import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { addApiKeySchema, apiKeyListResultSchema, apiKeySchema } from '../api-keys.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Direct-provider API-key route contracts. Two controllers consume these:
// `workspaceApiKeyController` (mounted under `/workspaces/:workspaceId`, so its
// paths are relative) and `userApiKeyController` (mounted at `/`, so its `/me`
// paths are absolute and carry no path params). See ApiKeyController in
// @cat-factory/server. (The account-scoped key routes live in `routes/accounts.ts`.)
// ---------------------------------------------------------------------------

const idParams = withObjectKeys(v.object({ id: v.string() }))

// ---- workspace-scoped (relative to `/workspaces/:workspaceId`) ------------

export const listWorkspaceApiKeysContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/api-keys',
  responsesByStatusCode: { 200: apiKeyListResultSchema, ...errorResponses },
})

export const addWorkspaceApiKeyContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/api-keys',
  requestBodySchema: addApiKeySchema,
  responsesByStatusCode: { 201: apiKeySchema, ...errorResponses },
})

export const removeWorkspaceApiKeyContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: idParams,
  pathResolver: ({ id }) => `/api-keys/${id}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

// ---- user-scoped (the caller's own pool, mounted at the root) -------------

export const listUserApiKeysContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/me/api-keys',
  responsesByStatusCode: { 200: apiKeyListResultSchema, ...errorResponses },
})

export const addUserApiKeyContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/me/api-keys',
  requestBodySchema: addApiKeySchema,
  responsesByStatusCode: { 201: apiKeySchema, ...errorResponses },
})

export const removeUserApiKeyContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: idParams,
  pathResolver: ({ id }) => `/me/api-keys/${id}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
