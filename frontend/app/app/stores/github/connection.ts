import type { ResyncRequest } from '~/types/domain'
import type { GitHubStoreContext } from './context'

/**
 * The App-installation lifecycle: discovering/binding an installation, dropping it, and
 * triggering a resync of the projections. Extracted from the store setup; each operation closes
 * over the shared {@link GitHubStoreContext} so behaviour is identical to the original
 * in-closure functions — the split is purely to keep every function within the size budget.
 */
export function createGitHubConnectionActions(ctx: GitHubStoreContext) {
  const { api, workspace, available, connection, installations, loadingInstallations } = ctx
  const { repos, availableRepos, pulls, issues, branches, syncing, load } = ctx

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

  return { getInstallUrl, loadInstallations, connect, disconnect, resync }
}
