import { describe, it, expect } from 'vitest'
import {
  describeFailure,
  failureDetail,
  reportedFailure,
} from '~/composables/pipelineErrorToast/describeFailure'
import { describeGenericFailure } from '~/composables/usePipelineErrorToast'
import { ApiError } from '~/composables/api/errors'
import { conflictInfo } from '~/utils/conflictCopy'

/** A `t` that shows which key and params it was asked for, so the join is assertable. */
const t = (key: string, params: Record<string, unknown>) => `${key}(${JSON.stringify(params)})`

describe('describeFailure', () => {
  it('reads a conflict through the same reason map as the toast', () => {
    const error = new ApiError(409, {
      error: {
        code: 'conflict',
        message: 'Blocked by an unmet dependency.',
        details: { reason: 'dependencies_unmet' },
        requestId: 'req-1',
      },
    })
    expect(describeFailure(error)).toEqual({
      descriptionKey: conflictInfo('dependencies_unmet')!.descriptionKey,
      message: 'Blocked by an unmet dependency.',
      issues: [],
      requestId: 'req-1',
    })
  })

  it('falls back to the generic conflict line for a reason this build does not know', () => {
    const error = new ApiError(409, { error: { code: 'conflict', details: { reason: 'new' } } })
    expect(describeFailure(error).descriptionKey).toBe('errors.conflict.fallbackMessage')
  })

  it('classifies every other failure exactly as the toast does', () => {
    for (const error of [
      new ApiError(404, { error: { code: 'not_found', message: 'Gone.' } }),
      new ApiError(502, '<html>bad gateway</html>'),
      new Error('Failed to fetch'),
      'a thrown string',
    ]) {
      expect(describeFailure(error)).toEqual(describeGenericFailure(error))
    }
  })

  it('never puts the raw message in the description', () => {
    const failure = describeFailure(
      new ApiError(403, { error: { code: 'forbidden', message: 'Admins only.' } }),
    )
    expect(failure.descriptionKey).toBe('errors.generic.description.forbidden')
    expect(failure.message).toBe('Admins only.')
  })
})

describe('reportedFailure', () => {
  it('keeps the reported text as detail under the generic reported description', () => {
    expect(reportedFailure('  pod crashed  ')).toEqual({
      descriptionKey: 'errors.reported.description',
      message: 'pod crashed',
      issues: [],
      requestId: null,
    })
  })

  it('takes a caller key and treats blank text as no detail', () => {
    expect(reportedFailure('  ', 'some.key')).toMatchObject({
      descriptionKey: 'some.key',
      message: null,
    })
    expect(reportedFailure(undefined).message).toBeNull()
  })
})

describe('failureDetail', () => {
  it('joins the message, the issues and the request id, dropping empty parts', () => {
    const failure = describeFailure(
      new ApiError(400, {
        error: {
          code: 'validation',
          message: 'Invalid body.',
          issues: [{ path: 'name', message: 'Required' }, { message: 'Too long' }],
          requestId: 'req-2',
        },
      }),
    )
    expect(failureDetail(failure, t)).toBe(
      'Invalid body. · name: Required, Too long · errors.generic.requestId({"id":"req-2"})',
    )
  })

  it('is empty when there is nothing to disclose', () => {
    expect(failureDetail(reportedFailure(null), t)).toBe('')
  })
})
