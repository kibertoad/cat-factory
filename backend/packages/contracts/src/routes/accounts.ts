import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  accountInvitationSchema,
  accountMemberSchema,
  accountSchema,
  addMemberSchema,
  connectEmailSchema,
  createAccountSchema,
  createInvitationSchema,
  emailConnectionSchema,
  setMemberRolesSchema,
  testEmailSchema,
  updateAccountSchema,
} from '../accounts.js'
import { accountSettingsViewSchema, updateAccountSettingsSchema } from '../accountSettings.js'
import {
  addApiKeySchema,
  apiKeyListResultSchema,
  apiKeySchema,
  updateApiKeySchema,
} from '../api-keys.js'
import { platformObservabilitySchema, platformObservabilityWindowSchema } from '../observability.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Account tenancy route contracts. See AccountController in @cat-factory/server.
// ---------------------------------------------------------------------------

const accountListSchema = v.array(accountSchema)
const accountMemberListSchema = v.array(accountMemberSchema)
const accountInvitationListSchema = v.array(accountInvitationSchema)

// Response wrappers that exist only inline in the controller today.
const createInvitationResultSchema = v.object({
  invitation: accountInvitationSchema,
  acceptUrl: v.nullable(v.string()),
})
const emailConnectionViewSchema = v.object({
  connection: v.nullable(emailConnectionSchema),
  configured: v.boolean(),
})
const okSchema = v.object({ ok: v.boolean() })

const accountIdParams = singleStringParam('accountId')

// ---- accounts (tenancy) ---------------------------------------------------

export const listAccountsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/accounts',
  responsesByStatusCode: { 200: accountListSchema, ...errorResponses },
})

export const createAccountContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/accounts',
  requestBodySchema: createAccountSchema,
  responsesByStatusCode: { 201: accountSchema, ...errorResponses },
})

export const updateAccountContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: accountIdParams,
  pathResolver: ({ accountId }) => `/accounts/${accountId}`,
  requestBodySchema: updateAccountSchema,
  responsesByStatusCode: { 200: accountSchema, ...errorResponses },
})

// ---- members --------------------------------------------------------------

export const listAccountMembersContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: accountIdParams,
  pathResolver: ({ accountId }) => `/accounts/${accountId}/members`,
  responsesByStatusCode: { 200: accountMemberListSchema, ...errorResponses },
})

export const addAccountMemberContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: accountIdParams,
  pathResolver: ({ accountId }) => `/accounts/${accountId}/members`,
  requestBodySchema: addMemberSchema,
  responsesByStatusCode: { 201: accountMemberSchema, ...errorResponses },
})

export const setMemberRolesContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: withObjectKeys(v.object({ accountId: v.string(), userId: v.string() })),
  pathResolver: ({ accountId, userId }) => `/accounts/${accountId}/members/${userId}/roles`,
  requestBodySchema: setMemberRolesSchema,
  responsesByStatusCode: { 200: accountMemberSchema, ...errorResponses },
})

// ---- invitations ----------------------------------------------------------

export const listInvitationsContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: accountIdParams,
  pathResolver: ({ accountId }) => `/accounts/${accountId}/invitations`,
  responsesByStatusCode: { 200: accountInvitationListSchema, ...errorResponses },
})

export const createInvitationContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: accountIdParams,
  pathResolver: ({ accountId }) => `/accounts/${accountId}/invitations`,
  requestBodySchema: createInvitationSchema,
  responsesByStatusCode: { 201: createInvitationResultSchema, ...errorResponses },
})

export const revokeInvitationContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: withObjectKeys(
    v.object({ accountId: v.string(), invitationId: v.string() }),
  ),
  pathResolver: ({ accountId, invitationId }) =>
    `/accounts/${accountId}/invitations/${invitationId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

// ---- account-scoped provider API keys -------------------------------------

export const listAccountApiKeysContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: accountIdParams,
  pathResolver: ({ accountId }) => `/accounts/${accountId}/api-keys`,
  responsesByStatusCode: { 200: apiKeyListResultSchema, ...errorResponses },
})

export const addAccountApiKeyContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: accountIdParams,
  pathResolver: ({ accountId }) => `/accounts/${accountId}/api-keys`,
  requestBodySchema: addApiKeySchema,
  responsesByStatusCode: { 201: apiKeySchema, ...errorResponses },
})

export const updateAccountApiKeyContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: withObjectKeys(v.object({ accountId: v.string(), id: v.string() })),
  pathResolver: ({ accountId, id }) => `/accounts/${accountId}/api-keys/${id}`,
  requestBodySchema: updateApiKeySchema,
  responsesByStatusCode: { 200: apiKeySchema, ...errorResponses },
})

export const removeAccountApiKeyContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: withObjectKeys(v.object({ accountId: v.string(), id: v.string() })),
  pathResolver: ({ accountId, id }) => `/accounts/${accountId}/api-keys/${id}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

// ---- email sender connection ----------------------------------------------

export const getEmailConnectionContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: accountIdParams,
  pathResolver: ({ accountId }) => `/accounts/${accountId}/email-connection`,
  responsesByStatusCode: { 200: emailConnectionViewSchema, ...errorResponses },
})

export const connectEmailContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: accountIdParams,
  pathResolver: ({ accountId }) => `/accounts/${accountId}/email-connection`,
  requestBodySchema: connectEmailSchema,
  responsesByStatusCode: { 201: emailConnectionSchema, ...errorResponses },
})

export const disconnectEmailContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: accountIdParams,
  pathResolver: ({ accountId }) => `/accounts/${accountId}/email-connection`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

export const testEmailContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: accountIdParams,
  pathResolver: ({ accountId }) => `/accounts/${accountId}/email-connection/test`,
  requestBodySchema: testEmailSchema,
  responsesByStatusCode: { 200: okSchema, ...errorResponses },
})

// ---- deployment settings --------------------------------------------------

export const getAccountSettingsContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: accountIdParams,
  pathResolver: ({ accountId }) => `/accounts/${accountId}/settings`,
  responsesByStatusCode: { 200: accountSettingsViewSchema, ...errorResponses },
})

export const updateAccountSettingsContract = defineApiContract({
  method: 'put',
  requestPathParamsSchema: accountIdParams,
  pathResolver: ({ accountId }) => `/accounts/${accountId}/settings`,
  requestBodySchema: updateAccountSettingsSchema,
  responsesByStatusCode: { 200: accountSettingsViewSchema, ...errorResponses },
})

// ---- platform-operator observability (admin-only) -------------------------

// Deployment-level aggregate health for the account, over a time window. Admin-gated
// (sensitive cross-workspace operational data). See PlatformObservabilityController.
export const getPlatformObservabilityContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: accountIdParams,
  requestQuerySchema: v.object({ window: v.optional(platformObservabilityWindowSchema) }),
  pathResolver: ({ accountId }) => `/accounts/${accountId}/observability/platform`,
  responsesByStatusCode: { 200: platformObservabilitySchema, ...errorResponses },
})
