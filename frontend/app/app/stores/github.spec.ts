import { describe, it, expect, vi, type Mock } from 'vitest'
import { useGitHubStore } from '~/stores/github'
import { useWorkspaceStore } from '~/stores/workspace'
import type {
  GitHubConnection,
  GitHubPatCheck,
  GitHubPullRequest,
  GitHubRepo,
  VcsConnectOption,
} from '~/types/domain'

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
    webUrl: 'https://github.com',
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
    getGitHubPatCheck: vi.fn().mockResolvedValue({ state: 'not_applicable' }),
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
        options: [
          { provider: 'gitlab', method: 'pat', webUrl: 'https://gitlab.acme.dev' },
        ] satisfies VcsConnectOption[],
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
          { provider: 'github', method: 'app', webUrl: 'https://github.com' },
          { provider: 'gitlab', method: 'pat', webUrl: 'https://gitlab.acme.dev' },
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
          { provider: 'github', method: 'app', webUrl: 'https://github.com' },
          { provider: 'gitlab', method: 'pat', webUrl: 'https://gitlab.acme.dev' },
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

  // The host a surface links to, before and after binding. `surfaceProvider` names the brand;
  // this names the instance, and the two must come from the same place or the copy and the link
  // disagree (the bootstrap modal renders both).
  it('takes the host from the connect option before binding, and from the connection after', async () => {
    stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: null }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({
        options: [
          { provider: 'gitlab', method: 'pat', webUrl: 'https://gitlab.acme.dev' },
        ] satisfies VcsConnectOption[],
      }),
      connectGitLab: vi
        .fn()
        .mockResolvedValue(
          connection({ provider: 'gitlab', method: 'pat', webUrl: 'https://gitlab.acme.dev' }),
        ),
    })
    const github = storeWithWorkspace()

    await github.probe()
    expect(github.surfaceWebUrl).toBe('https://gitlab.acme.dev')

    await github.connectGitLab('glpat-secret')
    expect(github.surfaceWebUrl).toBe('https://gitlab.acme.dev')
  })

  it('has no host to offer when several providers are connectable and none is bound', async () => {
    stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: null }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({
        options: [
          { provider: 'github', method: 'app', webUrl: 'https://github.com' },
          { provider: 'gitlab', method: 'pat', webUrl: 'https://gitlab.acme.dev' },
        ] satisfies VcsConnectOption[],
      }),
    })
    const github = storeWithWorkspace()

    await github.probe()

    expect(github.surfaceWebUrl).toBeNull()
  })
})

describe('github store — repo web links', () => {
  const repo = (over: Partial<GitHubRepo> = {}): GitHubRepo => ({
    githubId: 1,
    installationId: 42,
    owner: 'acme',
    name: 'api',
    defaultBranch: 'main',
    private: false,
    syncedAt: 0,
    ...over,
  })

  async function storeWith(conn: GitHubConnection, repos: GitHubRepo[]) {
    stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: conn }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
      listGitHubRepos: vi.fn().mockResolvedValue(repos),
    })
    const github = storeWithWorkspace()
    await github.probe()
    await github.load()
    return github
  }

  // Every one of these used to be hand-built from `https://github.com`, which is right for
  // exactly one deployment shape. The host now comes off the connection and the path shape off
  // the repo row's own provider.
  it('builds links on the connected instance, in the repo provider’s own shape', async () => {
    const github = await storeWith(
      connection({ provider: 'gitlab', method: 'pat', webUrl: 'https://gitlab.acme.dev' }),
      [repo({ provider: 'gitlab', owner: 'acme/platform' })],
    )

    expect(github.repoUrl(1)).toBe('https://gitlab.acme.dev/acme/platform/api')
    expect(github.pullUrl({ repoGithubId: 1, number: 7 } as never)).toBe(
      'https://gitlab.acme.dev/acme/platform/api/-/merge_requests/7',
    )
    expect(github.issueUrl({ repoGithubId: 1, number: 3 } as never)).toBe(
      'https://gitlab.acme.dev/acme/platform/api/-/issues/3',
    )
    expect(github.branchUrl(1, 'feat/sso')).toBe(
      'https://gitlab.acme.dev/acme/platform/api/-/tree/feat/sso',
    )
  })

  it('withholds every link when the deployment could not name its host', async () => {
    const github = await storeWith(connection({ webUrl: null }), [repo()])

    expect(github.repoUrl(1)).toBeNull()
    expect(github.pullUrl({ repoGithubId: 1, number: 7 } as never)).toBeNull()
    expect(github.branchUrl(1, 'main')).toBeNull()
  })

  // A row written before the discriminator existed is GitHub, so its links keep the GitHub shape
  // rather than falling through to whatever the connection happens to say.
  it('treats a repo row with no provider as GitHub', async () => {
    const github = await storeWith(connection(), [repo()])

    expect(github.pullUrl({ repoGithubId: 1, number: 7 } as never)).toBe(
      'https://github.com/acme/api/pull/7',
    )
  })
})

// The credential check rides the same probe DOOR, but neither the same failure nor the same
// await. Local mode reaches GitHub with a personal access token and wires no App module, so the
// connection read 503s exactly where this check matters most; sharing that catch would have
// discarded the answer there. And it is the only read that leaves the deployment, so a caller
// awaiting `probe()` must never end up waiting on GitHub.
describe('github store — GitHub PAT credential check', () => {
  const REPORT: GitHubPatCheck = {
    state: 'checked',
    report: {
      source: 'deployment',
      kind: 'classic',
      capabilities: { push: 'missing', pullRequests: 'missing', workflows: 'missing' },
      probedRepos: [],
      deniedRepos: [],
      unprobedRepoCount: 0,
      webUrl: 'https://github.com',
    },
  }

  it('resolves the check alongside the connection probe', async () => {
    stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: connection() }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
      getGitHubPatCheck: vi.fn().mockResolvedValue(REPORT),
    })
    const github = storeWithWorkspace()

    await github.probe()

    await vi.waitFor(() => expect(github.patCheck).toEqual(REPORT))
  })

  it('keeps the check when the connection read fails, as it does in local mode', async () => {
    stubApi({
      getGitHubConnection: vi.fn().mockRejectedValue(new Error('503')),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
      getGitHubPatCheck: vi.fn().mockResolvedValue(REPORT),
    })
    const github = storeWithWorkspace()

    await github.probe()

    expect(github.available).toBe(false)
    await vi.waitFor(() => expect(github.patCheck).toEqual(REPORT))
  })

  // A failed READ is not a verdict: `null` says "not answered", which the banner renders as
  // nothing. Collapsing it onto a clean report would be an all-clear nobody established.
  it('leaves the check unanswered when its own read fails', async () => {
    stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: null }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
      getGitHubPatCheck: vi.fn().mockRejectedValue(new Error('500')),
    })
    const github = storeWithWorkspace()

    await github.probe()

    expect(github.patCheck).toBeNull()
  })

  // The reason it is not awaited: two modals block their open on `probe()`, and every other
  // read behind it answers from local rows. Awaited, an unreachable GitHub held those modals
  // for the full outbound timeout to settle a banner they do not render.
  it('does not make callers wait on the outbound check', async () => {
    let settleCheck: (value: GitHubPatCheck) => void = () => {}
    stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: connection() }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
      getGitHubPatCheck: vi.fn().mockReturnValue(
        new Promise<GitHubPatCheck>((resolve) => {
          settleCheck = resolve
        }),
      ),
    })
    const github = storeWithWorkspace()

    await github.probe()

    expect(github.available).toBe(true)
    expect(github.patCheck).toBeNull()
    settleCheck(REPORT)
    await vi.waitFor(() => expect(github.patCheck).toEqual(REPORT))
  })

  // The on-board-open fan-out fires the probe from several places at once. The credential check
  // spends the user's GitHub rate limit, so it collapses to one per board rather than one per
  // caller — while `probe()`, the deliberate-refresh door, still re-checks, because the surfaces
  // that force a refresh are the ones that just changed what the answer depends on.
  it('checks once per board across the on-open fan-out, and again on a deliberate refresh', async () => {
    const getGitHubPatCheck = vi.fn().mockResolvedValue(REPORT)
    stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: connection() }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
      getGitHubPatCheck,
    })
    const github = storeWithWorkspace()

    await Promise.all([github.ensureProbed(), github.ensureProbed()])
    await github.ensureProbed()
    await vi.waitFor(() => expect(getGitHubPatCheck).toHaveBeenCalledTimes(1))

    await github.probe()
    await vi.waitFor(() => expect(getGitHubPatCheck).toHaveBeenCalledTimes(2))
  })
})

// Two inspector panels call `ensureLoaded()` on the same frame selection. The probe is
// single-flighted, so both callers share it, but the projection read behind it must be shared too.
describe('github store: ensureLoaded', () => {
  const repo: GitHubRepo = {
    githubId: 1,
    installationId: 42,
    owner: 'acme',
    name: 'api',
    defaultBranch: 'main',
    private: false,
    syncedAt: 0,
  }

  it('loads the projection once when two callers ask at the same time', async () => {
    // One linked repo, so the second caller cannot load again only because the list is empty.
    const api = stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: connection() }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
      listGitHubRepos: vi.fn().mockResolvedValue([repo]),
    })
    const github = storeWithWorkspace()

    await Promise.all([github.ensureLoaded(), github.ensureLoaded()])

    expect(api.listGitHubRepos).toHaveBeenCalledTimes(1)
    expect(api.listGitHubPullRequests).toHaveBeenCalledTimes(1)
    expect(api.listGitHubIssues).toHaveBeenCalledTimes(1)
  })

  // A connected workspace with no linked repos counts as loaded: the empty list is its answer, so
  // a later call does not read it again.
  it('does not load again for a connected workspace with no repos', async () => {
    const api = stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: connection() }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
      listGitHubRepos: vi.fn().mockResolvedValue([]),
    })
    const github = storeWithWorkspace()

    await github.ensureLoaded()
    await github.ensureLoaded()

    expect(api.listGitHubRepos).toHaveBeenCalledTimes(1)
    expect(api.listGitHubPullRequests).toHaveBeenCalledTimes(1)
    expect(api.listGitHubIssues).toHaveBeenCalledTimes(1)
  })

  // A board switch resets the store, and a switch back lands on the same workspace id. The
  // cleared projection must be read again, even though that id was loaded before.
  it('loads again after a reset clears the projection', async () => {
    const api = stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: connection() }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
      listGitHubRepos: vi.fn().mockResolvedValue([repo]),
    })
    const github = storeWithWorkspace()

    await github.ensureLoaded()
    github.reset()
    await github.ensureLoaded()

    expect(api.listGitHubRepos).toHaveBeenCalledTimes(2)
    expect(github.repos).toEqual([repo])
  })

  it('loads again after a load that failed', async () => {
    const api = stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: connection() }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
      listGitHubRepos: vi.fn().mockRejectedValueOnce(new Error('500')).mockResolvedValue([repo]),
    })
    const github = storeWithWorkspace()

    await expect(github.ensureLoaded()).rejects.toThrow('500')
    await github.ensureLoaded()

    expect(api.listGitHubRepos).toHaveBeenCalledTimes(2)
    expect(github.repos).toEqual([repo])
  })

  // `load()` is how every write refreshes the projection. A write that lands while an
  // `ensureLoaded()` read is in flight must not get that older read back.
  it('reads again on load() while an ensureLoaded() read is in flight', async () => {
    const api = stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: connection() }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
    })
    const github = storeWithWorkspace()
    await github.probe()

    const ensured = github.ensureLoaded()
    const reloaded = github.load()
    await Promise.all([ensured, reloaded])

    expect(api.listGitHubRepos).toHaveBeenCalledTimes(2)
  })

  // A disconnect clears the projection outside a load. A probe that finds the workspace connected
  // again (an App installed from another tab) must load it, not trust the earlier load.
  it('loads again after a disconnect and a later probe that finds a connection', async () => {
    const api = stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: connection() }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
      listGitHubRepos: vi.fn().mockResolvedValue([repo]),
      disconnectGitHub: vi.fn().mockResolvedValue(undefined),
    })
    const github = storeWithWorkspace()

    await github.ensureLoaded()
    await github.disconnect()
    await github.probe()
    await github.ensureLoaded()

    expect(api.listGitHubRepos).toHaveBeenCalledTimes(2)
    expect(github.repos).toEqual([repo])
  })

  // The reads behind `ensureLoaded()` and a later `load()` overlap, and the older one can finish
  // last. Its result is older than what is already shown, so it does not replace it.
  it('keeps the newer read when an older one finishes after it', async () => {
    let finishOlderRead: (repos: GitHubRepo[]) => void = () => {}
    const newer: GitHubRepo = { ...repo, githubId: 2, name: 'web' }
    stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: connection() }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
      listGitHubRepos: vi
        .fn()
        .mockReturnValueOnce(
          new Promise<GitHubRepo[]>((resolve) => {
            finishOlderRead = resolve
          }),
        )
        .mockResolvedValueOnce([newer]),
    })
    const github = storeWithWorkspace()
    await github.probe()

    const ensured = github.ensureLoaded()
    await github.load()
    expect(github.repos).toEqual([newer])
    // The older read is still running, but the newer one owns the flag and has finished.
    expect(github.loading).toBe(false)

    finishOlderRead([repo])
    await ensured

    expect(github.repos).toEqual([newer])
  })

  it('drops a read that finishes after a switch to another board', async () => {
    let finishRead: (repos: GitHubRepo[]) => void = () => {}
    stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: connection() }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
      listGitHubRepos: vi.fn().mockReturnValueOnce(
        new Promise<GitHubRepo[]>((resolve) => {
          finishRead = resolve
        }),
      ),
    })
    const github = storeWithWorkspace()
    await github.probe()

    const ensured = github.ensureLoaded()
    useWorkspaceStore().workspaceId = 'ws-2'
    github.reset()
    finishRead([repo])
    await ensured

    expect(github.repos).toEqual([])
  })

  // In the usual order the older read finishes first. A newer read has started by then, so the older
  // result is dropped, and the projection is not settled until the newer read finishes.
  it('stays loading until the newest read finishes', async () => {
    const finish: Array<(repos: GitHubRepo[]) => void> = []
    const newer: GitHubRepo = { ...repo, githubId: 2, name: 'web' }
    stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: connection() }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
      listGitHubRepos: vi.fn(
        () =>
          new Promise<GitHubRepo[]>((resolve) => {
            finish.push(resolve)
          }),
      ),
    })
    const github = storeWithWorkspace()
    await github.probe()

    const ensured = github.ensureLoaded()
    const reloaded = github.load()
    finish[0]?.([repo])
    await ensured

    expect(github.repos).toEqual([])
    expect(github.loading).toBe(true)

    finish[1]?.([newer])
    await reloaded

    expect(github.repos).toEqual([newer])
    expect(github.loading).toBe(false)
  })

  // A disconnect clears the projection in the same workspace, so the board id cannot tell the
  // read apart. A read that started before the disconnect must not put the old rows back.
  it('drops a read that finishes after a disconnect', async () => {
    let finishRead: (repos: GitHubRepo[]) => void = () => {}
    stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: connection() }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
      listGitHubRepos: vi.fn().mockReturnValueOnce(
        new Promise<GitHubRepo[]>((resolve) => {
          finishRead = resolve
        }),
      ),
      disconnectGitHub: vi.fn().mockResolvedValue(undefined),
    })
    const github = storeWithWorkspace()
    await github.probe()

    const ensured = github.ensureLoaded()
    await github.disconnect()
    // Nothing is left to wait for, so no spinner stays up for a read whose result is thrown away.
    expect(github.loading).toBe(false)
    finishRead([repo])
    await ensured

    expect(github.repos).toEqual([])
  })

  // `load()` reads nothing while the workspace is not connected, so it must not record the
  // projection as loaded. A later probe that finds a connection must lead to a read.
  it('loads after a connection appears when load() ran while not connected', async () => {
    const api = stubApi({
      getGitHubConnection: vi
        .fn()
        .mockResolvedValueOnce({ connection: null })
        .mockResolvedValue({ connection: connection() }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
      listGitHubRepos: vi.fn().mockResolvedValue([repo]),
    })
    const github = storeWithWorkspace()
    await github.probe()

    await github.load()
    await github.probe()
    await github.ensureLoaded()

    expect(api.listGitHubRepos).toHaveBeenCalledTimes(1)
    expect(github.repos).toEqual([repo])
  })

  // The App is uninstalled and installed again from another tab. The probe sees the new
  // connection, and the earlier load belongs to the old one.
  it('loads again when the probe finds a different connection', async () => {
    const getGitHubConnection = vi
      .fn()
      .mockResolvedValueOnce({ connection: connection() })
      .mockResolvedValueOnce({ connection: null })
      .mockResolvedValue({ connection: connection({ installationId: 43, connectedAt: 2 }) })
    const api = stubApi({
      getGitHubConnection,
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
      listGitHubRepos: vi.fn().mockResolvedValue([repo]),
    })
    const github = storeWithWorkspace()

    await github.ensureLoaded()
    await github.probe()
    await github.probe()
    await github.ensureLoaded()

    expect(api.listGitHubRepos).toHaveBeenCalledTimes(2)
  })

  // `refresh()` is the plain re-read for a surface opening while another read runs. It shares that
  // read, where `load()` is the after-write door and starts its own.
  it('shares an in-flight read on refresh() and starts a new one on load()', async () => {
    const api = stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: connection() }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
    })
    const github = storeWithWorkspace()
    await github.probe()

    await Promise.all([github.ensureLoaded(), github.refresh()])
    expect(api.listGitHubRepos).toHaveBeenCalledTimes(1)

    await Promise.all([github.ensureLoaded(), github.load()])
    expect(api.listGitHubRepos).toHaveBeenCalledTimes(2)
  })

  // Saving the linked repos sets the projection directly. A read that started before the save
  // must not put the earlier rows back, even if the reload that follows the save fails.
  it('keeps the saved repos when a read that started before the save finishes afterwards', async () => {
    let finishRead: (repos: GitHubRepo[]) => void = () => {}
    const saved: GitHubRepo = { ...repo, githubId: 2, name: 'web' }
    stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: connection() }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
      listGitHubRepos: vi
        .fn()
        .mockReturnValueOnce(
          new Promise<GitHubRepo[]>((resolve) => {
            finishRead = resolve
          }),
        )
        .mockRejectedValueOnce(new Error('500')),
      setGitHubLinkedRepos: vi.fn().mockResolvedValue([saved]),
    })
    const github = storeWithWorkspace()
    await github.probe()

    const ensured = github.ensureLoaded()
    await expect(github.setLinkedRepos([2])).rejects.toThrow('500')
    finishRead([repo])
    await ensured

    expect(github.repos).toEqual([saved])
  })

  it('keeps a pull request opened while a read was in flight', async () => {
    let finishPulls: (pulls: GitHubPullRequest[]) => void = () => {}
    const opened = { repoGithubId: 1, number: 7 } as GitHubPullRequest
    stubApi({
      getGitHubConnection: vi.fn().mockResolvedValue({ connection: connection() }),
      listVcsConnectOptions: vi.fn().mockResolvedValue({ options: [] }),
      listGitHubPullRequests: vi.fn().mockReturnValueOnce(
        new Promise<GitHubPullRequest[]>((resolve) => {
          finishPulls = resolve
        }),
      ),
      openGitHubPullRequest: vi.fn().mockResolvedValue(opened),
    })
    const github = storeWithWorkspace()
    await github.probe()

    const ensured = github.ensureLoaded()
    await github.openPullRequest(1, {} as never)
    finishPulls([])
    await ensured

    expect(github.pulls).toEqual([opened])
  })
})
