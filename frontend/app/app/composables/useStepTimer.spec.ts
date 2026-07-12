import { describe, expect, it } from 'vitest'
import type { PipelineStep } from '~/types/execution'
import { stepDurationLabel, stepDurationMs, stepIsRunning } from '~/composables/useStepTimer'

// The pure helpers encode one freeze rule shared by the list surfaces (pipeline timeline,
// inspector run list) and the single-step overlay, so pin the precedence here:
// finishedAt > (runFailed ? failureAt ?? startedAt) > pausedAt > live now.
function step(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return { agentKind: 'coder', state: 'working', ...overrides } as PipelineStep
}

const NOW = 10_000

describe('stepIsRunning', () => {
  it('is false for a null step', () => {
    expect(stepIsRunning(null, false)).toBe(false)
  })

  it('is false until the step has started', () => {
    expect(stepIsRunning(step({ startedAt: undefined }), false)).toBe(false)
  })

  it('is true for a started, unfinished, unparked step on a live run', () => {
    expect(stepIsRunning(step({ startedAt: 1000 }), false)).toBe(true)
  })

  it('is false once finished, parked, or the run failed', () => {
    expect(stepIsRunning(step({ startedAt: 1000, finishedAt: 2000 }), false)).toBe(false)
    expect(stepIsRunning(step({ startedAt: 1000, pausedAt: 1500 }), false)).toBe(false)
    expect(stepIsRunning(step({ startedAt: 1000 }), true)).toBe(false)
  })
})

describe('stepDurationMs', () => {
  it('is null until the step has started', () => {
    expect(stepDurationMs(step({ startedAt: undefined }), NOW, false, null)).toBeNull()
    expect(stepDurationMs(null, NOW, false, null)).toBeNull()
  })

  it('counts up to now while live', () => {
    expect(stepDurationMs(step({ startedAt: 4000 }), NOW, false, null)).toBe(6000)
  })

  it('freezes at finishedAt once finished (ignoring now)', () => {
    expect(stepDurationMs(step({ startedAt: 4000, finishedAt: 7000 }), NOW, false, null)).toBe(3000)
  })

  it('freezes at the run failure time when the run failed', () => {
    expect(stepDurationMs(step({ startedAt: 4000 }), NOW, true, 6000)).toBe(2000)
  })

  it('falls back to startedAt (zero) when the run failed with no failure time', () => {
    expect(stepDurationMs(step({ startedAt: 4000 }), NOW, true, null)).toBe(0)
  })

  it('freezes at the park time when parked on a human', () => {
    expect(stepDurationMs(step({ startedAt: 4000, pausedAt: 5500 }), NOW, false, null)).toBe(1500)
  })

  it('prefers finishedAt over the failure time', () => {
    expect(stepDurationMs(step({ startedAt: 4000, finishedAt: 5000 }), NOW, true, 6000)).toBe(1000)
  })

  it('never returns a negative duration', () => {
    expect(stepDurationMs(step({ startedAt: 8000 }), NOW, true, 6000)).toBe(0)
  })
})

describe('stepDurationLabel', () => {
  it('is null until the step has started', () => {
    expect(stepDurationLabel(step({ startedAt: undefined }), NOW, false, null)).toBeNull()
  })

  it('formats seconds and minutes', () => {
    expect(stepDurationLabel(step({ startedAt: 4000 }), NOW, false, null)).toBe('6s')
    expect(stepDurationLabel(step({ startedAt: 0, finishedAt: 90_000 }), NOW, false, null)).toBe(
      '1m 30s',
    )
  })
})
