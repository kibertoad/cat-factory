import {
  CatFactoryConnectionError,
  CatFactoryDecodeError,
  CatFactoryNotFoundError,
  CatFactoryServerError,
  CatFactoryTimeoutError,
  CatFactoryUnauthorizedError,
} from '@cat-factory/sdk'
import { describe, expect, it } from 'vitest'
import { DeploymentAnswerError } from './deploymentApi.js'
import { baseUrlStep, describeProbeFailure, probeFailureVerdict } from './probeFailure.js'
import type { SuiteIdentity } from './suiteIdentity.js'

// What is pinned here is the DIFFERENCE between the failures, because that is the whole reason this
// module exists. The chain walk, the classification and the per-cause hints are kernel's and are
// tested there; what belongs to this suite is that the facts a reader triages from stay
// distinguishable: the deployment never answered and we know why, it never answered and we do not,
// it answered with a refusal, and something answered that was not the deployment at all.
//
// Every input below is a shape one of the two REAL callers throws. That is not incidental: the
// module never sees a bare undici `TypeError`, because the SDK wraps one as a
// `CatFactoryConnectionError` and the root reads wrap one with the request named, and a test driving
// the unwrapped shape cannot see whether either wrapper still classifies.

const probe = { subject: 'the cat-factory backend', target: 'http://127.0.0.1:8787' }

/**
 * A suite, as one declares itself to the kit.
 *
 * Deliberately NOT this repository's own acceptance suite: what these assertions have to show is
 * that a remedy names the CONSUMER's variables, and pinned against the platform suite's spellings
 * they would pass just as well against a module that had hard-coded them, which is the state this
 * seam replaced.
 */
const identity: SuiteIdentity = {
  name: '@acme/acceptance',
  runCommand: 'pnpm --filter @acme/acceptance run acceptance',
  runIdVariable: 'ACME_RUN_ID',
  baseUrlVariable: 'ACME_BASE_URL',
  workspaceVariable: 'ACME_WORKSPACE_ID',
  configFile: 'acceptance/.env',
}

/** The link that names a transport failure, as Node hangs it off undici's contentless wrapper. */
function transportCause(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

/** A transport failure as the SDK re-throws one: its own wrapper over undici's over the real link. */
function sdkTransportFailure(message: string, code: string): CatFactoryConnectionError {
  return new CatFactoryConnectionError(
    'cat-factory SDK: GET /me failed to reach http://127.0.0.1:8787.',
    { cause: new TypeError('fetch failed', { cause: transportCause(message, code) }) },
  )
}

/**
 * The SDK's own client-side deadline.
 *
 * The abort marker is NAMED `AbortError` deliberately (that is how the transport tells its deadline
 * from a caller's cancellation, which it must never retry), which is exactly why this shape needs a
 * case: read by name alone it classifies as a cancelled request.
 */
function sdkDeadline(): CatFactoryTimeoutError {
  const marker = new Error('This operation was aborted')
  marker.name = 'AbortError'
  return new CatFactoryTimeoutError('cat-factory SDK: GET /me exceeded 30000ms.', { cause: marker })
}

/** A root read the deployment answered with a non-2xx, as `DeploymentApi` throws it. */
function rootRefusal(status: number, body: string): DeploymentAnswerError {
  const url = 'http://127.0.0.1:8787/health'
  return new DeploymentAnswerError({
    message: `GET ${url} failed with ${status}: ${body}`,
    status,
    answer: 'refused',
    method: 'GET',
    url,
  })
}

/** A root read that answered 2xx with something that is not the JSON the route documents. */
function rootForeignAnswer(): DeploymentAnswerError {
  const url = 'http://127.0.0.1:8787/health'
  return new DeploymentAnswerError({
    message: `GET ${url} answered 200 with a body that is not the JSON this route answers: <!DOCTYPE html>`,
    status: 200,
    answer: 'unparseable',
    method: 'GET',
    url,
    cause: new SyntaxError('Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON'),
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

/**
 * A 404 the deployment STATED, which is the opposite reading of the same status.
 *
 * `handleError` always emits a `code`, so `not_found` is the evidence that the route matched and the
 * resource did not: either it does not exist, or it lies outside the key's workspace, which the API
 * deliberately does not distinguish.
 */
function domain404(): CatFactoryNotFoundError {
  return new CatFactoryNotFoundError({
    status: 404,
    code: 'not_found',
    message: 'no such workspace',
    requestId: null,
    body: {},
  })
}

function revokedKey(): CatFactoryUnauthorizedError {
  return new CatFactoryUnauthorizedError({
    status: 401,
    code: 'unauthorized',
    message: 'revoked',
    requestId: null,
    body: {},
  })
}

describe('baseUrlStep', () => {
  it("names the suite's own variable and the file it was typed into", () => {
    expect(baseUrlStep('http://127.0.0.1:8787', identity)).toBe(
      `Re-read ACME_BASE_URL (http://127.0.0.1:8787) in acceptance/.env: it names the BACKEND ` +
        `origin serving /api/v1, not the SPA, and a shell export of the same variable wins over ` +
        `the file.`,
    )
  })

  it('drops the CLAUSES it can no longer support, not just their subjects', () => {
    // The degraded path is documented and reachable (`PreflightOptions.identity` is optional), and it
    // used to keep both trailing clauses: "a shell export of the same variable wins over the file"
    // with no variable and no file named sends a reader hunting for a configuration file this
    // message never identified. Asserted as the WHOLE string, since what is wrong with the old
    // rendering is a phrase it CONTAINS.
    expect(baseUrlStep('http://127.0.0.1:8787')).toBe(
      `Re-read the backend origin (http://127.0.0.1:8787): it names the BACKEND origin serving ` +
        `/api/v1, not the SPA.`,
    )
    expect(baseUrlStep(undefined)).toBe(
      'Re-read the backend origin: it names the BACKEND origin serving /api/v1, not the SPA.',
    )
  })

  it('scrubs the address, which may legitimately carry userinfo', () => {
    expect(baseUrlStep('https://svc:hunter2@backend.example.com', identity)).not.toContain(
      'hunter2',
    )
  })
})

describe('describeProbeFailure, when nothing answered', () => {
  it('names the real cause instead of the wrapper undici throws', () => {
    const failure = describeProbeFailure(
      sdkTransportFailure('connect ECONNREFUSED 127.0.0.1:8787', 'ECONNREFUSED'),
      probe,
      identity,
    )
    expect(failure).toMatchObject({ kind: 'unanswered', cause: 'refused' })
    expect(failure.detail).toContain('connect ECONNREFUSED 127.0.0.1:8787')
    // Dropped by kernel because it carries nothing: the diagnosis has to LEAD with the real cause.
    expect(failure.detail).not.toContain('fetch failed')
  })

  it('classifies through the SDK wrapper, and keeps the call it names', () => {
    // The shape the suite actually gets: the SDK never hands over undici's `TypeError`. Its own
    // message is the only thing that says WHICH call failed, so it is reported rather than dropped.
    const failure = describeProbeFailure(
      sdkTransportFailure('getaddrinfo ENOTFOUND backend.invalid', 'ENOTFOUND'),
      probe,
      identity,
    )
    expect(failure).toMatchObject({ kind: 'unanswered', cause: 'dns' })
    expect(failure.detail).toContain('GET /me failed to reach')
    expect(failure.detail).toContain('ENOTFOUND')
  })

  it('reads the SDK deadline as a TIMEOUT, not as a cancelled request', () => {
    // The finding this branch exists for. Its abort marker is named `AbortError`, so the chain walk
    // answered `aborted`: "a request superseded or a process shutting down: run the test again",
    // which is self-contradicting for a client-side deadline and withholds the remedy that names
    // what actually produces one, a firewall silently dropping packets or a saturated host.
    const failure = describeProbeFailure(sdkDeadline(), probe, identity)
    expect(failure).toMatchObject({ kind: 'unanswered', cause: 'timeout' })
    expect(failure.detail).toContain('exceeded 30000ms')
    const rendered = failure.remedy.steps.join('\n')
    expect(rendered).toContain('firewall')
    expect(rendered).not.toContain('run the test again')
  })

  it('relays the remedy for the classified cause rather than paraphrasing it', () => {
    // The same rule `deployment-health` follows for the backend's own config problems: the platform
    // already writes the better sentence, and a copy here would be one release behind it.
    const failure = describeProbeFailure(
      sdkTransportFailure('connect ECONNREFUSED 127.0.0.1:8787', 'ECONNREFUSED'),
      probe,
      identity,
    )
    expect(failure.remedy.steps[0]).toContain('Nothing is listening at http://127.0.0.1:8787')
  })

  it('withholds the credential guesses from a cause that sent no credential', () => {
    // The misdiagnosis this replaced. A refused connection never got as far as a request, so
    // "an API key that is missing, revoked, or scoped below admin" sent an operator to inspect a
    // token that could not have been involved.
    const rendered = describeProbeFailure(
      sdkTransportFailure('connect ECONNREFUSED 127.0.0.1:8787', 'ECONNREFUSED'),
      probe,
      identity,
    ).remedy.steps.join('\n')
    expect(rendered).not.toContain('scope is fixed when it is created')
    expect(rendered).not.toContain('Full access')
  })

  it('reports an UNCLASSIFIED throw as neither a reachability problem nor a refusal', () => {
    // "Unknown" is a state with its own remedy, not a missing one. What makes it honest is that it
    // claims neither of the two things the other branches know: no status came back, and no
    // transport code matched, so it points at the check rather than at a credential.
    const failure = describeProbeFailure(new Error('something nothing recognises'), probe, identity)
    expect(failure).toMatchObject({ kind: 'unanswered', cause: 'unknown' })
    expect(failure.remedy.steps.join('\n')).toContain(
      'neither a reachability problem nor a refusal',
    )
  })

  it('tells a certificate problem apart from a stopped deployment', () => {
    // Two setup mistakes that read identically as `fetch failed`, and whose fixes share nothing:
    // one starts a process, the other pastes a CA bundle or ticks a box.
    const failure = describeProbeFailure(
      sdkTransportFailure('self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'),
      probe,
      identity,
    )
    expect(failure).toMatchObject({ kind: 'unanswered', cause: 'tls-untrusted' })
    expect(failure.remedy.steps[0]).toContain('TLS certificate')
  })

  it('names the base URL as the hand-typed value it is, whatever the cause', () => {
    for (const error of [
      sdkTransportFailure('getaddrinfo ENOTFOUND backend.invalid', 'ENOTFOUND'),
      new Error('something else entirely'),
    ]) {
      const rendered = describeProbeFailure(error, probe, identity).remedy.steps.join('\n')
      expect(rendered).toContain('ACME_BASE_URL (http://127.0.0.1:8787)')
    }
  })

  it('carries the read-only command that reaches the deployment with no credential', () => {
    // The half a terminal can genuinely do, and the one read that answers for a deployment too
    // broken to authenticate anything.
    const failure = describeProbeFailure(new Error('boom'), probe, identity)
    expect(failure.remedy.commands?.[0]?.run).toBe(`curl -sS 'http://127.0.0.1:8787/health'`)
  })

  it('promises no command when it carries none, having no probe target to name', () => {
    // The target-naming half of the remedy is lost, never the cause: a runner that supplied no
    // context must not degrade to reporting nothing. What it must ALSO not do is keep the step that
    // says "with the command below", which sends a reader hunting for a line that was never printed.
    const failure = describeProbeFailure(
      new Error('something nothing recognises'),
      undefined,
      identity,
    )
    expect(failure).toMatchObject({ kind: 'unanswered', cause: 'unknown' })
    expect(failure.remedy.commands).toBeUndefined()
    const rendered = failure.remedy.steps.join('\n')
    expect(rendered).toContain('neither a reachability problem nor a refusal')
    expect(rendered).not.toContain('command below')
    expect(rendered).toContain('ACME_BASE_URL')
  })

  it('still describes a classified failure when no probe target was supplied', () => {
    const failure = describeProbeFailure(
      sdkTransportFailure('connect ECONNREFUSED 127.0.0.1:8787', 'ECONNREFUSED'),
      undefined,
      identity,
    )
    expect(failure).toMatchObject({ kind: 'unanswered', cause: 'refused' })
    expect(failure.detail).toContain('ECONNREFUSED')
    expect(failure.remedy.commands).toBeUndefined()
  })

  it('reports a chain that said nothing rather than rendering an empty reason', () => {
    // `getErrorMessage` answers empty for an error with nothing to say, and a verdict reading
    // `the check threw: ` states less than saying the runtime reported no reason.
    expect(describeProbeFailure(new Error(''), probe, identity).detail).toBe(
      'The connection failed for an unreported reason.',
    )
  })
})

describe('describeProbeFailure, when the deployment ANSWERED', () => {
  it('never classifies a stated refusal as a transport failure', () => {
    // A refusal the deployment stated is proof the transport worked, so running it through the
    // connection describer would report a healthy connection as an unrecognised transport failure.
    const failure = describeProbeFailure(unmatchedRoute(), probe, identity)
    expect(failure).toMatchObject({ kind: 'answered', status: 404 })
    expect(failure.remedy.steps.join('\n')).not.toContain('Nothing is listening')
  })

  it('reads an envelope-less 404 as a deployment OLDER than the suite', () => {
    // The finding this branch was written for. A new prerequisite driving an operation the running
    // build does not serve reported `the check threw: 404 unknown: HTTP 404`, whose actual fix
    // (rebuild and restart) nothing in the message pointed at.
    const rendered = describeProbeFailure(unmatchedRoute(), probe, identity).remedy.steps.join('\n')
    expect(rendered).toContain('UNMATCHED ROUTE')
    expect(rendered).toContain('OLDER than the suite driving it')
    expect(rendered).toContain('Rebuild and restart it')
  })

  it('still questions the origin on an envelope-less 404, which the SPA answers identically', () => {
    // The one answered failure where the address is not yet settled: a base URL naming the SPA 404s
    // an unknown path in exactly this shape, so it cannot be told from a backend one build behind.
    const failure = describeProbeFailure(unmatchedRoute(), probe, identity)
    expect(failure.remedy.steps.join('\n')).toContain('ACME_BASE_URL (http://127.0.0.1:8787)')
    // And it is the one answered failure that still carries the reachability read, for the same
    // reason: what is on that origin is the open question.
    expect(failure.remedy.commands?.[0]?.run).toContain('/health')
  })

  it('does NOT re-question the origin once an answer came back in our own envelope', () => {
    // A `code` our `handleError` emitted is proof the origin IS a cat-factory backend, so sending a
    // reader to re-read the address would point at the one thing this failure has settled. The
    // reachability command is withheld for exactly the same reason: it tests what is settled.
    const failure = describeProbeFailure(revokedKey(), probe, identity)
    expect(failure.remedy.steps.join('\n')).not.toContain('ACME_BASE_URL')
    expect(failure.remedy.commands).toBeUndefined()
  })

  it('reads a 404 that DID carry our envelope as a missing resource instead', () => {
    // The two 404s need opposite fixes, and the envelope is the only evidence available: our own
    // `handleError` always emits a `code`, so its absence is what says the route never matched.
    const rendered = describeProbeFailure(domain404(), probe, identity).remedy.steps.join('\n')
    // The variable BY NAME, since the remedy asks the reader to compare two values and one of them
    // is only comparable if they know which value it is.
    expect(rendered).toContain('Check ACME_WORKSPACE_ID against the workspace')
    expect(rendered).not.toContain('Rebuild and restart it')
  })

  it('paraphrases the workspace for a suite that configures no variable for one', () => {
    // Degrading by saying LESS, never by inventing a name: a deployment whose key is bound to its
    // only workspace configures no such value, and a variable named at it is one to go hunting for.
    const bare: SuiteIdentity = { ...identity, workspaceVariable: undefined }
    const rendered = describeProbeFailure(domain404(), probe, bare).remedy.steps.join('\n')
    expect(rendered).toContain('Check the workspace the suite is configured for against')
  })

  it('sends a rejected credential to a NEW token, since a scope cannot be raised', () => {
    const rendered = describeProbeFailure(revokedKey(), probe, identity).remedy.steps.join('\n')
    expect(rendered).toContain('scope is fixed when it is created')
    expect(rendered).toContain('Full access')
  })

  it('carries the request id, which is what joins the failure to the deployment log', () => {
    const rendered = describeProbeFailure(unmatchedRoute(), probe, identity).remedy.steps.join('\n')
    expect(rendered).toContain('req_abc123')
  })

  it('states no request id when the response carried none, rather than an empty one', () => {
    const rendered = describeProbeFailure(domain404(), probe, identity).remedy.steps.join('\n')
    expect(rendered).not.toContain('Quote request id')
  })

  it('offers the request id on a fault only when the response carried one', () => {
    // A gateway answering a 502 in the deployment's place sets no `X-Request-Id`, and the 5xx step
    // used to point at "the request id below" regardless, promising a line the next step omits.
    const withId = describeProbeFailure(
      new CatFactoryServerError({
        status: 503,
        code: 'unavailable',
        message: 'not wired',
        requestId: 'req_zz9',
        body: {},
      }),
      probe,
      identity,
    ).remedy.steps.join('\n')
    expect(withId).toContain('with the request id below')
    expect(withId).toContain('req_zz9')

    const withoutId = describeProbeFailure(
      new CatFactoryServerError({
        status: 502,
        code: 'internal',
        message: 'bad gateway',
        requestId: null,
        body: {},
      }),
      probe,
      identity,
    ).remedy.steps.join('\n')
    expect(withoutId).toContain('a fault worth reporting.')
    expect(withoutId).not.toContain('request id below')
  })
})

describe('describeProbeFailure, when a ROOT read answered', () => {
  it('reports the status rather than claiming no status came back', () => {
    // `deployment-health` is the FIRST prerequisite and the one an operator reads as causal. Thrown
    // as a plain `Error`, its non-2xx fell through to the unclassified remedy, which asserts "no
    // HTTP status came back … suspect the check itself" one line under a detail quoting the 404.
    const failure = describeProbeFailure(rootRefusal(404, '<!DOCTYPE html>'), probe, identity)
    expect(failure).toMatchObject({ kind: 'answered', status: 404 })
    const rendered = failure.remedy.steps.join('\n')
    expect(rendered).not.toContain('no HTTP status came back')
    expect(rendered).not.toContain('suspect the check itself')
    expect(rendered).toContain('answered 404')
  })

  it('states that no credential was involved, since both root reads are unauthenticated', () => {
    // The guidance that used to ride on the message, now a step: it is what keeps a reader from
    // going to inspect a key this read never sent.
    const rendered = describeProbeFailure(
      rootRefusal(503, 'upstream down'),
      probe,
      identity,
    ).remedy.steps.join('\n')
    expect(rendered).toContain('no credential by design')
    expect(rendered).toContain('ACME_BASE_URL (http://127.0.0.1:8787)')
  })

  it('keeps the deployment’s own account of itself instead of truncating it away', () => {
    // The reader is a terminal, not a toast. Under the human-sized cap a 502 with a few hundred
    // characters of body lost its tail, which for a root read is where the fix is named.
    const body = `${'upstream connect error '.repeat(20)}END-OF-BODY`
    const failure = describeProbeFailure(rootRefusal(502, body), probe, identity)
    expect(failure.detail).toContain('END-OF-BODY')
    expect(failure.detail).not.toContain('more characters of the cause chain')
  })

  it('sends a credential demand at the root to whatever is in FRONT of the deployment', () => {
    // These two routes require nothing, so a 401 here is an access gateway or a protected preview,
    // not the suite's key. Nothing the suite holds can satisfy it.
    const rendered = describeProbeFailure(
      rootRefusal(401, 'Unauthorized'),
      probe,
      identity,
    ).remedy.steps.join('\n')
    expect(rendered).toContain('in FRONT of the deployment')
    // The suite's own key is NAMED, to say it is not implicated: an unexplained 401 is the one that
    // sends a reader to re-mint a token, which is what this whole branch exists to head off.
    expect(rendered).toContain('nothing about the API key is implicated')
    expect(rendered).not.toContain('mint a new one')
  })

  it('sends a root-read fault to the deployment log rather than to a misconfiguration', () => {
    const rendered = describeProbeFailure(
      rootRefusal(500, 'boom'),
      probe,
      identity,
    ).remedy.steps.join('\n')
    expect(rendered).toContain('Read the deployment log')
    expect(rendered).toContain('boot failure or a gateway')
  })
})

describe('describeProbeFailure, when something that is not the deployment answered', () => {
  it('reads a root read’s non-JSON 2xx as a fact about the ORIGIN', () => {
    const failure = describeProbeFailure(rootForeignAnswer(), probe, identity)
    expect(failure.kind).toBe('foreign')
    const rendered = failure.remedy.steps.join('\n')
    expect(rendered).toContain('it was not this deployment')
    expect(rendered).toContain('ACME_BASE_URL (http://127.0.0.1:8787)')
    // Not a refusal, so the remedy says nothing about the request or the credential.
    expect(rendered).not.toContain('scope is fixed when it is created')
    expect(failure.detail).toContain('<!DOCTYPE html>')
  })

  it('reads the SDK decode failure the same way, which is a proxy answering for /api/v1', () => {
    // `CatFactoryDecodeError` is not a `CatFactoryApiError`, so it used to reach the transport
    // branch and be reported as a check that might be broken. It is the SPA or a gateway.
    const failure = describeProbeFailure(
      new CatFactoryDecodeError(
        'cat-factory SDK: GET /me returned a body that is not JSON.',
        '<!DOCTYPE html><title>SPA</title>',
        { cause: new SyntaxError("Unexpected token '<'") },
      ),
      probe,
      identity,
    )
    expect(failure.kind).toBe('foreign')
    expect(failure.remedy.steps.join('\n')).toContain('it was not this deployment')
    expect(failure.detail).toContain('not JSON')
  })
})

describe('the remedy every probe failure carries', () => {
  it('says how to RESUME rather than claiming a re-run starts clean', () => {
    // The gate runs in EVERY scenario's `beforeAll` by design, so a resumed pass reaches it with
    // services adopted and pull requests open. Told a re-run starts clean, that operator starts a
    // second pass, which `board-titles` then refuses.
    const rendered = describeProbeFailure(new Error('boom'), probe, identity).remedy.steps.join(
      '\n',
    )
    expect(rendered).toContain('ACME_RUN_ID')
    expect(rendered).not.toContain('Nothing was created')
  })

  it('scrubs a credential the base URL itself carries, in the step AND in the command', () => {
    // Userinfo is legal in a base URL and no URL policy rejects one, and this text is thrown out of
    // `beforeAll` and printed. kernel scrubs the target inside its own hints for the same reason.
    const failure = describeProbeFailure(
      new Error('boom'),
      {
        subject: 'the cat-factory backend',
        target: 'https://svc:hunter2@backend.example.com',
      },
      identity,
    )
    const rendered = `${failure.remedy.steps.join('\n')}\n${failure.remedy.commands?.[0]?.run}`
    expect(rendered).toContain('svc:[REDACTED]@backend.example.com')
    expect(rendered).not.toContain('hunter2')
  })

  it('keeps the command pasteable when the address holds a quote', () => {
    // A remedy whose command does not parse is worse than one with no command, because it is
    // offered as the thing to run. POSIX has no escape inside single quotes.
    const failure = describeProbeFailure(
      new Error('boom'),
      {
        target: "http://127.0.0.1:8787/it's",
      },
      identity,
    )
    expect(failure.remedy.commands?.[0]?.run).toBe(
      `curl -sS 'http://127.0.0.1:8787/it'\\''s/health'`,
    )
  })
})

describe('probeFailureVerdict', () => {
  it('is an unknown verdict, never an unsatisfied one', () => {
    // `preflight.ts` rule 2: a probe that failed is not evidence about the thing probed, and
    // reporting it as "unmet" sends someone to fix a model catalog over a refused request.
    const verdict = probeFailureVerdict(
      sdkTransportFailure('connect ECONNREFUSED 127.0.0.1:8787', 'ECONNREFUSED'),
      probe,
      identity,
    )
    expect(verdict.status).toBe('unknown')
  })

  it('puts the cause class on the summary line, which is all the streamed output prints', () => {
    const verdict = probeFailureVerdict(
      sdkTransportFailure('connect ECONNREFUSED 127.0.0.1:8787', 'ECONNREFUSED'),
      probe,
      identity,
    )
    expect(verdict.status === 'unknown' && verdict.probeFailure).toContain(
      'could not connect (refused)',
    )
  })

  it('says "the check threw" for an unclassified failure, which may never have been a connection', () => {
    const verdict = probeFailureVerdict(new Error('deployment answered 503'), probe, identity)
    expect(verdict.status === 'unknown' && verdict.probeFailure).toContain(
      'the check threw: deployment answered 503',
    )
  })

  it('says the deployment REFUSED when it answered, which is the opposite of unreachable', () => {
    // The summaries stay distinct because this line is the only part the streamed
    // one-per-prerequisite output prints, and it is what a reader triages from.
    const verdict = probeFailureVerdict(unmatchedRoute(), probe, identity)
    const summary = verdict.status === 'unknown' ? verdict.probeFailure : ''
    expect(summary).toContain('the deployment refused the check')
    expect(summary).toContain('404 unknown')
    expect(summary).not.toContain('could not connect')
  })

  it('says something ELSE answered when the shape was nobody’s, which needs a third fix', () => {
    const verdict = probeFailureVerdict(rootForeignAnswer(), probe, identity)
    const summary = verdict.status === 'unknown' ? verdict.probeFailure : ''
    expect(summary).toContain('something that is not this deployment answered')
    expect(summary).not.toContain('refused the check')
    expect(summary).not.toContain('could not connect')
  })
})
