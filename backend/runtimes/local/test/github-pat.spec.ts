import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DrizzleDb } from '@cat-factory/node-server'
import type { GitHubAvailableRepo, GitHubConnection, WorkspaceSnapshot } from '@cat-factory/kernel'
import type { GitHubPatCheck } from '@cat-factory/contracts'
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
    // Local mode authenticates with a deployment PAT, so the synthetic connection is NOT an
    // App installation: the SPA drops the App-only affordances (the installation settings
    // page, the repo-access grant), which would otherwise link to a github.com page for an
    // installation id that only exists here.
    expect(res.body.connection?.method).toBe('pat')
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

  it('searches the picker by owner/name over the PAT repo listing (no global search)', async () => {
    const calls = stubGitHub([
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
      { id: 3, name: 'alpha-utils' },
    ])
    const app = makeConformanceApp(db)
    const ws = (await app.createWorkspace({ seed: false })) as WorkspaceSnapshot

    const res = await app.call<GitHubAvailableRepo[]>(
      'GET',
      `/workspaces/${ws.workspace.id}/github/available-repos?q=alpha`,
    )

    expect(res.status).toBe(200)
    expect(res.body.map((r) => r.name).sort()).toEqual(['alpha', 'alpha-utils'])
    // A PAT can't scope GitHub's global repo search, so the picker filters the PAT's own
    // `/user/repos` listing — never `/search/repositories`.
    expect(calls.some((u) => u.includes('/user/repos'))).toBe(true)
    expect(calls.some((u) => u.includes('/search/repositories'))).toBe(false)
  })
})

// The credential check, driven through the container a local deployment actually BUILDS rather
// than one a test assembles.
//
// That distinction is the whole reason these live here. The check reads two things off the
// container, and a unit test supplying its own container proves only that the module reads the
// names it was handed: it shipped reading a repository the real container never carried, so the
// probe list was empty on every deployment, every fine-grained token reported `unknown`, and no
// test could fail. Reaching the seam through `buildLocalContainer` is what makes "wired" part of
// the claim, on the deployment shape where a PAT is the operational credential.
describe('[local] PAT credential check', () => {
  let db: DrizzleDb

  beforeAll(async () => {
    db = await setupTestDb()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * GitHub for a PAT deployment: the account probe, the repo listing the picker reads, and a
   * per-repository read. `repos` overrides the answer per `owner/name`; `'denied'` produces the
   * 404 GitHub returns for a repository a credential may not see. Unnamed repositories answer
   * pushable, because LINKING one syncs it and a fixture that 404s there fails its own setup.
   */
  function stubGitHub(options: {
    /** `undefined` sends NO scope header, which is how GitHub reports a fine-grained token. */
    scopes?: string
    repos?: Record<string, { push?: boolean } | 'denied'>
  }) {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ id: 42, login: 'octocat', type: 'User' }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            ...(options.scopes === undefined ? {} : { 'x-oauth-scopes': options.scopes }),
          },
        })
      }
      if (url.includes('/user/repos')) {
        return json([
          {
            id: 1,
            name: 'alpha',
            private: false,
            default_branch: 'main',
            owner: { login: 'octocat' },
          },
        ])
      }
      // Linking a repo syncs its branches/pulls/issues/commits; empty is enough, and answering
      // keeps the fixture's own setup out of the error log.
      const path = url.split('/repos/')[1] ?? ''
      const [owner, name, ...rest] = path.split('?')[0]!.split('/')
      if (rest.length > 0) return json([])
      const answer = options.repos?.[`${owner}/${name}`]
      if (answer === 'denied') return json({ message: 'Not Found' }, 404)
      return json({
        id: 1,
        name,
        owner: { login: owner },
        permissions: { push: answer?.push ?? true },
      })
    })
    return calls
  }

  /** A board with one service frame targeting `octocat/alpha`, the state a run needs. */
  async function boardTargetingAlpha() {
    const app = makeConformanceApp(db)
    const ws = (await app.createWorkspace({ seed: false })) as WorkspaceSnapshot
    const workspaceId = ws.workspace.id
    const linked = await app.call('PUT', `/workspaces/${workspaceId}/github/repos`, {
      repoGithubIds: [1],
    })
    expect(linked.status).toBe(200)
    const frame = await app.call('POST', `/workspaces/${workspaceId}/blocks/from-repo`, {
      repoGithubId: 1,
    })
    expect(frame.status).toBe(201)
    return { app, workspaceId }
  }

  // The deployment PAT lacking `repo` is the failure this whole surface exists to catch, and the
  // report has to name whose credential it is: in local mode that is the operator's, not the
  // signed-in user's, and the two have different remedies.
  it('reports the deployment token as under-scoped once a service targets a repo', async () => {
    stubGitHub({ scopes: 'read:user' })
    const { app, workspaceId } = await boardTargetingAlpha()

    const res = await app.call<GitHubPatCheck>('GET', `/workspaces/${workspaceId}/github/pat-check`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      state: 'checked',
      report: { source: 'deployment', kind: 'classic', capabilities: { push: 'missing' } },
    })
  })

  // The wiring assertion the unit test structurally cannot make: the probe list comes off the
  // real container, so a repository actually gets read, and it is the one a service targets.
  it('probes the repository the board’s service targets', async () => {
    const calls = stubGitHub({ scopes: undefined, repos: { 'octocat/alpha': { push: true } } })
    const { app, workspaceId } = await boardTargetingAlpha()
    calls.length = 0

    const res = await app.call<GitHubPatCheck>('GET', `/workspaces/${workspaceId}/github/pat-check`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ state: 'checked', report: { probedRepos: ['octocat/alpha'] } })
    expect(calls.some((u) => u.endsWith('/repos/octocat/alpha'))).toBe(true)
  })

  // A repository the connection can SEE is not one a run can target: only a service frame's
  // link makes it reachable, and until one exists no run starts that would present the token.
  // Linking without a frame is the state that separates the projection from the run-target set,
  // which is what the check now reads.
  it('answers not_applicable, and calls nothing, while no service targets the linked repo', async () => {
    const calls = stubGitHub({ scopes: 'read:user' })
    const app = makeConformanceApp(db)
    const ws = (await app.createWorkspace({ seed: false })) as WorkspaceSnapshot
    const linked = await app.call('PUT', `/workspaces/${ws.workspace.id}/github/repos`, {
      repoGithubIds: [1],
    })
    expect(linked.status).toBe(200)
    calls.length = 0

    const res = await app.call<GitHubPatCheck>(
      'GET',
      `/workspaces/${ws.workspace.id}/github/pat-check`,
    )

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ state: 'not_applicable' })
    expect(calls).toEqual([])
  })
})
