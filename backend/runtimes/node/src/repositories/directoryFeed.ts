import { type SQL, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'

// The append half of the directory change feed (docs/initiatives/directory-sync.md), shared by
// every repository that writes a directory entity. Mirror of the Cloudflare facade's
// `directoryFeed.ts`; the conformance suite `defineDirectoryFeedSuite` holds the two to one
// behaviour.
//
// A SOURCE is a query selecting `account_id, entity_type, workspace_id, entity_id`: the entities
// the caller's write touches. A source that reads the rows a write removes must run BEFORE that
// write, and one that reads the rows it creates must run AFTER, both inside the same transaction.

/** Advisory-lock class for the feed; the second key is the account. Distinct from every other class. */
const DIRECTORY_FEED_LOCK_CLASS = 0x6469_7263

type Executor = Pick<DrizzleDb, 'execute'>

/**
 * Take the feed's per-account advisory lock for every account the source names. It is held until
 * the enclosing transaction ends, so a second appender for the same account cannot compute its
 * `MAX(seq)` until this one has committed, which is what makes commit order equal `seq` order.
 *
 * Every writer takes it BEFORE its first row write: a path that wrote first and locked second
 * could deadlock against a path that locks and then deletes the same row. Accounts are locked in
 * id order so two multi-account writers cannot deadlock either. Re-taking a held lock is a no-op.
 */
export async function lockDirectoryFeed(tx: Executor, source: SQL): Promise<void> {
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(${DIRECTORY_FEED_LOCK_CLASS}, hashtext(a.account_id))
      FROM (SELECT DISTINCT s.account_id FROM (${source}) AS s
             WHERE s.account_id IS NOT NULL ORDER BY s.account_id) AS a`)
}

/**
 * Append one change per source row, under the lock (taken here too, for a caller whose source
 * names no account it locked earlier). Must run inside a transaction; outside one the lock is
 * released at once and the ordering guarantee is void.
 */
export async function appendDirectoryChanges(tx: Executor, source: SQL, at: number): Promise<void> {
  await lockDirectoryFeed(tx, source)
  await tx.execute(sql`
    INSERT INTO directory_changes (account_id, seq, entity_type, workspace_id, entity_id, at)
    SELECT src.account_id,
           COALESCE((SELECT MAX(d.seq) FROM directory_changes d WHERE d.account_id = src.account_id), 0)
             + ROW_NUMBER() OVER (PARTITION BY src.account_id
                                  ORDER BY src.entity_type, src.workspace_id, src.entity_id),
           src.entity_type, src.workspace_id, src.entity_id, ${at}
      FROM (${source}) AS src
     WHERE src.account_id IS NOT NULL`)
}

const text = (value: string) => sql`CAST(${value} AS TEXT)`

/** One account by id, for locking ahead of a write whose rows do not exist yet. */
export function accountSource(accountId: string | null): SQL {
  return sql`SELECT ${accountId === null ? sql`CAST(NULL AS TEXT)` : text(accountId)} AS account_id`
}

/** A user's profile, once per account they belong to. */
export function userSource(userId: string): SQL {
  return sql`SELECT account_id, CAST('user' AS TEXT) AS entity_type, CAST(NULL AS TEXT) AS workspace_id,
                    user_id AS entity_id
               FROM memberships WHERE user_id = ${text(userId)}`
}

/** An account membership, plus the member's `user` entity whose visibility it decides. */
export function accountMembershipSource(accountId: string, userId: string): SQL {
  return sql`SELECT ${text(accountId)} AS account_id, CAST('account_membership' AS TEXT) AS entity_type,
                    CAST(NULL AS TEXT) AS workspace_id, ${text(userId)} AS entity_id
             UNION ALL
             SELECT ${text(accountId)}, CAST('user' AS TEXT), CAST(NULL AS TEXT), ${text(userId)}`
}

/** One workspace membership, attributed to the account that owns the workspace. */
export function workspaceMembershipSource(workspaceId: string, userId: string): SQL {
  return sql`SELECT account_id, CAST('workspace_membership' AS TEXT) AS entity_type, id AS workspace_id,
                    ${text(userId)} AS entity_id
               FROM workspaces WHERE id = ${text(workspaceId)}`
}

/** Every workspace membership a user holds in one account's boards. */
export function accountWorkspaceMembershipsSource(accountId: string, userId: string): SQL {
  return sql`SELECT w.account_id, CAST('workspace_membership' AS TEXT) AS entity_type,
                    m.workspace_id, m.user_id AS entity_id
               FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
              WHERE m.user_id = ${text(userId)} AND w.account_id = ${text(accountId)}`
}

/** The workspace entity alone. */
export function workspaceSource(workspaceId: string): SQL {
  return sql`SELECT account_id, CAST('workspace' AS TEXT) AS entity_type, id AS workspace_id, id AS entity_id
               FROM workspaces WHERE id = ${text(workspaceId)}`
}

/**
 * The workspace and everything in it that the directory publishes: its members and live repos.
 * Used where the whole board appears in or leaves an account (create into, move, delete).
 */
export function workspaceTreeSource(workspaceId: string): SQL {
  return sql`${workspaceSource(workspaceId)}
             UNION ALL
             SELECT w.account_id, CAST('workspace_membership' AS TEXT), m.workspace_id, m.user_id
               FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
              WHERE m.workspace_id = ${text(workspaceId)}
             UNION ALL
             SELECT w.account_id, CAST('repo' AS TEXT), r.workspace_id, CAST(r.github_id AS TEXT)
               FROM github_repos r JOIN workspaces w ON w.id = r.workspace_id
              WHERE r.workspace_id = ${text(workspaceId)} AND r.deleted_at IS NULL`
}

/** Repo projection rows of one workspace, by provider id, tombstoned or not. */
export function reposSource(workspaceId: string, githubIds: readonly number[]): SQL {
  return sql`SELECT w.account_id, CAST('repo' AS TEXT) AS entity_type, r.workspace_id,
                    CAST(r.github_id AS TEXT) AS entity_id
               FROM github_repos r JOIN workspaces w ON w.id = r.workspace_id
              WHERE r.workspace_id = ${text(workspaceId)}
                AND r.github_id IN (${sql.join(
                  githubIds.map((id) => sql`${id}`),
                  sql`, `,
                )})`
}
