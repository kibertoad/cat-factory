import { describe, expect, it } from 'vitest'
import { connectionFailureResult, describeConnectionFailure } from './connection-failure.logic.js'

/**
 * Build the shape Node/undici actually throws from `fetch`: a generic `TypeError` wrapper whose
 * `.cause` carries the real failure and its `code`. Reading `error.message` on this is what
 * produced the bare "fetch failed" these helpers exist to replace, so every case starts here.
 */
function fetchFailure(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause })
}

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('describeConnectionFailure', () => {
  it('names the refused connection buried under the fetch wrapper', () => {
    const result = describeConnectionFailure(
      fetchFailure(coded('connect ECONNREFUSED 127.0.0.1:6443', 'ECONNREFUSED')),
      { subject: 'the Kubernetes apiserver', target: 'https://127.0.0.1:6443' },
    )
    expect(result.cause).toBe('refused')
    expect(result.detail).toBe('connect ECONNREFUSED 127.0.0.1:6443')
    // The wrapper is dropped precisely because it is the string the old code rendered alone.
    expect(result.detail).not.toContain('fetch failed')
    expect(result.hint).toContain('https://127.0.0.1:6443')
    expect(result.hint).toContain('The Kubernetes apiserver')
  })

  it('reads every branch of the AggregateError a dual-stack localhost produces', () => {
    // `localhost` resolving to both ::1 and 127.0.0.1 is the single most common local-k3s shape,
    // and the per-address detail is what tells an operator the cluster is down rather than that
    // one address family is unlistened.
    const aggregate = Object.assign(
      new AggregateError(
        [
          coded('connect ECONNREFUSED ::1:6443', 'ECONNREFUSED'),
          coded('connect ECONNREFUSED 127.0.0.1:6443', 'ECONNREFUSED'),
        ],
        '',
      ),
      { code: 'ECONNREFUSED' },
    )
    const result = describeConnectionFailure(fetchFailure(aggregate))
    expect(result.cause).toBe('refused')
    expect(result.detail).toContain('::1:6443')
    expect(result.detail).toContain('127.0.0.1:6443')
  })

  it('tells the TLS failures apart, because each has a different fix', () => {
    const untrusted = describeConnectionFailure(
      fetchFailure(coded('self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT')),
    )
    expect(untrusted.cause).toBe('tls-untrusted')
    expect(untrusted.hint).toContain('Skip TLS verification')

    const hostname = describeConnectionFailure(
      fetchFailure(
        coded("Hostname/IP does not match certificate's altnames", 'ERR_TLS_CERT_ALTNAME_INVALID'),
      ),
    )
    expect(hostname.cause).toBe('tls-hostname')
    expect(hostname.hint).not.toContain('Skip TLS verification')

    const protocol = describeConnectionFailure(
      fetchFailure(coded('wrong version number', 'ERR_SSL_WRONG_VERSION_NUMBER')),
    )
    expect(protocol.cause).toBe('tls-protocol')
    expect(protocol.hint).toContain('PLAIN-HTTP')
  })

  it('reads the innermost cause, not the generic wrapper undici puts around it', () => {
    // undici wraps a mid-handshake TLS failure in a `SocketError` whose own `UND_ERR_SOCKET` is a
    // recognised cause (`reset`). Answering with the outermost match sent the operator looking for
    // a proxy instead of pasting a CA bundle: the misdiagnosis this module exists to prevent.
    const result = describeConnectionFailure(
      fetchFailure(
        Object.assign(new Error('other side closed'), {
          code: 'UND_ERR_SOCKET',
          cause: coded('self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'),
        }),
      ),
    )
    expect(result.cause).toBe('tls-untrusted')
    expect(result.hint).toContain('Skip TLS verification')
  })

  it('counts identical aggregate branches instead of folding them into one', () => {
    // undici emits address-less `connect ECONNREFUSED` forms, so a dual-stack refusal routinely
    // renders the same text twice. Dropping the duplicate made "refused on both addresses" read
    // byte-for-byte like "refused on one", which is the distinction the branches are walked for.
    const aggregate = new AggregateError(
      [
        coded('connect ECONNREFUSED', 'ECONNREFUSED'),
        coded('connect ECONNREFUSED', 'ECONNREFUSED'),
      ],
      '',
    )
    expect(describeConnectionFailure(fetchFailure(aggregate)).detail).toBe(
      'connect ECONNREFUSED (x2)',
    )
  })

  it('recognises the probe timeout, which arrives as a DOMException with no code', () => {
    const timeout = new Error('The operation was aborted due to timeout')
    timeout.name = 'TimeoutError'
    const result = describeConnectionFailure(timeout, { subject: 'the runner pool API' })
    expect(result.cause).toBe('timeout')
    expect(result.hint).toContain('The runner pool API')
  })

  it('keeps a CANCELLED request apart from a timed-out one', () => {
    // `AbortSignal.timeout()` aborts with a `TimeoutError`, so an `AbortError` is some other
    // abort. Folded into `timeout` it sent the operator to inspect firewalls and security groups
    // over a request that was never allowed to finish.
    const aborted = new Error('This operation was aborted')
    aborted.name = 'AbortError'
    const result = describeConnectionFailure(aborted, { subject: 'the runner pool API' })
    expect(result.cause).toBe('aborted')
    expect(result.hint).toContain('run the test again')
    expect(result.hint).not.toContain('firewall')
  })

  it('recognises a header rejected for a control character, which carries no code either', () => {
    // The token-pasted-with-a-newline case: undici refuses to build the request, so this never
    // reaches the network and there is no `code` to key on.
    const result = describeConnectionFailure(new TypeError('Invalid header value'))
    expect(result.cause).toBe('invalid-header')
    expect(result.hint).toContain('single unbroken line')
  })

  it("does not read Go's JSON decode error as a badly pasted credential", () => {
    // `invalid character 'e' looking for beginning of value` is what a kube-apiserver or an
    // intercepting proxy answers with when something returns HTML instead of JSON. Matched on the
    // bare words "invalid character", it told that operator to re-copy a credential that was fine.
    const result = describeConnectionFailure(
      new Error("invalid character 'e' looking for beginning of value"),
    )
    expect(result.cause).toBe('unknown')
    expect(result.hint).toBeUndefined()
  })

  it('appends the code when the message omits it, so the exact identifier is always present', () => {
    const result = describeConnectionFailure(
      fetchFailure(coded('certificate has expired', 'CERT_HAS_EXPIRED')),
    )
    expect(result.detail).toBe('certificate has expired (CERT_HAS_EXPIRED)')
  })

  it('reports an unrecognised failure verbatim rather than guessing a remedy', () => {
    const result = describeConnectionFailure(new Error('Environment base URL is not permitted'))
    expect(result.cause).toBe('unknown')
    expect(result.detail).toBe('Environment base URL is not permitted')
    expect(result.hint).toBeUndefined()
  })

  it('passes our own refusal through intact, with no status class glued on and nothing scrubbed', () => {
    // Our refusals reach these catch blocks too: the apiserver client rejects a token that cannot
    // become a header before it ever dials. Two ways that message could be damaged on the way out,
    // both asserted against the REAL wording rather than a stand-in.
    //
    // 1. A `DomainError`'s `code` is a lowercase status class, not a transport code, so appending
    //    it would render as a baffling `(validation)` after a finished sentence.
    // 2. `redactSecrets` drops the run of characters after a bare `token`/`bearer`, so a message
    //    ABOUT a token can be mangled into advice with a `[REDACTED]` hole in it.
    const refusal = Object.assign(
      new Error(
        "The Kubernetes ServiceAccount token ('apiToken') contains a space or line break, which " +
          'a bearer token never does and an HTTP header cannot carry.',
      ),
      { code: 'validation' },
    )
    const result = describeConnectionFailure(refusal)
    expect(result.cause).toBe('unknown')
    expect(result.detail).not.toContain('(validation)')
    expect(result.detail).not.toContain('[REDACTED]')
    expect(result.detail).toContain('contains a space or line break')
  })

  it('keeps the bare wrapper when it is the only thing there is', () => {
    expect(describeConnectionFailure(fetchFailure(undefined)).detail).toBe('fetch failed')
  })

  it('scrubs a credential the transport error echoed back from the request URL', () => {
    const result = describeConnectionFailure(
      fetchFailure(
        coded('connect ECONNREFUSED https://h.test/x?token=abcd1234EFGH', 'ECONNREFUSED'),
      ),
    )
    expect(result.detail).not.toContain('abcd1234EFGH')
  })

  it('scrubs a credential the CALLER put in the probed URL, not just the error text', () => {
    // Nothing rejects userinfo in a base URL, so an operator can legitimately configure
    // `https://user:secret@host`. That string comes from the config rather than from the error, so
    // the hint is the only thing that touches it, and this verdict is rendered AND logged.
    const result = describeConnectionFailure(
      fetchFailure(coded('getaddrinfo ENOTFOUND envs.corp.test', 'ENOTFOUND')),
      { target: 'https://svc:hunter2primary@envs.corp.test/' },
    )
    expect(result.hint).not.toContain('hunter2primary')
    expect(result.hint).toContain('envs.corp.test')
  })

  it('scrubs BEFORE capping, so a secret cut in half cannot slip past the patterns', () => {
    // A JWT straddling the cap: sliced first, its surviving head matches no shape rule (the bearer
    // rule needs 8+ token characters, the JWT rule needs all three segments) and shipped verbatim.
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYXQtZmFjdG9yeSJ9.c2lnbmF0dXJlLXZhbHVlLWhlcmU'
    const result = describeConnectionFailure(
      fetchFailure(coded(`${'x'.repeat(370)} authorization: Bearer ${jwt}`, 'ECONNRESET')),
    )
    expect(result.detail).not.toContain('eyJ')
    expect(result.detail).toContain('[REDACTED]')
  })

  it('says that a capped chain was capped, rather than reading as the whole of it', () => {
    // A silent slice is indistinguishable from a complete chain, so a reader concludes the inner
    // links were never there.
    const result = describeConnectionFailure(new Error('a'.repeat(600)))
    expect(result.detail).toContain('more characters of the cause chain')
    expect(result.detail.startsWith('a'.repeat(400))).toBe(true)
  })

  it('survives a non-Error throw and a self-referential cause chain', () => {
    expect(describeConnectionFailure('just a string').detail).toBe('just a string')
    const looped: Error & { cause?: unknown } = new Error('round and round')
    looped.cause = looped
    expect(describeConnectionFailure(looped).detail).toBe('round and round')
  })
})

describe('connectionFailureResult', () => {
  it('renders the detail then the remedy as one operator-facing line', () => {
    const { message } = connectionFailureResult(
      fetchFailure(coded('getaddrinfo ENOTFOUND cluster.internal', 'ENOTFOUND')),
      { target: 'https://cluster.internal:6443' },
    )
    expect(message?.startsWith('getaddrinfo ENOTFOUND cluster.internal.')).toBe(true)
    expect(message).toContain('does not resolve')
  })

  it('is the detail alone when nothing actionable is known', () => {
    expect(connectionFailureResult(new Error('something odd')).message).toBe('something odd')
  })

  it('carries the machine-readable cause beside the English message', () => {
    // The message is English by construction and the SPA ships in ten languages, so the cause is
    // the half a localized verdict can render. A hand-built `{ ok: false, message }` cannot carry
    // it, which is why every probe answers through here.
    const result = connectionFailureResult(
      fetchFailure(coded('connect ECONNREFUSED 127.0.0.1:6443', 'ECONNREFUSED')),
      { subject: 'the Kubernetes apiserver', target: 'https://127.0.0.1:6443' },
    )
    expect(result).toMatchObject({ ok: false, failureCause: 'refused' })
    expect(result.message).toContain('ECONNREFUSED')
  })

  it('reports an unrecognised failure as `unknown` rather than omitting the cause', () => {
    // Absent and unknown are different facts: absent means the probe got an ANSWER (a status the
    // provider maps itself), so the SPA must be able to tell them apart.
    expect(connectionFailureResult(new Error('Environment base URL is not permitted'))).toEqual({
      ok: false,
      message: 'Environment base URL is not permitted',
      failureCause: 'unknown',
    })
  })
})
