import { describe, expect, it } from 'vitest'
import type {
  GitHubClient,
  GitHubInstallation,
  GitHubInstallationRepository,
} from '@cat-factory/kernel'
import { ConflictError } from '@cat-factory/kernel'
import { GitHubDocsProvider } from './GitHubDocsProvider.js'

// GitHubDocsProvider rides the workspace's installed GitHub App/PAT — it stores no
// per-workspace credential. The security-critical property is that a read is scoped to
// the workspace's OWN installation: a crafted `owner/repo:path` external id must never
// reach another tenant's repo through some other workspace's installation token. These
// tests pin that scoping (resolution via getByWorkspace + an owner-match guard), plus the
// implicit-connection availability signal.

function installation(overrides: Partial<GitHubInstallation> = {}): GitHubInstallation {
  return {
    installationId: 100,
    workspaceId: 'ws_1',
    accountId: 'acc_1',
    accountLogin: 'acme',
    targetType: 'Organization',
    provider: 'github',
    appId: null,
    cachedToken: null,
    tokenExpiresAt: null,
    createdAt: 0,
    deletedAt: null,
    ...overrides,
  }
}

function makeProvider(opts: {
  installationForWorkspace: GitHubInstallation | null
  commitSha?: string | null
  fileContent?: string | null
}) {
  const calls: { installationId: number; path: string }[] = []
  const installations: Partial<GitHubInstallationRepository> = {
    getByWorkspace: async (workspaceId) =>
      workspaceId === 'ws_1' ? opts.installationForWorkspace : null,
    // Present so a regression that reintroduces the deployment-wide scan is caught: any call
    // to listActive() from the fetch path is a tenant-isolation leak and fails the test.
    listActive: async () => {
      throw new Error('listActive must not be used to resolve a fetch (tenant-isolation leak)')
    },
  }
  const githubClient: Partial<GitHubClient> = {
    latestCommitSha: async (installationId, _ref, path) => {
      calls.push({ installationId, path })
      return opts.commitSha ?? 'sha-1'
    },
    getFileContent: async () =>
      opts.fileContent === null
        ? null
        : { content: opts.fileContent ?? '# Doc', sha: 'blob-1', path: 'docs/x.md' },
  }
  const provider = new GitHubDocsProvider({
    githubClient: githubClient as GitHubClient,
    installations: installations as GitHubInstallationRepository,
  })
  return { provider, calls }
}

describe('GitHubDocsProvider workspace-scoped reads', () => {
  it('fetchDocument reads via the workspace own installation when the owner matches', async () => {
    const { provider, calls } = makeProvider({ installationForWorkspace: installation() })

    const doc = await provider.fetchDocument({}, 'acme/repo:docs/x.md', 'ws_1')

    expect(doc.body).toBe('# Doc')
    expect(doc.version).toBe('sha-1')
    // Read with the workspace installation's token, not some deployment-wide match.
    expect(calls).toEqual([{ installationId: 100, path: 'docs/x.md' }])
  })

  it('fetchDocument rejects a doc whose owner is NOT the workspace installation account', async () => {
    const { provider } = makeProvider({ installationForWorkspace: installation() })

    // acme is this workspace's installation; other-tenant is a different account. Even if
    // other-tenant has the App installed elsewhere in the deployment, this workspace must
    // not be able to read it.
    await expect(
      provider.fetchDocument({}, 'other-tenant/repo:secret.md', 'ws_1'),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('fetchDocument rejects when the workspace has no installation', async () => {
    const { provider } = makeProvider({ installationForWorkspace: null })

    await expect(provider.fetchDocument({}, 'acme/repo:docs/x.md', 'ws_1')).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  it('probeVersion is scoped to the workspace installation the same way', async () => {
    const matching = makeProvider({ installationForWorkspace: installation(), commitSha: 'sha-9' })
    expect(await matching.provider.probeVersion({}, 'acme/repo:docs/x.md', 'ws_1')).toBe('sha-9')

    const crossTenant = makeProvider({ installationForWorkspace: installation() })
    await expect(
      crossTenant.provider.probeVersion({}, 'other-tenant/repo:secret.md', 'ws_1'),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('resolveImplicitConnection reports connected iff the workspace has an installation', async () => {
    const withInstall = makeProvider({ installationForWorkspace: installation() })
    expect(await withInstall.provider.resolveImplicitConnection('ws_1')).toEqual({
      credentials: {},
      label: 'GitHub',
    })

    const withoutInstall = makeProvider({ installationForWorkspace: null })
    expect(await withoutInstall.provider.resolveImplicitConnection('ws_1')).toBeNull()
  })
})
