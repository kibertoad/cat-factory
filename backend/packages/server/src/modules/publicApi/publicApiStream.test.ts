import { describe, expect, it } from 'vitest'
import type { PublicRun, PublicRunStep } from '@cat-factory/contracts'
import {
  createParkAnnouncer,
  isParked,
  reduceRunForStream,
  STREAM_DELIVERABLE_PREVIEW_CHARS,
} from './publicApiStream.js'

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

describe('reduceRunForStream', () => {
  const step = (over: Partial<PublicRunStep> = {}): PublicRunStep => ({
    agentKind: 'coder',
    state: 'done',
    progress: 1,
    subtasks: null,
    output: null,
    data: null,
    ...over,
  })

  const run = (steps: PublicRunStep[]): PublicRun => ({
    runId: 'run_1',
    taskId: 'blk_1',
    status: 'running',
    createdAt: 0,
    currentStep: 0,
    steps,
    externalIdentity: null,
    externalIdentityWithheld: false,
    pullRequest: null,
    error: null,
  })

  it('leaves a step that fits ENTIRELY alone, flag included', () => {
    // `truncated` has to mean "something was left out of this frame", not "this frame came from
    // the stream": a flag set unconditionally tells every caller its whole deliverable is partial
    // and sends them all to the point read for nothing.
    const small = step({ output: 'done', data: { verdict: 'ok' } })
    expect(reduceRunForStream(run([small])).steps[0]).toEqual(small)
  })

  it('clips an oversized output to a preview and SAYS SO', () => {
    const long = 'x'.repeat(STREAM_DELIVERABLE_PREVIEW_CHARS + 500)
    const [reduced] = reduceRunForStream(run([step({ output: long })])).steps
    expect(reduced?.output).toHaveLength(STREAM_DELIVERABLE_PREVIEW_CHARS)
    expect(reduced?.truncated).toBe(true)
  })

  it('withholds an oversized `data` but keeps a small one on the same run', () => {
    // Measured per step, not decided per run: the structured result a fork choice or an estimate
    // carries is small, and withholding it because a SIBLING step wrote a long report would strip
    // the stream of the very field a caller reacts to.
    const big = { rows: Array.from({ length: 400 }, (_, i) => `row-${i}-padding-padding`) }
    const [heavy, light] = reduceRunForStream(
      run([step({ data: big }), step({ data: { verdict: 'ok' } })]),
    ).steps
    expect(heavy?.data).toBeNull()
    expect(heavy?.truncated).toBe(true)
    expect(light?.data).toEqual({ verdict: 'ok' })
    expect(light?.truncated).toBeUndefined()
  })

  it('keeps every frame bounded however long the run gets', () => {
    // The quadratic the reduction exists to prevent: the stream re-sends the WHOLE run on every
    // change, so an unreduced late frame repeats every output produced so far. Asserted as a
    // RELATION over the frame's own size rather than a pinned byte count, which would be re-pinned
    // unread the first time a field is added.
    const long = 'y'.repeat(STREAM_DELIVERABLE_PREVIEW_CHARS * 10)
    const frame = JSON.stringify(
      reduceRunForStream(run(Array.from({ length: 12 }, () => step({ output: long })))),
    )
    expect(frame.length).toBeLessThan(12 * (STREAM_DELIVERABLE_PREVIEW_CHARS + 500))
  })
})
