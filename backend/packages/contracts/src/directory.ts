import * as v from 'valibot'
import { accountRolesSchema } from './accounts.js'
import { cursorSchema, pageLimitSchema } from './public-paging.js'
import { vcsProviderSchema } from './routes/auth.js'
import { workspaceAccessModeSchema, workspaceRoleSchema } from './workspace-members.js'

// ---------------------------------------------------------------------------
// Directory sync vocabulary: the entities an external system mirrors from an account (who is in
// it, which boards they reach, which repositories each board links). Design and slice plan:
// docs/initiatives/directory-sync.md.
//
// The entity type is persisted on every change-feed row and published on the wire, so this list
// is append-only: retiring a member strands rows that still carry it.
// ---------------------------------------------------------------------------

export const DIRECTORY_ENTITY_TYPES = [
  'workspace',
  'user',
  'account_membership',
  'workspace_membership',
  'repo',
] as const
export const directoryEntityTypeSchema = v.picklist(DIRECTORY_ENTITY_TYPES)
export type DirectoryEntityType = v.InferOutput<typeof directoryEntityTypeSchema>

export function isDirectoryEntityType(value: string): value is DirectoryEntityType {
  return (DIRECTORY_ENTITY_TYPES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// The public directory read surface (`/api/v1/directory/*`, slice 3). Each entity is the CURRENT
// state of a row; a change names an entity and carries its current state, or `null` once it no
// longer exists or is no longer visible to the calling key. Nothing here is a history: a change
// replayed late carries the state at the time it is read, so a consumer applying changes in `seq`
// order converges on the source.
// ---------------------------------------------------------------------------

export const directoryWorkspaceSchema = v.object({
  id: v.string(),
  name: v.string(),
  description: v.nullable(v.string()),
  accessMode: workspaceAccessModeSchema,
})
export type DirectoryWorkspace = v.InferOutput<typeof directoryWorkspaceSchema>

export const directoryUserSchema = v.object({
  id: v.string(),
  name: v.nullable(v.string()),
  email: v.nullable(v.string()),
  avatarUrl: v.nullable(v.string()),
})
export type DirectoryUser = v.InferOutput<typeof directoryUserSchema>

export const directoryAccountMembershipSchema = v.object({
  userId: v.string(),
  roles: accountRolesSchema,
  createdAt: v.number(),
})
export type DirectoryAccountMembership = v.InferOutput<typeof directoryAccountMembershipSchema>

export const directoryWorkspaceMembershipSchema = v.object({
  workspaceId: v.string(),
  userId: v.string(),
  role: workspaceRoleSchema,
  createdAt: v.number(),
})
export type DirectoryWorkspaceMembership = v.InferOutput<typeof directoryWorkspaceMembershipSchema>

export const directoryRepoSchema = v.object({
  workspaceId: v.string(),
  /** The provider's numeric repository id. */
  repoId: v.number(),
  provider: vcsProviderSchema,
  owner: v.string(),
  name: v.string(),
  defaultBranch: v.nullable(v.string()),
  private: v.boolean(),
  monorepo: v.boolean(),
})
export type DirectoryRepo = v.InferOutput<typeof directoryRepoSchema>

const changeBase = {
  /** Strictly increasing per account; the cursor a consumer stores. */
  seq: v.number(),
  /** When the change was recorded, epoch ms. */
  at: v.number(),
  /** The board the entity belongs to; null for users and account memberships. */
  workspaceId: v.nullable(v.string()),
  /** User id, workspace id, or the repo's provider id as a decimal string. */
  entityId: v.string(),
}

/** One change, carrying the entity's current state or `null` once it is gone or out of reach. */
export const directoryChangeSchema = v.variant('entityType', [
  v.object({
    ...changeBase,
    entityType: v.literal('workspace'),
    entity: v.nullable(directoryWorkspaceSchema),
  }),
  v.object({
    ...changeBase,
    entityType: v.literal('user'),
    entity: v.nullable(directoryUserSchema),
  }),
  v.object({
    ...changeBase,
    entityType: v.literal('account_membership'),
    entity: v.nullable(directoryAccountMembershipSchema),
  }),
  v.object({
    ...changeBase,
    entityType: v.literal('workspace_membership'),
    entity: v.nullable(directoryWorkspaceMembershipSchema),
  }),
  v.object({
    ...changeBase,
    entityType: v.literal('repo'),
    entity: v.nullable(directoryRepoSchema),
  }),
])
export type DirectoryChange = v.InferOutput<typeof directoryChangeSchema>

/** A non-negative whole `seq` in a query string. */
const seqQuerySchema = v.pipe(
  v.string(),
  v.regex(/^\d+$/, 'Must be a whole number'),
  v.transform(Number),
  v.number(),
  v.integer(),
  v.minValue(0),
)

export const listDirectoryChangesQuerySchema = v.object({
  /** Serve changes with `seq` greater than this; `0` (the default) means from the start. */
  after: v.optional(seqQuerySchema),
  limit: v.optional(pageLimitSchema),
})

export const directoryChangePageSchema = v.object({
  changes: v.array(directoryChangeSchema),
  /**
   * Pass as `after` on the next call. It can move past the last change served: changes the key
   * cannot see are skipped, and when the page ends short the cursor advances to `headSeq`.
   */
  nextAfter: v.number(),
  /** The account's newest `seq` when the page was read. `nextAfter === headSeq` means caught up. */
  headSeq: v.number(),
})
export type DirectoryChangePage = v.InferOutput<typeof directoryChangePageSchema>

export const listDirectorySnapshotQuerySchema = v.object({
  cursor: v.optional(cursorSchema),
  limit: v.optional(pageLimitSchema),
})

function snapshotPage<T extends v.GenericSchema>(item: T) {
  return v.object({
    items: v.array(item),
    nextCursor: v.nullable(v.string()),
    /**
     * The feed position the snapshot was taken at, the same on every page of one walk. After the
     * last page, replay `GET /api/v1/directory/changes?after=asOfSeq` to pick up anything that
     * changed while paging.
     */
    asOfSeq: v.number(),
  })
}

export const directoryWorkspacePageSchema = snapshotPage(directoryWorkspaceSchema)
export const directoryUserPageSchema = snapshotPage(directoryUserSchema)
export const directoryAccountMembershipPageSchema = snapshotPage(directoryAccountMembershipSchema)
export const directoryWorkspaceMembershipPageSchema = snapshotPage(
  directoryWorkspaceMembershipSchema,
)
export const directoryRepoPageSchema = snapshotPage(directoryRepoSchema)

/**
 * `details.reason` values the directory surface refuses with. `cursor_expired` (409): the changes
 * after this cursor were pruned, so the consumer must reconcile from a snapshot.
 * `account_scope_required` (403): users and account memberships are account-wide, so a key limited
 * to some workspaces cannot read them. `invalid_cursor` (422): a snapshot cursor this surface did
 * not issue.
 */
export const DIRECTORY_REFUSAL_REASONS = [
  'cursor_expired',
  'account_scope_required',
  'invalid_cursor',
] as const
export type DirectoryRefusalReason = (typeof DIRECTORY_REFUSAL_REASONS)[number]
