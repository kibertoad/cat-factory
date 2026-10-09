import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'

// The append half of the directory change feed (docs/initiatives/directory-sync.md), shared by
// every repository that writes a directory entity. Mirror of the Node facade's `directoryFeed.ts`;
// the conformance suite `defineDirectoryFeedSuite` holds the two to one behaviour.
//
// A SOURCE is a query selecting `account_id, entity_type, workspace_id, entity_id`: the entities
// the caller's write touches. The append statement goes into the SAME `db.batch` as the write: a
// batch is one transaction and SQLite serializes writers, so `MAX(seq) + ROW_NUMBER()` is safe and
// commit order equals `seq` order. A source reading rows the write removes is placed BEFORE the
// write in the batch; one reading rows it creates is placed AFTER.

export interface DirectorySource {
  sql: string
  binds: unknown[]
}

/** The statement appending one change per source row. */
export function appendDirectoryChanges(
  db: D1Database,
  source: DirectorySource,
  at: number,
): D1PreparedStatement {
  // SQLite materializes an INSERT ... SELECT that reads its own target before inserting, so every
  // row's MAX(seq) is the pre-statement value and ROW_NUMBER() spaces them apart.
  return db
    .prepare(
      `INSERT INTO directory_changes (account_id, seq, entity_type, workspace_id, entity_id, at)
       SELECT src.account_id,
              COALESCE((SELECT MAX(d.seq) FROM directory_changes d WHERE d.account_id = src.account_id), 0)
                + ROW_NUMBER() OVER (PARTITION BY src.account_id
                                     ORDER BY src.entity_type, src.workspace_id, src.entity_id),
              src.entity_type, src.workspace_id, src.entity_id, ?
         FROM (${source.sql}) AS src
        WHERE src.account_id IS NOT NULL`,
    )
    .bind(at, ...source.binds)
}

/** A user's profile, once per account they belong to. */
export function userSource(userId: string): DirectorySource {
  return {
    sql: `SELECT account_id, 'user' AS entity_type, NULL AS workspace_id, user_id AS entity_id
            FROM memberships WHERE user_id = ?`,
    binds: [userId],
  }
}

/** An account membership, plus the member's `user` entity whose visibility it decides. */
export function accountMembershipSource(accountId: string, userId: string): DirectorySource {
  return {
    sql: `SELECT ? AS account_id, 'account_membership' AS entity_type, NULL AS workspace_id,
                 ? AS entity_id
          UNION ALL
          SELECT ?, 'user', NULL, ?`,
    binds: [accountId, userId, accountId, userId],
  }
}

/** One workspace membership, attributed to the account that owns the workspace. */
export function workspaceMembershipSource(workspaceId: string, userId: string): DirectorySource {
  return {
    sql: `SELECT account_id, 'workspace_membership' AS entity_type, id AS workspace_id,
                 ? AS entity_id
            FROM workspaces WHERE id = ?`,
    binds: [userId, workspaceId],
  }
}

/** Every workspace membership a user holds in one account's boards. */
export function accountWorkspaceMembershipsSource(
  accountId: string,
  userId: string,
): DirectorySource {
  return {
    sql: `SELECT w.account_id, 'workspace_membership' AS entity_type, m.workspace_id,
                 m.user_id AS entity_id
            FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
           WHERE m.user_id = ? AND w.account_id = ?`,
    binds: [userId, accountId],
  }
}

/** The workspace entity alone. */
export function workspaceSource(workspaceId: string): DirectorySource {
  return {
    sql: `SELECT account_id, 'workspace' AS entity_type, id AS workspace_id, id AS entity_id
            FROM workspaces WHERE id = ?`,
    binds: [workspaceId],
  }
}

/**
 * The workspace and everything in it that the directory publishes: its members and live repos.
 * Used where the whole board appears in or leaves an account (move, delete).
 */
export function workspaceTreeSource(workspaceId: string): DirectorySource {
  const workspace = workspaceSource(workspaceId)
  return {
    sql: `${workspace.sql}
          UNION ALL
          SELECT w.account_id, 'workspace_membership', m.workspace_id, m.user_id
            FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
           WHERE m.workspace_id = ?
          UNION ALL
          SELECT w.account_id, 'repo', r.workspace_id, CAST(r.github_id AS TEXT)
            FROM github_repos r JOIN workspaces w ON w.id = r.workspace_id
           WHERE r.workspace_id = ? AND r.deleted_at IS NULL`,
    binds: [...workspace.binds, workspaceId, workspaceId],
  }
}

/** Repo projection rows of one workspace, by provider id, tombstoned or not. `githubIds` must fit one D1 statement. */
export function reposSource(workspaceId: string, githubIds: readonly number[]): DirectorySource {
  const placeholders = githubIds.map(() => '?').join(', ')
  return {
    sql: `SELECT w.account_id, 'repo' AS entity_type, r.workspace_id, CAST(r.github_id AS TEXT) AS entity_id
            FROM github_repos r JOIN workspaces w ON w.id = r.workspace_id
           WHERE r.workspace_id = ? AND r.github_id IN (${placeholders})`,
    binds: [workspaceId, ...githubIds],
  }
}

/** The live repo rows a `tombstoneMissing` call is about to tombstone. Same predicate as the update. */
export function reposToTombstoneSource(
  workspaceId: string,
  installationId: number,
  seenGithubIds: readonly number[],
): DirectorySource {
  const notSeen =
    seenGithubIds.length === 0
      ? ''
      : ` AND r.github_id NOT IN (${seenGithubIds.map(() => '?').join(', ')})`
  return {
    sql: `SELECT w.account_id, 'repo' AS entity_type, r.workspace_id, CAST(r.github_id AS TEXT) AS entity_id
            FROM github_repos r JOIN workspaces w ON w.id = r.workspace_id
           WHERE r.workspace_id = ? AND r.installation_id = ? AND r.deleted_at IS NULL${notSeen}`,
    binds: [workspaceId, installationId, ...seenGithubIds],
  }
}
