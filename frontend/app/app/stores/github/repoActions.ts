import type {
  CreateBranchInput,
  GitHubAvailableRepo,
  GitHubBranch,
  MergePullRequestInput,
  OpenPullRequestInput,
  RepoTreeEntry,
} from '~/types/domain'
import { pullKey, type GitHubStoreContext } from './context'

/**
 * The per-repo reads (link picker, branches, trees, file listings) and writes (create repo /
 * branch, open / merge a PR, comment). Extracted from the store setup; each operation closes
 * over the shared {@link GitHubStoreContext} so behaviour is identical to the original
 * in-closure functions — the split is purely to keep every function within the size budget.
 */
export function createGitHubRepoActions(ctx: GitHubStoreContext) {
  const { api, workspace, connected, repos, availableRepos, loadingAvailable, savingRepos } = ctx
  const { branches, repoFiles, upsertPull, getPull, load } = ctx

  /**
   * Load the repos the installation can access, with this workspace's link state.
   * With a `q` the backend filters `owner/name` server-side (the add-service picker
   * searches instead of prefetching a huge installation); without one it browses all
   * (the repo-link panel). A blank/short `q` clears the list rather than fetching.
   */
  async function loadAvailableRepos(q?: string) {
    if (!connected.value) return
    if (q !== undefined && q.trim() === '') {
      availableRepos.value = []
      return
    }
    loadingAvailable.value = true
    try {
      availableRepos.value = await api.listGitHubAvailableRepos(workspace.requireId(), q)
    } finally {
      loadingAvailable.value = false
    }
  }

  /**
   * Search the installation/PAT-accessible repos server-side WITHOUT touching the shared
   * `availableRepos`/`loadingAvailable` singleton — it returns the matches to the caller instead.
   * This is the reusable form behind `useRepoSearch`: two independent pickers (the add-service
   * modal and the doc-task reference-repo picker) can search concurrently without clobbering
   * each other's results. A blank/short `q` (or no connection) returns `[]`.
   */
  async function searchAvailableRepos(q: string): Promise<GitHubAvailableRepo[]> {
    if (!connected.value || q.trim() === '') return []
    return api.listGitHubAvailableRepos(workspace.requireId(), q)
  }

  /** Set the exact set of repos this workspace links, then refresh projections. */
  async function setLinkedRepos(repoGithubIds: number[]) {
    savingRepos.value = true
    try {
      repos.value = await api.setGitHubLinkedRepos(workspace.requireId(), repoGithubIds)
      // Reflect the new link state in the picker and refresh PRs/issues.
      const linked = new Set(repoGithubIds)
      availableRepos.value = availableRepos.value.map((r) => ({
        ...r,
        linked: linked.has(r.githubId),
      }))
      await load()
    } finally {
      savingRepos.value = false
    }
  }

  /** Lazily load (and cache) the branches for a single repo. */
  async function loadBranches(repoGithubId: number): Promise<GitHubBranch[]> {
    const list = await api.listGitHubBranches(workspace.requireId(), repoGithubId)
    branches.value = { ...branches.value, [repoGithubId]: list }
    return list
  }

  /** List one level of a (monorepo) repo's tree, for the service-directory picker. */
  function loadRepoTree(repoGithubId: number, path = '') {
    return api.listGitHubRepoTree(workspace.requireId(), repoGithubId, path)
  }

  /**
   * Load (and cache) EVERY file in a repo — the whole tree in one recursive read — so a
   * picker can search files by path entirely client-side (no per-keystroke server call).
   * Cached by repo id so re-opening the picker for the same repo is instant; force a
   * refetch with `{ reload: true }`. Mirrors the branches cache.
   */
  async function loadRepoFiles(
    repoGithubId: number,
    opts: { reload?: boolean } = {},
  ): Promise<RepoTreeEntry[]> {
    const cached = repoFiles.value[repoGithubId]
    if (cached && !opts.reload) return cached
    const files = await api.listGitHubRepoFiles(workspace.requireId(), repoGithubId)
    repoFiles.value = { ...repoFiles.value, [repoGithubId]: files }
    return files
  }

  // ---- repo writes ----------------------------------------------------------

  /**
   * Create a repository under the connected account (privileged App tier). Only
   * meaningful when `canCreateRepos`; the backend 409s otherwise. Returns the
   * created repo so the caller can confirm/link it.
   */
  function createRepo(input: Parameters<typeof api.createGitHubRepo>[1]) {
    return api.createGitHubRepo(workspace.requireId(), input)
  }

  async function createBranch(repoGithubId: number, input: CreateBranchInput) {
    const branch = await api.createGitHubBranch(workspace.requireId(), repoGithubId, input)
    const next = branches.value[repoGithubId] ?? []
    branches.value = { ...branches.value, [repoGithubId]: [branch, ...next] }
    return branch
  }

  async function openPullRequest(repoGithubId: number, input: OpenPullRequestInput) {
    const pr = await api.openGitHubPullRequest(workspace.requireId(), repoGithubId, input)
    upsertPull(pr)
    return pr
  }

  async function mergePullRequest(
    repoGithubId: number,
    number: number,
    input: MergePullRequestInput = {},
  ) {
    await api.mergeGitHubPullRequest(workspace.requireId(), repoGithubId, number, input)
    // Optimistically reflect the merge until the next sync confirms it.
    const existing = getPull(pullKey(repoGithubId, number))
    if (existing) upsertPull({ ...existing, state: 'closed', merged: true })
  }

  function comment(repoGithubId: number, number: number, body: string) {
    return api.commentGitHubIssue(workspace.requireId(), repoGithubId, number, body)
  }

  return {
    loadAvailableRepos,
    searchAvailableRepos,
    setLinkedRepos,
    loadBranches,
    loadRepoTree,
    loadRepoFiles,
    createRepo,
    createBranch,
    openPullRequest,
    mergePullRequest,
    comment,
  }
}
