import { describe, expect, it } from 'vitest'
import type { RequirementReview, RequirementReviewRepository } from '@cat-factory/kernel'
import { RefinedRequirementsPublisher } from './RefinedRequirementsPublisher.js'

function reviews(review: Partial<RequirementReview> | null): RequirementReviewRepository {
  return {
    getByBlock: async () => (review ? ({ id: 'rrv_1', ...review } as RequirementReview) : null),
  } as unknown as RequirementReviewRepository
}

describe('RefinedRequirementsPublisher', () => {
  it('posts the stored document under the review id', async () => {
    const posts: unknown[] = []
    const publisher = new RefinedRequirementsPublisher({
      requirementReviewRepository: reviews({
        status: 'incorporated',
        incorporatedRequirements: 'doc',
      }),
      issueWriteback: {
        postRefinedRequirements: async (workspaceId, blockId, post) => {
          posts.push({ workspaceId, blockId, post })
          return { issues: [{ source: 'jira', externalId: 'ENG-1', outcome: 'posted' }] }
        },
      },
    })
    const result = await publisher.publish('ws', 'blk')
    expect(result.issues).toHaveLength(1)
    expect(posts).toEqual([
      { workspaceId: 'ws', blockId: 'blk', post: { reviewId: 'rrv_1', document: 'doc' } },
    ])
  })

  for (const [label, review] of [
    ['no review', null],
    ['no document yet', { status: 'ready', incorporatedRequirements: null }],
    ['a fold rewriting the document', { status: 'incorporating', incorporatedRequirements: 'old' }],
  ] as const) {
    it(`refuses with refined_requirements_unavailable when there is ${label}`, async () => {
      const publisher = new RefinedRequirementsPublisher({
        requirementReviewRepository: reviews(review as Partial<RequirementReview> | null),
        issueWriteback: {
          postRefinedRequirements: async () => {
            throw new Error('must not post')
          },
        },
      })
      await expect(publisher.publish('ws', 'blk')).rejects.toMatchObject({
        code: 'conflict',
        details: { reason: 'refined_requirements_unavailable' },
      })
    })
  }

  it('refuses with no_linked_issues when the block has none', async () => {
    const publisher = new RefinedRequirementsPublisher({
      requirementReviewRepository: reviews({
        status: 'incorporated',
        incorporatedRequirements: 'doc',
      }),
      issueWriteback: { postRefinedRequirements: async () => ({ issues: [] }) },
    })
    await expect(publisher.publish('ws', 'blk')).rejects.toMatchObject({
      details: { reason: 'no_linked_issues' },
    })
  })
})
