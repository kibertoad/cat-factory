import { describe, expect, it } from 'vitest'
import { vcsWebBaseUrl } from './vcs-web-urls.js'

// The web host is INVERTED from the REST base every deployment already configures. What matters
// is which bases invert and which honestly cannot: a base that yields a wrong-but-plausible host
// sends a user to somebody else's namespace on the provider's public instance, so anything the
// rule does not recognise must answer null rather than a best guess.

describe('vcsWebBaseUrl', () => {
  it('maps github.com’s API host to its web host', () => {
    expect(vcsWebBaseUrl('github', 'https://api.github.com')).toBe('https://github.com')
    expect(vcsWebBaseUrl('github', 'https://api.github.com/')).toBe('https://github.com')
  })

  it('strips GitHub Enterprise Server’s REST suffix', () => {
    expect(vcsWebBaseUrl('github', 'https://ghe.acme.dev/api/v3')).toBe('https://ghe.acme.dev')
  })

  it('strips GitLab’s REST suffix, on the public and a self-managed instance', () => {
    expect(vcsWebBaseUrl('gitlab', 'https://gitlab.com/api/v4')).toBe('https://gitlab.com')
    expect(vcsWebBaseUrl('gitlab', 'https://gitlab.acme.dev/api/v4')).toBe(
      'https://gitlab.acme.dev',
    )
  })

  // A GitLab served from a subdirectory answers its API under that same prefix, so stripping only
  // the suffix (rather than discarding the path) is what keeps the link inside the install.
  it('keeps a relative-URL install’s own root', () => {
    expect(vcsWebBaseUrl('gitlab', 'https://acme.dev/gitlab/api/v4')).toBe(
      'https://acme.dev/gitlab',
    )
  })

  it('preserves a non-default port and an http scheme', () => {
    expect(vcsWebBaseUrl('gitlab', 'http://gitlab.internal:8080/api/v4')).toBe(
      'http://gitlab.internal:8080',
    )
  })

  // Each provider states its OWN rule: GitHub's alias must not rescue a GitLab base, and one
  // provider's REST suffix is not another's.
  it('does not apply one provider’s rule to another', () => {
    expect(vcsWebBaseUrl('gitlab', 'https://api.github.com')).toBeNull()
    expect(vcsWebBaseUrl('github', 'https://gitlab.acme.dev/api/v4')).toBeNull()
  })

  it('answers null for a base whose shape it cannot invert', () => {
    // A bare host: plausibly the web host, but nothing says so, and being wrong is silent.
    expect(vcsWebBaseUrl('gitlab', 'https://gitlab.acme.dev')).toBeNull()
    expect(vcsWebBaseUrl('gitlab', 'https://acme.dev/proxy/gitlab-rest')).toBeNull()
    expect(vcsWebBaseUrl('github', 'not-a-url')).toBeNull()
    expect(vcsWebBaseUrl('github', '')).toBeNull()
  })
})
