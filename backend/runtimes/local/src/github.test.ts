import { describe, expect, it } from 'vitest'
import {
  githubPatCreationUrl,
  gitlabVcsHost,
  harnessAllowedHosts,
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
