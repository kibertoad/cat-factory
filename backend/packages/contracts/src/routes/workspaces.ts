import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { workspaceSchema } from '../entities.js'
import { createWorkspaceSchema, renameWorkspaceSchema } from '../requests.js'
import { workspaceSnapshotSchema } from '../snapshot.js'
import { workspaceRoleSchema } from '../workspace-members.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Workspace (board) lifecycle route contracts. See WorkspaceController in
// @cat-factory/server. The list + create roots are mounted at `/` (the literals
// here are the full absolute paths); the single-workspace routes carry the
// `:workspaceId` segment in their literal too — the controller still reads it via
// `param(c, 'workspaceId')`, so it is NOT declared as a contract param.
// ---------------------------------------------------------------------------

/**
 * A board as returned by `GET /workspaces`, annotated with the caller's effective
 * workspace-RBAC role (`viewerRole`) so the SPA can badge a restricted board the caller
 * only reaches as a viewer/member. Optional: absent ⇒ dev-open, or a board the caller
 * reaches purely via account membership with no explicit member row.
 */
export const workspaceListItemSchema = v.object({
  ...workspaceSchema.entries,
  viewerRole: v.optional(workspaceRoleSchema),
})
export type WorkspaceListItem = v.InferOutput<typeof workspaceListItemSchema>

const workspaceListSchema = v.array(workspaceListItemSchema)

export const listWorkspacesContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/workspaces',
  responsesByStatusCode: { 200: workspaceListSchema, ...errorResponses },
})

export const createWorkspaceContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/workspaces',
  requestBodySchema: createWorkspaceSchema,
  responsesByStatusCode: { 201: workspaceSnapshotSchema, ...errorResponses },
})

export const getWorkspaceContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: singleStringParam('workspaceId'),
  pathResolver: ({ workspaceId }) => `/workspaces/${workspaceId}`,
  responsesByStatusCode: { 200: workspaceSnapshotSchema, ...errorResponses },
})

export const updateWorkspaceContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: singleStringParam('workspaceId'),
  pathResolver: ({ workspaceId }) => `/workspaces/${workspaceId}`,
  requestBodySchema: renameWorkspaceSchema,
  responsesByStatusCode: { 200: workspaceSchema, ...errorResponses },
})

export const deleteWorkspaceContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: singleStringParam('workspaceId'),
  pathResolver: ({ workspaceId }) => `/workspaces/${workspaceId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
