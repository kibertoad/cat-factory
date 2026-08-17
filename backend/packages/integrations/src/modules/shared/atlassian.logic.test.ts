import { describe, expect, it } from 'vitest'
import { assertSafeAtlassianBaseUrl, normalizeAtlassianBaseUrl } from './atlassian.logic.js'
import { ValidationError } from '@cat-factory/kernel'

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
      '127.1', // the short dotted form
      '0x7f000001', // one hex integer
      '2852039166', // 169.254.169.254 as an integer
      '0251.0376.0251.0376', // octal octets
      '[::ffff:169.254.169.254]', // IMDS through a mapped literal
      '[0:0:0:0:0:0:0:1]', // loopback, expanded
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

  it('reads the authority the way `fetch` will, not the way a regex would', () => {
    // Every one of these is a URL whose REAL host is internal while an authority picked out by
    // pattern reads as a long, innocent, public-looking name. A backslash ends the authority for
    // the URL parser, so the first two are dialled at 10.0.0.5 and 127.0.0.1; the third is
    // userinfo, so it is dialled at the metadata endpoint. Validating the same parse the request
    // uses is what makes the whole class unrepresentable.
    for (const url of [
      'https://10.0.0.5\\.acme.atlassian.net/wiki',
      'https://127.0.0.1\\@acme.atlassian.net',
      'https://acme.atlassian.net@169.254.169.254/',
    ]) {
      expect(() => assertSafeAtlassianBaseUrl(url), url).toThrow(ValidationError)
    }
  })

  it('refuses a host whose only disguise is the DNS root dot', () => {
    expect(() => assertSafeAtlassianBaseUrl('https://localhost./wiki')).toThrow(
      /must be a public host/,
    )
    expect(() => assertSafeAtlassianBaseUrl('https://127.0.0.1./wiki')).toThrow(
      /must be a public host/,
    )
  })

  it('accepts a site whose name merely starts like a private IPv6 prefix', () => {
    // `fc00::/7` is a rule about addresses. Applied to text it refuses a customer's own site.
    expect(() => assertSafeAtlassianBaseUrl('https://fdgroup.atlassian.net')).not.toThrow()
    expect(() => assertSafeAtlassianBaseUrl('https://fcbarcelona.atlassian.net')).not.toThrow()
  })
})
