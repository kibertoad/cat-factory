import { describe, expect, it } from 'vitest'
import { planEnvironmentBridges } from './environmentBridge.js'

describe('planEnvironmentBridges', () => {
  it('names the host of every loopback environment URL, deduplicated and sorted', () => {
    // Sorted and deduplicated because the result is compared against what a running container was
    // created with: an order that tracked the order the engine listed a run's peers would make two
    // identical bridge sets look different and replace the container for nothing.
    expect(
      planEnvironmentBridges([
        'http://cf-acc-pr8.127.0.0.1.nip.io/health',
        'http://api.cf-acc-pr8.127.0.0.1.nip.io',
        'http://cf-acc-pr8.127.0.0.1.nip.io/ready',
        'http://app.localhost:8080',
      ]).hosts,
    ).toEqual(['api.cf-acc-pr8.127.0.0.1.nip.io', 'app.localhost', 'cf-acc-pr8.127.0.0.1.nip.io'])
  })

  it('bridges a PEER service environment, not just the job own one', () => {
    // A cross-service integration test reaches its peer's environment over exactly the same
    // unreachable name, and fails in exactly the same way. Bridging only the first URL left that
    // case broken while looking fixed.
    expect(
      planEnvironmentBridges([
        'https://pr8.staging.example.com',
        'http://email-pr8.127.0.0.1.nip.io',
      ]).hosts,
    ).toEqual(['email-pr8.127.0.0.1.nip.io'])
  })

  it('needs nothing for a genuinely remote environment', () => {
    // The harmful direction: bridging this would break an environment the container could reach.
    expect(planEnvironmentBridges(['https://pr8.staging.example.com'])).toEqual({
      hosts: [],
      unbridgeable: [],
    })
  })

  it('reports a localhost environment as UNBRIDGEABLE rather than bridging it', () => {
    // A compose environment publishes `http://localhost:<ephemeral port>`, so this is the ordinary
    // case. A container will not honour an appended `localhost` hosts entry, and the frontend flow
    // serves WireMock and the built app on localhost INSIDE the container, so a bridge that DID
    // take would break the services the job is there to drive. Costing the job its warm-pool
    // member and a container replacement for that entry is pure loss.
    expect(planEnvironmentBridges(['http://localhost:32768', 'http://127.0.0.1:9000'])).toEqual({
      hosts: [],
      unbridgeable: ['http://127.0.0.1:9000', 'http://localhost:32768'],
    })
  })

  it('needs nothing when there is no URL, or it is not one', () => {
    expect(planEnvironmentBridges([null, undefined, '', 'not a url', 'http://'])).toEqual({
      hosts: [],
      unbridgeable: [],
    })
  })
})
