import { describe, expect, it } from 'vitest'
import {
  VCS_PROVIDERS,
  githubConnectionRef,
  githubInstallationId,
  isVcsProvider,
} from './vcs-types.js'

// The neutral identity vocabulary every port speaks. `githubConnectionRef` /
// `githubInstallationId` are the ONLY place the GitHub shape of a connection id is known, so
// their round trip is what keeps the GitHub concept from leaking through the neutral surface.

describe('isVcsProvider', () => {
  it('accepts exactly the providers the platform ships an adapter for', () => {
    for (const provider of VCS_PROVIDERS) expect(isVcsProvider(provider)).toBe(true)
    expect(VCS_PROVIDERS.length).toBeGreaterThan(0)
  })

  it('rejects an unknown name and any non-string', () => {
    expect(isVcsProvider('bitbucket')).toBe(false)
    expect(isVcsProvider('GitHub')).toBe(false)
    expect(isVcsProvider('')).toBe(false)
    expect(isVcsProvider(undefined)).toBe(false)
    expect(isVcsProvider(null)).toBe(false)
    expect(isVcsProvider(1)).toBe(false)
    expect(isVcsProvider(['github'])).toBe(false)
  })
})

describe('the GitHub installation-id mapping', () => {
  it('round-trips an installation id through the neutral ref', () => {
    const ref = githubConnectionRef(42)
    expect(ref).toEqual({ provider: 'github', connectionId: '42' })
    expect(githubInstallationId(ref)).toBe(42)
  })

  it('refuses to read a GitHub installation id off another provider’s connection', () => {
    // A wiring bug, not a user error: answering with a plausible number would point a GitHub
    // call at a GitLab connection's row id.
    expect(() => githubInstallationId({ provider: 'gitlab', connectionId: '42' })).toThrow(
      /github connection/,
    )
  })

  it('refuses an id that is not a whole number', () => {
    expect(() => githubInstallationId({ provider: 'github', connectionId: 'abc' })).toThrow(
      /Invalid github installation id/,
    )
    expect(() => githubInstallationId({ provider: 'github', connectionId: '4.5' })).toThrow(
      /Invalid github installation id/,
    )
  })
})
