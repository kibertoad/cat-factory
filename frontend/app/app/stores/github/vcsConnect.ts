import type { GitHubStoreContext } from './context'

/**
 * The provider-neutral half of the connection lifecycle: which connect surfaces the deployment
 * serves, and the per-workspace **PAT** connect (GitLab today). The GitHub-App installation
 * lifecycle lives in {@link createGitHubConnectionActions}; everything AFTER connecting — repos,
 * branches, pulls, issues — is the one GitHub-shaped surface both providers ride, so there is no
 * GitLab store (see the VCS section of CLAUDE.md).
 */
export function createVcsConnectActions(ctx: GitHubStoreContext) {
  const { api, workspace, available, connection, connectOptions, load } = ctx

  /**
   * Load the deployment's connect capability. Best-effort: a 403 (a member without
   * `integrations.manage`) or a 503 leaves the list empty, which renders as "no connect
   * surface" rather than a broken picker.
   */
  async function loadConnectOptions(): Promise<void> {
    try {
      const { options } = await api.listVcsConnectOptions(workspace.requireId())
      connectOptions.value = options
    } catch {
      connectOptions.value = []
    }
  }

  /**
   * Connect the workspace by pasting a GitLab PAT. The backend validates the token upstream
   * before sealing it, so a rejected token surfaces here as a thrown API error with the reason;
   * on success the returned connection carries `provider: 'gitlab'` and the projection loads
   * through the same reads the GitHub connection uses.
   */
  async function connectGitLab(pat: string): Promise<void> {
    connection.value = await api.connectGitLab(workspace.requireId(), pat.trim())
    available.value = true
    await load()
  }

  return { loadConnectOptions, connectGitLab }
}
