import { describe, expect, it } from 'vitest'
import { deploymentOutageTolerance } from './deploymentOutage.js'
import { sdkTransportFailure } from './testing/sdkFailures.js'

// What a tolerated outage SAYS, which is the half `deadline.test.ts` does not pin: that file drives
// the policy through a wait (which throws are sat through, which end it, what an expiry reports),
// and this one reads the observation itself.
//
// It is written against a deployment URL of realistic length on purpose. The SDK's account of a
// transport failure repeats the base URL twice before it reaches the runtime's chain (ADR 0060), so
// against `127.0.0.1:8787` a truncated observation still happens to show the errno and against any
// real address it shows neither the errno nor the host: a fixture that keeps the loopback URL
// reports the bug as fixed.

const BASE_URL = 'https://cat-factory.acme-staging.example.com'

function describeThrow(error: unknown): string | null {
  return deploymentOutageTolerance().describe(error)
}

describe('deploymentOutageTolerance', () => {
  it('states the runtime chain, which is what separates one outage from the next', async () => {
    const observation = describeThrow(
      await sdkTransportFailure({
        message: 'connect ECONNREFUSED 203.0.113.42:443',
        code: 'ECONNREFUSED',
        answeredCalls: 9,
        baseUrl: BASE_URL,
      }),
    )
    expect(observation).toContain('(refused)')
    expect(observation).toContain('connect ECONNREFUSED 203.0.113.42:443')
  })

  it('spends the line on evidence rather than on prose the line already carries', async () => {
    // The SDK's account opens by naming the cause in words ("nothing is listening at …"), which is
    // the class this line prints as `(refused)`, and it carries an origin history that is the same
    // sentence every poll interval for as long as the outage lasts. Both are worth reading ONCE, in
    // the refusal a pass ends on; a journal an operator reads an hour later wants what changed.
    const observation = describeThrow(
      await sdkTransportFailure({
        message: 'connect ECONNREFUSED 203.0.113.42:443',
        code: 'ECONNREFUSED',
        answeredCalls: 9,
        baseUrl: BASE_URL,
      }),
    )
    expect(observation).not.toContain('nothing is listening')
    expect(observation).not.toContain('had answered 9 calls')
  })

  it('says what it dropped, so a cut chain is never read as the whole one', async () => {
    const observation = describeThrow(
      await sdkTransportFailure({
        message: `connect ECONNREFUSED 203.0.113.42:443 ${'x'.repeat(500)}`,
        code: 'ECONNREFUSED',
        answeredCalls: 1,
        baseUrl: BASE_URL,
      }),
    )
    expect(observation).toContain('connect ECONNREFUSED 203.0.113.42:443')
    expect(observation).toMatch(/more characters|more chars/)
  })

  it('ends the wait on a cause that is configuration rather than weather', async () => {
    // Not a restart to sit through: an expired certificate is its own diagnosis, and two minutes of
    // silence followed by "the deployment stopped answering" is the wrong message twice over.
    const observation = describeThrow(
      await sdkTransportFailure({
        message: 'certificate has expired',
        code: 'CERT_HAS_EXPIRED',
        answeredCalls: 0,
        baseUrl: BASE_URL,
      }),
    )
    expect(observation).toBeNull()
  })
})
