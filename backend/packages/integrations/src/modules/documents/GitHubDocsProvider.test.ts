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
// the workspace's OWN installation: a crafted `owner/repo:path` external id can only ever
// ride THIS workspace's installation token (resolution via getByWorkspace, never a
// deployment-wide scan), and GitHub limits that token to what it may read — so another
// tenant's PRIVATE repo 404s at the read. A repo the token CAN reach (a public guidelines
// repo owned by someone else, or a cross-account PAT in local mode) links fine — there is
// no owner-string precheck. These tests pin that scoping plus the availability signal.

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
  /** When set, `getFileContent` rejects with this — the raw GitHub API failure path. */
  fileError?: unknown
}) {
  const calls: { installationId: number; path: string }[] = []
  const warnings: { obj: Record<string, unknown>; msg?: string }[] = []
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
    getFileContent: async () => {
      if (opts.fileError !== undefined) throw opts.fileError
      return opts.fileContent === null
        ? null
        : { content: opts.fileContent ?? '# Doc', sha: 'blob-1', path: 'docs/x.md' }
    },
  }
  const provider = new GitHubDocsProvider({
    githubClient: githubClient as GitHubClient,
    installations: installations as GitHubInstallationRepository,
    logger: { warn: (obj, msg) => warnings.push({ obj, msg }) },
  })
  return { provider, calls, warnings }
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

  it('reads a repo owned by another account when the token can see it, via the workspace installation', async () => {
    // acme is this workspace's installation; `other-owner` is a different account. A public
    // guidelines repo (or, in local mode, a PAT that spans accounts) is genuinely readable —
    // the workspace's own installation token is the boundary, not an owner-string match — so
    // the link goes through, still on THIS workspace's installation id.
    const { provider, calls } = makeProvider({ installationForWorkspace: installation() })

    const doc = await provider.fetchDocument({}, 'other-owner/guidelines:docs/x.md', 'ws_1')

    expect(doc.body).toBe('# Doc')
    expect(calls).toEqual([{ installationId: 100, path: 'docs/x.md' }])
  })

  it('a foreign private repo the token cannot read fails at the fetch (isolation enforced by the token)', async () => {
    // The real tenant-isolation boundary: another tenant's PRIVATE repo is unreadable with
    // THIS workspace's installation token, so GitHub 403/404s it — surfaced as a ConflictError
    // naming the access remediation, not a silent success.
    const { provider } = makeProvider({
      installationForWorkspace: installation(),
      fileError: Object.assign(new Error('Not Found'), { status: 404 }),
    })

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

  it('classifies a 403 file read as an access-denied conflict (not an opaque 500) and logs it', async () => {
    const { provider, warnings } = makeProvider({
      installationForWorkspace: installation(),
      fileError: Object.assign(new Error('Forbidden'), { status: 403 }),
    })

    await expect(provider.fetchDocument({}, 'acme/repo:docs/x.md', 'ws_1')).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('HTTP 403'),
      details: { owner: 'acme', repo: 'repo', path: 'docs/x.md', status: 403 },
    })
    // The failure is logged with full coordinates so it's diagnosable server-side.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.obj).toMatchObject({ workspaceId: 'ws_1', path: 'docs/x.md', status: 403 })
  })

  it('classifies a rate-limited 403 as a rate-limit (not a permission denial) and logs the flag', async () => {
    // GitHub reports a PRIMARY rate-limit as a 403 carrying `rateLimited`, so the message must
    // name the rate limit — not tell the user to grant read access they already have.
    const { provider, warnings } = makeProvider({
      installationForWorkspace: installation(),
      fileError: Object.assign(new Error('rate limit exceeded'), {
        status: 403,
        rateLimited: true,
      }),
    })

    await expect(provider.fetchDocument({}, 'acme/repo:docs/x.md', 'ws_1')).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('rate-limited'),
      details: { owner: 'acme', repo: 'repo', path: 'docs/x.md', status: 403 },
    })
    expect(warnings[0]!.obj).toMatchObject({ status: 403, rateLimited: true })
  })

  it('reports a not-found file with the default-branch hint (and logs it)', async () => {
    const { provider, warnings } = makeProvider({
      installationForWorkspace: installation(),
      fileContent: null,
    })

    await expect(provider.fetchDocument({}, 'acme/repo:docs/x.md', 'ws_1')).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('default branch'),
      details: { owner: 'acme', repo: 'repo', path: 'docs/x.md' },
    })
    expect(warnings[0]!.obj).toMatchObject({ notFound: true })
  })

  it('probeVersion is scoped to the workspace installation the same way', async () => {
    const matching = makeProvider({ installationForWorkspace: installation(), commitSha: 'sha-9' })
    expect(await matching.provider.probeVersion({}, 'acme/repo:docs/x.md', 'ws_1')).toBe('sha-9')

    // A different owner probes through the same workspace installation token (no owner-string
    // precheck) — reachability is the token's job, just like fetchDocument.
    const foreign = makeProvider({ installationForWorkspace: installation(), commitSha: 'sha-3' })
    expect(
      await foreign.provider.probeVersion({}, 'other-owner/guidelines:docs/x.md', 'ws_1'),
    ).toBe('sha-3')

    const noInstall = makeProvider({ installationForWorkspace: null })
    await expect(
      noInstall.provider.probeVersion({}, 'acme/repo:docs/x.md', 'ws_1'),
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
