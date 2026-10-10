import { describe, expect, it } from 'vitest'
import { assertSafeAtlassianBaseUrl, normalizeAtlassianBaseUrl } from './atlassian.logic.js'
import { ValidationError } from '../domain/errors.js'

// The write-boundary guard on an org-supplied site URL the platform later fetches with the
// workspace's own credentials. It runs BEFORE the URL is stored, so anything it lets through is
// a request the deployment will make from its own network position for as long as the row lives.

describe('normalizeAtlassianBaseUrl', () => {
  it('drops surrounding whitespace and trailing slashes so paths append uniformly', () => {
    expect(normalizeAtlassianBaseUrl('  https://acme.atlassian.net  ')).toBe(
      'https://acme.atlassian.net',
    )
    expect(normalizeAtlassianBaseUrl('https://acme.atlassian.net/')).toBe(
      'https://acme.atlassian.net',
    )
    expect(normalizeAtlassianBaseUrl('https://acme.atlassian.net///')).toBe(
      'https://acme.atlassian.net',
    )
  })

  it('drops a trailing /wiki, whatever its case, and only at the end', () => {
    expect(normalizeAtlassianBaseUrl('https://acme.atlassian.net/wiki')).toBe(
      'https://acme.atlassian.net',
    )
    expect(normalizeAtlassianBaseUrl('https://acme.atlassian.net/WIKI/')).toBe(
      'https://acme.atlassian.net',
    )
    // A `wiki` segment in the middle is part of the site path, not the suffix.
    expect(normalizeAtlassianBaseUrl('https://acme.atlassian.net/wiki/spaces')).toBe(
      'https://acme.atlassian.net/wiki/spaces',
    )
  })

  it('leaves an already-normal URL alone', () => {
    expect(normalizeAtlassianBaseUrl('https://acme.atlassian.net')).toBe(
      'https://acme.atlassian.net',
    )
  })
})

describe('assertSafeAtlassianBaseUrl', () => {
  it('accepts a public https site, port and path included', () => {
    expect(() => assertSafeAtlassianBaseUrl('https://acme.atlassian.net')).not.toThrow()
    expect(() => assertSafeAtlassianBaseUrl('https://acme.atlassian.net:8443/wiki')).not.toThrow()
    expect(() => assertSafeAtlassianBaseUrl('HTTPS://ACME.ATLASSIAN.NET')).not.toThrow()
  })

  it('requires https, so a stored credential is never sent in the clear', () => {
    expect(() => assertSafeAtlassianBaseUrl('http://acme.atlassian.net')).toThrow(/must use https/)
    expect(() => assertSafeAtlassianBaseUrl('ftp://acme.atlassian.net')).toThrow(/must use https/)
  })

  it('refuses embedded credentials in the authority', () => {
    expect(() => assertSafeAtlassianBaseUrl('https://user:pass@acme.atlassian.net')).toThrow(
      /must not contain credentials/,
    )
  })

  it('refuses anything that is not a URL at all', () => {
    for (const bad of ['', 'acme.atlassian.net', '://acme', 'https://', 'https://:8443']) {
      expect(() => assertSafeAtlassianBaseUrl(bad)).toThrow(ValidationError)
    }
    expect(() => assertSafeAtlassianBaseUrl('not a url')).toThrow(/not a valid URL/)
  })

  it('refuses an internal host through every encoding the classifier knows', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '10.0.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '2130706433',
      '0x7f.0.0.1',
      'svc.cluster.internal',
      '[::1]',
    ]) {
      expect(() => assertSafeAtlassianBaseUrl(`https://${host}`)).toThrow(/must be a public host/)
    }
  })

  it('strips the port before classifying, so a private host on any port is still refused', () => {
    expect(() => assertSafeAtlassianBaseUrl('https://127.0.0.1:8443')).toThrow(
      /must be a public host/,
    )
    expect(() => assertSafeAtlassianBaseUrl('https://[::1]:8443')).toThrow(/must be a public host/)
  })

  it('refuses an unterminated IPv6 literal rather than guessing where the host ends', () => {
    expect(() => assertSafeAtlassianBaseUrl('https://[::1:8443')).toThrow(/not a valid URL/)
  })
})
