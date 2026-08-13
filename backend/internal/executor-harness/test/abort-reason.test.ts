import { describe, expect, it } from 'vitest'
import { abortReasonOf } from '../src/failure.js'

// The decision `agent-runner`'s abort branch makes, pinned on its own because the runner test
// that drives it end-to-end needs a POSIX fake CLI and so cannot run everywhere.
//
// What it is for: every abort funnels through one AbortController, and the reason the caller
// supplied is the only thing that says whether a watchdog fired, something shut the harness down,
// or the backend asked for this one job to stop. The runner used to answer "aborted by watchdog"
// for all three.

describe('abortReasonOf', () => {
  it('answers with the reason the aborting caller gave', () => {
    const controller = new AbortController()
    controller.abort(new Error('harness shutting down (SIGTERM)'))
    expect(abortReasonOf(controller.signal)).toBe('harness shutting down (SIGTERM)')
  })

  it('falls back when there is no reason to read', () => {
    const controller = new AbortController()
    controller.abort()
    // A reasonless abort still sets one: an `AbortError` DOMException, which on Node IS an Error
    // and says only "This operation was aborted". Asserted as the FALLBACK rather than merely as
    // "not a watchdog", because that weaker check passed while the contentless platform sentence
    // was being quoted back as if it were a cause.
    expect(abortReasonOf(controller.signal)).toBe('agent run aborted')
    expect(abortReasonOf(undefined)).toBe('agent run aborted')
  })

  it('keeps a timeout abort, which does say something', () => {
    // The other reason the platform supplies. Unlike a bare abort it names what happened, so the
    // predicate that drops the contentless one must not take this with it.
    const signal = AbortSignal.timeout(0)
    return new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => {
        expect(abortReasonOf(signal)).toMatch(/timeout/i)
        resolve()
      })
    })
  })

  it('ignores a reason that carries no message', () => {
    const controller = new AbortController()
    controller.abort(new Error('   '))
    expect(abortReasonOf(controller.signal)).toBe('agent run aborted')
  })
})
