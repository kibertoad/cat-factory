import { defineApiContract } from '@toad-contracts/valibot'
import {
  directoryAccountMembershipPageSchema,
  directoryChangePageSchema,
  directoryRepoPageSchema,
  directoryUserPageSchema,
  directoryWorkspaceMembershipPageSchema,
  directoryWorkspacePageSchema,
  listDirectoryChangesQuerySchema,
  listDirectorySnapshotQuerySchema,
} from '../directory.js'
import { errorResponses, withMinScope } from './_shared.js'

// ---------------------------------------------------------------------------
// Route contracts for the public DIRECTORY surface (`/api/v1/directory/*`): the account's
// workspaces, users, memberships and linked repositories, as keyset-paged snapshots and an ordered
// change feed. Account-scoped rather than workspace-scoped, so no `x-cat-factory-workspace`
// header is read. Design: docs/initiatives/directory-sync.md.
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
