import { describe, expect, it } from 'vitest'
import { createParkAnnouncer, isParked } from './publicApiStream.js'

// The public SSE streams' park announcement. Both stream loops share this, and both of its rules
// fail in a way that is invisible from the code: announcing every tick floods a caller for as long
// as a human takes to answer (unbounded — there is no run-killing park timeout by design), while
// failing to re-arm silently swallows a SECOND park later in the same pipeline. Neither shows up in
// a smoke test of the happy path.

describe('isParked', () => {
  it('treats only `blocked` as the parked state', () => {
    expect(isParked('blocked')).toBe(true)
    // `paused` is the SPEND gate, which resumes on its own — not a human park, and the stream must
    // not invite a caller to answer a decision that does not exist.
    for (const status of ['running', 'paused', 'done', 'failed'] as const) {
      expect(isParked(status), status).toBe(false)
    }
  })
})

describe('createParkAnnouncer', () => {
  it('announces a park once, not on every poll tick', () => {
    const parks = createParkAnnouncer()
    expect(parks.shouldAnnounce('running')).toBe(false)
    expect(parks.shouldAnnounce('blocked')).toBe(true)
    // A park lasts as long as the human takes; identical frames every tick would be a flood.
    expect(parks.shouldAnnounce('blocked')).toBe(false)
    expect(parks.shouldAnnounce('blocked')).toBe(false)
  })

  it('re-arms on resume so a LATER park is announced too', () => {
    // A pipeline can park more than once — a requirements review, then a fork choice on the coder
    // step. A latch that never reset would leave the caller waiting on a park it was never told
    // about, which is precisely the hang this whole surface exists to prevent.
    const parks = createParkAnnouncer()
    expect(parks.shouldAnnounce('blocked')).toBe(true)
    expect(parks.shouldAnnounce('running')).toBe(false)
    expect(parks.shouldAnnounce('blocked')).toBe(true)
  })

  it('does not treat a spend pause as a park, and keeps the latch armed across one', () => {
    const parks = createParkAnnouncer()
    expect(parks.shouldAnnounce('paused')).toBe(false)
    expect(parks.shouldAnnounce('blocked')).toBe(true)
    // Pausing mid-park re-arms, so the park is re-announced when it resurfaces — the caller may
    // well have missed the first frame while the run was off in the spend gate.
    expect(parks.shouldAnnounce('paused')).toBe(false)
    expect(parks.shouldAnnounce('blocked')).toBe(true)
  })

  it('keeps two concurrent streams independent', () => {
    // Each connection has its own announcer; a shared latch would mean the second watcher of the
    // same run never learns it parked.
    const a = createParkAnnouncer()
    const b = createParkAnnouncer()
    expect(a.shouldAnnounce('blocked')).toBe(true)
    expect(b.shouldAnnounce('blocked')).toBe(true)
  })
})
