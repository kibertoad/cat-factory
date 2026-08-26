import { describe, expect, it } from 'vitest'
import { resolvesToLocalMachine } from './environment-host-bridge.logic.js'

describe('resolvesToLocalMachine', () => {
  it('accepts the literal spellings of this machine', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'app.localhost']) {
      expect(resolvesToLocalMachine(host), host).toBe(true)
    }
  })

  it('accepts the wildcard-DNS names an ingress template renders, which no literal test catches', () => {
    // THE case this function exists for. `cf-acc-pr8.127.0.0.1.nip.io` is a loopback name whose
    // address lives in its labels, so every host-literal check reads it as an ordinary domain and
    // the container never gets the bridge it needs.
    for (const host of [
      'cf-acc-pr8.127.0.0.1.nip.io',
      'CF-ACC-PR8.127.0.0.1.NIP.IO',
      'cf-acc-pr8.127.0.0.1.nip.io.',
      'cf-env-pr12.127.0.0.1.sslip.io',
      'api.127-0-0-1.nip.io',
    ]) {
      expect(resolvesToLocalMachine(host), host).toBe(true)
    }
  })

  it('REFUSES a wildcard name whose leftmost window is not loopback', () => {
    // The resolver answers the leftmost four-octet window, so this is what the name actually
    // resolves to. Bridging it would point the container at the host gateway for an address that
    // is somebody else's network: the PR #2075 shift, arriving as a bridge decision.
    expect(resolvesToLocalMachine('cf-acc-5.127.0.0.1.nip.io')).toBe(false)
    expect(resolvesToLocalMachine('app.10.1.2.3.nip.io')).toBe(false)
  })

  it('REFUSES a real remote host, including one that merely contains octets', () => {
    // The harmful direction. A bridge here would take an environment that WAS reachable from the
    // container and re-point it at the host gateway, which serves nothing for that name.
    for (const host of [
      'pr8.staging.example.com',
      'catalog.example.com',
      '203.0.113.10',
      // Not a wildcard-DNS suffix, so its four octets are labels in somebody's real zone and the
      // answer comes from that zone, not from the name.
      'app.127.0.0.1.example.com',
    ]) {
      expect(resolvesToLocalMachine(host), host).toBe(false)
    }
  })

  it('refuses an empty or blank hostname rather than treating it as local', () => {
    expect(resolvesToLocalMachine('')).toBe(false)
    expect(resolvesToLocalMachine('   ')).toBe(false)
  })
})
