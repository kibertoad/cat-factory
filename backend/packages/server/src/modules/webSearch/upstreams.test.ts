import { describe, expect, it } from 'vitest'
import { assertSafeWebSearchUrl } from './upstreams.js'

// The account-configured SearXNG URL is fetched server-side, so it must be SSRF-guarded:
// public host over http/https only, no private/internal/metadata targets.
describe('assertSafeWebSearchUrl', () => {
  it('accepts public http/https hosts', () => {
    for (const url of [
      'https://searx.example.com',
      'http://searx.example.com:8080/search',
      'https://search.brave.com',
    ]) {
      expect(() => assertSafeWebSearchUrl(url), url).not.toThrow()
    }
  })

  it('rejects private, loopback, and cloud-metadata hosts', () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data', // AWS IMDS
      'http://localhost:8080/search',
      'http://127.0.0.1/search',
      'http://10.0.0.5/search',
      'http://192.168.1.10/search',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://internal.corp.local/search',
    ]) {
      expect(() => assertSafeWebSearchUrl(url), url).toThrow()
    }
  })

  it('rejects non-http(s) schemes and embedded credentials', () => {
    expect(() => assertSafeWebSearchUrl('ftp://searx.example.com')).toThrow()
    expect(() => assertSafeWebSearchUrl('https://user:pass@searx.example.com')).toThrow()
  })
})
