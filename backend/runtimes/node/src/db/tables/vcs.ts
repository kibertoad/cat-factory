import { sql } from 'drizzle-orm'
import { bigint, index, integer, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// The VCS tables + projections, mirroring the Cloudflare D1 tables column-for-column
// (snake_case field names = column names) exactly as the rest of the Node schema does.
//
// One cohesive group — the connection/repo identity tables plus every read-model
// projection the sync/webhook path maintains (branches, pull requests, issues, commits,
// check runs, and the per-repo sync cursors) — split out of `../schema.ts` so that
// module stays inside its (shrink-only) size budget. `../schema.ts` re-exports
// everything here, so every existing `from '../db/schema.js'` import is unaffected and
// drizzle-kit still sees the tables through that entry point.
//
// Naming note: these tables predate the provider-neutral VCS vocabulary and are
// deliberately still GitHub-NAMED while serving both providers (their shapes are not
// GitHub-specific — see the incremental-migration note in CLAUDE.md). Do NOT read them
// as license to name a NEW field `githubId`.
// ---------------------------------------------------------------------------

// GitHub App installation bindings (mirror of D1 migration 0004 + the account_id /
// app_id columns from 0017 / 0019). The container executor reads this to resolve a
// run's installation id and mint a short-lived push token; tokens are cached
// in-memory by the auth adapter, never persisted here.
export const githubInstallations = pgTable(
  'github_installations',
  {
    installation_id: bigint('installation_id', { mode: 'number' }).primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    account_id: text('account_id'),
    account_login: text('account_login').notNull(),
    target_type: text('target_type').notNull(),
    app_id: text('app_id'),
    // Which VCS this connection talks to (github / gitlab). See contracts `GitHubConnection`
    // + kernel `GitHubInstallation.provider`.
    provider: text('provider').notNull().default('github'),
    cached_token: text('cached_token'),
    token_expires_at: bigint('token_expires_at', { mode: 'number' }),
    // Durable, sealed access credential for a per-workspace PAT connection (a hosted GitLab
    // connect seals the user's PAT here). Null for the GitHub-App path, which mints its own
    // tokens. See kernel `GitHubInstallation.accessToken`.
    access_token: text('access_token'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('idx_gh_install_workspace')
      .on(t.workspace_id)
      .where(sql`deleted_at IS NULL`),
    index('idx_gh_install_account')
      .on(t.account_id)
      .where(sql`deleted_at IS NULL`),
  ],
)

// Projection of a workspace's GitHub repositories (mirror of D1 migration 0004).
// The container executor resolves a run's target repo from the service frame the block
// sits under (via the account-owned `Service`, not any repo→block column).
export const githubRepos = pgTable(
  'github_repos',
  {
    workspace_id: text('workspace_id').notNull(),
    github_id: bigint('github_id', { mode: 'number' }).notNull(),
    installation_id: bigint('installation_id', { mode: 'number' }).notNull(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    default_branch: text('default_branch'),
    private: integer('private').notNull().default(0),
    // Whether the repo is a monorepo hosting several services (link-owned — sync
    // preserves it). See contracts `GitHubRepo.isMonorepo`.
    is_monorepo: integer('is_monorepo').notNull().default(0),
    // How the repo entered the projection: 'app' (shared GitHub App installation, visible
    // to every member) or 'user_pat' (reachable only via the linker's personal token).
    // Link-owned — sync preserves it. See contracts `GitHubRepo.linkedVia`.
    linked_via: text('linked_via').notNull().default('app'),
    // Which VCS the repo belongs to (github / gitlab) — the connection's provider, inherited
    // by the repo. See contracts `GitHubRepo.provider`.
    provider: text('provider').notNull().default('github'),
    etag: text('etag'),
    synced_at: bigint('synced_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.github_id] }),
    index('idx_gh_repos_install').on(t.installation_id),
  ],
)

// Per-user "repos my personal access token can reach" projection (mirror of D1). The
// fail-closed cache the board redaction checks so a frame backed by a `user_pat` repo is
// hidden from members who can't reach it, without a live GitHub call per snapshot. See the
// kernel `UserRepoAccessRepository` port.
export const githubUserRepoAccess = pgTable(
  'github_user_repo_access',
  {
    user_id: text('user_id').notNull(),
    repo_github_id: bigint('repo_github_id', { mode: 'number' }).notNull(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    default_branch: text('default_branch'),
    private: integer('private').notNull().default(0),
    synced_at: bigint('synced_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.repo_github_id] }),
    index('idx_gh_user_repo_access_repo').on(t.repo_github_id),
  ],
)

// GitHub projection tables (mirror of D1 migration 0004; sync cursors re-keyed by
// migration 0032). Local read models of a workspace's repos' branches / PRs / issues /
// commits / check runs, populated by the inline GitHub sync. `protected`/`merged` are
// 0/1 to mirror the D1 integer flags; soft-delete tombstones where the D1 tables have one.
export const githubBranches = pgTable(
  'github_branches',
  {
    workspace_id: text('workspace_id').notNull(),
    repo_github_id: bigint('repo_github_id', { mode: 'number' }).notNull(),
    name: text('name').notNull(),
    head_sha: text('head_sha').notNull(),
    protected: integer('protected').notNull().default(0),
    synced_at: bigint('synced_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.repo_github_id, t.name] })],
)

export const githubPullRequests = pgTable(
  'github_pull_requests',
  {
    workspace_id: text('workspace_id').notNull(),
    repo_github_id: bigint('repo_github_id', { mode: 'number' }).notNull(),
    number: integer('number').notNull(),
    github_id: bigint('github_id', { mode: 'number' }).notNull(),
    title: text('title').notNull(),
    state: text('state').notNull(),
    head_ref: text('head_ref'),
    base_ref: text('base_ref'),
    head_sha: text('head_sha'),
    merged: integer('merged').notNull().default(0),
    author: text('author'),
    gh_updated_at: bigint('gh_updated_at', { mode: 'number' }),
    synced_at: bigint('synced_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.repo_github_id, t.number] }),
    index('idx_gh_pr_state').on(t.workspace_id, t.state),
  ],
)

export const githubIssues = pgTable(
  'github_issues',
  {
    workspace_id: text('workspace_id').notNull(),
    repo_github_id: bigint('repo_github_id', { mode: 'number' }).notNull(),
    number: integer('number').notNull(),
    github_id: bigint('github_id', { mode: 'number' }).notNull(),
    title: text('title').notNull(),
    state: text('state').notNull(),
    author: text('author'),
    labels: text('labels').notNull().default('[]'),
    gh_updated_at: bigint('gh_updated_at', { mode: 'number' }),
    synced_at: bigint('synced_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.repo_github_id, t.number] })],
)

export const githubCommits = pgTable(
  'github_commits',
  {
    workspace_id: text('workspace_id').notNull(),
    repo_github_id: bigint('repo_github_id', { mode: 'number' }).notNull(),
    sha: text('sha').notNull(),
    message: text('message').notNull(),
    author: text('author'),
    authored_at: bigint('authored_at', { mode: 'number' }),
    synced_at: bigint('synced_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.repo_github_id, t.sha] })],
)

export const githubCheckRuns = pgTable(
  'github_check_runs',
  {
    workspace_id: text('workspace_id').notNull(),
    repo_github_id: bigint('repo_github_id', { mode: 'number' }).notNull(),
    github_id: bigint('github_id', { mode: 'number' }).notNull(),
    head_sha: text('head_sha').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull(),
    conclusion: text('conclusion'),
    synced_at: bigint('synced_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.repo_github_id, t.github_id] }),
    index('idx_gh_checks_sha').on(t.workspace_id, t.repo_github_id, t.head_sha),
  ],
)

// Incremental-sync bookkeeping, keyed by (installation, repo, kind) so a repo is
// fetched once per org and fanned out (mirror of D1 migration 0032).
export const githubSyncCursors = pgTable(
  'github_sync_cursors',
  {
    installation_id: bigint('installation_id', { mode: 'number' }).notNull(),
    repo_github_id: bigint('repo_github_id', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    etag: text('etag'),
    last_synced_at: bigint('last_synced_at', { mode: 'number' }),
    since_iso: text('since_iso'),
  },
  (t) => [primaryKey({ columns: [t.installation_id, t.repo_github_id, t.kind] })],
)
