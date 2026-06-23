import { describe, expect, it } from 'vitest'
import { localRunnerUrlError } from './localModelUrl.js'

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
})
