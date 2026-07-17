import * as v from 'valibot'
import { vcsProviderSchema } from './routes/auth.js'

// ---------------------------------------------------------------------------
// GitHub integration wire contracts. These describe the *projected* GitHub data
// cat-factory caches locally (repos/branches, pull requests/issues,
// commits/check-runs) and serves from D1, plus the request bodies for the
// connect, resync and write endpoints. As with the board entities, the worker's
// `GitHubClient` produces these shapes and the core derives its domain types
// from them, so the API, core and frontend share one vocabulary.
//
// Storage-only bookkeeping (the workspace that owns a row, soft-delete
// tombstones, the cached installation token) is deliberately NOT on the wire —
// it lives in the core ports / D1 layer.
// ---------------------------------------------------------------------------

/** A repository the integration tracks for a workspace. */
export const githubRepoSchema = v.object({
  githubId: v.number(),
  installationId: v.number(),
  owner: v.string(),
  name: v.string(),
  defaultBranch: v.nullable(v.string()),
  private: v.boolean(),
  /**
   * Whether this repo is a monorepo hosting more than one service. When true the
   * board lets several service frames target the same repo, each pinned to its own
   * subdirectory (carried on the {@link Service}), and that subdirectory is fed to
   * every agent working on the service. Owned by the board (set explicitly), so
   * sync never overwrites it. Absent/false ⇒ a plain single-service repo (the
   * historical behaviour).
   */
  isMonorepo: v.optional(v.boolean()),
  /**
   * How this repo entered the workspace's projection:
   *  - `'app'` (default) — reachable through the workspace's shared GitHub App
   *    installation, so every workspace member sees and can operate on it.
   *  - `'user_pat'` — reachable ONLY through the personal access token of the user
   *    who linked it (the App installation isn't granted it). Its board frame is
   *    redacted for members who can't reach it with their own PAT (fail closed).
   * Owned by the link, so sync never overwrites it. Absent ⇒ `'app'`.
   */
  linkedVia: v.optional(v.picklist(['app', 'user_pat'])),
  /**
   * Which VCS the repo belongs to (github / gitlab). Presentation switches on this — labels
   * ("Merge request" vs "Pull request"), icons, and host/URL shapes — while the data stays
   * provider-neutral. Owned by the connection the repo is reached through (the sync service
   * stamps the installation's provider). Absent on rows written before the column existed ⇒
   * treated as `'github'` (the only provider that populated these tables before).
   */
  provider: v.optional(vcsProviderSchema),
  /** When this projection row was last refreshed (epoch ms). */
  syncedAt: v.number(),
})
export type GitHubRepo = v.InferOutput<typeof githubRepoSchema>

/**
 * Identifying details of a freshly-created repository, returned by the repo
 * provisioning endpoint. Single source of truth for the shape: the kernel
 * `GitHubProvisioningClient` port derives its `ProvisionedRepo` from this, and the
 * createRepo route contract reuses it as its success body.
 */
export const provisionedRepoSchema = v.object({
  githubId: v.number(),
  owner: v.string(),
  name: v.string(),
  defaultBranch: v.nullable(v.string()),
  private: v.boolean(),
})
export type ProvisionedRepo = v.InferOutput<typeof provisionedRepoSchema>

export const githubBranchSchema = v.object({
  repoGithubId: v.number(),
  name: v.string(),
  headSha: v.string(),
  protected: v.boolean(),
  syncedAt: v.number(),
})
export type GitHubBranch = v.InferOutput<typeof githubBranchSchema>

export const githubPullRequestStateSchema = v.picklist(['open', 'closed'])
export type GitHubPullRequestState = v.InferOutput<typeof githubPullRequestStateSchema>

export const githubPullRequestSchema = v.object({
  repoGithubId: v.number(),
  number: v.number(),
  githubId: v.number(),
  title: v.string(),
  state: githubPullRequestStateSchema,
  headRef: v.nullable(v.string()),
  baseRef: v.nullable(v.string()),
  headSha: v.nullable(v.string()),
  merged: v.boolean(),
  author: v.nullable(v.string()),
  /** GitHub's `updated_at` (epoch ms), used as the incremental sync cursor. */
  updatedAt: v.nullable(v.number()),
  syncedAt: v.number(),
})
export type GitHubPullRequest = v.InferOutput<typeof githubPullRequestSchema>

/**
 * The result of OPENING a pull request: the synced {@link GitHubPullRequest} projection PLUS
 * the web `url`. The projection deliberately omits `url` (it isn't a sync cursor and never
 * hits the DB), but the create call's response DOES carry it (`html_url` / `web_url`), so a
 * caller that just opened a PR — e.g. a backend post-op recording {@link PullRequestRef} on a
 * block — gets a real link without reconstructing a provider-specific URL. Each VCS provider
 * fills `url` from its own field, keeping the shared layer provider-agnostic.
 */
export type OpenedPullRequest = GitHubPullRequest & { url: string }

export const githubIssueStateSchema = v.picklist(['open', 'closed'])
export type GitHubIssueState = v.InferOutput<typeof githubIssueStateSchema>

export const githubIssueSchema = v.object({
  repoGithubId: v.number(),
  number: v.number(),
  githubId: v.number(),
  title: v.string(),
  state: githubIssueStateSchema,
  author: v.nullable(v.string()),
  labels: v.array(v.string()),
  updatedAt: v.nullable(v.number()),
  syncedAt: v.number(),
})
export type GitHubIssue = v.InferOutput<typeof githubIssueSchema>

export const githubCommitSchema = v.object({
  repoGithubId: v.number(),
  sha: v.string(),
  message: v.string(),
  author: v.nullable(v.string()),
  authoredAt: v.nullable(v.number()),
  syncedAt: v.number(),
})
export type GitHubCommit = v.InferOutput<typeof githubCommitSchema>

export const githubCheckRunSchema = v.object({
  repoGithubId: v.number(),
  githubId: v.number(),
  headSha: v.string(),
  name: v.string(),
  status: v.string(),
  conclusion: v.nullable(v.string()),
  /**
   * The check run's GitHub web URL (`html_url`). Optional: the live check-runs read
   * (used by the CI gate) populates it so the UI can link to the failed run; the
   * persisted projection doesn't store it, so rows read back from the DB omit it.
   */
  htmlUrl: v.optional(v.nullable(v.string())),
  syncedAt: v.number(),
})
export type GitHubCheckRun = v.InferOutput<typeof githubCheckRunSchema>

/** A workspace's GitHub App installation, as exposed to clients (no token). */
export const githubConnectionSchema = v.object({
  installationId: v.number(),
  accountLogin: v.string(),
  targetType: v.picklist(['Organization', 'User']),
  connectedAt: v.number(),
  /**
   * The VCS this connection talks to (github / gitlab). The SPA switches connect-surface
   * copy/icons on it. Absent on backends predating the column ⇒ treated as `'github'`.
   */
  provider: v.optional(vcsProviderSchema),
  /**
   * Whether cat-factory can create repositories under this account itself — true
   * only for accounts served by the privileged App tier (ADR 0005). When false,
   * the UI keeps the manual "create on GitHub" flow.
   */
  canCreateRepos: v.optional(v.boolean(), false),
  /**
   * Whether the installation actually granted the App `workflows: write`. When
   * false, pushes that add/update `.github/workflows/*` are rejected by GitHub, so
   * the UI warns the user to grant the permission. Read from the token's granted
   * set (App ∩ install approval); defaults to false for older backends.
   */
  canManageWorkflows: v.optional(v.boolean(), false),
})
export type GitHubConnection = v.InferOutput<typeof githubConnectionSchema>

/**
 * A discoverable GitHub App installation (one account where the App is installed),
 * listed via the app JWT so the connect UI can offer a pick instead of a manually
 * typed installation id. `connected` says whether it's already bound: to THIS
 * workspace, to ANOTHER one (so connecting would be rejected), or to NONE.
 */
export const githubInstallationOptionSchema = v.object({
  installationId: v.number(),
  accountLogin: v.string(),
  targetType: v.picklist(['Organization', 'User']),
  accountAvatarUrl: v.nullable(v.string()),
  connected: v.picklist(['this', 'other', 'none']),
})
export type GitHubInstallationOption = v.InferOutput<typeof githubInstallationOptionSchema>

/**
 * A repository the connected installation can access, annotated with whether the
 * current workspace explicitly links it. Repos are linked per workspace (the
 * installation is shared across an account's workspaces, but each board chooses
 * its own repos), so the connect UI lists these and the user picks a subset.
 */
export const githubAvailableRepoSchema = v.object({
  githubId: v.number(),
  owner: v.string(),
  name: v.string(),
  defaultBranch: v.nullable(v.string()),
  private: v.boolean(),
  /** Whether this repo is currently linked to (tracked by) this workspace. */
  linked: v.boolean(),
  /** Whether the (linked) repo is flagged as a monorepo. False for unlinked repos. */
  isMonorepo: v.optional(v.boolean(), false),
  /**
   * True when this repo is surfaced ONLY through the signed-in user's personal access token
   * (the workspace's GitHub App can't reach it). Linking it makes a `linkedVia:'user_pat'`
   * service whose frame is hidden from members without their own access. The picker badges
   * these so the user knows the difference. Absent/false ⇒ an App-reachable repo.
   */
  personal: v.optional(v.boolean(), false),
  /**
   * The VCS this repo lives on (github / gitlab) — every listed repo is reachable through the
   * workspace's one connection, so this is the connection's provider. Drives the picker's
   * provider-keyed labels/icons. Absent ⇒ treated as `'github'`.
   */
  provider: v.optional(vcsProviderSchema),
})
export type GitHubAvailableRepo = v.InferOutput<typeof githubAvailableRepoSchema>

// ---- Request bodies -------------------------------------------------------

/**
 * Create a repository under the connected account (privileged App tier, ADR
 * 0005). `name` is a single GitHub name segment — no `owner/` prefix — matching
 * the bootstrap repo-name rule; the owner is the connected installation account.
 */
export const createRepoRequestSchema = v.object({
  name: v.pipe(
    v.string(),
    v.trim(),
    v.regex(/^[A-Za-z0-9_.-]+$/, "Only letters, digits, '.', '_' and '-' are allowed"),
    v.minLength(1),
    v.maxLength(100),
  ),
  private: v.optional(v.boolean(), true),
  description: v.optional(v.pipe(v.string(), v.maxLength(350)), ''),
})
export type CreateRepoRequest = v.InferOutput<typeof createRepoRequestSchema>

/** Set the exact set of repos (by GitHub numeric id) this workspace links. */
export const linkReposSchema = v.object({
  repoGithubIds: v.array(v.number()),
})
export type LinkReposInput = v.InferOutput<typeof linkReposSchema>

/** Mark (or unmark) a linked repo as a monorepo hosting several services. */
export const setRepoMonorepoSchema = v.object({
  isMonorepo: v.boolean(),
})
export type SetRepoMonorepoInput = v.InferOutput<typeof setRepoMonorepoSchema>

/**
 * One directory entry of a repo's tree, used by the monorepo service picker to let
 * a user browse a repo and pin a service to its subdirectory. Mirrors the slice of
 * GitHub's contents API the picker needs (it lists a single level at a time).
 */
export const repoTreeEntrySchema = v.object({
  /** Path relative to the repo root, e.g. `packages/api`. */
  path: v.string(),
  /** Base name, e.g. `api`. */
  name: v.string(),
  /** `file` | `dir` | `symlink` | `submodule`. */
  type: v.string(),
})
export type RepoTreeEntry = v.InferOutput<typeof repoTreeEntrySchema>

/** Trigger a resync. Defaults to an incremental resync of all tracked repos. */
export const resyncRequestSchema = v.object({
  /** Limit the resync to a single repo (by its GitHub numeric id). */
  repoGithubId: v.optional(v.number()),
  /** Run a full backfill (durable Workflow) instead of an incremental pass. */
  full: v.optional(v.boolean()),
})
export type ResyncRequest = v.InferOutput<typeof resyncRequestSchema>

export const createBranchSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  fromSha: v.pipe(v.string(), v.minLength(1)),
})
export type CreateBranchInput = v.InferOutput<typeof createBranchSchema>

export const commitFilesSchema = v.object({
  branch: v.pipe(v.string(), v.minLength(1)),
  message: v.pipe(v.string(), v.minLength(1)),
  files: v.pipe(
    v.array(
      v.object({
        path: v.pipe(v.string(), v.minLength(1)),
        content: v.string(),
      }),
    ),
    v.minLength(1),
  ),
  /**
   * Repo-relative paths to DELETE in the same commit (e.g. a removed module's stale
   * deep-dive file, an orphaned spec shard). Built into the tree as removed entries
   * alongside the written `files`, so a deterministic render that drops a path also
   * prunes it. Absent / empty ⇒ a pure add-or-update commit (the prior behaviour).
   */
  deletions: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
  /** Parent commit to build on; defaults to the branch tip. */
  baseSha: v.optional(v.string()),
})
export type CommitFilesInput = v.InferOutput<typeof commitFilesSchema>

export const openPullRequestSchema = v.object({
  title: v.pipe(v.string(), v.minLength(1)),
  head: v.pipe(v.string(), v.minLength(1)),
  base: v.pipe(v.string(), v.minLength(1)),
  body: v.optional(v.string()),
  draft: v.optional(v.boolean()),
})
export type OpenPullRequestInput = v.InferOutput<typeof openPullRequestSchema>

export const mergePullRequestSchema = v.object({
  method: v.optional(v.picklist(['merge', 'squash', 'rebase'])),
})
export type MergePullRequestInput = v.InferOutput<typeof mergePullRequestSchema>

export const commentSchema = v.object({
  body: v.pipe(v.string(), v.minLength(1)),
})
export type CommentInput = v.InferOutput<typeof commentSchema>
