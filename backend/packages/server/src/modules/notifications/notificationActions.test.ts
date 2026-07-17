import type { Notification } from '@cat-factory/contracts'
import { describe, expect, it, vi } from 'vitest'
import type { ServerContainer } from '../../http/env.js'
import {
  HEADLESS_ACTIONABLE_NOTIFICATION_TYPES,
  notificationActEffect,
} from './notificationActions.js'

/** A notification with the fields the effect reads, defaulting the rest of the shape. */
function notification(over: Partial<Notification> & Pick<Notification, 'type'>): Notification {
  return {
    id: 'ntf_1',
    status: 'open',
    severity: 'normal',
    blockId: 'blk_1',
    executionId: 'exec_1',
    title: 't',
    body: 'b',
    payload: null,
    createdAt: 1,
    resolvedAt: null,
    ...over,
  }
}

/** A container stub exposing only the two `executionService` methods the effect calls. */
function containerWith() {
  const mergePr = vi.fn(async () => {})
  const retry = vi.fn(async () => {})
  const container = { executionService: { mergePr, retry } } as unknown as ServerContainer
  return { container, mergePr, retry }
}

describe('notificationActEffect', () => {
  it('merges the PR for merge_review / pipeline_complete', async () => {
    for (const type of ['merge_review', 'pipeline_complete'] as const) {
      const { container, mergePr, retry } = containerWith()
      await notificationActEffect(
        container,
        'ws_1',
        'usr_1',
      )(notification({ type, blockId: 'blk_9' }))
      expect(mergePr).toHaveBeenCalledExactlyOnceWith('ws_1', 'blk_9')
      expect(retry).not.toHaveBeenCalled()
    }
  })

  it('retries the run for ci_failed / test_failed', async () => {
    for (const type of ['ci_failed', 'test_failed'] as const) {
      const { container, mergePr, retry } = containerWith()
      await notificationActEffect(
        container,
        'ws_1',
        null,
      )(notification({ type, executionId: 'exec_9' }))
      expect(retry).toHaveBeenCalledExactlyOnceWith('ws_1', 'exec_9')
      expect(mergePr).not.toHaveBeenCalled()
    }
  })

  it('is a no-op for an informational type (no automated side-effect)', async () => {
    const { container, mergePr, retry } = containerWith()
    await notificationActEffect(
      container,
      'ws_1',
      null,
    )(notification({ type: 'requirement_review' }))
    expect(mergePr).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
  })

  it('short-circuits when the merge/retry target id is missing', async () => {
    const { container, mergePr, retry } = containerWith()
    await notificationActEffect(
      container,
      'ws_1',
      null,
    )(notification({ type: 'merge_review', blockId: null }))
    await notificationActEffect(
      container,
      'ws_1',
      null,
    )(notification({ type: 'ci_failed', executionId: null }))
    expect(mergePr).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
  })

  it('the actionable set is exactly the types with a side-effect case', () => {
    expect(new Set(HEADLESS_ACTIONABLE_NOTIFICATION_TYPES)).toEqual(
      new Set(['merge_review', 'pipeline_complete', 'ci_failed', 'test_failed']),
    )
  })
})
