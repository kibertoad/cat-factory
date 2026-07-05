import { describe, expect, it } from 'vitest'
import type { CiCheck } from '../ports/ci-status.js'
import type { ReleaseHealthReport, ReleaseSignal } from '../ports/release-health.js'
import {
  aggregateCi,
  classifyReleaseHealth,
  describeFailingChecks,
  describeRegressedSignals,
  isCiGreen,
  listFailingChecks,
} from './gate-logic.js'

const check = (
  status: string,
  conclusion: string | null,
  name = 'build',
  url: string | null = null,
): CiCheck => ({
  name,
  status,
  conclusion,
  url,
})

describe('aggregateCi', () => {
  it('reports `none` when there are no checks (nothing to gate)', () => {
    expect(aggregateCi([])).toBe('none')
    expect(isCiGreen('none')).toBe(true)
  })

  it('reports `success` when every completed check passed', () => {
    expect(aggregateCi([check('completed', 'success'), check('completed', 'neutral')])).toBe(
      'success',
    )
    expect(isCiGreen('success')).toBe(true)
  })

  it('treats neutral and skipped conclusions as passing', () => {
    expect(aggregateCi([check('completed', 'skipped')])).toBe('success')
  })

  it('does not fail the gate on a stale (superseded) check', () => {
    expect(aggregateCi([check('completed', 'success'), check('completed', 'stale')])).toBe(
      'success',
    )
    expect(aggregateCi([check('completed', 'stale'), check('in_progress', null)])).toBe('pending')
  })

  it('reports `pending` while a check is still running and none have failed', () => {
    expect(aggregateCi([check('completed', 'success'), check('in_progress', null)])).toBe('pending')
    expect(aggregateCi([check('queued', null)])).toBe('pending')
    expect(isCiGreen('pending')).toBe(false)
  })

  it('reports `failure` as soon as one completed check failed, even if others pend', () => {
    expect(aggregateCi([check('completed', 'failure'), check('in_progress', null)])).toBe('failure')
    expect(aggregateCi([check('completed', 'timed_out')])).toBe('failure')
    expect(aggregateCi([check('completed', 'cancelled')])).toBe('failure')
    expect(isCiGreen('failure')).toBe(false)
  })
})

describe('describeFailingChecks', () => {
  it('names the failing checks with their conclusions', () => {
    const summary = describeFailingChecks([
      check('completed', 'success', 'lint'),
      check('completed', 'failure', 'unit'),
      check('completed', 'timed_out', 'e2e'),
    ])
    expect(summary).toContain('unit (failure)')
    expect(summary).toContain('e2e (timed_out)')
    expect(summary).not.toContain('lint')
  })

  it('falls back to a generic message when nothing is conclusively failing', () => {
    expect(describeFailingChecks([check('in_progress', null)])).toBe('CI reported a failure.')
  })
})

describe('listFailingChecks', () => {
  it('returns the completed, non-passing checks as name + conclusion + url (for the UI)', () => {
    const failing = listFailingChecks([
      check('completed', 'success', 'lint'),
      check('completed', 'failure', 'unit', 'https://github.com/o/r/runs/1'),
      check('completed', 'timed_out', 'e2e'),
      check('in_progress', null, 'slow'),
    ])
    expect(failing).toEqual([
      { name: 'unit', conclusion: 'failure', url: 'https://github.com/o/r/runs/1' },
      { name: 'e2e', conclusion: 'timed_out', url: null },
    ])
  })

  it('is empty when nothing has conclusively failed', () => {
    expect(listFailingChecks([check('completed', 'success'), check('in_progress', null)])).toEqual(
      [],
    )
  })

  it('excludes stale (superseded) checks — nothing for the ci-fixer to fix', () => {
    expect(listFailingChecks([check('completed', 'stale')])).toEqual([])
  })
})

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
