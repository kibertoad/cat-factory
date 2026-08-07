import { describe, expect, it } from 'vitest'
import type { AppConfig } from './types.js'
import { resolveVcsWebUrls } from './vcsWebUrls.js'

// ONE derivation for every facade. What it must get right is which providers appear at all: a
// missing entry is rendered as a withheld link, so reporting one for a provider whose base did
// not invert would put a link to the wrong instance on the board, and omitting one for a
// provider that IS connected takes a working link away.

const config = (github: string, gitlab: string) =>
  ({
    github: { enabled: false, apiBase: github },
    gitlab: { enabled: false, apiBase: gitlab },
  }) as AppConfig

const GITLAB_PUBLIC = 'https://gitlab.com/api/v4'

describe('resolveVcsWebUrls', () => {
  it('resolves each provider from its REST base', () => {
    expect(
      resolveVcsWebUrls(config('https://api.github.com', 'https://gitlab.acme.dev/api/v4')),
    ).toEqual({ github: 'https://github.com', gitlab: 'https://gitlab.acme.dev' })
  })

  // Both `enabled` flags are false in every case here, and both hosts still resolve. Local mode
  // connects with a PAT and no App / no `GITLAB_TOKEN`, so gating on either flag would silently
  // strip every repo, pull/merge request and issue link on precisely that deployment.
  it('resolves a provider the deployment has not opted into', () => {
    expect(resolveVcsWebUrls(config('https://api.github.com', GITLAB_PUBLIC))).toEqual({
      github: 'https://github.com',
      gitlab: 'https://gitlab.com',
    })
  })

  it('omits a provider whose base does not name a host', () => {
    expect(
      resolveVcsWebUrls(config('https://acme.dev/gh-proxy', 'https://acme.dev/gl-proxy')),
    ).toEqual({})
  })

  // The two providers withhold independently: a proxied GitLab base must not cost the GitHub
  // link, and vice versa.
  it('withholds only the provider that did not invert', () => {
    expect(
      resolveVcsWebUrls(config('https://api.github.com', 'https://acme.dev/gl-proxy')),
    ).toEqual({
      github: 'https://github.com',
    })
    expect(resolveVcsWebUrls(config('https://acme.dev/gh-proxy', GITLAB_PUBLIC))).toEqual({
      gitlab: 'https://gitlab.com',
    })
  })
})
