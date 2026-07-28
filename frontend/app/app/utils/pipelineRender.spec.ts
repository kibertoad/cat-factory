import { describe, it, expect } from 'vitest'
import type { PipelineStep } from '~/types/execution'
import { dedicatedParkView } from './pipelineRender'

/** A minimal coder step; the predicate only reads approval/followUps/forkDecision. */
const step = (over: Partial<PipelineStep>): PipelineStep =>
  ({
    agentKind: 'coder',
    state: 'waiting_decision',
    approval: { id: 'ap_1', status: 'pending', proposal: '' },
    ...over,
  }) as PipelineStep

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
      dedicatedParkView(step({ followUps: followUps(['pending', 'answered']) as never })),
    ).toBe('follow-ups')
  })

  it('does not claim a step whose follow-up items are all decided', () => {
    expect(
      dedicatedParkView(step({ followUps: followUps(['answered', 'dismissed']) as never })),
    ).toBeNull()
  })

  it('does not claim a WORKING coder that is still streaming items (no approval raised)', () => {
    // Clicking a live step must keep opening the ordinary detail (progress + output).
    expect(
      dedicatedParkView(
        step({ state: 'working', approval: null, followUps: followUps(['pending']) as never }),
      ),
    ).toBeNull()
  })

  it('owns the fork park while awaiting a choice, and while a chat reply is in flight', () => {
    expect(dedicatedParkView(step({ forkDecision: { status: 'awaiting_choice' } as never }))).toBe(
      'fork-decision',
    )
    expect(dedicatedParkView(step({ forkDecision: { status: 'answering' } as never }))).toBe(
      'fork-decision',
    )
  })

  it('releases the step once the fork is resolved (chosen / single_path / skipped)', () => {
    for (const status of ['chosen', 'single_path', 'skipped', 'proposing']) {
      expect(dedicatedParkView(step({ forkDecision: { status } as never }))).toBeNull()
    }
  })

  it('leaves a plain approval park to the generic rail', () => {
    expect(dedicatedParkView(step({}))).toBeNull()
  })
})
