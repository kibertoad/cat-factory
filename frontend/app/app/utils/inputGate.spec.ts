import { describe, expect, it } from 'vitest'
import type { RunInputGate } from '@cat-factory/contracts'
import type { ExecutionInstance } from '~/types/execution'
import { inputGateNoticeFor } from './inputGate'

const run = (inputGate?: Partial<RunInputGate>): ExecutionInstance =>
  ({
    id: 'exe_1',
    steps: [],
    ...(inputGate
      ? { inputGate: { mode: 'standard', issues: [], checkedAt: 1, ...inputGate } }
      : {}),
  }) as unknown as ExecutionInstance

const thin = [{ code: 'description_thin', severity: 'advisory' }] as RunInputGate['issues']
const missing = [{ code: 'description_missing', severity: 'blocking' }] as RunInputGate['issues']

describe('inputGateNoticeFor', () => {
  it('shows the park, with the tone that carries the two ways out', () => {
    expect(inputGateNoticeFor(run({ status: 'blocked', issues: missing }))?.tone).toBe('blocked')
  })

  it('keeps a waiver visible, because what was overruled explains the output', () => {
    expect(inputGateNoticeFor(run({ status: 'overridden', issues: missing }))?.tone).toBe('waived')
  })

  // The regression this pins: advisory findings were recorded on the run and reported over the
  // API while being invisible in the product, which left `advisory` MODE (whose entire purpose is
  // "watch what the gate would have caught before turning it up") with nothing to watch.
  it('shows advisory findings on a PASSED verdict, which is what advisory mode produces', () => {
    const notice = inputGateNoticeFor(run({ status: 'passed', mode: 'advisory', issues: thin }))
    expect(notice?.tone).toBe('advisory')
    expect(notice?.gate.issues).toEqual(thin)
  })

  it('shows a standard-mode advisory too, which never parks but is still a finding', () => {
    expect(inputGateNoticeFor(run({ status: 'passed', issues: thin }))?.tone).toBe('advisory')
  })

  it.each(['passed', 'off', 'not_applicable'] as const)(
    'says nothing about a %s verdict with no findings',
    (status) => {
      expect(inputGateNoticeFor(run({ status, issues: [] }))).toBeNull()
    },
  )

  it('says nothing when the gate has not evaluated the run yet, or there is no run', () => {
    expect(inputGateNoticeFor(run())).toBeNull()
    expect(inputGateNoticeFor(null)).toBeNull()
    expect(inputGateNoticeFor(undefined)).toBeNull()
  })
})
