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
import { auditEventPageSchema } from '../audit.js'
import {
  addApiKeySchema,
  apiKeyListResultSchema,
  apiKeySchema,
  updateApiKeySchema,
} from '../api-keys.js'
import { platformObservabilitySchema, platformObservabilityWindowSchema } from '../observability.js'
import { reportWindowSchema, reportsViewSchema } from '../reports.js'
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

// Admin-forced session revocation: end every session a member currently holds, without touching
// their membership or roles. The offboarding lever an account admin needs when access must stop
// NOW (a lost laptop, a departure processed ahead of the directory), and the deliberate companion
// to the self-serve `/auth/sessions/revoke-all`.
//
// It is its own route rather than a side effect of a role change, because the two answer different
// questions: roles decide what somebody may do on their NEXT request (the RBAC gate re-reads them,
// so a downgrade needs no revocation), while this decides whether their existing bearers still
// authenticate at all. Folding one into the other would sign a person out of every board because
// their role on one of them was adjusted.
//
// Idempotent, and it returns no body: the new generation is an internal number, and reporting it
// would invite a client to compare values that only the server may compare.
export const revokeMemberSessionsContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: withObjectKeys(v.object({ accountId: v.string(), userId: v.string() })),
  pathResolver: ({ accountId, userId }) =>
    `/accounts/${accountId}/members/${userId}/revoke-sessions`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

// ---- audit log ------------------------------------------------------------

// One page of the account's audit log, newest first. Admin-gated for READ as well as write: the
// log names who did what to whom, which is exactly the roster metadata a non-admin member has no
// business enumerating.
//
// Paginated from day one and by KEYSET, because an audit table only grows: the unbounded SELECT
// that is merely untidy on a young deployment is the one that times out on the deployment old
// enough to have something worth auditing. `cursor` is opaque and round-trips verbatim; `limit` is
// clamped server-side, so a client asking for the whole table gets a page.
export const listAuditEventsContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: accountIdParams,
  requestQuerySchema: v.object({
    cursor: v.optional(v.string()),
    limit: v.optional(v.pipe(v.unknown(), v.transform(Number), v.number(), v.minValue(1))),
  }),
  pathResolver: ({ accountId }) => `/accounts/${accountId}/audit-events`,
  responsesByStatusCode: { 200: auditEventPageSchema, ...errorResponses },
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

// ---- reports (admin-only) -------------------------------------------------

// Cross-cutting usage analytics for the account: spend per model / agent kind / ticket /
// run, and spend + run activity per workspace / service / repository / task type, over a
// time window. Admin gated for the same reason as the dashboard above (cross-workspace
// operational data). `workspaceId` narrows EVERY breakdown to one board; absent ⇒ the whole
// account. The two activity-scaled spend axes (`ticket`, `run`) are capped, and the
// projection's `capped` array names each cap; an empty array means nothing was dropped.
export const getReportsContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: accountIdParams,
  requestQuerySchema: v.object({
    window: v.optional(reportWindowSchema),
    workspaceId: v.optional(v.string()),
  }),
  pathResolver: ({ accountId }) => `/accounts/${accountId}/reports`,
  responsesByStatusCode: { 200: reportsViewSchema, ...errorResponses },
})
