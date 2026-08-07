import { describe, expect, it } from 'vitest'
import type { AppConfig } from './types.js'
import { resolveVcsWebUrls } from './vcsWebUrls.js'

// ONE derivation for both facades. What it must get right is which providers appear at all: a
// missing entry is rendered as a withheld link, so reporting one for a provider whose base did
// not invert would put a link to the wrong instance on the board, and omitting one for a
// provider that IS connected takes a working link away.

const config = (github: string, gitlab?: string) =>
  ({
    github: { enabled: false, apiBase: github },
    ...(gitlab ? { gitlab: { enabled: true, apiBase: gitlab } } : {}),
  }) as AppConfig

describe('resolveVcsWebUrls', () => {
  it('resolves each configured provider from its REST base', () => {
    expect(
      resolveVcsWebUrls(config('https://api.github.com', 'https://gitlab.acme.dev/api/v4')),
    ).toEqual({ github: 'https://github.com', gitlab: 'https://gitlab.acme.dev' })
  })

  // Local mode connects GitHub with a PAT and no App, so `enabled` is false while the workspace
  // holds a real GitHub connection. Gating on it would silently strip every repo link there.
  it('resolves GitHub even when no App is configured', () => {
    expect(resolveVcsWebUrls(config('https://api.github.com')).github).toBe('https://github.com')
  })

  it('omits a provider whose base does not name a host', () => {
    expect(resolveVcsWebUrls(config('https://acme.dev/gh-proxy'))).toEqual({})
  })

  it('omits GitLab entirely when the deployment configures none', () => {
    expect(resolveVcsWebUrls(config('https://api.github.com')).gitlab).toBeUndefined()
  })
})
