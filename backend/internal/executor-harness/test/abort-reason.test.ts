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

  it('names no watchdog when there is no reason to read', () => {
    const controller = new AbortController()
    controller.abort()
    // A DOMException (`AbortError`), not an Error, and it says only "This operation was aborted":
    // the fallback has to cover it, and covering it by guessing a cause is the bug.
    expect(abortReasonOf(controller.signal)).not.toMatch(/watchdog/i)
    expect(abortReasonOf(undefined)).not.toMatch(/watchdog/i)
  })

  it('ignores a reason that carries no message', () => {
    const controller = new AbortController()
    controller.abort(new Error('   '))
    expect(abortReasonOf(controller.signal)).toBe('agent run aborted')
  })
})
