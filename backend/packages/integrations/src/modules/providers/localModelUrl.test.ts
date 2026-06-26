import { describe, expect, it, vi } from 'vitest'
import { fetchLocalRunner, localRunnerUrlError } from './localModelUrl.js'

describe('localRunnerUrlError (SSRF allow-list)', () => {
  it('accepts loopback and private-LAN runner URLs', () => {
    for (const url of [
      'http://localhost:11434/v1',
      'http://localhost:1234/v1',
      'http://127.0.0.1:8080/v1',
      'http://127.5.6.7/v1',
      'http://10.0.0.5:8000/v1',
      'http://172.16.0.1/v1',
      'http://172.31.255.255/v1',
      'http://192.168.1.50:11434/v1',
      'http://my-box.local:11434/v1',
      'http://[::1]:8080/v1',
      'http://[fd00::1]:8080/v1',
    ]) {
      expect(localRunnerUrlError(url), url).toBeNull()
    }
  })

  it('rejects public hosts, the metadata endpoint, and other link-local addresses', () => {
    for (const url of [
      'http://evil.example.com/v1', // public hostname
      'http://8.8.8.8/v1', // public IP
      'http://169.254.169.254/latest/meta-data', // cloud metadata (link-local)
      'http://172.32.0.1/v1', // just outside the 172.16/12 private range
      'http://[fe80::1]/v1', // IPv6 link-local
      'http://[::]/v1', // unspecified
      'http://0.0.0.0/v1', // unspecified v4
    ]) {
      expect(localRunnerUrlError(url), url).toBeTruthy()
    }
  })

  it('rejects malformed URLs and non-http(s) schemes', () => {
    expect(localRunnerUrlError('not a url')).toBeTruthy()
    expect(localRunnerUrlError('file:///etc/passwd')).toBeTruthy()
    expect(localRunnerUrlError('ftp://localhost/v1')).toBeTruthy()
  })

  it('rejects embedded credentials', () => {
    expect(localRunnerUrlError('http://user:pass@localhost:11434/v1')).toBeTruthy()
    expect(localRunnerUrlError('http://user@127.0.0.1:8080/v1')).toBeTruthy()
  })

  it('rejects obfuscated encodings of dangerous targets', () => {
    // The WHATWG URL parser canonicalises integer/octal/hex IPv4 before the allow-list
    // sees it, so an obfuscated metadata/public address normalises to dotted form and is
    // then denied — there is no encoding bypass.
    for (const url of [
      'http://2852039166/v1', // bare-integer 169.254.169.254 (metadata)
      'http://0xa9.0xfe.0xa9.0xfe/v1', // hex octets → 169.254.169.254
      'http://134744072/v1', // bare-integer 8.8.8.8 (public)
      'http://[::ffff:169.254.169.254]/v1', // IPv4-mapped metadata endpoint
    ]) {
      expect(localRunnerUrlError(url), url).toBeTruthy()
    }
  })

  it('canonicalises obfuscated encodings of loopback and allows them', () => {
    // Same canonicalisation, benign target: these all normalise to 127.0.0.1.
    for (const url of ['http://2130706433/v1', 'http://0177.0.0.1/v1', 'http://0x7f.0.0.1/v1']) {
      expect(localRunnerUrlError(url), url).toBeNull()
    }
  })
})

describe('fetchLocalRunner (redirect re-validation)', () => {
  const ok = () => new Response('ok', { status: 200 })
  const redirectTo = (location: string) =>
    new Response(null, { status: 302, headers: { location } })

  it('returns the response when no redirect occurs', async () => {
    const doFetch = vi.fn().mockResolvedValue(ok())
    const res = await fetchLocalRunner('http://localhost:11434/models', {}, doFetch)
    expect(res.status).toBe(200)
    expect(doFetch).toHaveBeenCalledTimes(1)
    // Manual redirect handling so a 3xx is observed rather than auto-followed.
    expect(doFetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' })
  })

  it('follows a redirect to another allowed local host', async () => {
    const doFetch = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('http://127.0.0.1:8080/models'))
      .mockResolvedValueOnce(ok())
    const res = await fetchLocalRunner('http://localhost:11434/models', {}, doFetch)
    expect(res.status).toBe(200)
    expect(doFetch).toHaveBeenCalledTimes(2)
  })

  it('refuses a redirect to the cloud-metadata endpoint', async () => {
    const doFetch = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('http://169.254.169.254/latest/meta-data'))
    await expect(fetchLocalRunner('http://localhost:11434/models', {}, doFetch)).rejects.toThrow(
      /Blocked local-runner request/,
    )
    // The denied target is never fetched.
    expect(doFetch).toHaveBeenCalledTimes(1)
  })

  it('gives up on a redirect loop', async () => {
    const doFetch = vi.fn().mockResolvedValue(redirectTo('http://localhost:11434/models'))
    await expect(fetchLocalRunner('http://localhost:11434/models', {}, doFetch)).rejects.toThrow(
      /too many redirects/i,
    )
  })
})
