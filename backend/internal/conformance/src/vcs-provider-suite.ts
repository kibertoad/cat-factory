import type {
  GitHubInstallation,
  GitHubInstallationRepository,
  GitHubRepo,
  RepoProjectionRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the `provider` VCS discriminator on the GitHub-named projection
// tables (`github_installations` / `github_repos`). The SPA switches presentation on this
// field, so a facade that dropped the column, mapped it to a different name, or lost the
// default would silently break the GitLab surface on one runtime only. This suite drives the
// SAME upsert → read assertions through whichever real repositories a runtime hands it: a
// GitLab connection + repo must round-trip `'gitlab'`, and a repo written with no provider
// must default to `'github'` (the legacy-row backstop the column's DEFAULT provides).

function installation(overrides: Partial<GitHubInstallation> = {}): GitHubInstallation {
  return {
    installationId: 1,
    workspaceId: 'ws',
    accountId: null,
    accountLogin: 'acme',
    targetType: 'Organization',
    appId: null,
    provider: 'github',
    cachedToken: null,
    tokenExpiresAt: null,
    createdAt: 1,
    deletedAt: null,
    ...overrides,
  }
}

function repo(overrides: Partial<GitHubRepo> & Pick<GitHubRepo, 'githubId'>): GitHubRepo {
  return {
    installationId: 1,
    owner: 'acme',
    name: `repo-${overrides.githubId}`,
    defaultBranch: 'main',
    private: false,
    linkedVia: 'app',
    syncedAt: 1,
    ...overrides,
  }
}

/**
 * Assert a runtime's installation + repo projection repositories persist and read back the
 * `provider` discriminator identically. `makeRepos` returns fresh repositories over the
 * runtime's real store; ids are unique per case so the shared database stays isolated.
 */
export function defineVcsProviderSuite(
  name: string,
  makeRepos: () => {
    installations: GitHubInstallationRepository
    repoProjection: RepoProjectionRepository
  },
): void {
  describe(`[${name}] VCS provider projection parity`, () => {
    let seq = 0
    const scope = () => {
      seq += 1
      return { ws: `${name}-vcs-ws-${seq}`, install: 900_000 + seq, repo: 900_000 + seq }
    }

    it('round-trips a gitlab connection + repo', async () => {
      const { installations, repoProjection } = makeRepos()
      const { ws, install, repo: repoId } = scope()
      await installations.upsert(
        installation({ installationId: install, workspaceId: ws, provider: 'gitlab' }),
      )
      await repoProjection.upsertMany(ws, [
        repo({ githubId: repoId, installationId: install, provider: 'gitlab' }),
      ])

      const conn = await installations.getByWorkspace(ws)
      expect(conn?.provider).toBe('gitlab')
      const rows = await repoProjection.list(ws)
      expect(rows.map((r) => r.provider)).toEqual(['gitlab'])
      expect((await repoProjection.get(ws, repoId))?.provider).toBe('gitlab')
    })

    it('round-trips a github connection + repo', async () => {
      const { installations, repoProjection } = makeRepos()
      const { ws, install, repo: repoId } = scope()
      await installations.upsert(
        installation({ installationId: install, workspaceId: ws, provider: 'github' }),
      )
      await repoProjection.upsertMany(ws, [
        repo({ githubId: repoId, installationId: install, provider: 'github' }),
      ])

      expect((await installations.getByWorkspace(ws))?.provider).toBe('github')
      expect((await repoProjection.get(ws, repoId))?.provider).toBe('github')
    })

    it('defaults a repo written with no provider to github (legacy-row backstop)', async () => {
      const { installations, repoProjection } = makeRepos()
      const { ws, install, repo: repoId } = scope()
      await installations.upsert(installation({ installationId: install, workspaceId: ws }))
      // Explicitly omit `provider` to exercise the column DEFAULT / mapper fallback.
      const { provider: _drop, ...noProvider } = repo({ githubId: repoId, installationId: install })
      await repoProjection.upsertMany(ws, [noProvider])
      expect((await repoProjection.get(ws, repoId))?.provider).toBe('github')
    })
  })
}
