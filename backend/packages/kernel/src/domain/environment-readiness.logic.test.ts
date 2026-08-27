import { describe, expect, it } from 'vitest'
import {
  ENVIRONMENT_READY_TIMEOUT_MS,
  describeWaitedFor,
  judgeEnvironmentReadiness,
} from './environment-readiness.logic.js'

describe('judgeEnvironmentReadiness', () => {
  it('is ready only when the provider says ready', () => {
    expect(judgeEnvironmentReadiness({ status: 'ready' }, 0)).toEqual({ kind: 'ready' })
    expect(judgeEnvironmentReadiness({ status: 'provisioning' }, 0)).toMatchObject({
      kind: 'waiting',
    })
  })

  it('keeps a ready environment with no URL ready', () => {
    // A service that declares no ingress publishes nothing, and that is a legitimate outcome.
    // Whether the STEP consuming it has an address to hit is a different question, asked (and
    // refused) at dispatch — not here.
    expect(judgeEnvironmentReadiness({ status: 'ready' }, 0)).toEqual({ kind: 'ready' })
  })

  it('gives up immediately on a state the environment will not leave, naming it', () => {
    for (const status of ['failed', 'expired', 'tearing_down', 'torn_down'] as const) {
      const verdict = judgeEnvironmentReadiness({ status }, 0)
      expect(verdict.kind).toBe('failed')
      expect(verdict.kind === 'failed' && verdict.error).toContain(status)
    }
  })

  it('prefers the provider’s own error over the generic wording', () => {
    const verdict = judgeEnvironmentReadiness(
      { status: 'failed', lastError: '  404 No commit found for the ref  ' },
      0,
    )
    expect(verdict).toEqual({ kind: 'failed', error: '404 No commit found for the ref' })
  })

  it('waits right up to the ceiling, then times out with what it waited', () => {
    const justUnder = judgeEnvironmentReadiness(
      { status: 'provisioning' },
      ENVIRONMENT_READY_TIMEOUT_MS - 1,
    )
    expect(justUnder.kind).toBe('waiting')

    const spent = judgeEnvironmentReadiness(
      { status: 'provisioning' },
      ENVIRONMENT_READY_TIMEOUT_MS,
    )
    expect(spent.kind).toBe('timed_out')
    // The timeout is OURS, so it says so: the elapsed wait and the ceiling it crossed, rather
    // than a bare "not ready" that reads like the provider's verdict.
    expect(spent.kind === 'timed_out' && spent.error).toContain('20 minutes')
  })

  it('leaves the ceiling generous enough for a real per-PR backend', () => {
    // The run this bound was written for took 5m36s from create to online. A ceiling under that
    // fails healthy environments, which is the more expensive mistake of the two.
    expect(ENVIRONMENT_READY_TIMEOUT_MS).toBeGreaterThan(10 * 60 * 1000)
  })
})

describe('describeWaitedFor', () => {
  it('states a wait in the coarsest unit that is still true', () => {
    expect(describeWaitedFor(90_000)).toBe('2 minutes')
    expect(describeWaitedFor(60_000)).toBe('1 minute')
    expect(describeWaitedFor(4_000)).toBe('4 seconds')
    // Never "0 seconds": a wait that happened is quoted as having happened.
    expect(describeWaitedFor(10)).toBe('1 second')
  })
})
