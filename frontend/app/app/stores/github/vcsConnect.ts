import { computed, type ComputedRef } from 'vue'
import type { VcsProvider } from '~/types/domain'
import type { GitHubStoreContext } from './context'

/**
 * Everything a component needs to know about WHICH provider it is dealing with. Kept here,
 * beside the connect actions that populate the state it reads, so the three questions stay
 * answered in one place: what is connected, what could be connected, and what a given surface
 * should therefore call itself.
 */
export interface VcsProviderViews {
  /** The provider backing the current connection; a connection predating the discriminator is App-era GitHub. */
  provider: ComputedRef<VcsProvider>
  canConnectGitHubApp: ComputedRef<boolean>
  canConnectGitLabPat: ComputedRef<boolean>
  soleConnectProvider: ComputedRef<VcsProvider | null>
  surfaceProvider: ComputedRef<VcsProvider | null>
}

/** The derived provider questions above, off the probed connection + capability state. */
export function createVcsProviderViews(ctx: GitHubStoreContext): VcsProviderViews {
  const { connection, connectOptions } = ctx

  const provider = computed<VcsProvider>(() => connection.value?.provider ?? 'github')

  /** Whether the deployment can serve a GitHub App connect / a per-workspace GitLab PAT connect. */
  const canConnectGitHubApp = computed(() =>
    connectOptions.value.some((o) => o.provider === 'github' && o.method === 'app'),
  )
  const canConnectGitLabPat = computed(() =>
    connectOptions.value.some((o) => o.provider === 'gitlab' && o.method === 'pat'),
  )

  /**
   * The single provider this deployment can connect, or null when it offers several (or none) —
   * what the connect copy keys off so a one-provider deployment never says "choose a provider".
   */
  const soleConnectProvider = computed<VcsProvider | null>(() => {
    const providers = new Set(connectOptions.value.map((o) => o.provider))
    return providers.size === 1 ? [...providers][0]! : null
  })

  /**
   * The provider a repo-facing surface is ABOUT: the connected one, or (with nothing bound yet)
   * the only one this deployment could connect. Null when it offers several and none is
   * connected, because naming one there would be a guess — such a surface says something neutral
   * instead (`vcs.onboarding.titleAny` is the pattern). Distinct from {@link provider}, which
   * answers "what is connected" and therefore defaults to `github`: reading THAT before a
   * connection exists is what puts "Pick an existing GitHub repository" in front of a
   * GitLab-only deployment.
   */
  const surfaceProvider = computed<VcsProvider | null>(() =>
    connection.value !== null ? provider.value : soleConnectProvider.value,
  )

  return {
    provider,
    canConnectGitHubApp,
    canConnectGitLabPat,
    soleConnectProvider,
    surfaceProvider,
  }
}

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
