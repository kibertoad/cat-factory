import type {
  CommitFilesInput,
  CreateBranchInput,
  CreatedRepo,
  CreateRepoRequest,
  GitHubAvailableRepo,
  GitHubBranch,
  GitHubConnection,
  GitHubInstallationOption,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepo,
  MergePullRequestInput,
  OpenPullRequestInput,
  RepoTreeEntry,
  ResyncRequest,
} from '~/types/domain'
import type { ApiContext } from './context'

/**
 * GitHub integration: connection management, the D1-served projection reads
 * (fast, rate-limit-free) and the repo writes (branches/commits/PRs/merges).
 */
export function githubApi({ http, ws }: ApiContext) {
  return {
    // ---- github integration ----------------------------------------------
    // Connection management, projection reads (served from D1 — fast and
    // rate-limit-free) and repo writes. A 503 from `getGitHubConnection` means
    // the integration is off (the store hides its UI on any error there).
    getGitHubInstallUrl: (workspaceId: string) =>
      http<{ url: string }>(`${ws(workspaceId)}/github/install-url`),

    getGitHubConnection: (workspaceId: string) =>
      http<{ connection: GitHubConnection | null }>(`${ws(workspaceId)}/github/connection`),

    listGitHubInstallations: (workspaceId: string) =>
      http<{ installations: GitHubInstallationOption[] }>(
        `${ws(workspaceId)}/github/installations`,
      ),

    connectGitHub: (workspaceId: string, installationId: number) =>
      http<GitHubConnection>(`${ws(workspaceId)}/github/connect`, {
        method: 'POST',
        body: { installationId },
      }),

    disconnectGitHub: (workspaceId: string) =>
      http(`${ws(workspaceId)}/github/connection`, { method: 'DELETE' }),

    resyncGitHub: (workspaceId: string, body: ResyncRequest = {}) =>
      http<{ status: string }>(`${ws(workspaceId)}/github/resync`, { method: 'POST', body }),

    listGitHubRepos: (workspaceId: string) => http<GitHubRepo[]>(`${ws(workspaceId)}/github/repos`),

    // Programmatic repo creation (privileged App tier). Only called when the
    // connection reports `canCreateRepos`; otherwise the UI opens GitHub directly.
    createGitHubRepo: (workspaceId: string, body: CreateRepoRequest) =>
      http<CreatedRepo>(`${ws(workspaceId)}/github/repos`, { method: 'POST', body }),

    // Repos the connected installation can access, annotated with whether this
    // workspace links each (drives the per-workspace repo picker).
    listGitHubAvailableRepos: (workspaceId: string) =>
      http<GitHubAvailableRepo[]>(`${ws(workspaceId)}/github/available-repos`),

    // Set the exact set of repos this workspace links.
    setGitHubLinkedRepos: (workspaceId: string, repoGithubIds: number[]) =>
      http<GitHubRepo[]>(`${ws(workspaceId)}/github/repos`, {
        method: 'PUT',
        body: { repoGithubIds },
      }),

    // Browse one level of a (monorepo) repo's tree to pin a service to a subdirectory.
    listGitHubRepoTree: (workspaceId: string, repoGithubId: number, path = '') =>
      http<RepoTreeEntry[]>(`${ws(workspaceId)}/github/repos/${repoGithubId}/tree`, {
        query: { path },
      }),

    listGitHubBranches: (workspaceId: string, repoGithubId: number) =>
      http<GitHubBranch[]>(`${ws(workspaceId)}/github/repos/${repoGithubId}/branches`),

    listGitHubPullRequests: (workspaceId: string) =>
      http<GitHubPullRequest[]>(`${ws(workspaceId)}/github/pulls`),

    listGitHubIssues: (workspaceId: string) =>
      http<GitHubIssue[]>(`${ws(workspaceId)}/github/issues`),

    createGitHubBranch: (workspaceId: string, repoGithubId: number, body: CreateBranchInput) =>
      http<GitHubBranch>(`${ws(workspaceId)}/github/repos/${repoGithubId}/branches`, {
        method: 'POST',
        body,
      }),

    commitGitHubFiles: (workspaceId: string, repoGithubId: number, body: CommitFilesInput) =>
      http<{ sha: string }>(`${ws(workspaceId)}/github/repos/${repoGithubId}/commits`, {
        method: 'POST',
        body,
      }),

    openGitHubPullRequest: (
      workspaceId: string,
      repoGithubId: number,
      body: OpenPullRequestInput,
    ) =>
      http<GitHubPullRequest>(`${ws(workspaceId)}/github/repos/${repoGithubId}/pulls`, {
        method: 'POST',
        body,
      }),

    mergeGitHubPullRequest: (
      workspaceId: string,
      repoGithubId: number,
      number: number,
      body: MergePullRequestInput = {},
    ) =>
      http(`${ws(workspaceId)}/github/repos/${repoGithubId}/pulls/${number}/merge`, {
        method: 'PUT',
        body,
      }),

    commentGitHubIssue: (
      workspaceId: string,
      repoGithubId: number,
      number: number,
      bodyText: string,
    ) =>
      http(`${ws(workspaceId)}/github/repos/${repoGithubId}/issues/${number}/comments`, {
        method: 'POST',
        body: { body: bodyText },
      }),
  }
}
