import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { workspaceSchema } from '../entities.js'
import { createWorkspaceSchema, renameWorkspaceSchema } from '../requests.js'
import { workspaceSnapshotSchema } from '../snapshot.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Workspace (board) lifecycle route contracts. See WorkspaceController in
// @cat-factory/server. The list + create roots are mounted at `/` (the literals
// here are the full absolute paths); the single-workspace routes carry the
// `:workspaceId` segment in their literal too — the controller still reads it via
// `param(c, 'workspaceId')`, so it is NOT declared as a contract param.
// ---------------------------------------------------------------------------

const workspaceListSchema = v.array(workspaceSchema)

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
  requestPathParamsSchema: withObjectKeys(v.object({ workspaceId: v.string() })),
  pathResolver: ({ workspaceId }) => `/workspaces/${workspaceId}`,
  responsesByStatusCode: { 200: workspaceSnapshotSchema, ...errorResponses },
})

export const updateWorkspaceContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: withObjectKeys(v.object({ workspaceId: v.string() })),
  pathResolver: ({ workspaceId }) => `/workspaces/${workspaceId}`,
  requestBodySchema: renameWorkspaceSchema,
  responsesByStatusCode: { 200: workspaceSchema, ...errorResponses },
})

export const deleteWorkspaceContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: withObjectKeys(v.object({ workspaceId: v.string() })),
  pathResolver: ({ workspaceId }) => `/workspaces/${workspaceId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
