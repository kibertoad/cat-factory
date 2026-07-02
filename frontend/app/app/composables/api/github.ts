import {
  commentGitHubIssueContract,
  commitGitHubFilesContract,
  connectGitHubContract,
  createGitHubBranchContract,
  createGitHubRepoContract,
  disconnectGitHubContract,
  getGitHubConnectionContract,
  getGitHubInstallUrlContract,
  listGitHubAvailableReposContract,
  listGitHubBranchesContract,
  listGitHubInstallationsContract,
  listGitHubIssuesContract,
  listGitHubPullsContract,
  listGitHubReposContract,
  listGitHubRepoTreeContract,
  mergeGitHubPullRequestContract,
  openGitHubPullRequestContract,
  resyncGitHubContract,
  setGitHubLinkedReposContract,
} from '@cat-factory/contracts'
import type {
  CommitFilesInput,
  CreateBranchInput,
  MergePullRequestInput,
  OpenPullRequestInput,
  ResyncRequest,
} from '~/types/domain'
import type { SendParams } from './client'
import type { ApiContext } from './context'

// The create-repo body is typed from the contract's INPUT shape so the
// valibot-defaulted `private`/`description` stay optional for callers (the exported
// `CreateRepoRequest` is the post-default OUTPUT shape).
type CreateRepoBody = NonNullable<SendParams<typeof createGitHubRepoContract>['body']>

/**
 * GitHub integration: connection management, the D1-served projection reads
 * (fast, rate-limit-free) and the repo writes (branches/commits/PRs/merges).
 */
export function githubApi({ send, ws }: ApiContext) {
  return {
    // ---- github integration ----------------------------------------------
    // Connection management, projection reads (served from D1 — fast and
    // rate-limit-free) and repo writes. A 503 from `getGitHubConnection` means
    // the integration is off (the store hides its UI on any error there).
    getGitHubInstallUrl: (workspaceId: string) =>
      send(getGitHubInstallUrlContract, { pathPrefix: ws(workspaceId) }),

    getGitHubConnection: (workspaceId: string) =>
      send(getGitHubConnectionContract, { pathPrefix: ws(workspaceId) }),

    listGitHubInstallations: (workspaceId: string) =>
      send(listGitHubInstallationsContract, { pathPrefix: ws(workspaceId) }),

    connectGitHub: (workspaceId: string, installationId: number) =>
      send(connectGitHubContract, { pathPrefix: ws(workspaceId), body: { installationId } }),

    disconnectGitHub: (workspaceId: string) =>
      send(disconnectGitHubContract, { pathPrefix: ws(workspaceId) }),

    resyncGitHub: (workspaceId: string, body: ResyncRequest = {}) =>
      send(resyncGitHubContract, { pathPrefix: ws(workspaceId), body }),

    listGitHubRepos: (workspaceId: string) =>
      send(listGitHubReposContract, { pathPrefix: ws(workspaceId) }),

    // Programmatic repo creation (privileged App tier). Only called when the
    // connection reports `canCreateRepos`; otherwise the UI opens GitHub directly.
    createGitHubRepo: (workspaceId: string, body: CreateRepoBody) =>
      send(createGitHubRepoContract, { pathPrefix: ws(workspaceId), body }),

    // Repos the connected installation can access, annotated with whether this
    // workspace links each (drives the per-workspace repo picker). An optional `q`
    // filters `owner/name` server-side so the add-service picker searches instead of
    // prefetching the whole (possibly huge) installation; omitting it browses all.
    listGitHubAvailableRepos: (workspaceId: string, q?: string) =>
      send(listGitHubAvailableReposContract, {
        pathPrefix: ws(workspaceId),
        queryParams: { q },
      }),

    // Set the exact set of repos this workspace links.
    setGitHubLinkedRepos: (workspaceId: string, repoGithubIds: number[]) =>
      send(setGitHubLinkedReposContract, { pathPrefix: ws(workspaceId), body: { repoGithubIds } }),

    // Browse one level of a (monorepo) repo's tree to pin a service to a subdirectory.
    listGitHubRepoTree: (workspaceId: string, repoGithubId: number, path = '') =>
      send(listGitHubRepoTreeContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { repoGithubId: String(repoGithubId) },
        queryParams: { path },
      }),

    listGitHubBranches: (workspaceId: string, repoGithubId: number) =>
      send(listGitHubBranchesContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { repoGithubId: String(repoGithubId) },
      }),

    listGitHubPullRequests: (workspaceId: string) =>
      send(listGitHubPullsContract, { pathPrefix: ws(workspaceId) }),

    listGitHubIssues: (workspaceId: string) =>
      send(listGitHubIssuesContract, { pathPrefix: ws(workspaceId) }),

    createGitHubBranch: (workspaceId: string, repoGithubId: number, body: CreateBranchInput) =>
      send(createGitHubBranchContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { repoGithubId: String(repoGithubId) },
        body,
      }),

    commitGitHubFiles: (workspaceId: string, repoGithubId: number, body: CommitFilesInput) =>
      send(commitGitHubFilesContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { repoGithubId: String(repoGithubId) },
        body,
      }),

    openGitHubPullRequest: (
      workspaceId: string,
      repoGithubId: number,
      body: OpenPullRequestInput,
    ) =>
      send(openGitHubPullRequestContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { repoGithubId: String(repoGithubId) },
        body,
      }),

    mergeGitHubPullRequest: (
      workspaceId: string,
      repoGithubId: number,
      number: number,
      body: MergePullRequestInput = {},
    ) =>
      send(mergeGitHubPullRequestContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { repoGithubId: String(repoGithubId), number: String(number) },
        body,
      }),

    commentGitHubIssue: (
      workspaceId: string,
      repoGithubId: number,
      number: number,
      bodyText: string,
    ) =>
      send(commentGitHubIssueContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { repoGithubId: String(repoGithubId), number: String(number) },
        body: { body: bodyText },
      }),
  }
}
