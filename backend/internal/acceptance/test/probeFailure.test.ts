import { CatFactoryNotFoundError, CatFactoryUnauthorizedError } from '@cat-factory/sdk'
import { describe, expect, it } from 'vitest'
import { describeProbeFailure, probeFailureVerdict } from '../src/probeFailure.ts'

// What is pinned here is the DIFFERENCE between the failures, because that is the whole reason this
// module exists. The chain walk, the classification and the per-cause hints are kernel's and are
// tested there; what belongs to this suite is that the three facts a reader triages from stay
// distinguishable: the deployment never answered and we know why, it never answered and we do not,
// and it answered with a refusal.

const probe = { subject: 'the cat-factory backend', target: 'http://127.0.0.1:8787' }

/** Shaped as undici throws it: a contentless wrapper over the link that names the failure. */
function transportFailure(message: string, code: string): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error(message), { code }),
  })
}

/**
 * An unmatched ROUTE, as the SDK renders one: Hono's built-in 404 carries no error envelope, so the
 * SDK fills `code` with `unknown` rather than the `not_found` our own `handleError` would emit.
 */
function unmatchedRoute(): CatFactoryNotFoundError {
  return new CatFactoryNotFoundError({
    status: 404,
    code: 'unknown',
    message: 'HTTP 404',
    requestId: 'req_abc123',
    body: '404 Not Found',
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

  it('reports an UNCLASSIFIED throw as neither a reachability problem nor a refusal', () => {
    // "Unknown" is a state with its own remedy, not a missing one. What makes it honest is that it
    // claims neither of the two things the other branches know: no status came back, and no
    // transport code matched, so it points at the check rather than at a credential.
    const failure = describeProbeFailure(new Error('something nothing recognises'), probe)
    expect(failure.cause).toBe('unknown')
    expect(failure.status).toBeUndefined()
    expect(failure.remedy.steps.join('\n')).toContain(
      'neither a reachability problem nor a refusal',
    )
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

describe('describeProbeFailure, when the deployment ANSWERED', () => {
  it('never classifies a stated refusal as a transport failure', () => {
    // A refusal the deployment stated is proof the transport worked, so running it through the
    // connection describer would report a healthy connection as an unrecognised transport failure.
    const failure = describeProbeFailure(unmatchedRoute(), probe)
    expect(failure.status).toBe(404)
    expect(failure.remedy.steps.join('\n')).not.toContain('Nothing is listening')
  })

  it('reads an envelope-less 404 as a deployment OLDER than the suite', () => {
    // The finding this branch was written for. A new prerequisite driving an operation the running
    // build does not serve reported `the check threw: 404 unknown: HTTP 404`, whose actual fix
    // (rebuild and restart) nothing in the message pointed at.
    const rendered = describeProbeFailure(unmatchedRoute(), probe).remedy.steps.join('\n')
    expect(rendered).toContain('UNMATCHED ROUTE')
    expect(rendered).toContain('OLDER than this suite')
    expect(rendered).toContain('pnpm build')
  })

  it('still questions the origin on an envelope-less 404, which the SPA answers identically', () => {
    // The one answered failure where the address is not yet settled: a base URL naming the SPA 404s
    // an unknown path in exactly this shape, so it cannot be told from a backend one build behind.
    const rendered = describeProbeFailure(unmatchedRoute(), probe).remedy.steps.join('\n')
    expect(rendered).toContain('CAT_FACTORY_BASE_URL (http://127.0.0.1:8787)')
  })

  it('does NOT re-question the origin once an answer came back in our own envelope', () => {
    // A `code` our `handleError` emitted is proof the origin IS a cat-factory backend, so sending a
    // reader to re-read the address would point at the one thing this failure has settled.
    const rendered = describeProbeFailure(
      new CatFactoryUnauthorizedError({
        status: 401,
        code: 'unauthorized',
        message: 'revoked',
        requestId: null,
        body: {},
      }),
      probe,
    ).remedy.steps.join('\n')
    expect(rendered).not.toContain('CAT_FACTORY_BASE_URL')
  })

  it('reads a 404 that DID carry our envelope as a missing resource instead', () => {
    // The two 404s need opposite fixes, and the envelope is the only evidence available: our own
    // `handleError` always emits a `code`, so its absence is what says the route never matched.
    const rendered = describeProbeFailure(
      new CatFactoryNotFoundError({
        status: 404,
        code: 'not_found',
        message: 'no such workspace',
        requestId: null,
        body: {},
      }),
      probe,
    ).remedy.steps.join('\n')
    expect(rendered).toContain('ACCEPTANCE_WORKSPACE_ID')
    expect(rendered).not.toContain('pnpm build')
  })

  it('sends a rejected credential to a NEW token, since a scope cannot be raised', () => {
    const rendered = describeProbeFailure(
      new CatFactoryUnauthorizedError({
        status: 401,
        code: 'unauthorized',
        message: 'revoked',
        requestId: null,
        body: {},
      }),
      probe,
    ).remedy.steps.join('\n')
    expect(rendered).toContain('scope is fixed when it is created')
    expect(rendered).toContain('CAT_FACTORY_API_KEY')
  })

  it('carries the request id, which is what joins the failure to the deployment log', () => {
    const rendered = describeProbeFailure(unmatchedRoute(), probe).remedy.steps.join('\n')
    expect(rendered).toContain('req_abc123')
  })

  it('states no request id when the response carried none, rather than an empty one', () => {
    const rendered = describeProbeFailure(
      new CatFactoryNotFoundError({
        status: 404,
        code: 'not_found',
        message: 'gone',
        requestId: null,
        body: {},
      }),
      probe,
    ).remedy.steps.join('\n')
    expect(rendered).not.toContain('Quote request id')
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

  it('says the deployment REFUSED when it answered, which is the opposite of unreachable', () => {
    // The three summaries stay distinct because this line is the only part the streamed
    // one-per-prerequisite output prints, and it is what a reader triages from.
    const verdict = probeFailureVerdict(unmatchedRoute(), probe)
    const summary = verdict.status === 'unknown' ? verdict.probeFailure : ''
    expect(summary).toContain('the deployment refused the check')
    expect(summary).toContain('404 unknown')
    expect(summary).not.toContain('could not connect')
  })
})
