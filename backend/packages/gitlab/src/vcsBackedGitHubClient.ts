import type {
  GitHubClient,
  GitHubRepoRef,
  VcsClient,
  VcsConnectionRef,
  VcsProvider,
  VcsRepoRef,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Adapt a provider-neutral `VcsClient` (e.g. {@link FetchGitLabClient}) to the
// legacy `GitHubClient` port the engine's gates, mergers and repo-read paths still
// consume. The two interfaces are method-for-method identical apart from their
// addressing: `GitHubClient` keys every call on `installationId: number` +
// `{ owner, repo }`, while `VcsClient` keys on a `VcsConnectionRef` + a `VcsRepoRef`.
// This bridge maps one onto the other so a deployment can serve the CI gate,
// mergeability/merge and repo linking against ANY VcsClient provider without the
// engine being migrated to the neutral port first.
//
// It is deliberately provider-agnostic (it takes the `provider` discriminator so the
// synthesised connection carries the right adapter key), so the same bridge works for
// any future VcsClient, not just GitLab. The `installationId` becomes the connection id
// verbatim — for a single-token deployment (local mode's PAT) the token source ignores
// it anyway, and for a stored-connection deployment the id round-trips as the connection
// row id.
// ---------------------------------------------------------------------------

/** A `VcsClient` plus the connection identity an adapted call should use. */
export interface VcsBackedGitHubClientOptions {
  vcs: VcsClient
  provider: VcsProvider
}

const toRepoRef = (ref: GitHubRepoRef): VcsRepoRef => ({
  // The neutral client resolves the project from `owner/repo` when `repoId` is empty,
  // which is all the gate/merge/repo-read paths have to hand.
  repoId: '',
  owner: ref.owner,
  repo: ref.repo,
})

/**
 * Wrap a {@link VcsClient} as a {@link GitHubClient}. Optional `GitHubClient` methods are
 * only exposed when the underlying `VcsClient` implements them, so a consumer's
 * `if (client.listReviewThreads)` capability check still reflects reality.
 *
 * The App-installation discovery methods (`getInstallation` / `listInstallations`) have no
 * `VcsClient` equivalent — they belong to GitHub's App model, which a single-token provider
 * does not have — so they throw. This matches local mode's GitHub PAT client, whose app-JWT
 * paths also throw; the connect flow synthesises installations out-of-band instead.
 */
export function asGitHubClient(options: VcsBackedGitHubClientOptions): GitHubClient {
  const { vcs, provider } = options
  const conn = (installationId: number): VcsConnectionRef => ({
    provider,
    connectionId: String(installationId),
  })
  const unsupported = (op: string): Promise<never> =>
    Promise.reject(
      new Error(
        `${op} is not supported for a single-token ${provider} connection (no App installation model).`,
      ),
    )

  const client: GitHubClient = {
    // ---- installation-level (no VcsClient equivalent) ---------------------
    getInstallation: () => unsupported('getInstallation'),
    listInstallations: () => unsupported('listInstallations'),
    listInstallationRepos: (installationId) => vcs.listRepos(conn(installationId)),
    // A single-token GitLab connection lists a bounded set of projects, so the realtime
    // picker search reuses that listing and filters `owner/name` in memory — the account
    // scope opts are moot (the token already scopes the listing).
    searchInstallationRepos: async (installationId, query, opts) => {
      const q = query.trim().toLowerCase()
      if (!q) return []
      const { items } = await vcs.listRepos(conn(installationId))
      const matched = items.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q))
      return matched.slice(0, Math.min(Math.max(opts?.limit ?? 50, 1), 100))
    },

    // ---- reads ------------------------------------------------------------
    getRepo: (i, ref) => vcs.getRepo(conn(i), toRepoRef(ref)),
    getRepoById: async (i, repoGithubId) => {
      // A single-token GitLab connection lists a bounded project set, so resolve the id
      // against that listing (no per-installation enumeration cap to worry about here).
      const { items } = await vcs.listRepos(conn(i))
      return items.find((r) => r.githubId === repoGithubId) ?? null
    },
    canPush: (i, ref) => vcs.canPush(conn(i), toRepoRef(ref)),
    listBranches: (i, ref, etag) => vcs.listBranches(conn(i), toRepoRef(ref), etag),
    branchHeadSha: (i, ref, branch) => vcs.branchHeadSha(conn(i), toRepoRef(ref), branch),
    listRootEntries: (i, ref) => vcs.listRootEntries(conn(i), toRepoRef(ref)),
    listDirectory: (i, ref, path, gitRef) =>
      vcs.listDirectory(conn(i), toRepoRef(ref), path, gitRef),
    getFileContent: (i, ref, path, gitRef) =>
      vcs.getFileContent(conn(i), toRepoRef(ref), path, gitRef),
    latestCommitSha: (i, ref, path, gitRef) =>
      vcs.latestCommitSha(conn(i), toRepoRef(ref), path, gitRef),
    listPullRequests: (i, ref, opts) => vcs.listPullRequests(conn(i), toRepoRef(ref), opts),
    listIssues: (i, ref, opts) => vcs.listIssues(conn(i), toRepoRef(ref), opts),
    getIssue: (i, ref, n) => vcs.getIssue(conn(i), toRepoRef(ref), n),
    searchIssues: (i, query, limit) => vcs.searchIssues(conn(i), query, limit),
    searchCode: (i, query, limit) => vcs.searchCode(conn(i), query, limit),
    listCommits: (i, ref, opts) => vcs.listCommits(conn(i), toRepoRef(ref), opts),
    listCheckRuns: (i, ref, sha) => vcs.listCheckRuns(conn(i), toRepoRef(ref), sha),

    // ---- writes -----------------------------------------------------------
    createBranch: (i, ref, name, fromSha) =>
      vcs.createBranch(conn(i), toRepoRef(ref), name, fromSha),
    commitFiles: (i, ref, input) => vcs.commitFiles(conn(i), toRepoRef(ref), input),
    createIssue: (i, ref, input) => vcs.createIssue(conn(i), toRepoRef(ref), input),
    closeIssue: (i, ref, n) => vcs.closeIssue(conn(i), toRepoRef(ref), n),
    openPullRequest: (i, ref, input) => vcs.openPullRequest(conn(i), toRepoRef(ref), input),
    updatePullRequest: (i, ref, n, patch) =>
      vcs.updatePullRequest(conn(i), toRepoRef(ref), n, patch),
    getPullRequestMergeability: (i, ref, n) =>
      vcs.getPullRequestMergeability(conn(i), toRepoRef(ref), n),
    mergePullRequest: (i, ref, n, input) => vcs.mergePullRequest(conn(i), toRepoRef(ref), n, input),
    deleteBranch: (i, ref, branch) => vcs.deleteBranch(conn(i), toRepoRef(ref), branch),
    comment: (i, ref, n, body) => vcs.comment(conn(i), toRepoRef(ref), n, body),
    mergeBranch: (i, ref, input) => vcs.mergeBranch(conn(i), toRepoRef(ref), input),
  }

  // Optional reads: expose only when the underlying provider implements them, so a
  // capability check on the GitHubClient stays honest.
  if (vcs.listSubIssues) {
    client.listSubIssues = (i, ref, n) => vcs.listSubIssues!(conn(i), toRepoRef(ref), n)
  }
  if (vcs.listRequestedReviewers) {
    client.listRequestedReviewers = (i, ref, n) =>
      vcs.listRequestedReviewers!(conn(i), toRepoRef(ref), n)
  }
  if (vcs.listPullRequestReviews) {
    client.listPullRequestReviews = (i, ref, n) =>
      vcs.listPullRequestReviews!(conn(i), toRepoRef(ref), n)
  }
  if (vcs.listIssueComments) {
    client.listIssueComments = (i, ref, n) => vcs.listIssueComments!(conn(i), toRepoRef(ref), n)
  }
  if (vcs.getRequiredApprovingReviewCount) {
    client.getRequiredApprovingReviewCount = (i, ref, branch, n) =>
      vcs.getRequiredApprovingReviewCount!(conn(i), toRepoRef(ref), branch, n)
  }
  if (vcs.getPullRequestBaseRef) {
    client.getPullRequestBaseRef = (i, ref, n) =>
      vcs.getPullRequestBaseRef!(conn(i), toRepoRef(ref), n)
  }
  if (vcs.listReviewThreads) {
    client.listReviewThreads = (i, ref, n) => vcs.listReviewThreads!(conn(i), toRepoRef(ref), n)
  }
  if (vcs.replyToReviewThread) {
    client.replyToReviewThread = (i, ref, threadId, body) =>
      vcs.replyToReviewThread!(conn(i), toRepoRef(ref), threadId, body)
  }
  if (vcs.resolveReviewThread) {
    client.resolveReviewThread = (i, ref, threadId) =>
      vcs.resolveReviewThread!(conn(i), toRepoRef(ref), threadId)
  }
  if (vcs.rebasePullRequest) {
    client.rebasePullRequest = (i, ref, n) => vcs.rebasePullRequest!(conn(i), toRepoRef(ref), n)
  }

  return client
}
