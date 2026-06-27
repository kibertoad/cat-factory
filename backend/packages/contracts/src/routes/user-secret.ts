import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { connectionTestResultSchema } from '../provider-config.js'
import {
  storeUserSecretSchema,
  testUserSecretSchema,
  userSecretDescriptorSchema,
  userSecretStatusSchema,
} from '../user-secret.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Per-USER generic secret route contracts (a GitHub PAT today). Scoped to the
// signed-in user (not a workspace) and mounted at the root, so the paths here
// are absolute. The secret is write-only — only status metadata is returned.
// See UserSecretController in @cat-factory/server.
// ---------------------------------------------------------------------------

// Response wrapper that exists only inline in the controller today.
const userSecretsViewSchema = v.object({
  secrets: v.array(userSecretStatusSchema),
  descriptors: v.array(userSecretDescriptorSchema),
})

const kindParams = withObjectKeys(v.object({ kind: v.string() }))

export const listUserSecretsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/user-secrets',
  responsesByStatusCode: { 200: userSecretsViewSchema, ...errorResponses },
})

export const getUserSecretDescriptorContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: kindParams,
  pathResolver: ({ kind }) => `/user-secrets/${kind}/descriptor`,
  responsesByStatusCode: { 200: userSecretDescriptorSchema, ...errorResponses },
})

export const storeUserSecretContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: kindParams,
  pathResolver: ({ kind }) => `/user-secrets/${kind}`,
  requestBodySchema: storeUserSecretSchema,
  responsesByStatusCode: { 201: userSecretStatusSchema, ...errorResponses },
})

export const removeUserSecretContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: kindParams,
  pathResolver: ({ kind }) => `/user-secrets/${kind}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

export const testUserSecretContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: kindParams,
  pathResolver: ({ kind }) => `/user-secrets/${kind}/test`,
  requestBodySchema: testUserSecretSchema,
  responsesByStatusCode: { 200: connectionTestResultSchema, ...errorResponses },
})
