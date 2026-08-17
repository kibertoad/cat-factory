import type {
  Clock,
  GitHubClient,
  GitHubInstallation,
  GitHubInstallationRepository,
  VcsWebUrls,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { GitHubInstallationService } from './GitHubInstallationService.js'

// How a connection reports the way it AUTHENTICATES (`method`) and WHERE its repositories can
// be opened (`webUrl`). Both are derived from the ROW, and this service reads back rows
// written by three different paths — its own App connect, the per-workspace PAT connect, and
// local mode's auto-provisioned synthetic row — so it cannot assert a method, it has to derive
// one. Getting this wrong is not cosmetic: the SPA offers the GitHub App's installation
// settings page (the "grant the App access to this repo" link) on an `app` connection only,
// and that URL 404s for anything else.

function installation(overrides: Partial<GitHubInstallation> = {}): GitHubInstallation {
  return {
    installationId: 7,
    workspaceId: 'ws-1',
    accountId: null,
    accountLogin: 'octocat',
    targetType: 'User',
    appId: 'app-default',
    provider: 'github',
    cachedToken: null,
    tokenExpiresAt: null,
    accessToken: null,
    createdAt: 1000,
    deletedAt: null,
    ...overrides,
  }
}

function makeService(
  row: GitHubInstallation,
  // The deployment's resolved hosts, one per provider — this service reads back rows from every
  // connect path, so the ROW's provider is what picks the host. `{}` is a deployment whose API
  // base did not invert to one.
  webUrls: VcsWebUrls = { github: 'https://github.com', gitlab: 'https://gitlab.acme.dev' },
) {
  const rows = new Map<number, GitHubInstallation>([[row.installationId, row]])
  const installations: GitHubInstallationRepository = {
    getByInstallationId: async (id) => rows.get(id) ?? null,
    listByInstallationIds: async (ids) => ids.map((id) => rows.get(id)).filter((r) => r != null),
    getByWorkspace: async (ws) =>
      [...rows.values()].find((r) => r.workspaceId === ws && !r.deletedAt) ?? null,
    listWorkspacesForInstallation: async () => [],
    listActive: async () => [...rows.values()],
    listActiveForAccount: async () => [],
    upsert: async (i) => void rows.set(i.installationId, i),
    softDelete: async () => {},
  }
  return new GitHubInstallationService({
    githubClient: {} as GitHubClient,
    githubInstallationRepository: installations,
    workspaceRepository: {
      get: async () => ({ id: 'ws-1' }),
      accountOf: async () => null,
    } as unknown as WorkspaceRepository,
    clock: { now: () => 2000 } as Clock,
    webUrls,
  })
}

describe('GitHubInstallationService connection method + host', () => {
  it('reports an App installation as `app`', async () => {
    const service = makeService(installation())
    expect((await service.getConnection('ws-1'))?.method).toBe('app')
  })

  // The per-workspace PAT connect writes its rows through the same table and they are read
  // back here, so a provider test would not save us: what makes this NOT an App installation
  // is that no App owns it.
  it('reports a per-workspace PAT connection as `pat`', async () => {
    const service = makeService(
      installation({ provider: 'gitlab', appId: null, accessToken: 'sealed:glpat' }),
    )
    expect((await service.getConnection('ws-1'))?.method).toBe('pat')
  })

  // Local mode's synthetic row: PAT-backed, but with no per-connection credential either (the
  // one deployment PAT is read at mint time), so `accessToken` alone would misread it as an App.
  it('reports local mode’s synthetic connection as `pat`', async () => {
    const service = makeService(installation({ appId: null, accessToken: null }))
    expect((await service.getConnection('ws-1'))?.method).toBe('pat')
  })

  // The host is picked by the ROW's provider, not by the service that owns the App connect:
  // local mode writes a `gitlab` row through this same reader, and pointing it at github.com
  // is the class of bug this field exists to end.
  it('reports the host of the provider the row names', async () => {
    const github = makeService(installation())
    expect((await github.getConnection('ws-1'))?.webUrl).toBe('https://github.com')
    const gitlab = makeService(installation({ provider: 'gitlab', appId: null }))
    expect((await gitlab.getConnection('ws-1'))?.webUrl).toBe('https://gitlab.acme.dev')
  })

  // A base the deployment configured behind a path we cannot invert resolves to no host at all,
  // and the connection says so. The SPA withholds the links rather than guessing a public host.
  it('reports a null host when the deployment resolved none for the row’s provider', async () => {
    const service = makeService(installation({ provider: 'gitlab', appId: null }), {})
    expect((await service.getConnection('ws-1'))?.webUrl).toBeNull()
  })
})
