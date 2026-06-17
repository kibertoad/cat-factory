import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  CreateBranchInput,
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
  ResyncRequest,
} from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * GitHub integration state: the workspace's App installation, the projected
 * repos/branches/pull-requests/issues the backend caches in D1, and the actions
 * that connect/resync and write against the repo. `available` mirrors the
 * backend's opt-in gate — a 503 from the connection probe means the integration
 * is off, and the UI hides its entry points (exactly as the documents store
 * gates on its source probe, and `auth.required` gates the login UI). Per
 * workspace, like the board itself; nothing is persisted client-side.
 */
export const useGitHubStore = defineStore('github', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  /** null = unknown (not probed yet), true/false = integration on/off. */
  const available = ref<boolean | null>(null)
  /** The workspace's App installation, or null when not yet connected. */
  const connection = ref<GitHubConnection | null>(null)
  /** Discovered App installations for the connect picker; loaded on demand. */
  const installations = ref<GitHubInstallationOption[]>([])
  const loadingInstallations = ref(false)
  const repos = ref<GitHubRepo[]>([])
  /** Repos the installation can access, for the per-workspace link picker. */
  const availableRepos = ref<GitHubAvailableRepo[]>([])
  const loadingAvailable = ref(false)
  const savingRepos = ref(false)
  const pulls = ref<GitHubPullRequest[]>([])
  const issues = ref<GitHubIssue[]>([])
  /** Branches loaded lazily per repo (by GitHub numeric id). */
  const branches = ref<Record<number, GitHubBranch[]>>({})
  const loading = ref(false)
  const syncing = ref(false)

  const connected = computed(() => connection.value !== null)
  /** Whether cat-factory can create repos under the connected account itself. */
  const canCreateRepos = computed(() => connection.value?.canCreateRepos === true)

  function repoFor(repoGithubId: number): GitHubRepo | undefined {
    return repos.value.find((r) => r.githubId === repoGithubId)
  }

  /** The repo linked to a board block (its backing service repo), if any. */
  function repoForBlock(blockId: string): GitHubRepo | undefined {
    return repos.value.find((r) => r.blockId === blockId)
  }

  function pullsForRepo(repoGithubId: number): GitHubPullRequest[] {
    return pulls.value.filter((p) => p.repoGithubId === repoGithubId)
  }

  function issuesForRepo(repoGithubId: number): GitHubIssue[] {
    return issues.value.filter((i) => i.repoGithubId === repoGithubId)
  }

  /** Build the github.com URL for a repo / PR / issue from the projection row. */
  function repoUrl(repoGithubId: number): string | null {
    const r = repoFor(repoGithubId)
    return r ? `https://github.com/${r.owner}/${r.name}` : null
  }
  function pullUrl(pr: GitHubPullRequest): string | null {
    const base = repoUrl(pr.repoGithubId)
    return base ? `${base}/pull/${pr.number}` : null
  }
  function issueUrl(issue: GitHubIssue): string | null {
    const base = repoUrl(issue.repoGithubId)
    return base ? `${base}/issues/${issue.number}` : null
  }

  /** Probe the integration: resolves `available` and the current connection. */
  async function probe() {
    if (!workspace.workspaceId) return
    try {
      const { connection: conn } = await api.getGitHubConnection(workspace.requireId())
      available.value = true
      connection.value = conn
    } catch {
      // 503 (integration disabled) or any error → hide the UI entry points.
      available.value = false
      connection.value = null
    }
  }

  /** Load the cached repos, pull requests and issues for the workspace. */
  async function load() {
    if (!connected.value) return
    loading.value = true
    try {
      const [r, p, i] = await Promise.all([
        api.listGitHubRepos(workspace.requireId()),
        api.listGitHubPullRequests(workspace.requireId()),
        api.listGitHubIssues(workspace.requireId()),
      ])
      repos.value = r
      pulls.value = p
      issues.value = i
    } finally {
      loading.value = false
    }
  }

  /**
   * Ensure the projection (repos/PRs/issues) is loaded at least once — for views
   * that need it without opening the GitHub panel (e.g. the inspector's repo link).
   * Probes the integration first if it hasn't been yet.
   */
  async function ensureLoaded() {
    if (available.value === null) await probe()
    if (connected.value && repos.value.length === 0) await load()
  }

  /** Load the repos the installation can access, with this workspace's link state. */
  async function loadAvailableRepos() {
    if (!connected.value) return
    loadingAvailable.value = true
    try {
      availableRepos.value = await api.listGitHubAvailableRepos(workspace.requireId())
    } finally {
      loadingAvailable.value = false
    }
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

  /** The URL a workspace owner visits to install the App against this workspace. */
  function getInstallUrl(): Promise<string> {
    return api.getGitHubInstallUrl(workspace.requireId()).then((r) => r.url)
  }

  /** Discover the App's installations so the user can connect one without typing an id. */
  async function loadInstallations() {
    loadingInstallations.value = true
    try {
      const { installations: list } = await api.listGitHubInstallations(workspace.requireId())
      installations.value = list
    } finally {
      loadingInstallations.value = false
    }
  }

  /** Programmatic bind by installation id (the browser flow uses the redirect). */
  async function connect(installationId: number) {
    connection.value = await api.connectGitHub(workspace.requireId(), installationId)
    available.value = true
    await load()
  }

  async function disconnect() {
    await api.disconnectGitHub(workspace.requireId())
    connection.value = null
    repos.value = []
    availableRepos.value = []
    pulls.value = []
    issues.value = []
    branches.value = {}
  }

  /** Trigger a resync, then refresh projections (no-op for queued/backfill). */
  async function resync(body: ResyncRequest = {}) {
    syncing.value = true
    try {
      const res = await api.resyncGitHub(workspace.requireId(), body)
      await load()
      return res
    } finally {
      syncing.value = false
    }
  }

  // ---- repo writes ----------------------------------------------------------

  /**
   * Create a repository under the connected account (privileged App tier). Only
   * meaningful when `canCreateRepos`; the backend 409s otherwise. Returns the
   * created repo so the caller can confirm/link it.
   */
  function createRepo(input: CreateRepoRequest) {
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
    const i = pulls.value.findIndex(
      (p) => p.repoGithubId === pr.repoGithubId && p.number === pr.number,
    )
    if (i >= 0) pulls.value[i] = pr
    else pulls.value.unshift(pr)
    return pr
  }

  async function mergePullRequest(
    repoGithubId: number,
    number: number,
    input: MergePullRequestInput = {},
  ) {
    await api.mergeGitHubPullRequest(workspace.requireId(), repoGithubId, number, input)
    // Optimistically reflect the merge until the next sync confirms it.
    const i = pulls.value.findIndex((p) => p.repoGithubId === repoGithubId && p.number === number)
    if (i >= 0) pulls.value[i] = { ...pulls.value[i]!, state: 'closed', merged: true }
  }

  function comment(repoGithubId: number, number: number, body: string) {
    return api.commentGitHubIssue(workspace.requireId(), repoGithubId, number, body)
  }

  return {
    available,
    connection,
    installations,
    loadingInstallations,
    repos,
    availableRepos,
    loadingAvailable,
    savingRepos,
    pulls,
    issues,
    branches,
    loading,
    syncing,
    connected,
    canCreateRepos,
    repoFor,
    repoForBlock,
    pullsForRepo,
    issuesForRepo,
    repoUrl,
    pullUrl,
    issueUrl,
    probe,
    load,
    ensureLoaded,
    loadAvailableRepos,
    setLinkedRepos,
    loadBranches,
    getInstallUrl,
    loadInstallations,
    connect,
    disconnect,
    resync,
    createRepo,
    createBranch,
    openPullRequest,
    mergePullRequest,
    comment,
  }
})
