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

  it('names the state a timed-out environment was stuck in, from the note', () => {
    // The gap issue #2153 reported: the ceiling formatted `lastError` into this message, and
    // `lastError` is structurally NULL on the only status that can reach it, so the platform's
    // whole account of a 20-minute wait was that it had waited 20 minutes. The note is the
    // channel a `provisioning` provider actually has.
    const spent = judgeEnvironmentReadiness(
      { status: 'provisioning', statusNote: '  the deploy succeeded and no target went healthy  ' },
      ENVIRONMENT_READY_TIMEOUT_MS,
    )
    expect(spent.kind).toBe('timed_out')
    expect(spent.kind === 'timed_out' && spent.error).toContain(
      'Last provider note: the deploy succeeded and no target went healthy',
    )
  })

  it('labels a timeout fallback by which channel it came from', () => {
    // A caller carrying a `lastError` on a provisioning row is not how the persistence sites
    // write today, but the two claims are different and the message says which it is rather than
    // presenting an error as a note.
    const verdict = judgeEnvironmentReadiness(
      { status: 'provisioning', lastError: 'quota exceeded' },
      ENVIRONMENT_READY_TIMEOUT_MS,
    )
    expect(verdict.kind === 'timed_out' && verdict.error).toContain(
      'Last provider error: quota exceeded',
    )
  })

  it('states BOTH channels on a timeout that carries both, fault first', () => {
    // The precedence rule, on the one branch where both can be present: a recorded fault outranks
    // a note everywhere, and neither may be dropped. Ranking the note first hid `lastError`, and
    // it is the more specific claim of the two and the only one that is a fault.
    const verdict = judgeEnvironmentReadiness(
      {
        status: 'provisioning',
        lastError: 'quota exceeded',
        statusNote: 'the deploy job is queued',
      },
      ENVIRONMENT_READY_TIMEOUT_MS,
    )
    expect(verdict.kind === 'timed_out' && verdict.error).toBe(
      'Environment was still provisioning after 20 minutes (readiness ceiling 20 minutes). ' +
        'Last provider error: quota exceeded Last provider note: the deploy job is queued',
    )
  })

  it('appends the note to a terminal state rather than letting it stand in for the cause', () => {
    // A note describes the spin-up the environment was in the middle of, so on a state it will
    // never leave it may not become the whole message: nothing here knows that the note is why
    // the environment ended up torn down.
    const verdict = judgeEnvironmentReadiness(
      { status: 'torn_down', statusNote: 'waiting for the load balancer' },
      0,
    )
    expect(verdict.kind).toBe('failed')
    expect(verdict.kind === 'failed' && verdict.error).toBe(
      'Environment provisioning did not complete (status: torn_down). ' +
        'Last provider note: waiting for the load balancer',
    )
  })

  it('lets the provider’s error outrank its note on a terminal state', () => {
    const verdict = judgeEnvironmentReadiness(
      { status: 'failed', lastError: 'quota exceeded', statusNote: 'waiting for the balancer' },
      0,
    )
    expect(verdict).toEqual({ kind: 'failed', error: 'quota exceeded' })
  })

  it('is byte-for-byte the old wording when the provider says nothing', () => {
    // The whole channel is opt-in: a deployment whose providers never set a note keeps exactly
    // the messages it had.
    const spent = judgeEnvironmentReadiness(
      { status: 'provisioning' },
      ENVIRONMENT_READY_TIMEOUT_MS,
    )
    expect(spent.kind === 'timed_out' && spent.error).toBe(
      'Environment was still provisioning after 20 minutes (readiness ceiling 20 minutes).',
    )
    expect(judgeEnvironmentReadiness({ status: 'expired' }, 0)).toEqual({
      kind: 'failed',
      error: 'Environment provisioning did not complete (status: expired).',
    })
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
