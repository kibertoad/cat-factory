import { getGitHubPatCheckContract, type GitHubPatCheck } from '@cat-factory/contracts'
import { requestByContract } from '@toad-contracts/hono'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { handleError } from '../src/http/errorHandler.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { githubController } from '../src/modules/github/GitHubController.js'

// What the CONTROLLER decides about the credential check, as opposed to what the probe decides
// (that is `githubPatCapability.test.ts`, in integrations): WHICH token gets judged, and WHETHER
// one is judged at all.
//
// Both rules are load-bearing. A run authenticates as its initiator's own token only when the
// workspace permits it, so the check asks the same shared resolver the dispatch mint and the
// engine's GitHub client ask — otherwise a workspace that turned the preference off is nagged
// about a credential none of its runs touch, and a hosted deployment on a GitHub App is told
// something about a token it never uses. And a token is judged only where a run would present
// it, which is what the run-target read decides: a board whose services target no GitHub
// repository reaches GitHub nowhere.
//
// This file builds its OWN container, so it can assert what the module DECIDES and nothing about
// what a facade WIRES. That gap is not theoretical — the read below replaced a field no facade
// ever attached — so the wiring claim is made where it can be: `runtimes/local/test/github-pat`
// drives the same endpoint through a container `buildLocalContainer` actually produced.

const CLASSIC_OK = new Response('{}', {
  status: 200,
  headers: { 'x-oauth-scopes': 'repo, workflow' },
})

function makeApp(
  options: {
    /** What the shared run-path resolver answers; omitted ⇒ no per-user secret store wired. */
    initiatorToken?: string | null
    resolveRunInitiatorToken?: ReturnType<typeof vi.fn>
    /** The deployment's own configured token (local mode); omitted ⇒ a GitHub App deployment. */
    configuredToken?: string
    /** What the board's services target; omitted ⇒ one GitHub repo, so a token IS judged. */
    runRepos?: { owner: string; name: string; provider?: 'github' | 'gitlab' }[]
    fetch?: typeof fetch
    /** Omit the signed-in user, as an auth-off deployment would. */
    anonymous?: boolean
  } = {},
) {
  const doFetch =
    options.fetch ?? (vi.fn(() => Promise.resolve(CLASSIC_OK.clone())) as unknown as typeof fetch)
  vi.stubGlobal('fetch', doFetch)

  const resolveRunInitiatorToken =
    options.resolveRunInitiatorToken ??
    (options.initiatorToken !== undefined
      ? vi.fn(() => Promise.resolve(options.initiatorToken ?? null))
      : undefined)

  const container = {
    config: { github: { apiBase: 'https://api.github.com', enabled: false } },
    ...(resolveRunInitiatorToken ? { resolveRunInitiatorToken } : {}),
    ...(options.configuredToken
      ? { vcsIdentity: { github: { configuredToken: () => options.configuredToken } } }
      : {}),
    listWorkspaceRunRepos: () =>
      Promise.resolve(options.runRepos ?? [{ owner: 'acme', name: 'api', provider: 'github' }]),
    vcsWebUrls: { github: 'https://github.com' },
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', container)
    if (!options.anonymous) {
      c.set('user', {
        id: 'usr_1',
        login: 'ada',
        name: null,
        avatarUrl: null,
        aud: 'session',
        exp: 0,
        gen: 0,
      })
    }
    // The gate has already resolved access by the time a controller runs; the check reads no
    // permission of its own (a member must see a verdict about their OWN token).
    c.set('workspaceAccess', { role: 'member', permissions: [] } as never)
    await next()
  })
  app.route('/workspaces/:workspaceId', githubController())
  app.onError(handleError)
  return { app, container, resolveRunInitiatorToken, doFetch }
}

async function check(app: Hono<AppEnv>): Promise<GitHubPatCheck> {
  const res = await requestByContract(app, getGitHubPatCheckContract, {
    pathPrefix: '/workspaces/ws_1',
  })
  expect(res.status).toBe(200)
  return (await res.json()) as GitHubPatCheck
}

describe('GET /workspaces/:workspaceId/github/pat-check', () => {
  // The answer for a hosted GitHub-App deployment. A 404/503 would make the SPA branch on the
  // deployment shape before it could ask; `not_applicable` lets it make one unconditional call.
  it('answers not_applicable when no personal access token is in play', async () => {
    const { app } = makeApp()
    expect(await check(app)).toEqual({ state: 'not_applicable' })
  })

  it('judges the initiator token when the workspace permits it', async () => {
    const { app, resolveRunInitiatorToken } = makeApp({ initiatorToken: 'ghp_mine' })
    expect(await check(app)).toMatchObject({ state: 'checked', report: { source: 'initiator' } })
    expect(resolveRunInitiatorToken).toHaveBeenCalledWith({
      workspaceId: 'ws_1',
      initiatedBy: 'usr_1',
    })
  })

  // The whole reason the shared resolver is asked rather than the secret store directly: on an
  // opted-out workspace a member's token is not what their runs use.
  it('falls through to the deployment credential when the workspace opted out', async () => {
    const { app } = makeApp({ initiatorToken: null, configuredToken: 'ghp_deployment' })
    expect(await check(app)).toMatchObject({ state: 'checked', report: { source: 'deployment' } })
  })

  it('judges the deployment credential when no secret store is wired at all', async () => {
    const { app } = makeApp({ configuredToken: 'ghp_deployment' })
    expect(await check(app)).toMatchObject({ state: 'checked', report: { source: 'deployment' } })
  })

  it('judges the deployment credential for an anonymous caller', async () => {
    const { app } = makeApp({
      anonymous: true,
      initiatorToken: 'ghp_mine',
      configuredToken: 'ghp_deployment',
    })
    expect(await check(app)).toMatchObject({ state: 'checked', report: { source: 'deployment' } })
  })

  // An unreadable secret store is exactly the condition under which the run path also falls back,
  // so mirroring it keeps this answering about the token a run would actually use.
  it('falls back to the deployment credential when the initiator lookup throws', async () => {
    const { app } = makeApp({
      resolveRunInitiatorToken: vi.fn(() => Promise.reject(new Error('decrypt failed'))),
      configuredToken: 'ghp_deployment',
    })
    expect(await check(app)).toMatchObject({ state: 'checked', report: { source: 'deployment' } })
  })

  it('probes only the GitHub repositories a board’s services target', async () => {
    const seen: string[] = []
    const { app } = makeApp({
      initiatorToken: 'github_pat_11FINE',
      runRepos: [
        { owner: 'acme', name: 'api', provider: 'github' },
        { owner: 'acme', name: 'legacy', provider: 'gitlab' },
      ],
      fetch: (async (url: string | URL) => {
        const path = String(url)
        if (path.endsWith('/user')) return new Response('{}', { status: 200 })
        seen.push(path)
        return new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 })
      }) as unknown as typeof fetch,
    })

    const result = await check(app)
    expect(result).toMatchObject({ state: 'checked', report: { probedRepos: ['acme/api'] } })
    // The GitLab row is reachable through a different token on a different host; asking GitHub
    // about it would produce a 404 the fold now reads as a repository the token was denied.
    expect(seen).toEqual(['https://api.github.com/repos/acme/api'])
  })

  // The provider gate, and the reason it sits in front of the CLASSIC path too: a classic
  // token's scopes are readable with no repository at all, so a GitLab-bound board rendered a
  // blocking verdict about a credential its runs could never present. Nothing here contradicts
  // that verdict once it exists, which is what made it the loudest possible wrong answer.
  it('judges nothing on a board whose services target only GitLab', async () => {
    const { app, doFetch } = makeApp({
      initiatorToken: 'ghp_mine',
      runRepos: [{ owner: 'acme', name: 'legacy', provider: 'gitlab' }],
    })
    expect(await check(app)).toEqual({ state: 'not_applicable' })
    expect(vi.mocked(doFetch)).not.toHaveBeenCalled()
  })

  // Same rule, the not-yet-linked case: no service targets a repository, so no run starts that
  // would authenticate, and the outbound call is pure cost.
  it('judges nothing before a service is linked to a repository', async () => {
    const { app, doFetch } = makeApp({ initiatorToken: 'ghp_mine', runRepos: [] })
    expect(await check(app)).toEqual({ state: 'not_applicable' })
    expect(vi.mocked(doFetch)).not.toHaveBeenCalled()
  })
})
