import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { workspaceSchema } from '../entities.js'
import {
  addWorkspaceMemberSchema,
  setWorkspaceAccessModeSchema,
  setWorkspaceMemberRoleSchema,
  workspaceMemberSchema,
} from '../workspace-members.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Workspace-membership route contracts (workspace-rbac initiative, slice 5). See
// WorkspaceMemberController in @cat-factory/server. All mounted under
// `/workspaces/:workspaceId`. The roster read is open to any resolved role
// (`workspace.read`, satisfied by the gate resolution itself); every write requires
// `members.manage` (enforced by `requirePermission` in the controller).
// ---------------------------------------------------------------------------

const workspaceMemberListSchema = v.array(workspaceMemberSchema)

const workspaceIdParams = singleStringParam('workspaceId')
const memberParams = withObjectKeys(v.object({ workspaceId: v.string(), userId: v.string() }))

export const listWorkspaceMembersContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: workspaceIdParams,
  pathResolver: ({ workspaceId }) => `/workspaces/${workspaceId}/members`,
  responsesByStatusCode: { 200: workspaceMemberListSchema, ...errorResponses },
})

export const addWorkspaceMemberContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: workspaceIdParams,
  pathResolver: ({ workspaceId }) => `/workspaces/${workspaceId}/members`,
  requestBodySchema: addWorkspaceMemberSchema,
  responsesByStatusCode: { 201: workspaceMemberSchema, ...errorResponses },
})

export const setWorkspaceMemberRoleContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: memberParams,
  pathResolver: ({ workspaceId, userId }) => `/workspaces/${workspaceId}/members/${userId}`,
  requestBodySchema: setWorkspaceMemberRoleSchema,
  responsesByStatusCode: { 200: workspaceMemberSchema, ...errorResponses },
})

export const removeWorkspaceMemberContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: memberParams,
  pathResolver: ({ workspaceId, userId }) => `/workspaces/${workspaceId}/members/${userId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

export const setWorkspaceAccessModeContract = defineApiContract({
  method: 'put',
  requestPathParamsSchema: workspaceIdParams,
  pathResolver: ({ workspaceId }) => `/workspaces/${workspaceId}/access-mode`,
  requestBodySchema: setWorkspaceAccessModeSchema,
  responsesByStatusCode: { 200: workspaceSchema, ...errorResponses },
})
