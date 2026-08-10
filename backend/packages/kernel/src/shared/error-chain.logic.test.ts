import { describe, expect, it } from 'vitest'
import { getErrorMessage } from '../domain/errors.js'
import { describeError } from './best-effort.js'
import { describeConnectionFailure } from './connection-failure.logic.js'
import { errorChainText, MAX_ERROR_CHAIN_CHARS } from './error-chain.logic.js'

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
