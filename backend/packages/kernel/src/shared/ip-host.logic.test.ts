import { describe, expect, it } from 'vitest'
import {
  decimalV4,
  decodeIpv4,
  isBlockedPrivateHost,
  isCloudMetadataHost,
  isPrivateV4,
  mappedV4,
} from './ip-host.logic.js'

// These are the SSRF guards' primitives: every org-supplied URL the platform later FETCHES
// (Atlassian sites, environment management APIs, the Kubernetes apiserver) is classified here
// first. A hole is not a wrong answer on a screen, it is an internal endpoint reached with the
// deployment's own network position, so the cases below are written as the bypasses they exist
// to refuse: obfuscated encodings, boundary octets, and the near-misses that must still pass.

describe('isPrivateV4', () => {
  it('names loopback, the "this network" range and RFC1918 as private', () => {
    expect(isPrivateV4([127, 0, 0, 1])).toBe(true)
    expect(isPrivateV4([0, 0, 0, 0])).toBe(true)
    expect(isPrivateV4([10, 1, 2, 3])).toBe(true)
    expect(isPrivateV4([192, 168, 1, 1])).toBe(true)
    expect(isPrivateV4([169, 254, 169, 254])).toBe(true)
  })

  it('bounds 172.16/12 at both ends', () => {
    expect(isPrivateV4([172, 15, 0, 1])).toBe(false)
    expect(isPrivateV4([172, 16, 0, 1])).toBe(true)
    expect(isPrivateV4([172, 31, 255, 255])).toBe(true)
    expect(isPrivateV4([172, 32, 0, 1])).toBe(false)
  })

  it('does not over-reach into the public neighbours of each range', () => {
    expect(isPrivateV4([8, 8, 8, 8])).toBe(false)
    expect(isPrivateV4([11, 0, 0, 1])).toBe(false)
    // The second octet matters: only 169.254/16 is link-local, and only 192.168/16 is private.
    expect(isPrivateV4([169, 253, 0, 1])).toBe(false)
    expect(isPrivateV4([192, 167, 1, 1])).toBe(false)
    expect(isPrivateV4([126, 0, 0, 1])).toBe(false)
  })
})

describe('decimalV4', () => {
  it('parses a dotted-decimal literal, including the top of the range', () => {
    expect(decimalV4('1.2.3.4')).toEqual([1, 2, 3, 4])
    expect(decimalV4('255.255.255.255')).toEqual([255, 255, 255, 255])
    expect(decimalV4('0.0.0.0')).toEqual([0, 0, 0, 0])
  })

  it('refuses an out-of-range octet in ANY position', () => {
    expect(decimalV4('256.1.1.1')).toBeNull()
    expect(decimalV4('1.256.1.1')).toBeNull()
    expect(decimalV4('1.1.256.1')).toBeNull()
    expect(decimalV4('1.1.1.256')).toBeNull()
  })

  it('refuses anything that is not exactly four decimal octets', () => {
    expect(decimalV4('1.2.3')).toBeNull()
    expect(decimalV4('1.2.3.4.5')).toBeNull()
    expect(decimalV4('1234.1.1.1')).toBeNull()
    expect(decimalV4('0x7f.0.0.1')).toBeNull()
    expect(decimalV4('example.com')).toBeNull()
    expect(decimalV4('2130706433')).toBeNull()
    expect(decimalV4(' 1.2.3.4')).toBeNull()
    expect(decimalV4('1.2.3.4 ')).toBeNull()
  })
})

describe('mappedV4', () => {
  it('extracts the embedded address from the dotted mapped form', () => {
    expect(mappedV4('::ffff:127.0.0.1')).toEqual([127, 0, 0, 1])
    expect(mappedV4('::ffff:8.8.8.8')).toEqual([8, 8, 8, 8])
  })

  it('extracts it from the hex-group form `new URL` normalizes to', () => {
    expect(mappedV4('::ffff:7f00:1')).toEqual([127, 0, 0, 1])
    expect(mappedV4('::ffff:c0a8:0101')).toEqual([192, 168, 1, 1])
    expect(mappedV4('::ffff:ffff:ffff')).toEqual([255, 255, 255, 255])
  })

  it('refuses an out-of-range octet rather than truncating it', () => {
    expect(mappedV4('::ffff:256.0.0.1')).toBeNull()
    expect(mappedV4('::ffff:1.1.1.300')).toBeNull()
  })

  it('refuses anything that is not an IPv4-mapped literal', () => {
    expect(mappedV4('::1')).toBeNull()
    expect(mappedV4('127.0.0.1')).toBeNull()
    expect(mappedV4('::ffff:zzzz:1')).toBeNull()
    expect(mappedV4('2001:4860:4860::8888')).toBeNull()
  })
})

describe('decodeIpv4', () => {
  it('decodes every encoding of the same address to the same octets', () => {
    // The point of the module: these are four spellings of 127.0.0.1, and a guard that
    // recognised only the first is the bypass.
    expect(decodeIpv4('127.0.0.1')).toEqual([127, 0, 0, 1])
    expect(decodeIpv4('::ffff:127.0.0.1')).toEqual([127, 0, 0, 1])
    expect(decodeIpv4('::ffff:7f00:1')).toEqual([127, 0, 0, 1])
    expect(decodeIpv4('2130706433')).toEqual([127, 0, 0, 1])
  })

  it('decodes a bare integer across the whole 32-bit space', () => {
    expect(decodeIpv4('0')).toEqual([0, 0, 0, 0])
    expect(decodeIpv4('4294967295')).toEqual([255, 255, 255, 255])
    expect(decodeIpv4('3232235777')).toEqual([192, 168, 1, 1])
    // One past the top of the space is not an address.
    expect(decodeIpv4('4294967296')).toBeNull()
  })

  it('returns null for a host that is not an IPv4 literal in any form', () => {
    expect(decodeIpv4('example.com')).toBeNull()
    expect(decodeIpv4('::1')).toBeNull()
    expect(decodeIpv4('')).toBeNull()
  })
})

describe('isCloudMetadataHost', () => {
  it('blocks the metadata hostnames whatever the case, brackets included', () => {
    expect(isCloudMetadataHost('metadata.google.internal')).toBe(true)
    expect(isCloudMetadataHost('METADATA.GOOGLE.INTERNAL')).toBe(true)
    expect(isCloudMetadataHost('fd00:ec2::254')).toBe(true)
    expect(isCloudMetadataHost('[fd00:ec2::254]')).toBe(true)
  })

  it('blocks the WHOLE link-local range, through every IPv4 encoding', () => {
    expect(isCloudMetadataHost('169.254.169.254')).toBe(true)
    expect(isCloudMetadataHost('169.254.0.1')).toBe(true)
    expect(isCloudMetadataHost('2852039166')).toBe(true)
    expect(isCloudMetadataHost('::ffff:169.254.169.254')).toBe(true)
    expect(isCloudMetadataHost('169.253.169.254')).toBe(false)
  })

  it('blocks the Alibaba metadata address exactly, not its neighbours', () => {
    expect(isCloudMetadataHost('100.100.100.200')).toBe(true)
    expect(isCloudMetadataHost('100.100.100.201')).toBe(false)
    expect(isCloudMetadataHost('100.100.101.200')).toBe(false)
    expect(isCloudMetadataHost('100.101.100.200')).toBe(false)
    expect(isCloudMetadataHost('101.100.100.200')).toBe(false)
  })

  it('leaves the merely-private and the plainly-public alone', () => {
    // This policy ALLOWS private hosts (a Kubernetes apiserver is one); it only refuses
    // the metadata endpoints, which is a different question from `isBlockedPrivateHost`.
    expect(isCloudMetadataHost('10.0.0.1')).toBe(false)
    expect(isCloudMetadataHost('127.0.0.1')).toBe(false)
    expect(isCloudMetadataHost('example.com')).toBe(false)
    expect(isCloudMetadataHost('8.8.8.8')).toBe(false)
  })
})

describe('isBlockedPrivateHost', () => {
  it('blocks the local names and an empty host', () => {
    expect(isBlockedPrivateHost('')).toBe(true)
    expect(isBlockedPrivateHost('localhost')).toBe(true)
    expect(isBlockedPrivateHost('api.localhost')).toBe(true)
    expect(isBlockedPrivateHost('svc.cluster.internal')).toBe(true)
    expect(isBlockedPrivateHost('printer.local')).toBe(true)
    expect(isBlockedPrivateHost('LOCALHOST')).toBe(true)
  })

  it('does not block a public name that merely ENDS in one of those words', () => {
    // The suffix is a label boundary, not a substring: refusing these would lock a customer
    // out of their own domain.
    expect(isBlockedPrivateHost('mylocalhost')).toBe(false)
    expect(isBlockedPrivateHost('notinternal')).toBe(false)
    expect(isBlockedPrivateHost('local.example.com')).toBe(false)
  })

  it('blocks the private IPv4 ranges and passes public addresses', () => {
    expect(isBlockedPrivateHost('127.0.0.1')).toBe(true)
    expect(isBlockedPrivateHost('10.0.0.1')).toBe(true)
    expect(isBlockedPrivateHost('192.168.1.1')).toBe(true)
    expect(isBlockedPrivateHost('172.16.0.1')).toBe(true)
    expect(isBlockedPrivateHost('169.254.169.254')).toBe(true)
    expect(isBlockedPrivateHost('8.8.8.8')).toBe(false)
    expect(isBlockedPrivateHost('172.32.0.1')).toBe(false)
  })

  it('blocks every obfuscated numeric encoding outright, public or not', () => {
    // A bare integer / hex / octal host is never a legitimate public hostname, so this policy
    // refuses the FORM rather than decoding it: `3232235777` and `0x7f.0.0.1` are both blocked,
    // and so is a public address written that way.
    expect(isBlockedPrivateHost('2130706433')).toBe(true)
    expect(isBlockedPrivateHost('134744072')).toBe(true)
    expect(isBlockedPrivateHost('0x7f.0.0.1')).toBe(true)
    expect(isBlockedPrivateHost('0177.0.0.1')).toBe(true)
    expect(isBlockedPrivateHost('1.2.3.4.5')).toBe(true)
    // A dotted literal that decodes to nothing valid is refused in doubt.
    expect(isBlockedPrivateHost('256.1.1.1')).toBe(true)
  })

  it('blocks the IPv6 local literals, bracketed or bare', () => {
    expect(isBlockedPrivateHost('::1')).toBe(true)
    expect(isBlockedPrivateHost('[::1]')).toBe(true)
    expect(isBlockedPrivateHost('::')).toBe(true)
    expect(isBlockedPrivateHost('fe80::1')).toBe(true)
    expect(isBlockedPrivateHost('fc00::1')).toBe(true)
    expect(isBlockedPrivateHost('fd00::1')).toBe(true)
  })

  it('classifies an IPv4-mapped IPv6 literal by the address it embeds', () => {
    expect(isBlockedPrivateHost('::ffff:127.0.0.1')).toBe(true)
    expect(isBlockedPrivateHost('::ffff:7f00:1')).toBe(true)
    expect(isBlockedPrivateHost('::ffff:8.8.8.8')).toBe(false)
  })

  it('passes a public IPv6 literal and an ordinary hostname', () => {
    expect(isBlockedPrivateHost('2001:4860:4860::8888')).toBe(false)
    expect(isBlockedPrivateHost('example.com')).toBe(false)
    expect(isBlockedPrivateHost('sub.domain.example.co.uk')).toBe(false)
  })
})
