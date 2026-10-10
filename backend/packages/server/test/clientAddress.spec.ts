import { describe, expect, it } from 'vitest'
import {
  forwardedClientAddress,
  normalizeClientAddress,
  resolveTrustedProxyHops,
} from '../src/http/clientAddress.js'

// SEC-4: the password throttle is only as good as the address it keys on. These pin the two
// properties that make it work: a client cannot mint fresh buckets, and a client cannot pin
// somebody else's.

describe('forwardedClientAddress', () => {
  it('takes the RIGHTMOST hop, which is the one the nearest proxy appended', () => {
    // Under nginx's appending `proxy_add_x_forwarded_for` the leftmost entry is whatever the
    // client sent, so only rightmost is the address that really connected to our proxy.
    expect(forwardedClientAddress('1.2.3.4, 203.0.113.9', 1)).toBe('203.0.113.9')
    // An overwriting proxy leaves a single entry, where rightmost and leftmost agree.
    expect(forwardedClientAddress('203.0.113.9', 1)).toBe('203.0.113.9')
  })

  it('ignores a spoofed prefix the client prepended', () => {
    const spoofed = 'evil, 10.9.9.9, 203.0.113.9'
    expect(forwardedClientAddress(spoofed, 1)).toBe('203.0.113.9')
  })

  it('counts back from the end for a multi-proxy chain', () => {
    expect(forwardedClientAddress('1.1.1.1, 203.0.113.9, 10.0.0.7', 2)).toBe('203.0.113.9')
  })

  it('discards a chain shorter than the declared topology', () => {
    // Claiming two proxies but seeing one hop means the request did not traverse the chain we
    // were told about, so it is no evidence about the client: the caller falls back to the peer.
    expect(forwardedClientAddress('203.0.113.9', 2)).toBeNull()
    expect(forwardedClientAddress('', 1)).toBeNull()
    expect(forwardedClientAddress(undefined, 1)).toBeNull()
  })

  it('refuses a hop that is not an address', () => {
    expect(forwardedClientAddress('not-an-ip', 1)).toBeNull()
    expect(forwardedClientAddress('1.2.3.4, garbage', 1)).toBeNull()
  })
})

describe('normalizeClientAddress', () => {
  it('keeps a plain IPv4 address', () => {
    expect(normalizeClientAddress('203.0.113.9')).toBe('203.0.113.9')
  })

  it('strips a port a proxy appended', () => {
    // A port-appending proxy (IIS/ARR) would otherwise mint one bucket per connection.
    expect(normalizeClientAddress('203.0.113.9:51514')).toBe('203.0.113.9')
    expect(normalizeClientAddress('[2001:db8::1]:443')).toBe('2001:db8:0:0::/64')
  })

  it('buckets IPv6 to its /64 so one allocation is one bucket', () => {
    // A residential or hosting IPv6 allocation is routinely a /64 or larger; keying on the
    // full address would hand an attacker 2^64 buckets, the same hole as a spoofable header.
    const a = normalizeClientAddress('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd')
    const b = normalizeClientAddress('2001:db8:1234:5678:1111:2222:3333:4444')
    expect(a).toBe(b)
    expect(a).toBe('2001:db8:1234:5678::/64')
    // A different /64 is a different bucket.
    expect(normalizeClientAddress('2001:db8:1234:9999::1')).not.toBe(a)
  })

  it('expands compressed and IPv4-mapped IPv6 forms before bucketing', () => {
    expect(normalizeClientAddress('::1')).toBe('0:0:0:0::/64')
    expect(normalizeClientAddress('::ffff:203.0.113.9')).toBe('0:0:0:0::/64')
    expect(normalizeClientAddress('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
  })

  it('refuses anything that is not an address', () => {
    for (const raw of ['', '   ', 'evil', 'localhost', '1.2.3', '999.1.1.1', '2001:db8::zz']) {
      expect(normalizeClientAddress(raw), raw).toBeNull()
    }
  })
})

describe('resolveTrustedProxyHops', () => {
  it('defaults to one proxy', () => {
    expect(resolveTrustedProxyHops(undefined)).toBe(1)
    expect(resolveTrustedProxyHops('')).toBe(1)
    expect(resolveTrustedProxyHops('not a number')).toBe(1)
  })

  it('clamps below one, since zero would mean trusting the client end of the chain', () => {
    expect(resolveTrustedProxyHops('0')).toBe(1)
    expect(resolveTrustedProxyHops('-3')).toBe(1)
  })

  it('honours a real chain depth', () => {
    expect(resolveTrustedProxyHops('2')).toBe(2)
    expect(resolveTrustedProxyHops(' 3 ')).toBe(3)
  })
})
