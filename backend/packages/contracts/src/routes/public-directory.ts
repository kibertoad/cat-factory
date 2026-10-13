import { defineApiContract, noBodyResponse } from '@toad-contracts/valibot'
import {
  directoryAccountMembershipPageSchema,
  directoryChangePageSchema,
  directoryRepoPageSchema,
  directoryUserPageSchema,
  directoryWebhookListSchema,
  directoryWebhookSchema,
  directoryWorkspaceMembershipPageSchema,
  directoryWorkspacePageSchema,
  listDirectoryChangesQuerySchema,
  listDirectorySnapshotQuerySchema,
  putDirectoryWebhookSchema,
} from '../directory.js'
import { errorResponses, singleStringParam, withMinScope } from './_shared.js'

// ---------------------------------------------------------------------------
// Route contracts for the public DIRECTORY surface (`/api/v1/directory/*`): the account's
// workspaces, users, memberships and linked repositories, as keyset-paged snapshots and an ordered
// change feed. Account-scoped rather than workspace-scoped, so no `x-cat-factory-workspace`
// header is read. Design: backend/docs/adr/0067-directory-sync.md.
//
// All `read`: mirroring a directory changes nothing on the platform. Users and account memberships
// are account-wide facts, so a key limited to some workspaces is refused them; the other three are
// filtered to the key's workspaces.
// ---------------------------------------------------------------------------

/** The ordered change feed after a cursor. */
export const listDirectoryChangesContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestQuerySchema: listDirectoryChangesQuerySchema,
    pathResolver: () => '/api/v1/directory/changes',
    responsesByStatusCode: { 200: directoryChangePageSchema, ...errorResponses },
  }),
)

export const listDirectoryWorkspacesContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestQuerySchema: listDirectorySnapshotQuerySchema,
    pathResolver: () => '/api/v1/directory/workspaces',
    responsesByStatusCode: { 200: directoryWorkspacePageSchema, ...errorResponses },
  }),
)

export const listDirectoryUsersContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestQuerySchema: listDirectorySnapshotQuerySchema,
    pathResolver: () => '/api/v1/directory/users',
    responsesByStatusCode: { 200: directoryUserPageSchema, ...errorResponses },
  }),
)

export const listDirectoryAccountMembershipsContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestQuerySchema: listDirectorySnapshotQuerySchema,
    pathResolver: () => '/api/v1/directory/account-memberships',
    responsesByStatusCode: { 200: directoryAccountMembershipPageSchema, ...errorResponses },
  }),
)

export const listDirectoryWorkspaceMembershipsContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestQuerySchema: listDirectorySnapshotQuerySchema,
    pathResolver: () => '/api/v1/directory/workspace-memberships',
    responsesByStatusCode: { 200: directoryWorkspaceMembershipPageSchema, ...errorResponses },
  }),
)

export const listDirectoryReposContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestQuerySchema: listDirectorySnapshotQuerySchema,
    pathResolver: () => '/api/v1/directory/repos',
    responsesByStatusCode: { 200: directoryRepoPageSchema, ...errorResponses },
  }),
)

// ---- Directory webhooks: account-level push endpoints (`admin`, account-wide keys only) --------

const webhookIdParams = singleStringParam('webhookId')

export const listDirectoryWebhooksContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/directory/webhooks',
    responsesByStatusCode: { 200: directoryWebhookListSchema, ...errorResponses },
  }),
)

export const putDirectoryWebhookContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'put',
    requestPathParamsSchema: webhookIdParams,
    requestBodySchema: putDirectoryWebhookSchema,
    pathResolver: ({ webhookId }) => `/api/v1/directory/webhooks/${webhookId}`,
    responsesByStatusCode: { 200: directoryWebhookSchema, ...errorResponses },
  }),
)

export const deleteDirectoryWebhookContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'delete',
    requestPathParamsSchema: webhookIdParams,
    pathResolver: ({ webhookId }) => `/api/v1/directory/webhooks/${webhookId}`,
    responsesByStatusCode: { 204: noBodyResponse(), ...errorResponses },
  }),
)
