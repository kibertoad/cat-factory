import type { Notification } from '@cat-factory/contracts'
import { notificationTypeSchema } from '@cat-factory/contracts'
import { describe, expect, it, vi } from 'vitest'
import type { ServerContainer } from '../../http/env.js'
import {
  HEADLESS_ACTIONABLE_NOTIFICATION_TYPES,
  notificationActEffect,
  RUN_RETRYING_NOTIFICATION_TYPES,
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

/** A container stub exposing only what the effect calls: two `executionService` methods plus the
 *  optional merge track-record module the effort tag lands on. */
function containerWith() {
  const mergePr = vi.fn(async () => {})
  const retry = vi.fn(async () => {})
  const tag = vi.fn(async () => {})
  const container = {
    executionService: { mergePr, retry },
    mergeTrackRecords: { service: { tag } },
  } as unknown as ServerContainer
  return { container, mergePr, retry, tag }
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
      // No effort supplied ⇒ the tag is passed through as `undefined`, so the merge track record
      // keeps a null tag. Tagging is a nudge, never a gate.
      expect(mergePr).toHaveBeenCalledExactlyOnceWith('ws_1', 'blk_9', undefined)
      expect(retry).not.toHaveBeenCalled()
    }
  })

  it('forwards the reviewer-effort tag to the merge so it lands in the same request', async () => {
    // The one-tap confirm-and-tag: the card's picked effort travels with the merge rather than
    // needing a second round-trip, which is what keeps tagging cheap enough to actually happen.
    for (const type of ['merge_review', 'pipeline_complete'] as const) {
      const { container, mergePr } = containerWith()
      await notificationActEffect(
        container,
        'ws_1',
        'usr_1',
        'major',
      )(notification({ type, blockId: 'blk_9' }))
      expect(mergePr).toHaveBeenCalledExactlyOnceWith('ws_1', 'blk_9', 'major')
    }
  })

  it('records ONLY the tag for a merge_tag_request (the PR already merged externally)', async () => {
    // The post-hoc nudge has nothing to merge — acting on it must not call `mergePr`, or it would
    // throw on a block that is already `done`.
    const { container, mergePr, tag } = containerWith()
    await notificationActEffect(
      container,
      'ws_1',
      'usr_1',
      'none',
    )(notification({ type: 'merge_tag_request', payload: { mergeTrackRecordId: 'mtr_1' } }))
    expect(tag).toHaveBeenCalledExactlyOnceWith('ws_1', 'mtr_1', 'none')
    expect(mergePr).not.toHaveBeenCalled()
  })

  it('does nothing for a merge_tag_request with no record id or no picked effort', async () => {
    // Both are best-effort states: a record may never have been written (classification is a side
    // channel), and a human may act without picking. Neither may throw.
    const noRecord = containerWith()
    await notificationActEffect(
      noRecord.container,
      'ws_1',
      'usr_1',
      'none',
    )(notification({ type: 'merge_tag_request', payload: null }))
    expect(noRecord.tag).not.toHaveBeenCalled()

    const noEffort = containerWith()
    await notificationActEffect(
      noEffort.container,
      'ws_1',
      'usr_1',
    )(notification({ type: 'merge_tag_request', payload: { mergeTrackRecordId: 'mtr_1' } }))
    expect(noEffort.tag).not.toHaveBeenCalled()
  })

  it('retries the run for ci_failed / test_failed / deploy_blocked', async () => {
    for (const type of ['ci_failed', 'test_failed', 'deploy_blocked'] as const) {
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
      new Set(['merge_review', 'pipeline_complete', 'ci_failed', 'test_failed', 'deploy_blocked']),
    )
  })

  it('retries the run for exactly the declared retry set, over the whole vocabulary', async () => {
    // The public API's individual-usage credential guard branches on
    // `RUN_RETRYING_NOTIFICATION_TYPES` and this effect is what it is guarding, so the two are only
    // safe while the set states what the effect actually does. Driven over EVERY member of the
    // picklist rather than the handful named above: a new card type that retries is admitted to
    // this route ungated, and the only assertion that catches that is one nobody has to remember to
    // extend.
    for (const type of notificationTypeSchema.options) {
      const { container, retry } = containerWith()
      await notificationActEffect(container, 'ws_1', null)(notification({ type }))
      expect(
        { type, retried: retry.mock.calls.length > 0 },
        `${type} must retry iff it is in RUN_RETRYING_NOTIFICATION_TYPES`,
      ).toEqual({ type, retried: RUN_RETRYING_NOTIFICATION_TYPES.has(type) })
    }
  })
})
