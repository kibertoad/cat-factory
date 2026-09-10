import { describe, expect, it } from 'vitest'
import type {
  PublicDecision,
  PublicDecisionList,
  PublicRun,
  PublicRunStep,
} from '@cat-factory/contracts'
import {
  createDecisionAnnouncer,
  createParkAnnouncer,
  isParked,
  reduceDecisionsForStream,
  reduceRunForStream,
  STREAM_DECISION_TEXT_PREVIEW_CHARS,
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

describe('createDecisionAnnouncer', () => {
  it('writes a frame only when the decision list moved', () => {
    // The park case, and the reason the detector exists: a park lasts as long as a human takes and
    // the projection is rebuilt every tick, so an always-fire channel is an unbounded stream of
    // identical payloads for however long nobody answers.
    const changed = createDecisionAnnouncer()
    expect(changed.shouldAnnounce('{"decisions":[]}')).toBe(true)
    expect(changed.shouldAnnounce('{"decisions":[]}')).toBe(false)
    expect(changed.shouldAnnounce('{"decisions":[]}')).toBe(false)
  })

  it('keeps firing as the SAME live decision advances', () => {
    // The other direction, and the failure the channel exists to prevent. A review reports its
    // slices one at a time, so a latch that fired once would deliver the first state and go quiet:
    // a caller cannot tell that from a reviewer that stopped, which is exactly what it was polling
    // the decisions endpoint to find out.
    const changed = createDecisionAnnouncer()
    const slices = (reported: number) =>
      `{"decisions":[{"kind":"pr-review","reportedSlices":${reported}}]}`
    expect(changed.shouldAnnounce(slices(0))).toBe(true)
    expect(changed.shouldAnnounce(slices(1))).toBe(true)
    expect(changed.shouldAnnounce(slices(1))).toBe(false)
    expect(changed.shouldAnnounce(slices(2))).toBe(true)
  })

  it('announces a list that returns to a payload it held earlier', () => {
    // Compared against the LAST payload rather than every one seen, which is what a run that parks,
    // resumes and parks again on the same question produces. Remembering the whole history would
    // swallow the second park, which is the same bug the park announcer re-arms to avoid.
    const changed = createDecisionAnnouncer()
    expect(changed.shouldAnnounce('parked')).toBe(true)
    expect(changed.shouldAnnounce('working')).toBe(true)
    expect(changed.shouldAnnounce('parked')).toBe(true)
  })
})

describe('reduceDecisionsForStream', () => {
  /** A parked review carrying `count` findings, each with a `detail` of `detailChars`. */
  function reviewList(count: number, detailChars: number): PublicDecisionList {
    return {
      runId: 'exec_1',
      taskId: 'task_1',
      status: 'blocked',
      parked: true,
      decisions: [
        {
          kind: 'pr-review',
          findings: Array.from({ length: count }, (_, i) => ({
            findingId: `f_${i}`,
            detail: 'd'.repeat(detailChars),
          })),
        } as unknown as PublicDecision,
      ],
      unanswerable: [],
      truncated: false,
    }
  }

  it('leaves a list that already fits untouched and unflagged', () => {
    // `truncated` means exactly "something was left out of THIS frame", not "this frame came from
    // the stream": a caller that indexed a clipped preview as the whole detail would then have a
    // tail that is absent in a way that reads as never written.
    const list = reviewList(3, 40)
    expect(reduceDecisionsForStream(list)).toEqual(list)
  })

  it('clips over-long model text to a preview and reports the clip', () => {
    const reduced = reduceDecisionsForStream(reviewList(1, STREAM_DECISION_TEXT_PREVIEW_CHARS * 4))
    const finding = (reduced.decisions[0] as unknown as { findings: { detail: string }[] })
      .findings[0]!
    expect(finding.detail).toHaveLength(STREAM_DECISION_TEXT_PREVIEW_CHARS)
    expect(reduced.truncated).toBe(true)
  })

  it('never drops a DECISION, however much prose it carries', () => {
    // The one thing the reduction may not do, and the reason the flag sits on the list rather than
    // standing in for entries left out: an empty `decisions` that means "narrowed" and one that
    // means "nothing is being asked" are opposite facts, and telling them apart is the whole job of
    // this surface.
    const reduced = reduceDecisionsForStream(reviewList(80, 5_000))
    expect(reduced.decisions).toHaveLength(1)
    const findings = (reduced.decisions[0] as unknown as { findings: unknown[] }).findings
    expect(findings).toHaveLength(80)
  })

  it('bounds a park holding a whole review of findings', () => {
    // The point of reducing at all. The frame is re-sent whenever any part of the list moves, so an
    // unreduced park of eighty model-authored findings repeats hundreds of kilobytes for the rest
    // of the run. A RELATION over the frame's own shape rather than a pinned byte count, which
    // would be re-pinned unread the first time a decision kind grows a field.
    const list = reviewList(80, STREAM_DECISION_TEXT_PREVIEW_CHARS * 5)
    const before = JSON.stringify(list).length
    const after = JSON.stringify(reduceDecisionsForStream(list)).length
    expect(after).toBeLessThan(before / 4)
    expect(after).toBeLessThan(80 * (STREAM_DECISION_TEXT_PREVIEW_CHARS + 200))
  })

  it('clips text anywhere in the payload, including a named wait', () => {
    // Kind-AGNOSTIC on purpose: what a decision carries is decided by the kind, so a rule written
    // per kind is one the fifteenth kind escapes silently. `unanswerable[]` carries model-adjacent
    // prose too and is part of the same frame.
    const reduced = reduceDecisionsForStream({
      ...reviewList(0, 0),
      unanswerable: [
        { reason: 'curation_gate', detail: 'w'.repeat(9_000) },
      ] as unknown as PublicDecisionList['unanswerable'],
    })
    const wait = reduced.unanswerable[0] as unknown as { detail: string }
    expect(wait.detail).toHaveLength(STREAM_DECISION_TEXT_PREVIEW_CHARS)
    expect(reduced.truncated).toBe(true)
  })
})
