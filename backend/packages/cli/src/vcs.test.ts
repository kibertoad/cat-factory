import { describe, expect, it } from 'vitest'
import {
  githubPatCreationUrl,
  gitlabPatCreationUrl,
  patCreationUrl,
  patEnvVar,
  providerLabel,
} from './vcs.js'

describe('githubPatCreationUrl', () => {
  it('points at the classic-token form with the local-mode scopes pre-selected', () => {
    const url = new URL(githubPatCreationUrl())
    expect(url.origin + url.pathname).toBe('https://github.com/settings/tokens/new')
    expect(url.searchParams.get('scopes')).toBe('repo,workflow')
    expect(url.searchParams.get('description')).toBe('cat-factory local mode')
  })
})

describe('gitlabPatCreationUrl', () => {
  it('points at the PAT form with the api scope pre-selected', () => {
    const url = new URL(gitlabPatCreationUrl())
    expect(url.origin + url.pathname).toBe(
      'https://gitlab.com/-/user_settings/personal_access_tokens',
    )
    expect(url.searchParams.get('scopes[]')).toBe('api')
    expect(url.searchParams.get('name')).toBe('cat-factory local mode')
  })
})

describe('provider helpers', () => {
  it('maps each provider to its url, env var and label', () => {
    expect(patCreationUrl('github')).toContain('github.com')
    expect(patCreationUrl('gitlab')).toContain('gitlab.com')
    expect(patEnvVar('github')).toBe('GITHUB_PAT')
    expect(patEnvVar('gitlab')).toBe('GITLAB_PAT')
    expect(providerLabel('github')).toBe('GitHub')
    expect(providerLabel('gitlab')).toBe('GitLab')
  })
})
