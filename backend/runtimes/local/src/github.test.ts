import { describe, expect, it } from 'vitest'
import { createRecordingLogger } from '@cat-factory/kernel'
import {
  classifyPatProbe,
  describePatProbeVerdict,
  githubPatCreationUrl,
  LocalPatAppTokenSource,
  probeGitHubPat,
  warnOnGitHubPatProblemInBackground,
} from './github.js'

/** Flush pending microtasks so a fire-and-forget background chain settles before we assert. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

// NOTE: the PAT-authenticated client behaviour (Bearer auth, merge, mergeability, CI reads)
// is asserted for BOTH GitHub and GitLab in the cross-provider `vcs-conformance.test.ts`.
// This file keeps only the GitHub-specific units (the app token source + the PAT URL); the
// credential source itself (env-vs-store precedence, install, the derived hosts) has its own.

describe('LocalPatAppTokenSource', () => {
  it('returns the PAT for installation tokens and rejects app-JWT use', async () => {
    const reg = new LocalPatAppTokenSource(() => 'pat_abc')
    expect(reg.defaultAppId).toBe('')
    expect(reg.apps()).toEqual([{ appId: '' }])
    await expect(reg.installationToken()).resolves.toBe('pat_abc')
    await expect(reg.authForApp().appJwt()).rejects.toThrow(/not available in local/)
  })

  it('reads the token per call, so one installed later is used without a rebuild', async () => {
    let token: string | undefined
    const reg = new LocalPatAppTokenSource(() => token)
    await expect(reg.installationToken()).rejects.toThrow(/no source-control token yet/)
    token = 'pat_installed'
    await expect(reg.installationToken()).resolves.toBe('pat_installed')
  })
})

describe('githubPatCreationUrl', () => {
  it('points at the classic-token form with the local-mode scopes pre-selected', () => {
    const url = new URL(githubPatCreationUrl())
    expect(url.origin + url.pathname).toBe('https://github.com/settings/tokens/new')
    expect(url.searchParams.get('scopes')).toBe('repo,workflow')
    expect(url.searchParams.get('description')).toBe('cat-factory local mode')
  })
})

// A12: the boot-time PAT probe. The classification is pure; probeGitHubPat is exercised with an
// injected fetch so no network or real token is needed.
describe('classifyPatProbe (A12)', () => {
  it('flags an invalid/expired token on 401', () => {
    expect(classifyPatProbe({ status: 401, scopesHeader: null })).toEqual({
      ok: false,
      reason: 'invalid',
      detail: expect.stringContaining('401'),
    })
  })

  it('flags a rejected token on 403', () => {
    expect(classifyPatProbe({ status: 403, scopesHeader: null })).toMatchObject({
      ok: false,
      reason: 'forbidden',
    })
  })

  it('accepts a classic token that carries both required scopes', () => {
    expect(classifyPatProbe({ status: 200, scopesHeader: 'repo, workflow, read:org' })).toEqual({
      ok: true,
    })
  })

  it('flags an under-scoped classic token, naming the missing scope', () => {
    expect(classifyPatProbe({ status: 200, scopesHeader: 'repo' })).toEqual({
      ok: false,
      reason: 'underscoped',
      missing: ['workflow'],
    })
  })

  it('does NOT false-warn on a fine-grained token (no scope header at all)', () => {
    expect(classifyPatProbe({ status: 200, scopesHeader: null })).toEqual({ ok: true })
  })

  // GitHub sends the header for every CLASSIC token, so an empty value is a positive statement
  // that this one grants nothing — not the fine-grained token's silence. Passing it as `ok`
  // sent the operator's most easily made mistake (GitHub's form ticks nothing by default)
  // straight past the boot warning that exists to catch it.
  it('flags a classic token with an empty scope header as missing everything', () => {
    expect(classifyPatProbe({ status: 200, scopesHeader: '' })).toEqual({
      ok: false,
      reason: 'underscoped',
      missing: ['repo', 'workflow'],
    })
  })
})

describe('probeGitHubPat (A12)', () => {
  it('returns undefined when the deployment has no token (nothing to probe)', async () => {
    await expect(probeGitHubPat({}, undefined)).resolves.toBeUndefined()
  })

  it('probes GET /user with the PAT and classifies the response', async () => {
    let requested = ''
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      requested = typeof input === 'string' ? input : input.toString()
      return new Response('{}', { status: 200, headers: { 'x-oauth-scopes': 'repo, workflow' } })
    }) as typeof fetch
    await expect(probeGitHubPat({}, 'ghp_x', { fetchImpl })).resolves.toEqual({
      ok: true,
    })
    expect(requested).toBe('https://api.github.com/user')
  })

  it('stays silent (undefined) on a network error — never blocks boot', async () => {
    const fetchImpl = (async () => {
      throw new Error('ENOTFOUND')
    }) as typeof fetch
    await expect(probeGitHubPat({}, 'ghp_x', { fetchImpl })).resolves.toBeUndefined()
  })
})

describe('describePatProbeVerdict (A12)', () => {
  it('is undefined when the token is fine', () => {
    expect(describePatProbeVerdict({ ok: true })).toBeUndefined()
  })

  it('names the missing scopes and links the pre-scoped creation URL', () => {
    const msg = describePatProbeVerdict({ ok: false, reason: 'underscoped', missing: ['workflow'] })
    expect(msg).toMatch(/missing required scope\(s\) workflow/)
    expect(msg).toContain(githubPatCreationUrl())
  })

  it('reports a rejected token with its detail', () => {
    const msg = describePatProbeVerdict({ ok: false, reason: 'invalid', detail: 'HTTP 401 — bad' })
    expect(msg).toMatch(/rejected by GitHub/)
    expect(msg).toContain('HTTP 401')
  })
})

describe('warnOnGitHubPatProblemInBackground (app-startup item 6)', () => {
  it('returns immediately without blocking (the github.com probe runs in the background)', () => {
    const log = createRecordingLogger()
    // A fetch that never settles during this synchronous check: the call must STILL return with no
    // warning yet, so boot never stalls on the github.com round-trip.
    const fetchImpl = (() => new Promise<Response>(() => {})) as typeof fetch
    warnOnGitHubPatProblemInBackground({}, 'ghp_x', log, { fetchImpl })
    expect(log.lines).toEqual([])
  })

  it('warns once the deferred probe reports an under-scoped token', async () => {
    const log = createRecordingLogger()
    const fetchImpl = (async () =>
      new Response('{}', { status: 200, headers: { 'x-oauth-scopes': 'repo' } })) as typeof fetch
    warnOnGitHubPatProblemInBackground({}, 'ghp_x', log, { fetchImpl })
    await flush()
    expect(log.lines).toHaveLength(1)
    expect(log.lines[0]?.msg).toMatch(/missing required scope\(s\) workflow/)
  })

  it('stays silent for a healthy token and swallows a network error (never throws)', async () => {
    const log = createRecordingLogger()
    const healthy = (async () =>
      new Response('{}', {
        status: 200,
        headers: { 'x-oauth-scopes': 'repo, workflow' },
      })) as typeof fetch
    warnOnGitHubPatProblemInBackground({}, 'ghp_x', log, {
      fetchImpl: healthy,
    })
    // A network error → probeGitHubPat returns undefined → treated as ok → no warning, no throw.
    const boom = (async () => {
      throw new Error('ENOTFOUND')
    }) as typeof fetch
    warnOnGitHubPatProblemInBackground({}, 'ghp_x', log, {
      fetchImpl: boom,
    })
    await flush()
    expect(log.lines).toEqual([])
  })
})
