// ---------------------------------------------------------------------------
// GitHub integration. The backend's `GitHubModule` projects GitHub data
// (repos/branches, pull requests/issues) into D1 and serves it fast and
// rate-limit-free, alongside connect/resync/write endpoints. These mirror the
// `@cat-factory/contracts` GitHub schemas so responses drop straight into the
// Pinia store, just as the document-source types do for Confluence/Notion.
// ---------------------------------------------------------------------------

/** A workspace's GitHub App installation, as exposed to clients (no token). */
export interface GitHubConnection {
  installationId: number
  accountLogin: string
  targetType: 'Organization' | 'User'
  connectedAt: number
}

/**
 * A discoverable App installation for the connect picker. `connected` says
 * whether it's already bound: to THIS workspace, to ANOTHER (so connecting would
 * be rejected), or to NONE (free to connect).
 */
export interface GitHubInstallationOption {
  installationId: number
  accountLogin: string
  targetType: 'Organization' | 'User'
  accountAvatarUrl: string | null
  connected: 'this' | 'other' | 'none'
}

/** A repository the integration tracks for a workspace. */
export interface GitHubRepo {
  githubId: number
  installationId: number
  owner: string
  name: string
  defaultBranch: string | null
  private: boolean
  /** Optional link to a board block this repo backs. */
  blockId: string | null
  syncedAt: number
}

export interface GitHubBranch {
  repoGithubId: number
  name: string
  headSha: string
  protected: boolean
  syncedAt: number
}

/**
 * A repo the connected installation can access, annotated with whether the
 * current workspace links it. Drives the per-workspace repo picker — repos are
 * linked explicitly per board, since the installation is shared across an
 * account's workspaces.
 */
export interface GitHubAvailableRepo {
  githubId: number
  owner: string
  name: string
  defaultBranch: string | null
  private: boolean
  linked: boolean
}

export type GitHubPullRequestState = 'open' | 'closed'

export interface GitHubPullRequest {
  repoGithubId: number
  number: number
  githubId: number
  title: string
  state: GitHubPullRequestState
  headRef: string | null
  baseRef: string | null
  headSha: string | null
  merged: boolean
  author: string | null
  updatedAt: number | null
  syncedAt: number
}

export type GitHubIssueState = 'open' | 'closed'

export interface GitHubIssue {
  repoGithubId: number
  number: number
  githubId: number
  title: string
  state: GitHubIssueState
  author: string | null
  labels: string[]
  updatedAt: number | null
  syncedAt: number
}

// ---- request inputs -------------------------------------------------------

/** Trigger a resync. Defaults to an incremental resync of all tracked repos. */
export interface ResyncRequest {
  /** Limit the resync to a single repo (by its GitHub numeric id). */
  repoGithubId?: number
  /** Run a full backfill (durable Workflow) instead of an incremental pass. */
  full?: boolean
}

export interface CreateBranchInput {
  name: string
  fromSha: string
}

export interface CommitFilesInput {
  branch: string
  message: string
  files: { path: string; content: string }[]
  /** Parent commit to build on; defaults to the branch tip. */
  baseSha?: string
}

export interface OpenPullRequestInput {
  title: string
  head: string
  base: string
  body?: string
  draft?: boolean
}

export interface MergePullRequestInput {
  method?: 'merge' | 'squash' | 'rebase'
}
