import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DrizzleDb } from '@cat-factory/node-server'
import type { GitHubAvailableRepo, GitHubConnection, WorkspaceSnapshot } from '@cat-factory/kernel'
import { makeConformanceApp, setupTestDb } from './harness.js'

// Local mode reaches GitHub through a PAT, not a GitHub App. These tests assert the
// PAT-backed read/link wiring: the integration reports CONNECTED with no connect flow (a
// synthetic per-workspace installation is auto-provisioned from the PAT account), and the
// repo picker lists repos via `/user/repos` (the PAT analogue of the App-only
// `/installation/repositories`). GitHub is stubbed at the `fetch` boundary so no network
// or real token is needed; everything below the client is the real shared integration.

describe('[local] PAT GitHub linking', () => {
  let db: DrizzleDb

  beforeAll(async () => {
    db = await setupTestDb()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function stubGitHub(repos: Array<{ id: number; name: string; private?: boolean }>): string[] {
    const calls: string[] = []
    const realFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ id: 42, login: 'octocat', type: 'User' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/user/repos')) {
        const body = repos.map((r) => ({
          id: r.id,
          name: r.name,
          private: r.private ?? false,
          default_branch: 'main',
          owner: { login: 'octocat' },
        }))
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return realFetch(input as Parameters<typeof fetch>[0], init)
    })
    return calls
  }

  it('reports connected (synthetic installation) without a connect flow', async () => {
    stubGitHub([])
    const app = makeConformanceApp(db)
    const ws = (await app.createWorkspace({ seed: false })) as WorkspaceSnapshot

    const res = await app.call<{ connection: GitHubConnection | null }>(
      'GET',
      `/workspaces/${ws.workspace.id}/github/connection`,
    )

    expect(res.status).toBe(200)
    expect(res.body.connection).not.toBeNull()
    expect(res.body.connection?.accountLogin).toBe('octocat')
    // The PAT carries `workflow` scope, so the connection isn't flagged as missing it.
    expect(res.body.connection?.canManageWorkflows).toBe(true)
  })

  it('lists repos the PAT can access via /user/repos, flagged unlinked', async () => {
    const calls = stubGitHub([
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta', private: true },
    ])
    const app = makeConformanceApp(db)
    const ws = (await app.createWorkspace({ seed: false })) as WorkspaceSnapshot

    const res = await app.call<GitHubAvailableRepo[]>(
      'GET',
      `/workspaces/${ws.workspace.id}/github/available-repos`,
    )

    expect(res.status).toBe(200)
    expect(res.body.map((r) => r.name).sort()).toEqual(['alpha', 'beta'])
    expect(res.body.every((r) => r.linked === false)).toBe(true)
    // It used the PAT user-repos endpoint, never the App-only installation endpoint.
    expect(calls.some((u) => u.includes('/user/repos'))).toBe(true)
    expect(calls.some((u) => u.includes('/installation/repositories'))).toBe(false)
  })
})
