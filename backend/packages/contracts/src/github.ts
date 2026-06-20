import * as v from 'valibot'

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
  /** Optional link to a board block this repo backs. */
  blockId: v.nullable(v.string()),
  /**
   * Whether this repo is a monorepo hosting more than one service. When true the
   * board lets several service frames target the same repo, each pinned to its own
   * subdirectory (carried on the {@link Service}), and that subdirectory is fed to
   * every agent working on the service. Owned by the board (set explicitly), so —
   * like `blockId` — sync never overwrites it. Absent/false ⇒ a plain single-service
   * repo (the historical behaviour).
   */
  isMonorepo: v.optional(v.boolean()),
  /** When this projection row was last refreshed (epoch ms). */
  syncedAt: v.number(),
})
export type GitHubRepo = v.InferOutput<typeof githubRepoSchema>

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
