import { describe, expect, it } from 'vitest'
import type { RefinedRequirementsWritebackResult } from '@cat-factory/contracts'
import {
  createRecordingLogger,
  type OperationalCounter,
  type OperationalDimensions,
  type RequirementReview,
  type RequirementReviewRepository,
} from '@cat-factory/kernel'
import { RefinedRequirementsPublisher } from './RefinedRequirementsPublisher.js'

function harness(
  review: Partial<RequirementReview> | null,
  write: () => Promise<RefinedRequirementsWritebackResult | 'disabled'>,
) {
  const recorded: unknown[] = []
  const counted: { counter: OperationalCounter; dimensions?: OperationalDimensions }[] = []
  const calls: unknown[] = []
  const logger = createRecordingLogger()
  const publisher = new RefinedRequirementsPublisher({
    requirementReviewRepository: {
      getByBlock: async () => (review ? ({ id: 'rrv_1', ...review } as RequirementReview) : null),
      recordIssueWriteback: async (ws: string, id: string, record: unknown) => {
        recorded.push({ ws, id, record })
      },
    } as unknown as RequirementReviewRepository,
    issueWriteback: {
      writeRefinedRequirements: async (...args) => {
        calls.push(args)
        return write()
      },
    },
    operationalMetrics: {
      increment: (counter, dimensions) => counted.push({ counter, dimensions }),
    },
    clock: { now: () => 7 },
    logger,
  })
  return { publisher, recorded, counted, calls, logger }
}

const SETTLED = { status: 'incorporated' as const, incorporatedRequirements: 'doc' }
const ONE_UPDATED: RefinedRequirementsWritebackResult = {
  issues: [{ source: 'jira', externalId: 'ENG-7', outcome: 'updated' }],
}

describe('RefinedRequirementsPublisher.publish', () => {
  it('writes the stored document, records the outcome and counts it', async () => {
    const h = harness(SETTLED, async () => ONE_UPDATED)
    expect(await h.publisher.publish('ws', 'blk')).toEqual(ONE_UPDATED)
    expect(h.calls).toEqual([['ws', 'blk', 'doc', 'manual']])
    expect(h.recorded).toEqual([
      { ws: 'ws', id: 'rrv_1', record: { trigger: 'manual', at: 7, issues: ONE_UPDATED.issues } },
    ])
    expect(h.counted).toEqual([
      {
        counter: 'writeback.requirements_description',
        dimensions: { trigger: 'manual', outcome: 'updated' },
      },
    ])
  })

  for (const [label, review] of [
    ['no review', null],
    ['no document yet', { status: 'ready', incorporatedRequirements: null }],
    ['a fold rewriting the document', { status: 'incorporating', incorporatedRequirements: 'old' }],
  ] as const) {
    it(`refuses with refined_requirements_unavailable when there is ${label}`, async () => {
      const h = harness(review as Partial<RequirementReview> | null, async () => ONE_UPDATED)
      await expect(h.publisher.publish('ws', 'blk')).rejects.toMatchObject({
        details: { reason: 'refined_requirements_unavailable' },
      })
      expect(h.calls).toEqual([])
    })
  }

  it('refuses with no_linked_issues when the block has none', async () => {
    const h = harness(SETTLED, async () => ({ issues: [] }))
    await expect(h.publisher.publish('ws', 'blk')).rejects.toMatchObject({
      details: { reason: 'no_linked_issues' },
    })
    expect(h.recorded).toEqual([])
  })
})

describe('RefinedRequirementsPublisher.onReviewSettled', () => {
  it('writes automatically and records it as automatic', async () => {
    const h = harness(SETTLED, async () => ONE_UPDATED)
    await h.publisher.onReviewSettled('ws', 'blk')
    expect(h.calls).toEqual([['ws', 'blk', 'doc', 'automatic']])
    expect(h.recorded).toEqual([
      {
        ws: 'ws',
        id: 'rrv_1',
        record: { trigger: 'automatic', at: 7, issues: ONE_UPDATED.issues },
      },
    ])
  })

  it('records nothing when the workspace has the setting off', async () => {
    const h = harness(SETTLED, async () => 'disabled')
    await h.publisher.onReviewSettled('ws', 'blk')
    expect(h.recorded).toEqual([])
    expect(h.counted).toEqual([])
  })

  it('never throws into the run, and says why it did not write', async () => {
    const h = harness(SETTLED, async () => {
      throw new Error('tracker store unreachable')
    })
    await expect(h.publisher.onReviewSettled('ws', 'blk')).resolves.toBeUndefined()
    expect(h.logger.lines.map((line) => line.level)).toContain('warn')
  })
})
