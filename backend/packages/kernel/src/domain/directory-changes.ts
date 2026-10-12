import {
  type DirectoryEntityType,
  type DirectoryUser,
  type DirectoryUserAccount,
  isDirectoryEntityType,
  vcsProviderSchema,
} from '@cat-factory/contracts'
import type { DirectoryChangeRecord } from '../ports/directory-changes.js'

// The rules both facades' directory repositories apply to stored change-feed rows
// (backend/docs/adr/0067-directory-sync.md), kept here so the D1 and Postgres readers cannot drift.

/** A `directory_changes` row as both facades store it. */
export interface StoredDirectoryChange {
  account_id: string
  seq: number
  entity_type: string
  workspace_id: string | null
  entity_id: string
  at: number
}

/** The entity types a key limited to some workspaces may read: the ones that belong to a board. */
export const WORKSPACE_DIRECTORY_ENTITY_TYPES: readonly DirectoryEntityType[] = [
  'workspace',
  'workspace_membership',
  'repo',
]

/**
 * Map a stored change row to its record. The vocabulary is append-only, so an unknown entity type
 * is a row this build cannot interpret and it throws rather than skipping it: a reader that
 * dropped the row would advance its cursor past a change it never served.
 */
export function directoryChangeFromRow(row: StoredDirectoryChange): DirectoryChangeRecord {
  if (!isDirectoryEntityType(row.entity_type)) {
    throw new Error(`Unknown directory entity type '${row.entity_type}' at seq ${row.seq}`)
  }
  return {
    accountId: row.account_id,
    seq: row.seq,
    entityType: row.entity_type,
    workspaceId: row.workspace_id,
    entityId: row.entity_id,
    at: row.at,
  }
}

/** The `user_identities` columns the directory reads to publish a user's accounts. */
export interface StoredUserIdentity {
  user_id: string
  provider: string
  subject: string
  metadata: string | null
}

/**
 * The login providers a user's directory accounts come from: the source-control hosts. A password,
 * Google or OIDC identity names nobody on a host, so it is not an account a mirror can match on.
 */
export const DIRECTORY_ACCOUNT_PROVIDERS: readonly DirectoryUserAccount['provider'][] =
  vcsProviderSchema.options

/** Whether identities of `provider` are published as accounts, so linking one is a directory change. */
export function isDirectoryAccountProvider(
  provider: string,
): provider is DirectoryUserAccount['provider'] {
  return (DIRECTORY_ACCOUNT_PROVIDERS as readonly string[]).includes(provider)
}

/**
 * The login a host identity recorded at sign-in. Its metadata is written as
 * `JSON.stringify({ login })`, so a value that is not JSON is a corrupt row and throws rather than
 * being served as no login.
 */
function loginOf(metadata: string | null): string | null {
  if (metadata === null) return null
  const parsed: unknown = JSON.parse(metadata)
  if (typeof parsed !== 'object' || parsed === null || !('login' in parsed)) return null
  return typeof parsed.login === 'string' ? parsed.login : null
}

function compare(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Give each user the host accounts among `identities`, ordered by provider then id, so a snapshot
 * page and a feed read of the same user serve identical entities.
 */
export function withDirectoryAccounts(
  users: Omit<DirectoryUser, 'accounts'>[],
  identities: StoredUserIdentity[],
): DirectoryUser[] {
  const byUser = new Map<string, DirectoryUserAccount[]>()
  for (const identity of identities) {
    if (!isDirectoryAccountProvider(identity.provider)) continue
    const accounts = byUser.get(identity.user_id) ?? []
    accounts.push({
      provider: identity.provider,
      id: identity.subject,
      login: loginOf(identity.metadata),
    })
    byUser.set(identity.user_id, accounts)
  }
  return users.map((user) => ({
    ...user,
    accounts: (byUser.get(user.id) ?? []).sort(
      (a, b) => compare(a.provider, b.provider) || compare(a.id, b.id),
    ),
  }))
}
