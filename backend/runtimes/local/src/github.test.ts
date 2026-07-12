import { describe, expect, it } from 'vitest'
import {
  classifyPatProbe,
  describePatProbeVerdict,
  githubPatCreationUrl,
  gitlabVcsHost,
  harnessAllowedHosts,
  probeGitHubPat,
  StaticTokenAppRegistry,
} from './github.js'

// NOTE: the PAT-authenticated client behaviour (Bearer auth, merge, mergeability, CI reads)
// is asserted for BOTH GitHub and GitLab in the cross-provider `vcs-conformance.test.ts`.
// This file keeps only the GitHub-specific units (the static app registry + the PAT URL).

describe('StaticTokenAppRegistry', () => {
  it('returns the PAT for installation tokens and rejects app-JWT use', async () => {
    const reg = new StaticTokenAppRegistry('pat_abc')
    expect(reg.defaultAppId).toBe('')
    expect(reg.apps()).toEqual([{ appId: '' }])
    await expect(reg.installationToken()).resolves.toBe('pat_abc')
    await expect(reg.authForApp().appJwt()).rejects.toThrow(/not available in local/)
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

  it('does NOT false-warn on a fine-grained token (no reported scopes)', () => {
    expect(classifyPatProbe({ status: 200, scopesHeader: null })).toEqual({ ok: true })
    expect(classifyPatProbe({ status: 200, scopesHeader: '' })).toEqual({ ok: true })
  })
})

describe('probeGitHubPat (A12)', () => {
  it('returns undefined when no GITHUB_PAT is set (nothing to probe)', async () => {
    await expect(probeGitHubPat({})).resolves.toBeUndefined()
  })

  it('probes GET /user with the PAT and classifies the response', async () => {
    let requested = ''
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      requested = typeof input === 'string' ? input : input.toString()
      return new Response('{}', { status: 200, headers: { 'x-oauth-scopes': 'repo, workflow' } })
    }) as typeof fetch
    await expect(probeGitHubPat({ GITHUB_PAT: 'ghp_x' }, { fetchImpl })).resolves.toEqual({
      ok: true,
    })
    expect(requested).toBe('https://api.github.com/user')
  })

  it('stays silent (undefined) on a network error — never blocks boot', async () => {
    const fetchImpl = (async () => {
      throw new Error('ENOTFOUND')
    }) as typeof fetch
    await expect(probeGitHubPat({ GITHUB_PAT: 'ghp_x' }, { fetchImpl })).resolves.toBeUndefined()
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

describe('gitlabVcsHost', () => {
  it('returns undefined in GitHub mode (no GITLAB_PAT)', () => {
    expect(gitlabVcsHost({})).toBeUndefined()
    expect(gitlabVcsHost({ GITHUB_PAT: 'ghp_x' })).toBeUndefined()
  })

  it('defaults to gitlab.com when only GITLAB_PAT is set', () => {
    expect(gitlabVcsHost({ GITLAB_PAT: 'glpat_x' })).toBe('gitlab.com')
  })

  it('derives the host from GITLAB_API_BASE for a self-managed instance', () => {
    expect(
      gitlabVcsHost({ GITLAB_PAT: 'glpat_x', GITLAB_API_BASE: 'https://git.acme.com/api/v4' }),
    ).toBe('git.acme.com')
  })

  it('falls back to gitlab.com on an unparseable GITLAB_API_BASE', () => {
    expect(gitlabVcsHost({ GITLAB_PAT: 'glpat_x', GITLAB_API_BASE: 'not a url' })).toBe(
      'gitlab.com',
    )
  })
})

describe('harnessAllowedHosts', () => {
  it('is undefined in GitHub mode with no extra hosts (harness keeps its github.com default)', () => {
    expect(harnessAllowedHosts({})).toBeUndefined()
  })

  it('adds the GitLab host so the harness will not reject a GitLab clone URL', () => {
    expect(harnessAllowedHosts({ GITLAB_PAT: 'glpat_x' })).toBe('gitlab.com')
    expect(
      harnessAllowedHosts({
        GITLAB_PAT: 'glpat_x',
        GITLAB_API_BASE: 'https://git.acme.com/api/v4',
      }),
    ).toBe('git.acme.com')
  })

  it('merges operator-set GITHUB_ALLOWED_HOSTS with the GitLab host (deduped)', () => {
    const out = harnessAllowedHosts({
      GITLAB_PAT: 'glpat_x',
      GITHUB_ALLOWED_HOSTS: 'gitlab.com, ghe.internal',
    })
    expect(out?.split(',').sort()).toEqual(['ghe.internal', 'gitlab.com'])
  })
})
