import { describe, expect, it } from 'vitest'
import { describeProbeFailure, probeFailureVerdict } from '../src/probeFailure.ts'

// What is pinned here is the DIFFERENCE between the causes, because that is the whole reason this
// module exists. The classification, the walk and the per-cause hints are kernel's and are tested
// there; what belongs to this suite is that a classified cause reaches the verdict with kernel's
// remedy and WITHOUT the credential guesses, and that an unclassified one keeps them.

const probe = { subject: 'the cat-factory backend', target: 'http://127.0.0.1:8787' }

/** Shaped as undici throws it: a contentless wrapper over the link that names the failure. */
function transportFailure(message: string, code: string): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error(message), { code }),
  })
}

describe('describeProbeFailure', () => {
  it('names the real cause instead of the wrapper undici throws', () => {
    const failure = describeProbeFailure(
      transportFailure('connect ECONNREFUSED 127.0.0.1:8787', 'ECONNREFUSED'),
      probe,
    )
    expect(failure.cause).toBe('refused')
    expect(failure.detail).toContain('connect ECONNREFUSED 127.0.0.1:8787')
    // Dropped by kernel because it carries nothing: the diagnosis has to LEAD with the real cause.
    expect(failure.detail).not.toContain('fetch failed')
  })

  it('relays the remedy for the classified cause rather than paraphrasing it', () => {
    // The same rule `deployment-health` follows for the backend's own config problems: the platform
    // already writes the better sentence, and a copy here would be one release behind it.
    const failure = describeProbeFailure(
      transportFailure('connect ECONNREFUSED 127.0.0.1:8787', 'ECONNREFUSED'),
      probe,
    )
    expect(failure.remedy.steps[0]).toContain('Nothing is listening at http://127.0.0.1:8787')
  })

  it('withholds the credential guesses from a cause that sent no credential', () => {
    // The misdiagnosis this replaced. A refused connection never got as far as a request, so
    // "an API key that is missing, revoked, or scoped below admin" sent an operator to inspect a
    // token that could not have been involved.
    const rendered = describeProbeFailure(
      transportFailure('connect ECONNREFUSED 127.0.0.1:8787', 'ECONNREFUSED'),
      probe,
    ).remedy.steps.join('\n')
    expect(rendered).not.toContain('CAT_FACTORY_API_KEY')
    expect(rendered).not.toContain('Full access')
  })

  it('keeps the credential guesses for an UNCLASSIFIED throw, where they are all that is known', () => {
    // An answered-and-refused request throws with no transport code, and then a rejected key really
    // is one of the candidates. "Unknown" is a state with its own remedy, not a missing one.
    const failure = describeProbeFailure(new Error('deployment answered 503'), probe)
    expect(failure.cause).toBe('unknown')
    const rendered = failure.remedy.steps.join('\n')
    expect(rendered).toContain('CAT_FACTORY_API_KEY')
    expect(rendered).toContain('WAS answered and then refused')
  })

  it('tells a certificate problem apart from a stopped deployment', () => {
    // Two setup mistakes that read identically as `fetch failed`, and whose fixes share nothing:
    // one starts a process, the other pastes a CA bundle or ticks a box.
    const failure = describeProbeFailure(
      transportFailure('self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'),
      probe,
    )
    expect(failure.cause).toBe('tls-untrusted')
    expect(failure.remedy.steps[0]).toContain('TLS certificate')
  })

  it('names the base URL as the hand-typed value it is, whatever the cause', () => {
    for (const error of [
      transportFailure('getaddrinfo ENOTFOUND backend.invalid', 'ENOTFOUND'),
      new Error('something else entirely'),
    ]) {
      const rendered = describeProbeFailure(error, probe).remedy.steps.join('\n')
      expect(rendered).toContain('CAT_FACTORY_BASE_URL (http://127.0.0.1:8787)')
    }
  })

  it('carries the read-only command that reaches the deployment with no credential', () => {
    // The half a terminal can genuinely do, and the one read that answers for a deployment too
    // broken to authenticate anything.
    const failure = describeProbeFailure(new Error('boom'), probe)
    expect(failure.remedy.commands?.[0]?.run).toBe(`curl -sS 'http://127.0.0.1:8787/health'`)
  })

  it('still describes a failure when no probe target was supplied', () => {
    // The target-naming half of the remedy is lost, never the cause: a runner that supplied no
    // context must not degrade to reporting nothing.
    const failure = describeProbeFailure(
      transportFailure('connect ECONNREFUSED 127.0.0.1:8787', 'ECONNREFUSED'),
    )
    expect(failure.cause).toBe('refused')
    expect(failure.detail).toContain('ECONNREFUSED')
    expect(failure.remedy.commands).toBeUndefined()
    expect(failure.remedy.steps.join('\n')).toContain('CAT_FACTORY_BASE_URL')
  })

  it('reports a chain that said nothing rather than rendering an empty reason', () => {
    // `getErrorMessage` answers empty for an error with nothing to say, and a verdict reading
    // `the check threw: ` states less than saying the runtime reported no reason.
    expect(describeProbeFailure(new Error(''), probe).detail).toBe(
      'The connection failed for an unreported reason.',
    )
  })
})

describe('probeFailureVerdict', () => {
  it('is an unknown verdict, never an unsatisfied one', () => {
    // `preflight.ts` rule 2: a probe that failed is not evidence about the thing probed, and
    // reporting it as "unmet" sends someone to fix a model catalog over a refused request.
    const verdict = probeFailureVerdict(
      transportFailure('connect ECONNREFUSED 127.0.0.1:8787', 'ECONNREFUSED'),
      probe,
    )
    expect(verdict.status).toBe('unknown')
  })

  it('puts the cause class on the summary line, which is all the streamed output prints', () => {
    const verdict = probeFailureVerdict(
      transportFailure('connect ECONNREFUSED 127.0.0.1:8787', 'ECONNREFUSED'),
      probe,
    )
    expect(verdict.status === 'unknown' && verdict.probeFailure).toContain(
      'could not connect (refused)',
    )
  })

  it('says "the check threw" for an unclassified failure, which may never have been a connection', () => {
    const verdict = probeFailureVerdict(new Error('deployment answered 503'), probe)
    expect(verdict.status === 'unknown' && verdict.probeFailure).toContain(
      'the check threw: deployment answered 503',
    )
  })
})
