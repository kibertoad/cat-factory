import { describe, expect, it } from 'vitest'
import { addressBridges, planEnvironmentBridges } from './environmentBridge.js'

const url = (value: string) => ({ url: value })

describe('planEnvironmentBridges', () => {
  it('names the host of every loopback environment URL, deduplicated and sorted', () => {
    // Sorted and deduplicated because the result is compared against what a running container was
    // created with: an order that tracked the order the engine listed a run's peers would make two
    // identical bridge sets look different and replace the container for nothing.
    expect(
      planEnvironmentBridges([
        url('http://cf-acc-pr8.127.0.0.1.nip.io/health'),
        url('http://api.cf-acc-pr8.127.0.0.1.nip.io'),
        url('http://cf-acc-pr8.127.0.0.1.nip.io/ready'),
        url('http://app.localhost:8080'),
      ]).bridges,
    ).toEqual([
      { host: 'api.cf-acc-pr8.127.0.0.1.nip.io', target: 'host-gateway' },
      { host: 'app.localhost', target: 'host-gateway' },
      { host: 'cf-acc-pr8.127.0.0.1.nip.io', target: 'host-gateway' },
    ])
  })

  it('bridges a PEER service environment, not just the job own one', () => {
    // A cross-service integration test reaches its peer's environment over exactly the same
    // unreachable name, and fails in exactly the same way. Bridging only the first URL left that
    // case broken while looking fixed.
    expect(
      planEnvironmentBridges([
        url('https://pr8.staging.example.com'),
        url('http://email-pr8.127.0.0.1.nip.io'),
      ]).bridges,
    ).toEqual([{ host: 'email-pr8.127.0.0.1.nip.io', target: 'host-gateway' }])
  })

  it('needs nothing for a genuinely remote environment', () => {
    // The harmful direction: bridging this would break an environment the container could reach.
    expect(planEnvironmentBridges([url('https://pr8.staging.example.com')])).toEqual({
      bridges: [],
      unbridgeable: [],
    })
  })

  it('reports a localhost environment as UNBRIDGEABLE rather than bridging it', () => {
    // A compose environment publishes `http://localhost:<ephemeral port>`, so this is the ordinary
    // case. A container will not honour an appended `localhost` hosts entry, and the frontend flow
    // serves WireMock and the built app on localhost INSIDE the container, so a bridge that DID
    // take would break the services the job is there to drive. Costing the job its warm-pool
    // member and a container replacement for that entry is pure loss.
    expect(
      planEnvironmentBridges([url('http://localhost:32768'), url('http://127.0.0.1:9000')]),
    ).toEqual({
      bridges: [],
      unbridgeable: ['http://127.0.0.1:9000', 'http://localhost:32768'],
    })
  })

  it('needs nothing when there is no URL, or it is not one', () => {
    expect(
      planEnvironmentBridges([null, undefined, url(''), url('not a url'), url('http://')]),
    ).toEqual({
      bridges: [],
      unbridgeable: [],
    })
  })

  it('maps a remote name onto the PROVED address the environment carries', () => {
    // The Kargo shape: the per-environment record lives in an internal DNS view, so the name
    // resolves nowhere from anywhere the container can ask, while the balancer fronting it is
    // perfectly reachable and routes on the Host header. Before the target could hold an address
    // this fell out as `none`, whose own contract asserts the container reaches it as written.
    expect(
      planEnvironmentBridges([
        { url: 'https://pr-14.test.example.cloud/health', address: '10.4.19.22' },
      ]).bridges,
    ).toEqual([{ host: 'pr-14.test.example.cloud', target: { ip: '10.4.19.22' } }])
  })

  it('refuses an address a bridge must never name, and says nothing rather than half-bridging', () => {
    // Metadata and loopback are the two an address bridge could only ever be abused to reach:
    // loopback inside a container is the container's own namespace, where the harness is
    // listening. The verdict is `none`, which is the same as before the address was offered.
    expect(
      planEnvironmentBridges([
        { url: 'https://pr-14.test.example.cloud', address: '169.254.169.254' },
        { url: 'https://pr-15.test.example.cloud', address: '127.0.0.1' },
        { url: 'https://pr-16.test.example.cloud', address: '2130706433' },
      ]),
    ).toEqual({ bridges: [], unbridgeable: [] })
  })

  it('keeps a local name on the host gateway even when an address is offered for it', () => {
    // A name that answers with this machine's own address is a dead end inside a container
    // whatever a provider says about it, so the gateway branch wins and the address is ignored.
    expect(
      planEnvironmentBridges([{ url: 'http://cf-acc-pr8.127.0.0.1.nip.io', address: '10.4.19.22' }])
        .bridges,
    ).toEqual([{ host: 'cf-acc-pr8.127.0.0.1.nip.io', target: 'host-gateway' }])
  })
})

describe('addressBridges', () => {
  it('keeps only what a runtime with no host-gateway concept can express', () => {
    const { bridges } = planEnvironmentBridges([
      url('http://cf-acc-pr8.127.0.0.1.nip.io'),
      { url: 'https://pr-14.test.example.cloud', address: '10.4.19.22' },
    ])
    expect(addressBridges(bridges)).toEqual([
      { host: 'pr-14.test.example.cloud', ip: '10.4.19.22' },
    ])
  })
})
