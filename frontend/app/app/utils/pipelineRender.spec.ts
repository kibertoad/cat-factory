import { describe, it, expect } from 'vitest'
import { binaryCandidateStatusSchema } from '@cat-factory/contracts'
import type { ExecutionInstance, PipelineStep } from '~/types/execution'
import { missingI18nKeys } from '../../test/i18nKeys'
import { REDIRECT_PARK_PRESENTATION, dedicatedParkView, stepSkipReasonKey } from './pipelineRender'

/** A minimal coder step; the predicate only reads approval/followUps/forkDecision. */
const step = (over: Partial<PipelineStep>): PipelineStep =>
  ({
    agentKind: 'coder',
    state: 'waiting_decision',
    approval: { id: 'ap_1', status: 'pending', proposal: '' },
    ...over,
  }) as PipelineStep

/**
 * A run carrying no input-gate verdict: the ordinary case for every step-shaped park below.
 * Passed explicitly because `dedicatedParkView` REQUIRES the run — the gate's park is a fact
 * about the run rather than the step, so a call that omitted it would silently miss it.
 */
const run = (over: Partial<ExecutionInstance> = {}): ExecutionInstance =>
  ({ id: 'exe_1', steps: [], ...over }) as unknown as ExecutionInstance

const followUps = (statuses: string[]) => ({
  enabled: true,
  items: statuses.map((status, i) => ({
    id: `fu_${i}`,
    kind: 'follow_up',
    title: 't',
    detail: '',
    status,
    createdAt: 0,
    updatedAt: 0,
  })),
  loops: 0,
})

describe('dedicatedParkView', () => {
  // The regression this pins: a coder parked on the follow-up gate (or the fork choice)
  // carries a pending `step.approval`, but the generic approve resolver 409s on it — the
  // surfaces must route these parks to their dedicated window, never the "Approve &
  // proceed" rail.
  it('owns a follow-up park (pending approval + undecided items)', () => {
    expect(
      dedicatedParkView(step({ followUps: followUps(['pending', 'answered']) as never }), run()),
    ).toBe('follow-ups')
  })

  it('does not claim a step whose follow-up items are all decided', () => {
    expect(
      dedicatedParkView(step({ followUps: followUps(['answered', 'dismissed']) as never }), run()),
    ).toBeNull()
  })

  it('does not claim a WORKING coder that is still streaming items (no approval raised)', () => {
    // Clicking a live step must keep opening the ordinary detail (progress + output).
    expect(
      dedicatedParkView(
        step({ state: 'working', approval: null, followUps: followUps(['pending']) as never }),
        run(),
      ),
    ).toBeNull()
  })

  it('owns the fork park while awaiting a choice, and while a chat reply is in flight', () => {
    expect(
      dedicatedParkView(step({ forkDecision: { status: 'awaiting_choice' } as never }), run()),
    ).toBe('fork-decision')
    expect(dedicatedParkView(step({ forkDecision: { status: 'answering' } as never }), run())).toBe(
      'fork-decision',
    )
  })

  it('releases the step once the fork is resolved (chosen / single_path / skipped)', () => {
    for (const status of ['chosen', 'single_path', 'skipped', 'proposing']) {
      expect(dedicatedParkView(step({ forkDecision: { status } as never }), run())).toBeNull()
    }
  })

  // A generating step parks BETWEEN its candidate pass and its delivering pass. Approving it
  // generically would mark done a step that has staged files and delivered nothing, so it owns
  // the park exactly as the fork choice one subject over does.
  it('owns the candidate park while awaiting a choice', () => {
    expect(
      dedicatedParkView(step({ binaryCandidates: { status: 'awaiting_choice' } as never }), run()),
    ).toBe('binary-candidates')
  })

  // Derived from the picklist the engine itself writes, rather than a hand-listed set: every
  // status EXCEPT the parked one must release the step, and a status added to the vocabulary is
  // then covered here the day it lands instead of quietly falling outside a stale literal list.
  it('releases the step on every settled status the vocabulary holds', () => {
    const settled = binaryCandidateStatusSchema.options.filter((s) => s !== 'awaiting_choice')
    expect(settled.length).toBeGreaterThan(0)
    for (const status of settled) {
      expect(dedicatedParkView(step({ binaryCandidates: { status } as never }), run())).toBeNull()
    }
  })

  it('leaves a plain approval park to the generic rail', () => {
    expect(dedicatedParkView(step({}), run())).toBeNull()
  })

  // The PRE-DISPATCH INPUT GATE parks whatever step 0 happens to be and leaves nothing
  // kind-specific on the step, so it is recognised off the RUN. The generic approve resolver
  // refuses it server-side: approving it would mark the run's first working step done and skip
  // the work the run exists to do.
  it('owns a step whose park is the input gate, read off the run', () => {
    const blocked = run({
      inputGate: { status: 'blocked', mode: 'standard', issues: [], checkedAt: 1 },
    } as never)
    expect(dedicatedParkView(step({}), blocked)).toBe('input-gate')
  })

  it('releases the step once the gate is waived or passed', () => {
    for (const status of ['overridden', 'passed', 'off', 'not_applicable']) {
      const settled = run({
        inputGate: { status, mode: 'standard', issues: [], checkedAt: 1 },
      } as never)
      expect(dedicatedParkView(step({}), settled)).toBeNull()
    }
  })

  it('does not claim a step with no pending approval, whatever the gate says', () => {
    // The gate's verdict alone must not turn an unparked step into a dedicated park: a run
    // parked on the gate has exactly one step holding the approval.
    const blocked = run({
      inputGate: { status: 'blocked', mode: 'standard', issues: [], checkedAt: 1 },
    } as never)
    expect(dedicatedParkView(step({ approval: null, state: 'working' }), blocked)).toBeNull()
  })
})

describe('REDIRECT_PARK_PRESENTATION', () => {
  // The `Record` over the park vocabulary already proves at COMPILE time that every park has an
  // entry, which is the whole reason it replaced the ternaries that rendered the fork's copy for
  // the candidate park. What no type can prove is that an entry still names a key that EXISTS:
  // a table lookup is invisible to typed message keys and to `i18n:check` alike, so deleting the
  // catalog entry reads as a clean removal and the button renders its own key path at runtime.
  it('names catalog keys that resolve', () => {
    const keys = Object.values(REDIRECT_PARK_PRESENTATION).flatMap((p) => [
      p.noticeKey,
      p.actionKey,
      p.railActionKey,
    ])
    expect(missingI18nKeys(keys)).toEqual([])
  })

  // Two parks pointing at one string is how the bug this table replaced would come back: the
  // copy would be uniform and wrong again, and every other check would still pass.
  it('gives each park its own copy', () => {
    const notices = Object.values(REDIRECT_PARK_PRESENTATION).map((p) => p.noticeKey)
    expect(new Set(notices).size).toBe(notices.length)
  })
})

describe('stepSkipReasonKey', () => {
  const skipped = (over: Partial<PipelineStep>): PipelineStep =>
    ({ agentKind: 'tester-ui', state: 'done', skipped: true, ...over }) as PipelineStep

  it('answers null for a step that ran', () => {
    expect(stepSkipReasonKey(step({ state: 'done' }))).toBeNull()
  })

  it('names the axis, and narrows a condition by the scope still on the step', () => {
    expect(stepSkipReasonKey(skipped({ skipReason: 'gated' }))).toBe(
      'pipeline.progress.skipped.gated',
    )
    expect(stepSkipReasonKey(skipped({ skipReason: 'producer_skipped' }))).toBe(
      'pipeline.progress.skipped.producerSkipped',
    )
    // The condition case reads the scope off the step's own `stepOptions`, so the copy and the
    // scope it names cannot disagree.
    expect(
      stepSkipReasonKey(
        skipped({
          skipReason: 'condition',
          stepOptions: { condition: { serviceScope: 'frontend' } },
        } as Partial<PipelineStep>),
      ),
    ).toBe('pipeline.progress.skipped.conditionFrontend')
    expect(
      stepSkipReasonKey(
        skipped({
          skipReason: 'condition',
          stepOptions: { condition: { serviceScope: 'backend' } },
        } as Partial<PipelineStep>),
      ),
    ).toBe('pipeline.progress.skipped.conditionBackend')
  })

  it('still states the SKIP for a reason this build does not know', () => {
    // A stored run can name a member since retired, and a browser can be older than the member it
    // reads. Losing the reason is acceptable; rendering nothing (so the step reads as one that ran
    // and said nothing) is not, and neither is guessing onto a current member.
    // Cast through `unknown`: the type is CLOSED, so a retired member is unrepresentable at compile
    // time and only reachable from persisted data — which is exactly the case being pinned.
    expect(
      stepSkipReasonKey(
        skipped({ skipReason: 'retired_axis' } as unknown as Partial<PipelineStep>),
      ),
    ).toBe('pipeline.progress.skipped.unknown')
    expect(stepSkipReasonKey(skipped({}))).toBe('pipeline.progress.skipped.unknown')
  })

  it('every reason it can name has copy in the catalog', () => {
    const keys = [
      'gated',
      'conditionFrontend',
      'conditionBackend',
      'producerSkipped',
      'unknown',
    ].map((k) => `pipeline.progress.skipped.${k}`)
    expect(missingI18nKeys(keys)).toEqual([])
  })
})
