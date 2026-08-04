import { describe, it, expect } from 'vitest'
import type { ExecutionInstance, PipelineStep } from '~/types/execution'
import { dedicatedParkView } from './pipelineRender'

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

  it('leaves a plain approval park to the generic rail', () => {
    expect(dedicatedParkView(step({}), run())).toBeNull()
  })

  // The PRE-TOKEN INPUT GATE parks whatever step 0 happens to be and leaves nothing
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
