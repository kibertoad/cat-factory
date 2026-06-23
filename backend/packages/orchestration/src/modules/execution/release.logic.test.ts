import { describe, expect, it } from 'vitest'
import type { ReleaseHealthReport, ReleaseSignal } from '@cat-factory/kernel'
import { classifyReleaseHealth, describeRegressedSignals } from './release.logic.js'

const sig = (state: ReleaseSignal['state'], over: Partial<ReleaseSignal> = {}): ReleaseSignal => ({
  kind: 'monitor',
  id: 'm1',
  name: 'errors',
  state,
  ...over,
})

const report = (
  status: ReleaseHealthReport['status'],
  signals: ReleaseSignal[],
): ReleaseHealthReport => ({
  status,
  signals,
})

describe('classifyReleaseHealth', () => {
  it('escalates on a regression regardless of the window', () => {
    expect(
      classifyReleaseHealth({ report: report('regressed', [sig('alert')]), windowElapsed: false }),
    ).toBe('fail')
    expect(
      classifyReleaseHealth({ report: report('regressed', [sig('alert')]), windowElapsed: true }),
    ).toBe('fail')
  })

  it('keeps polling while the window is still open and nothing has regressed', () => {
    expect(
      classifyReleaseHealth({ report: report('pending', [sig('no_data')]), windowElapsed: false }),
    ).toBe('pending')
    expect(
      classifyReleaseHealth({ report: report('healthy', [sig('ok')]), windowElapsed: false }),
    ).toBe('pending')
  })

  it('passes once the window elapses with no regression — including a quiet/no_data signal', () => {
    // A healthy window passes…
    expect(
      classifyReleaseHealth({ report: report('healthy', [sig('ok')]), windowElapsed: true }),
    ).toBe('pass')
    // …and so does a still-`pending`/`no_data` one: the window is the grace period, and a
    // permanently-`no_data` monitor must NOT hang the gate until it fails as a timeout.
    expect(
      classifyReleaseHealth({ report: report('pending', [sig('no_data')]), windowElapsed: true }),
    ).toBe('pass')
  })
})

describe('describeRegressedSignals', () => {
  it('names the alerting signals with their detail', () => {
    const text = describeRegressedSignals([
      sig('alert', { name: 'p99 latency', detail: 'SLI 0.91 vs target 0.99' }),
      sig('ok', { name: 'apdex' }),
    ])
    expect(text).toContain('p99 latency')
    expect(text).toContain('SLI 0.91 vs target 0.99')
    expect(text).not.toContain('apdex')
  })

  it('falls back to a generic message when nothing is alerting', () => {
    expect(describeRegressedSignals([sig('warn')])).toBe('A monitored release signal regressed.')
  })
})
