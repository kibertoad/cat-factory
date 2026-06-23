import { describe, expect, it } from 'vitest'
import type { CiCheck } from '@cat-factory/kernel'
import { aggregateCi, describeFailingChecks, isCiGreen, listFailingChecks } from './ci.logic.js'

const check = (status: string, conclusion: string | null, name = 'build'): CiCheck => ({
  name,
  status,
  conclusion,
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

  it('reports `pending` while a check is still running and none have failed', () => {
    expect(aggregateCi([check('completed', 'success'), check('in_progress', null)])).toBe('pending')
    expect(aggregateCi([check('queued', null)])).toBe('pending')
    expect(isCiGreen('pending')).toBe(false)
  })

  it('reports `failure` as soon as one completed check failed, even if others pend', () => {
    expect(aggregateCi([check('completed', 'failure'), check('in_progress', null)])).toBe('failure')
    expect(aggregateCi([check('completed', 'timed_out')])).toBe('failure')
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
  it('returns the completed, non-passing checks as name + conclusion (for the UI)', () => {
    const failing = listFailingChecks([
      check('completed', 'success', 'lint'),
      check('completed', 'failure', 'unit'),
      check('completed', 'timed_out', 'e2e'),
      check('in_progress', null, 'slow'),
    ])
    expect(failing).toEqual([
      { name: 'unit', conclusion: 'failure' },
      { name: 'e2e', conclusion: 'timed_out' },
    ])
  })

  it('is empty when nothing has conclusively failed', () => {
    expect(listFailingChecks([check('completed', 'success'), check('in_progress', null)])).toEqual(
      [],
    )
  })
})
