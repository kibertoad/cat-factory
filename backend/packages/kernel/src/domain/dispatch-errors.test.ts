import { describe, expect, it } from 'vitest'
import {
  DISPATCH_DOC_URLS,
  DispatchError,
  harnessDispatchError,
  harnessDispatchFailureMessage,
  isDispatchFailure,
} from './dispatch-errors.js'

describe('harnessDispatchFailureMessage', () => {
  it('preserves the raw `<label> dispatch failed (HTTP n): body` first line for a non-404', () => {
    const msg = harnessDispatchFailureMessage({
      label: 'Container',
      status: 503,
      body: 'no capacity in region us-east',
    })
    expect(msg).toBe('Container dispatch failed (HTTP 503): no capacity in region us-east')
    // No elaboration for a non-404 — the raw line is the whole message.
    expect(msg).not.toContain('stale')
  })

  it('keeps the legacy `dispatch failed` phrase so the fallback regex still matches', () => {
    const msg = harnessDispatchFailureMessage({ label: 'Local container', status: 500, body: 'x' })
    expect(/dispatch failed/i.test(msg)).toBe(true)
  })

  it('appends the stale-image cause + republish remedy + doc link on a 404', () => {
    const msg = harnessDispatchFailureMessage({
      label: 'Container',
      status: 404,
      body: 'not found',
    })
    // Raw first line is still present (greppable / regex-matchable).
    expect(msg.startsWith('Container dispatch failed (HTTP 404): not found')).toBe(true)
    expect(msg).toContain('predates this dispatch route')
    expect(msg).toContain('fresh')
    expect(msg).toContain(DISPATCH_DOC_URLS.runnerImage)
  })
})

describe('harnessDispatchError', () => {
  it('builds a DispatchError carrying the status and the elaborated message', () => {
    const err = harnessDispatchError({ label: 'Container', status: 404, body: 'nope' })
    expect(err).toBeInstanceOf(DispatchError)
    expect(err.status).toBe(404)
    expect(err.name).toBe('DispatchError')
    expect(err.message).toContain('predates this dispatch route')
  })
})

describe('isDispatchFailure', () => {
  it('recognises a structured DispatchError', () => {
    expect(isDispatchFailure(new DispatchError('Runner pool POST → 500: boom', 500))).toBe(true)
  })

  it('falls back to the legacy message shape for a plain Error (older/other producer)', () => {
    expect(isDispatchFailure(new Error('Container dispatch failed (HTTP 502): body'))).toBe(true)
  })

  it('does not match an unrelated error (e.g. a pre-flight rejection)', () => {
    expect(isDispatchFailure(new Error("No connected GitHub repository found for 'ws1'"))).toBe(
      false,
    )
    expect(isDispatchFailure(undefined)).toBe(false)
    expect(isDispatchFailure('a string')).toBe(false)
  })
})

describe('DispatchError', () => {
  it('carries the HTTP status as a structured field', () => {
    expect(new DispatchError('Runner pool post → 502: down', 502).status).toBe(502)
    // 0 marks a pre-request / network fault with no HTTP response.
    expect(new DispatchError('network unreachable', 0).status).toBe(0)
  })
})
