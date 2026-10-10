import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DrizzleDb } from '@cat-factory/node-server'
import type { GitHubConnection, WorkspaceSnapshot } from '@cat-factory/kernel'
import { makeConformanceApp, setupTestDb } from './harness.js'

// The LOCAL half of the connection-host parity assertion (Node asserts it in
// `github-projections.spec.ts`, the Worker in `github-connect.spec.ts`, each against its own
// composition root). `webUrl` is what every repo / merge request / issue link on the board is
// built from, and null WITHHOLDS them all, so a facade that cannot name its host silently
// strips the affordances rather than failing.
//
// Local mode is the deployment shape where that is easiest to get wrong: it reaches GitLab with
// a `GITLAB_PAT`, never the `GITLAB_TOKEN` that opts into the single-token engine connection.
// Reading the instance address off that opt-in left a local GitLab developer with no links at
// all — including on gitlab.com, where the default base is right — so these two cases pin that
// the address is read independently of it.

describe('[local] GitLab PAT connection host', () => {
  let db: DrizzleDb

  beforeAll(async () => {
    db = await setupTestDb()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * The synthetic installation is attributed by reading the token's own account. That read is
   * not what these cases are about, so answer it locally rather than over the network — the row
   * is written either way (an unreadable account only costs the login label).
   */
  function stubAccountRead(): void {
    const realFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ id: 7, login: 'gitlabber', type: 'User' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return realFetch(input as Parameters<typeof fetch>[0], init)
    })
  }

  /** Boot the local facade against a GitLab PAT — `GITHUB_PAT` unset, so the credential is GitLab's. */
  const gitlabApp = (apiBase?: string) =>
    makeConformanceApp(db, undefined, {
      env: {
        GITHUB_PAT: undefined,
        GITLAB_PAT: 'test-gitlab-pat',
        ...(apiBase ? { GITLAB_API_BASE: apiBase } : {}),
      },
    })

  async function connection(apiBase?: string): Promise<GitHubConnection | null> {
    stubAccountRead()
    const app = gitlabApp(apiBase)
    const ws = (await app.createWorkspace({ seed: false })) as WorkspaceSnapshot
    const res = await app.call<{ connection: GitHubConnection | null }>(
      'GET',
      `/workspaces/${ws.workspace.id}/github/connection`,
    )
    expect(res.status).toBe(200)
    return res.body.connection
  }

  it('names the self-managed instance the deployment addresses', async () => {
    const found = await connection('https://gitlab.acme.dev/api/v4')
    expect(found?.provider).toBe('gitlab')
    expect(found?.webUrl).toBe('https://gitlab.acme.dev')
  })

  // No `GITLAB_API_BASE` means the public instance, which is a host like any other: the links
  // must be built, not withheld. This is the case a token-gated read got wrong most quietly,
  // because nothing about the deployment looks misconfigured.
  it('names the public instance when the deployment configures no base', async () => {
    expect((await connection())?.webUrl).toBe('https://gitlab.com')
  })
})
