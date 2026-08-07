import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  GitHubAvailableRepo,
  GitHubBranch,
  GitHubConnection,
  GitHubInstallationOption,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepo,
  RepoTreeEntry,
  VcsConnectOption,
  VcsProvider,
} from '~/types/domain'
import { branchWebUrl, issueWebUrl, pullWebUrl, repoWebUrl } from '~/utils/vcs'
import { useSingleFlightProbe } from '~/composables/useSingleFlightProbe'
import { useUpsertList } from '~/composables/useUpsertList'
import { useWorkspaceStore } from '~/stores/workspace'
import { useServicesStore } from '~/stores/services'
import { pullKey, type GitHubStoreContext } from '~/stores/github/context'
import { createGitHubConnectionActions } from '~/stores/github/connection'
import { createGitHubRepoActions } from '~/stores/github/repoActions'
import { createVcsConnectActions, createVcsProviderViews } from '~/stores/github/vcsConnect'

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
  /** The workspace's VCS connection (App installation or PAT), or null when not connected. */
  const connection = ref<GitHubConnection | null>(null)
  /** The connect surfaces this deployment serves; resolved by the probe alongside `connection`. */
  const connectOptions = ref<VcsConnectOption[]>([])
  /** Discovered App installations for the connect picker; loaded on demand. */
  const installations = ref<GitHubInstallationOption[]>([])
  const loadingInstallations = ref(false)
  const repos = ref<GitHubRepo[]>([])
  /** Repos the installation can access, for the per-workspace link picker. */
  const availableRepos = ref<GitHubAvailableRepo[]>([])
  const loadingAvailable = ref(false)
  const savingRepos = ref(false)
  const {
    items: pulls,
    upsert: upsertPull,
    get: getPull,
  } = useUpsertList<GitHubPullRequest>({
    key: (p) => pullKey(p.repoGithubId, p.number),
    prepend: true,
  })
  const issues = ref<GitHubIssue[]>([])
  /** Branches loaded lazily per repo (by GitHub numeric id). */
  const branches = ref<Record<number, GitHubBranch[]>>({})
  const loading = ref(false)
  const syncing = ref(false)

  const connected = computed(() => connection.value !== null)
  /** Whether cat-factory can create repos under the connected account itself. */
  const canCreateRepos = computed(() => connection.value?.canCreateRepos === true)
  /**
   * True when connected but the install is MISSING `workflows: write` — agent
   * pushes that touch `.github/workflows/*` will be rejected until it's granted.
   */
  const missingWorkflowsPermission = computed(
    () => connection.value !== null && connection.value.canManageWorkflows !== true,
  )

  function repoFor(repoGithubId: number): GitHubRepo | undefined {
    return repos.value.find((r) => r.githubId === repoGithubId)
  }

  /**
   * The repo backing a board service frame, if any — resolved through the account-owned
   * Service bound to the frame (the sole repo↔frame linkage; the projection carries no
   * repo→block column).
   */
  function repoForBlock(blockId: string): GitHubRepo | undefined {
    const service = useServicesStore().serviceByFrameBlock[blockId]
    return service?.repoGithubId != null ? repoFor(service.repoGithubId) : undefined
  }

  function pullsForRepo(repoGithubId: number): GitHubPullRequest[] {
    return pulls.value.filter((p) => p.repoGithubId === repoGithubId)
  }

  function issuesForRepo(repoGithubId: number): GitHubIssue[] {
    return issues.value.filter((i) => i.repoGithubId === repoGithubId)
  }

  // Web links for a repo / pull request / issue / branch, built from the connection's own host
  // (`webUrl`) and the repo row's provider. Every one of these used to be a hand-built
  // `https://github.com/…`, which is only right for a github.com deployment: a self-managed
  // GitLab or GitHub Enterprise workspace was linked to whatever the public instance serves at
  // that path. Null when the deployment could not name its host, so the caller withholds the
  // link rather than pointing at an instance the repo does not live on.
  function repoUrl(repoGithubId: number): string | null {
    const r = repoFor(repoGithubId)
    return r ? repoWebUrl(connection.value?.webUrl, r) : null
  }
  /** The provider a projected row belongs to; a row predating the discriminator is GitHub. */
  function providerOfRepo(repoGithubId: number): VcsProvider {
    return repoFor(repoGithubId)?.provider ?? 'github'
  }
  function pullUrl(pr: GitHubPullRequest): string | null {
    return pullWebUrl(providerOfRepo(pr.repoGithubId), repoUrl(pr.repoGithubId), pr.number)
  }
  function issueUrl(issue: GitHubIssue): string | null {
    return issueWebUrl(
      providerOfRepo(issue.repoGithubId),
      repoUrl(issue.repoGithubId),
      issue.number,
    )
  }
  function branchUrl(repoGithubId: number, branch: string): string | null {
    return branchWebUrl(providerOfRepo(repoGithubId), repoUrl(repoGithubId), branch)
  }

  /**
   * Probe the integration: resolves `available`, the current connection, and which connect
   * surfaces the deployment serves. The capability read rides the same round trip (it is what
   * the not-connected UI renders from), and degrades to "no connect surface" on its own.
   */
  async function runProbe() {
    if (!workspace.workspaceId) return
    try {
      const [{ connection: conn }, options] = await Promise.all([
        api.getGitHubConnection(workspace.requireId()),
        api
          .listVcsConnectOptions(workspace.requireId())
          .then((r) => r.options)
          .catch(() => []),
      ])
      available.value = true
      connection.value = conn
      connectOptions.value = options
    } catch {
      // 503 (integration disabled) or any error → hide the UI entry points.
      available.value = false
      connection.value = null
      connectOptions.value = []
    }
  }
  // Single-flight the probe (app-startup initiative, item 12): `probe()` still re-reads on demand,
  // but the on-board-open callers (the board page's onboarding gate + the SideBar) use
  // `ensureProbed()` so their duplicate fire collapses to one request per board. A workspace switch
  // (new id) re-probes.
  const { probe, ensureProbed } = useSingleFlightProbe(runProbe, () => workspace.workspaceId)

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

  /** Full file listing per repo (recursive tree), cached by GitHub numeric id. */
  const repoFiles = ref<Record<number, RepoTreeEntry[]>>({})

  // The installation lifecycle + the per-repo reads/writes, split into cohesive factories
  // sharing the state above (a size-only extraction mirroring `stores/board/` — behaviour is
  // identical to the former in-closure functions).
  const context: GitHubStoreContext = {
    api,
    workspace,
    available,
    connection,
    connectOptions,
    installations,
    loadingInstallations,
    repos,
    availableRepos,
    loadingAvailable,
    savingRepos,
    pulls,
    upsertPull,
    getPull,
    issues,
    branches,
    repoFiles,
    syncing,
    connected,
    load,
  }
  const connectionActions = createGitHubConnectionActions(context)
  const repoActions = createGitHubRepoActions(context)
  const vcsConnectActions = createVcsConnectActions(context)
  // The derived "which provider" questions, beside the connect actions that populate what they
  // read (see `createVcsProviderViews` for why `provider` and `surfaceProvider` differ).
  const providerViews = createVcsProviderViews(context)

  /**
   * Drop the per-workspace projection + connection state (called on workspace switch)
   * so the prior workspace's repos/PRs/issues don't linger until the re-probe + reload
   * land. `available` returns to `null` (unknown) so the onboarding gate re-resolves.
   */
  function reset() {
    available.value = null
    connection.value = null
    connectOptions.value = []
    installations.value = []
    repos.value = []
    availableRepos.value = []
    pulls.value = []
    issues.value = []
    branches.value = {}
    repoFiles.value = {}
  }

  return {
    available,
    connection,
    connectOptions,
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
    ...providerViews,
    canCreateRepos,
    missingWorkflowsPermission,
    repoFor,
    repoForBlock,
    pullsForRepo,
    issuesForRepo,
    repoUrl,
    pullUrl,
    issueUrl,
    branchUrl,
    probe,
    ensureProbed,
    load,
    ensureLoaded,
    repoFiles,
    ...connectionActions,
    ...repoActions,
    ...vcsConnectActions,
    reset,
  }
})
