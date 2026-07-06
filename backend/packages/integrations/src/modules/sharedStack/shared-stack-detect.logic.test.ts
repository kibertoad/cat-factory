import { describe, expect, it } from 'vitest'
import { parseVcsCloneUrl } from './shared-stack-detect.logic.js'

describe('parseVcsCloneUrl', () => {
  it('parses an https GitHub URL with a .git suffix', () => {
    expect(parseVcsCloneUrl('https://github.com/acme/acme-shared-services.git')).toEqual({
      owner: 'acme',
      repo: 'acme-shared-services',
      provider: 'github',
    })
  })

  it('parses an https URL without the .git suffix and with a trailing slash', () => {
    expect(parseVcsCloneUrl('https://github.com/acme/acme-shared-services/')).toEqual({
      owner: 'acme',
      repo: 'acme-shared-services',
      provider: 'github',
    })
  })

  it('derives the provider even when the URL carries an explicit port', () => {
    // Regression: `url.host` includes `:port`, so provider inference must use `url.hostname`.
    expect(parseVcsCloneUrl('https://github.com:443/acme/acme-shared-services.git')).toEqual({
      owner: 'acme',
      repo: 'acme-shared-services',
      provider: 'github',
    })
    expect(parseVcsCloneUrl('ssh://git@github.com:22/acme/acme-shared-services.git')).toEqual({
      owner: 'acme',
      repo: 'acme-shared-services',
      provider: 'github',
    })
  })

  it('parses an scp-like SSH URL', () => {
    expect(parseVcsCloneUrl('git@github.com:acme/acme-shared-services.git')).toEqual({
      owner: 'acme',
      repo: 'acme-shared-services',
      provider: 'github',
    })
  })

  it('derives the gitlab provider and keeps a nested group path as the owner', () => {
    expect(parseVcsCloneUrl('https://gitlab.com/group/subgroup/project.git')).toEqual({
      owner: 'group/subgroup',
      repo: 'project',
      provider: 'gitlab',
    })
  })

  it('omits the provider for an unknown (self-hosted enterprise) host', () => {
    expect(parseVcsCloneUrl('https://git.acme.internal/acme/shared.git')).toEqual({
      owner: 'acme',
      repo: 'shared',
    })
  })

  it('derives gitlab for a self-hosted gitlab host', () => {
    expect(parseVcsCloneUrl('https://gitlab.acme.com/acme/shared.git')).toEqual({
      owner: 'acme',
      repo: 'shared',
      provider: 'gitlab',
    })
  })

  it('returns null when no owner/repo can be recovered', () => {
    expect(parseVcsCloneUrl('https://github.com/acme')).toBeNull()
    expect(parseVcsCloneUrl('not a url')).toBeNull()
    expect(parseVcsCloneUrl('')).toBeNull()
  })
})
