import { describe, it, expect, vi, type Mock } from 'vitest'
import { useGitHubStore } from '~/stores/github'
import { useWorkspaceStore } from '~/stores/workspace'
import type { GitHubConnection, VcsConnectOption } from '~/types/domain'

// The VCS connect surface of the (single, GitHub-shaped) repo store: which connect methods the
// deployment offers, the per-workspace GitLab PAT connect, and the provider-routed disconnect.
// These decide what the connect UI renders — an App picker a GitLab-only deployment can't serve,
// or a GitHub disconnect call against a GitLab connection, are exactly the failures worth pinning.

function connection(overrides: Partial<GitHubConnection> = {}): GitHubConnection {
  return {
    installationId: 42,
    accountLogin: 'octocat',
    targetType: 'User',
    connectedAt: 1,
    provider: 'github',
    method: 'app',
    canCreateRepos: false,
    canManageWorkflows: true,
    ...overrides,
  }
}

/** Stub the auto-imported `useApi()` with just the calls the connect actions make. */
function stubApi<T extends Record<string, Mock>>(api: T) {
  const full = {
    listGitHubRepos: vi.fn().mockResolvedValue([]),
    listGitHubPullRequests: vi.fn().mockResolvedValue([]),
    listGitHubIssues: vi.fn().mockResolvedValue([]),
    ...api,
  }
  vi.stubGlobal('useApi', () => full)
  return full
}

/** A store bound to an active workspace (the actions all resolve one). */
function storeWithWorkspace() {
  useWorkspaceStore().workspaceId = 'ws-1'
  return useGitHubStore()
}

describe('github store — VCS connect capability', () => {
  it('probes the connection and the connect options together', async () => {
    stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: null }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({
        options: [{ provider: 'gitlab', method: 'pat' }] satisfies VcsConnectOption[],
      }),
    })
    const github = storeWithWorkspace()

    await github.probe()

    expect(github.available).toBe(true)
    expect(github.canConnectGitHubApp).toBe(false)
    expect(github.canConnectGitLabPat).toBe(true)
    // A single-provider deployment names its provider, so the connect copy never says "choose".
    expect(github.soleConnectProvider).toBe('gitlab')
    // …and the repo-facing surfaces name it too, BEFORE anything is connected. `provider`
    // answers "what is connected" and so defaults to github; a surface reading that one is how
    // "Pick an existing GitHub repository" ends up on a GitLab-only deployment.
    expect(github.provider).toBe('github')
    expect(github.surfaceProvider).toBe('gitlab')
  })

  it('names the connected provider once bound, whatever the deployment could connect', async () => {
    stubApi({
      getGitHubConnection: vi
        .fn()
        .mockResolvedValue({ connection: connection({ provider: 'gitlab', method: 'pat' }) }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({
        options: [
          { provider: 'github', method: 'app' },
          { provider: 'gitlab', method: 'pat' },
        ] satisfies VcsConnectOption[],
      }),
    })
    const github = storeWithWorkspace()

    await github.probe()

    // Several connectable, so there is no sole provider — but one IS connected, and that is
    // what every repo-facing surface is about.
    expect(github.soleConnectProvider).toBeNull()
    expect(github.surfaceProvider).toBe('gitlab')
  })

  it('reports no connect surface when the capability read fails, without hiding the integration', async () => {
    // A member without `integrations.manage` gets a 403 here. That must degrade to "nothing to
    // connect", NOT to a broken picker — and must not flip the whole integration off.
    stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: connection() }),
      listVcsConnectOptions: vi.fn().mockRejectedValue(new Error('403')),
    })
    const github = storeWithWorkspace()

    await github.probe()

    expect(github.available).toBe(true)
    expect(github.connectOptions).toEqual([])
    expect(github.soleConnectProvider).toBeNull()
  })

  it('stays neutral when the deployment serves several providers', async () => {
    stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: null }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({
        options: [
          { provider: 'github', method: 'app' },
          { provider: 'gitlab', method: 'pat' },
        ] satisfies VcsConnectOption[],
      }),
    })
    const github = storeWithWorkspace()

    await github.probe()

    expect(github.canConnectGitHubApp).toBe(true)
    expect(github.canConnectGitLabPat).toBe(true)
    expect(github.soleConnectProvider).toBeNull()
    // Nothing connected and several on offer: naming one would be a guess, so the surfaces
    // fall back to their neutral copy rather than picking a brand.
    expect(github.surfaceProvider).toBeNull()
  })

  it('connects GitLab with a trimmed PAT and loads the projection', async () => {
    const api = stubApi({
      connectGitLab: vi.fn().mockResolvedValue(connection({ provider: 'gitlab' })),
    })
    const github = storeWithWorkspace()

    await github.connectGitLab('  glpat-secret  ')

    expect(api.connectGitLab).toHaveBeenCalledWith('ws-1', 'glpat-secret')
    expect(github.connected).toBe(true)
    expect(github.provider).toBe('gitlab')
    expect(github.available).toBe(true)
    // Connecting seeds the projection reads, exactly as the App connect does.
    expect(api.listGitHubRepos).toHaveBeenCalledWith('ws-1')
  })

  it('routes disconnect to the provider that is actually connected', async () => {
    const api = stubApi({
      connectGitLab: vi.fn().mockResolvedValue(connection({ provider: 'gitlab' })),
      disconnectGitLab: vi.fn().mockResolvedValue(undefined),
      disconnectGitHub: vi.fn().mockResolvedValue(undefined),
    })
    const github = storeWithWorkspace()
    await github.connectGitLab('glpat-secret')

    await github.disconnect()

    expect(api.disconnectGitLab).toHaveBeenCalledWith('ws-1')
    expect(api.disconnectGitHub).not.toHaveBeenCalled()
    expect(github.connection).toBeNull()
  })

  it('disconnects a connection with no provider through the GitHub route', async () => {
    // Backends predating the discriminator omit `provider`; those are GitHub App connections.
    const api = stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({
        connection: { ...connection(), provider: undefined },
      }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
      disconnectGitHub: vi.fn().mockResolvedValue(undefined),
      disconnectGitLab: vi.fn().mockResolvedValue(undefined),
    })
    const github = storeWithWorkspace()
    await github.probe()

    await github.disconnect()

    expect(api.disconnectGitHub).toHaveBeenCalledWith('ws-1')
    expect(api.disconnectGitLab).not.toHaveBeenCalled()
  })
})
