import { describe, expect, it } from 'vitest'
import { ValidationError } from '../../domain/errors'
import { assertSafeAtlassianBaseUrl } from '../../shared/atlassian.logic'
import { assertSafeEnvironmentUrl } from './environments.logic'

// SSRF host-classification regression tests (Finding #6b). The guards must block
// the obfuscated loopback/link-local/RFC1918 encodings that bypass a naive
// dotted-decimal match, while leaving ordinary public hosts untouched.

const expectBlocked = (url: string) => {
  expect(() => assertSafeEnvironmentUrl(url), url).toThrow(ValidationError)
  expect(() => assertSafeAtlassianBaseUrl(url), url).toThrow(ValidationError)
}

const expectAllowed = (url: string) => {
  expect(() => assertSafeEnvironmentUrl(url), url).not.toThrow()
  expect(() => assertSafeAtlassianBaseUrl(url), url).not.toThrow()
}

describe('SSRF host guard — obfuscated internal targets', () => {
  it('blocks bare-integer IPv4 (decimal 127.0.0.1)', () => {
    expectBlocked('https://2130706433')
  })

  it('blocks hex-encoded octets', () => {
    expectBlocked('https://0x7f.0.0.1')
    expectBlocked('https://0x7f000001')
  })

  it('blocks octal / leading-zero octets', () => {
    expectBlocked('https://0177.0.0.1')
  })

  it('blocks IPv4-mapped IPv6 with private embedded v4', () => {
    expectBlocked('https://[::ffff:169.254.169.254]')
    expectBlocked('https://[::ffff:127.0.0.1]')
    // hex-group form of 169.254.169.254
    expectBlocked('https://[::ffff:a9fe:a9fe]')
  })

  it('blocks plain dotted-decimal private / loopback / link-local ranges', () => {
    expectBlocked('https://127.0.0.1')
    expectBlocked('https://10.0.0.5')
    expectBlocked('https://192.168.1.1')
    expectBlocked('https://172.16.0.1')
    expectBlocked('https://169.254.169.254')
    expectBlocked('https://0.0.0.0')
  })

  it('blocks IPv6 loopback / link-local / unique-local literals', () => {
    expectBlocked('https://[::1]')
    expectBlocked('https://[fe80::1]')
    expectBlocked('https://[fc00::1]')
    expectBlocked('https://[fd00::1]')
  })

  it('blocks localhost and internal suffixes', () => {
    expectBlocked('https://localhost')
    expectBlocked('https://svc.internal')
    expectBlocked('https://svc.local')
  })

  it('blocks malformed all-numeric dotted hosts', () => {
    expectBlocked('https://999.1.1.1')
  })
})

describe('SSRF host guard — legitimate public hosts unchanged', () => {
  it('allows ordinary public hostnames', () => {
    expectAllowed('https://your-team.atlassian.net')
    expectAllowed('https://api.example.com/path?q=1')
    expectAllowed('https://fcbank.com')
    expectAllowed('https://example123.io')
  })

  it('allows public dotted-decimal IPv4', () => {
    expectAllowed('https://8.8.8.8')
    expectAllowed('https://1.1.1.1')
  })
})

describe('SSRF host guard — scheme and credential rules', () => {
  it('rejects non-https', () => {
    expect(() => assertSafeEnvironmentUrl('http://example.com')).toThrow(ValidationError)
    expect(() => assertSafeAtlassianBaseUrl('http://example.com')).toThrow(ValidationError)
  })

  it('rejects embedded credentials', () => {
    expect(() => assertSafeEnvironmentUrl('https://user:pass@example.com')).toThrow(ValidationError)
    expect(() => assertSafeAtlassianBaseUrl('https://user:pass@example.com')).toThrow(
      ValidationError,
    )
  })
})
