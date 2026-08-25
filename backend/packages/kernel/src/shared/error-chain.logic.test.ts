import { describe, expect, it } from 'vitest'
import { getErrorMessage } from '../domain/errors.js'
import { describeError } from './best-effort.js'
import { describeConnectionFailure } from './connection-failure.logic.js'
import {
  errorChainDiagnosisText,
  errorChainMatches,
  errorChainText,
  MAX_ERROR_CHAIN_CHARS,
  MAX_LOGGED_ERROR_CHAIN_CHARS,
  publicDiagnostic,
} from './error-chain.logic.js'

/**
 * Build the shape Node/undici actually throws from `fetch`: a generic `TypeError` wrapper whose
 * `.cause` carries the real failure and its `code`. Reading `error.message` on this is what made
 * every non-probe surface in the product report "fetch failed" and nothing else.
 */
function fetchFailure(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause })
}

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('errorChainText', () => {
  it('leaves an ordinary error exactly as it was', () => {
    // The no-cause case is the overwhelming majority of throws in the repo, and it must read
    // byte-for-byte as before: this change adds causes, it does not reformat messages.
    expect(errorChainText(new Error('Missing secret values for: apiToken'))).toBe(
      'Missing secret values for: apiToken',
    )
  })

  it('appends the cause undici hides behind its wrapper', () => {
    expect(
      errorChainText(fetchFailure(coded('connect ECONNREFUSED 127.0.0.1:6443', 'ECONNREFUSED'))),
    ).toBe('fetch failed: connect ECONNREFUSED 127.0.0.1:6443')
  })

  it('KEEPS the leading link that describeConnectionFailure drops', () => {
    // The one deliberate divergence between the two describers, and it is load-bearing in both
    // directions: a probe's verdict leads with the real cause because it is read as a diagnosis,
    // while this string is what a `DispatchError` carries and what downstream checks match by
    // their opening phrase. Dropping a leading link here would silently re-point those matches.
    const error = fetchFailure(coded('self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'))
    expect(errorChainText(error).startsWith('fetch failed')).toBe(true)
    expect(describeConnectionFailure(error).detail.startsWith('fetch failed')).toBe(false)
  })

  it('keeps a matched opening phrase matchable', () => {
    // `isDispatchFailure`'s regex fallback and the eviction sentinels match the FIRST phrase; the
    // appended causes must not move it.
    const wrapped = new Error('harness dispatch failed (HTTP 404): no route', {
      cause: new Error('upstream said so'),
    })
    expect(errorChainText(wrapped).startsWith('harness dispatch failed (HTTP 404)')).toBe(true)
  })

  it('reads every branch of the AggregateError a dual-stack localhost produces', () => {
    const aggregate = Object.assign(
      new AggregateError([
        coded('connect ECONNREFUSED ::1:6443', 'ECONNREFUSED'),
        coded('connect ECONNREFUSED 127.0.0.1:6443', 'ECONNREFUSED'),
      ]),
      { code: 'ECONNREFUSED' },
    )
    const text = errorChainText(fetchFailure(aggregate))
    expect(text).toContain('::1:6443')
    expect(text).toContain('127.0.0.1:6443')
  })

  it('folds identically-rendered branches into a count instead of dropping one', () => {
    // undici emits address-less `connect ECONNREFUSED` forms, so "refused on both addresses" and
    // "refused on one" would otherwise render byte-for-byte alike.
    const aggregate = new AggregateError([
      coded('connect ECONNREFUSED', 'ECONNREFUSED'),
      coded('connect ECONNREFUSED', 'ECONNREFUSED'),
    ])
    expect(errorChainText(aggregate)).toContain('(x2)')
  })

  it('appends the transport code when the message does not carry it', () => {
    expect(errorChainText(coded('write EPIPE', 'UND_ERR_SOCKET'))).toBe(
      'write EPIPE (UND_ERR_SOCKET)',
    )
  })

  it('ignores a lowercase status-class code (our own DomainError shape)', () => {
    // A `(validation)` glued onto an already-complete refusal reads as nonsense to whoever gets it.
    expect(errorChainText(coded('Pick a merge preset', 'validation'))).toBe('Pick a merge preset')
  })

  it('terminates on a cause cycle instead of re-rendering the same link', () => {
    const outer: Error & { cause?: unknown } = new Error('outer')
    const inner = new Error('inner', { cause: outer })
    outer.cause = inner
    const text = errorChainText(outer)
    expect(text).toBe('outer: inner')
  })

  it('scrubs a credential the error text echoed back, before the cap applies', () => {
    const text = errorChainText(
      new Error('POST https://api.example.test/hook', {
        cause: new Error('rejected token=abcd1234EFGHijkl5678'),
      }),
    )
    expect(text).not.toContain('abcd1234EFGHijkl5678')
    expect(text).toContain('api.example.test')
  })

  it('says how much of a pathological chain it dropped', () => {
    const text = errorChainText(new Error('x'.repeat(MAX_ERROR_CHAIN_CHARS + 120)))
    expect(text.length).toBeLessThan(MAX_ERROR_CHAIN_CHARS + 60)
    expect(text).toContain('more characters of the cause chain')
  })

  it('still names a thrown non-Error, including null', () => {
    // `throw null` walks to no links at all, and reporting '' would read as a failure nobody
    // described rather than one with nothing behind it.
    expect(errorChainText(null)).toBe('null')
    expect(errorChainText(undefined)).toBe('undefined')
    expect(errorChainText('just a string')).toBe('just a string')
    expect(errorChainText(404)).toBe('404')
  })

  it('says NOTHING for an error with nothing to say, so a caller fallback still fires', () => {
    // `String(new Error(''))` is `Error`, the base constructor name every error shares. Answering
    // with it turns every `getErrorMessage(err) || '<what to do about it>'` guard in the repo into
    // dead code and prints `Error` where the actionable sentence belongs.
    expect(errorChainText(new Error(''))).toBe('')
    expect(errorChainText(new Error('')) || 'Docker daemon not reachable').toBe(
      'Docker daemon not reachable',
    )
  })

  it('keeps a CUSTOM error name, which is the one fact a message-less error has', () => {
    expect(errorChainText(Object.assign(new Error(''), { name: 'AbortError' }))).toBe('AbortError')
  })

  it('describes a value whose own accessors throw instead of throwing itself', () => {
    // The describer runs inside `runBestEffort`'s catch and inside the durable drivers' `.catch`
    // handlers, whose contract is not to propagate. A throwing getter on a thrown SDK object must
    // therefore cost a link, never turn a swallowed failure into an unhandled rejection.
    const hostile = new Error('outer')
    Object.defineProperty(hostile, 'cause', {
      get() {
        throw new Error('cause getter exploded')
      },
    })
    expect(errorChainText(hostile)).toBe('outer')

    const unstringifiable = {
      toString() {
        throw new Error('toString exploded')
      },
    }
    expect(() => errorChainText(unstringifiable)).not.toThrow()
    expect(() =>
      errorChainText({
        message: 'x',
        get code() {
          throw new Error('boom')
        },
      }),
    ).not.toThrow()
  })

  it('bounds how many branches of one aggregate it walks, and SAYS what it skipped', () => {
    // A `Promise.any` over a fleet rejects with one branch per endpoint. Walking hundreds to
    // render a few hundred characters is work thrown away; walking eight silently would render
    // "(x8)", which reads as eight being all there were.
    const wide = new AggregateError(
      Array.from({ length: 40 }, (_unused, i) => new Error(`endpoint ${i} refused`)),
    )
    const text = errorChainText(wide, 10_000)
    expect(text).toContain('endpoint 0 refused')
    expect(text).toContain('more branches not read')
    expect(text).not.toContain('endpoint 39 refused')
  })

  it('caps to the budget the CALLER asks for, so a log line is not held to the UI budget', () => {
    const long = new Error('y'.repeat(2_000))
    expect(errorChainText(long).length).toBeLessThan(MAX_ERROR_CHAIN_CHARS + 60)
    expect(errorChainText(long, MAX_LOGGED_ERROR_CHAIN_CHARS)).toBe('y'.repeat(2_000))
  })
})

describe('errorChainMatches', () => {
  it('recognises a sentinel phrase sitting past the DISPLAY cap', () => {
    // The bug this exists for: a verdict read off `getErrorMessage` inherits that string's
    // 400-char budget, so a long wrapper pushes the phrase out of reach and a rollout stop is
    // misclassified as a crash, spending a healthy run's eviction budget.
    const buried = new Error('a'.repeat(MAX_ERROR_CHAIN_CHARS + 50), {
      cause: new Error('runtime signalled the container to exit'),
    })
    expect(errorChainText(buried)).not.toContain('runtime signalled')
    expect(errorChainMatches(buried, /runtime signalled the container to exit/i)).toBe(true)
  })

  it('answers the same on a repeat call with a global pattern', () => {
    const pattern = /refused/g
    const error = new Error('connection refused')
    expect(errorChainMatches(error, pattern)).toBe(true)
    expect(errorChainMatches(error, pattern)).toBe(true)
  })
})

describe('publicDiagnostic', () => {
  it('answers an UNAUTHENTICATED caller with the outermost link only', () => {
    // `/ready` is public on both facades. The chain is what makes an error useful to the operator
    // and what makes this field a leak: the inner link is the deployment's database address.
    const poolFailure = new Error('Connection terminated unexpectedly', {
      cause: coded('connect ECONNREFUSED 10.4.2.7:5432', 'ECONNREFUSED'),
    })
    expect(publicDiagnostic(poolFailure)).toBe('Connection terminated unexpectedly')
    expect(publicDiagnostic(poolFailure)).not.toContain('10.4.2.7')
  })

  it('scrubs what it does answer with', () => {
    expect(publicDiagnostic(new Error('rejected token=abcd1234EFGHijkl5678'))).not.toContain(
      'abcd1234EFGHijkl5678',
    )
  })
})

describe('the three describers agree on the chain', () => {
  const error = fetchFailure(coded('getaddrinfo ENOTFOUND cluster.internal', 'ENOTFOUND'))

  it('getErrorMessage reports it (the string a human is shown)', () => {
    expect(getErrorMessage(error)).toContain('getaddrinfo ENOTFOUND cluster.internal')
  })

  it('describeError reports it (the log line an operator greps)', () => {
    expect(describeError(error)).toEqual({
      err: 'fetch failed: getaddrinfo ENOTFOUND cluster.internal',
      errKind: 'TypeError',
    })
  })

  it('describeConnectionFailure reports it AND classifies it (the probe verdict)', () => {
    const described = describeConnectionFailure(error)
    expect(described.cause).toBe('dns')
    expect(described.detail).toContain('getaddrinfo ENOTFOUND cluster.internal')
  })
})

describe('errorChainDiagnosisText', () => {
  it('leads with the cause, which is the half a diagnosis is read for', () => {
    // The rule `describeConnectionFailure` has always applied, available as a function so a reader
    // that wants it does not have to be a connection VERDICT to get it. The acceptance kit's
    // per-poll observation is the caller that went without: it takes the runtime chain alone, on a
    // 200-character budget, and spent the first fourteen of them on a phrase identical for every
    // transport failure there is.
    const error = fetchFailure(coded('connect ECONNREFUSED 127.0.0.1:6443', 'ECONNREFUSED'))
    expect(errorChainDiagnosisText(error)).toBe('connect ECONNREFUSED 127.0.0.1:6443')
    // Its sibling keeps it, and that divergence is the reason both exist.
    expect(errorChainText(error).startsWith('fetch failed')).toBe(true)
  })

  it('keeps the wrapper when it is the only thing the chain said', () => {
    // Dropping it here would answer EMPTY for a failure that was genuinely reported, and empty is
    // the value every `|| '<what to do about it>'` guard in the product reads as "undescribable".
    expect(errorChainDiagnosisText(fetchFailure(undefined))).toBe('fetch failed')
  })

  it('agrees with the describer that owns the rule', () => {
    // Asserted as a RELATION rather than as a second copy of the expected prose: the point of
    // extracting the reduction was that one statement of it serves both, and a test spelling out
    // what each returns would pass with two implementations that had drifted.
    const error = fetchFailure(coded('getaddrinfo ENOTFOUND cat-factory.invalid', 'ENOTFOUND'))
    expect(errorChainDiagnosisText(error)).toBe(describeConnectionFailure(error).detail)
  })
})
