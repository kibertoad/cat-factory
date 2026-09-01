import { describe, expect, it } from 'vitest'
import {
  classifyLocalMachineHostBridge,
  hostBridgeKey,
  isBridgeableAddress,
  resolvesToLocalMachine,
} from './environment-host-bridge.logic.js'

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

describe('classifyLocalMachineHostBridge', () => {
  it('bridges the names an added hosts-file entry is the first answer for', () => {
    for (const host of ['cf-acc-pr8.127.0.0.1.nip.io', 'app.localhost', 'host.docker.internal']) {
      expect(classifyLocalMachineHostBridge(host), host).toEqual({
        kind: 'bridge',
        host,
        target: 'host-gateway',
      })
    }
  })

  it('normalises the host it hands back, so the entry matches what the container looks up', () => {
    expect(classifyLocalMachineHostBridge(' CF-ACC-PR8.127.0.0.1.NIP.IO. ')).toEqual({
      kind: 'bridge',
      host: 'cf-acc-pr8.127.0.0.1.nip.io',
      target: 'host-gateway',
    })
  })

  it('reports `localhost` and every IP literal as UNBRIDGEABLE, never as a bridge', () => {
    // A compose environment publishes `http://localhost:<port>`, so this is the ordinary case
    // rather than a corner. Graded as a bridge it costs the job its warm-pool member and forces a
    // container replacement, for an /etc/hosts line the container will not honour: the image's own
    // `127.0.0.1 localhost` is matched first, and an IP literal is never looked up at all.
    for (const host of ['localhost', '127.0.0.1', '127.9.9.9', '::1', '[::1]', '0.0.0.0', '::']) {
      const verdict = classifyLocalMachineHostBridge(host)
      expect(verdict.kind, host).toBe('unbridgeable')
    }
  })

  it('leaves a genuinely remote host alone', () => {
    for (const host of ['pr8.staging.example.com', '203.0.113.10', 'cf-acc-5.127.0.0.1.nip.io']) {
      expect(classifyLocalMachineHostBridge(host), host).toEqual({ kind: 'none' })
    }
  })

  it('answers `none` for an empty hostname rather than inventing a bridge', () => {
    expect(classifyLocalMachineHostBridge('   ')).toEqual({ kind: 'none' })
  })

  it('maps a remote NAME onto a stated address, which `none` could never express', () => {
    // The gap this closes. A per-environment record that lives in an internal DNS view resolves
    // nowhere from the deployment while the balancer fronting it is perfectly reachable, and
    // `none`'s own contract asserts the opposite: that the container reaches it as written.
    expect(classifyLocalMachineHostBridge('PR-14.test.example.cloud.', ' 10.4.19.22 ')).toEqual({
      kind: 'bridge',
      host: 'pr-14.test.example.cloud',
      target: { ip: '10.4.19.22' },
    })
  })

  it('keeps a LOCAL name on the host gateway even when an address is offered for it', () => {
    // A name that answers with this machine's own address is a dead end inside a container
    // whatever a provider says about it, so the ordering is load-bearing rather than incidental.
    expect(classifyLocalMachineHostBridge('cf-acc-pr8.127.0.0.1.nip.io', '10.4.19.22')).toEqual({
      kind: 'bridge',
      host: 'cf-acc-pr8.127.0.0.1.nip.io',
      target: 'host-gateway',
    })
  })

  it('answers `none` for an address a bridge may not name, rather than half-bridging', () => {
    for (const address of [
      '127.0.0.1',
      '169.254.169.254',
      '2130706433',
      '0x7f000001',
      'not-an-ip',
    ]) {
      expect(classifyLocalMachineHostBridge('pr-14.test.example.cloud', address), address).toEqual({
        kind: 'none',
      })
    }
  })

  it('answers `none` for a remote IP LITERAL with an address, which no hosts entry re-points', () => {
    expect(classifyLocalMachineHostBridge('203.0.113.10', '10.4.19.22')).toEqual({ kind: 'none' })
  })
})

describe('isBridgeableAddress', () => {
  it('allows the private and public addresses a real balancer answers on', () => {
    // RFC1918 is deliberately ALLOWED, unlike the strict URL policy: an internal load balancer on
    // 10.x is the population this exists for, and refusing it would leave nothing to name.
    for (const address of ['10.4.19.22', '172.16.3.4', '192.168.1.9', '203.0.113.10', 'fd12::1']) {
      expect(isBridgeableAddress(address), address).toBe(true)
    }
  })

  it('refuses what an address bridge could only ever be abused to reach', () => {
    for (const address of [
      '127.0.0.1', // the container's OWN namespace, where the harness is listening
      '::1',
      '0.0.0.0',
      '169.254.169.254', // instance credentials
      'fe80::1',
      '100.100.100.200',
      '224.0.0.1',
      '255.255.255.255',
      '2130706433', // loopback, spelled so a `127.` prefix match misses it
      '0x7f.0.0.1',
      '::ffff:127.0.0.1',
      'balancer.internal', // a NAME is just the lookup that already failed
      '',
    ]) {
      expect(isBridgeableAddress(address), address).toBe(false)
    }
  })
})

describe('hostBridgeKey', () => {
  it('separates the same host on two different targets', () => {
    // The key is an IDENTITY: a mismatch destroys and rebuilds a warm container, so folding these
    // two together would leave a run wedged against a stale address nothing will replace.
    expect(hostBridgeKey({ host: 'env.example', target: 'host-gateway' })).not.toBe(
      hostBridgeKey({ host: 'env.example', target: { ip: '10.4.19.22' } }),
    )
    expect(hostBridgeKey({ host: 'env.example', target: { ip: '10.4.19.22' } })).toBe(
      hostBridgeKey({ host: 'env.example', target: { ip: '10.4.19.22' } }),
    )
  })
})
