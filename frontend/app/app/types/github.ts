// ---------------------------------------------------------------------------
// GitHub integration. The backend's `GitHubModule` projects GitHub data
// (repos/branches, pull requests/issues) into D1 and serves it fast and
// rate-limit-free, alongside connect/resync/write endpoints.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of
// truth). `CreatedRepo` has no exported contract type (the create-repo route
// models the response inline), so it stays frontend-only below.
// ---------------------------------------------------------------------------

export type {
  GitHubConnection,
  GitHubInstallationOption,
  GitHubRepo,
  RepoTreeEntry,
  GitHubBranch,
  GitHubAvailableRepo,
  GitHubPullRequestState,
  GitHubPullRequest,
  GitHubIssueState,
  GitHubIssue,
  ResyncRequest,
  CreateBranchInput,
  CreateRepoRequest,
  CommitFilesInput,
  OpenPullRequestInput,
  MergePullRequestInput,
} from '@cat-factory/contracts'

/** The freshly-created repository returned by the create-repo endpoint. Frontend-only. */
export interface CreatedRepo {
  githubId: number
  owner: string
  name: string
  defaultBranch: string | null
  private: boolean
}
