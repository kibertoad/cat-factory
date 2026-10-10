import { describe, expect, it } from 'vitest'
import { createRecordingLogger, noopLogger } from '../ports/logging.js'
import { describeError, runBestEffort } from './best-effort.js'

describe('describeError', () => {
  it('keeps the message and the constructor name', () => {
    expect(describeError(new TypeError('bad shape'))).toEqual({
      err: 'bad shape',
      errKind: 'TypeError',
    })
  })

  it('scrubs a credential the error text echoed back', () => {
    // The realistic case: `fetch` / a provider SDK quoting the request URL in its message.
    const fields = describeError(new Error('GET https://api.example.test/x?token=abcd1234EFGH 401'))
    expect(String(fields.err)).not.toContain('abcd1234EFGH')
    expect(String(fields.err)).toContain('api.example.test')
  })

  it('describes a non-Error throw without losing it', () => {
    expect(describeError('just a string')).toEqual({ err: 'just a string', errKind: 'string' })
  })
})

describe('runBestEffort', () => {
  it('returns the value and logs nothing on success', async () => {
    const logger = createRecordingLogger()
    await expect(runBestEffort(logger, 'op', () => 7)).resolves.toBe(7)
    expect(logger.lines).toEqual([])
  })

  it('swallows a rejection, returns undefined, and warns once naming the operation', async () => {
    const logger = createRecordingLogger()
    const result = await runBestEffort(
      logger,
      'issueWriteback.onPullRequestMerged',
      () => Promise.reject(new Error('github is down')),
      { workspaceId: 'ws_1' },
    )
    expect(result).toBeUndefined()
    expect(logger.lines).toHaveLength(1)
    expect(logger.lines[0]).toMatchObject({
      level: 'warn',
      msg: 'best-effort issueWriteback.onPullRequestMerged failed',
      fields: { workspaceId: 'ws_1', err: 'github is down', errKind: 'Error' },
    })
  })

  it('swallows a SYNCHRONOUS throw too — the caller never sees it', async () => {
    // The distinction matters: `.catch(() => {})` on a function that throws before returning a
    // promise does NOT swallow, so a straight port of the old idiom would change behaviour.
    await expect(
      runBestEffort(noopLogger, 'op', () => {
        throw new Error('threw before awaiting')
      }),
    ).resolves.toBeUndefined()
  })
})

describe('createRecordingLogger', () => {
  it('accumulates a child logger`s bound fields onto every line, in one shared list', () => {
    const logger = createRecordingLogger()
    logger.child({ workspaceId: 'ws_1' }).child({ executionId: 'exec_1' }).info('advanced', {
      step: 'coder',
    })
    expect(logger.lines).toEqual([
      {
        level: 'info',
        msg: 'advanced',
        fields: { workspaceId: 'ws_1', executionId: 'exec_1', step: 'coder' },
      },
    ])
  })
})
