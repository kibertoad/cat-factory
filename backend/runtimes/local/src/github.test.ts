import { describe, expect, it } from 'vitest'
import { githubPatCreationUrl, StaticTokenAppRegistry } from './github.js'

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
