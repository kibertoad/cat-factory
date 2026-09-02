import { describe, expect, it } from 'vitest'
import {
  describeRouteCandidate,
  deriveEnvironmentCoordinates,
  reachabilityNote,
  statedRouteTarget,
} from './environment-reachability.js'

describe('statedRouteTarget', () => {
  it('reads the one thing a candidate names, trimming and lower-casing a host', () => {
    // Read through this rather than off the fields, so the trimming a probe applies and the
    // case-insensitivity DNS applies happen in one place and cannot disagree with themselves.
    expect(statedRouteTarget({ address: ' 10.4.19.22 ' })).toEqual({
      kind: 'address',
      address: '10.4.19.22',
    })
    expect(statedRouteTarget({ host: ' ALB-4.elb.Example ' })).toEqual({
      kind: 'host',
      host: 'alb-4.elb.example',
    })
  })

  it('refuses to GUESS when a candidate names both or neither', () => {
    // Both is two claims with no way to tell which was meant, and neither names nothing at all.
    // Guessing either onto a kind is what would rest the bridge rule on a parse: a resolver handed
    // a non-canonical literal answers loopback happily, where the address rule refuses it.
    expect(statedRouteTarget({ address: '10.4.19.22', host: 'alb.example' })).toEqual({
      kind: 'unusable',
    })
    expect(statedRouteTarget({ label: 'internal ALB' })).toEqual({ kind: 'unusable' })
    expect(statedRouteTarget({ address: '   ' })).toEqual({ kind: 'unusable' })
  })
})

describe('describeRouteCandidate', () => {
  it('marks a NAME as one, so it does not read as an address somebody typed wrong', () => {
    // ONE renderer, because three surfaces print this list and each of them says "addresses".
    expect(describeRouteCandidate({ address: '10.4.19.22', label: 'internal ALB' })).toBe(
      '10.4.19.22 (internal ALB)',
    )
    expect(describeRouteCandidate({ host: 'alb-4.elb.example' })).toBe('alb-4.elb.example (name)')
    expect(describeRouteCandidate({ host: 'alb-4.elb.example', label: 'public ALB' })).toBe(
      'alb-4.elb.example (name, public ALB)',
    )
  })

  it('renders a candidate naming nothing rather than splicing undefined into a prompt', () => {
    expect(describeRouteCandidate({ label: 'internal ALB' })).toBe(
      'an entry stating no usable target (internal ALB)',
    )
    expect(describeRouteCandidate({})).toBe('an entry stating no usable target')
  })
})

describe('deriveEnvironmentCoordinates', () => {
  it('reads the host, the explicit port and the scheme', () => {
    expect(
      deriveEnvironmentCoordinates('https://PR-14.test.example.cloud:8443/health?x=1'),
    ).toEqual({ host: 'pr-14.test.example.cloud', port: 8443, scheme: 'https' })
  })

  it('falls back to the scheme default when the URL states no port', () => {
    // The Tester is always given a concrete port, and the probe always has one to dial.
    expect(deriveEnvironmentCoordinates('https://env.example')?.port).toBe(443)
    expect(deriveEnvironmentCoordinates('http://env.example/deep/path')?.port).toBe(80)
  })

  it('answers a null PORT, never zero, for a scheme with no default it knows', () => {
    // The divergence that made two copies of this a bug rather than a duplication: one returned
    // `0`, which reads as falsy at one call site and as a dialable port at another, and it is what
    // routed a non-http environment URL into a FAILED deploy.
    expect(deriveEnvironmentCoordinates('ftp://env.example')).toEqual({
      host: 'env.example',
      port: null,
      scheme: 'ftp',
    })
  })

  it('separates userinfo from the host on the LAST `@`, since a password may contain one', () => {
    expect(deriveEnvironmentCoordinates('https://user:p@ss@env.example/x')?.host).toBe(
      'env.example',
    )
  })

  it('keeps a bracketed IPv6 literal bracketed, with its port read off the end', () => {
    // What `URL.hostname` also returns, so the string every downstream normaliser sees is
    // unchanged by this deriver replacing the two `new URL` copies.
    expect(deriveEnvironmentCoordinates('http://[2001:db8::1]:8080/')).toEqual({
      host: '[2001:db8::1]',
      port: 8080,
      scheme: 'http',
    })
    expect(deriveEnvironmentCoordinates('https://[2001:db8::1]')?.port).toBe(443)
  })

  it('answers null for anything it cannot parse, rather than guessing a host', () => {
    // Each of these is a URL `new URL` throws on, and answering with a host anyway is how a
    // garbled URL gets dialled on a scheme default.
    for (const url of [
      null,
      undefined,
      '',
      'not a url',
      'env.example:443',
      'https://',
      'https://env.example:abc',
      'https://env.example:0',
      'https://env.example:70000',
      'https://[2001:db8::1',
      'https://2001:db8::1',
      'https://[2001:db8::1]x',
    ]) {
      expect(deriveEnvironmentCoordinates(url), String(url)).toBeNull()
    }
  })
})

describe('reachabilityNote', () => {
  const proof = (over: Record<string, unknown>) => ({
    state: 'reached' as const,
    via: null,
    reason: null,
    attempts: [],
    checkedAt: 1,
    ...over,
  })

  it('WITHHOLDS a note for a proof recording that nothing was wired to probe', () => {
    // `unproved` is the standing state of every deployment with no prober, so narrating it would
    // put an unverified-reachability warning on every prompt and train a reader to skip the
    // section that matters. Identical, to a reader, to no proof at all.
    expect(
      reachabilityNote({ candidates: [], proof: proof({ state: 'unproved' }) }),
    ).toBeUndefined()
    expect(reachabilityNote({ candidates: [], proof: null })).toBeUndefined()
    expect(reachabilityNote(null)).toBeUndefined()
  })

  it('narrates an INCONCLUSIVE proof, which is the platform having looked and failed to tell', () => {
    expect(
      reachabilityNote({
        candidates: [],
        proof: proof({
          state: 'inconclusive',
          reason: 'probe_failed',
          attempts: [{ target: 'env.example:443', outcome: 'probe_failed', detail: 'ECONNRESET' }],
        }),
      }),
    ).toEqual({ state: 'inconclusive', reason: 'probe_failed', detail: 'ECONNRESET' })
  })

  it('carries the address that carried, and nothing when the name itself did', () => {
    expect(reachabilityNote({ candidates: [], proof: proof({ via: '10.4.19.22' }) })).toEqual({
      state: 'reached',
      address: '10.4.19.22',
    })
    expect(reachabilityNote({ candidates: [], proof: proof({}) })).toEqual({ state: 'reached' })
  })
})
