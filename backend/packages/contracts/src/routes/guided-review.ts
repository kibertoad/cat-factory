import {
  ContractNoBody,
  defineApiContract,
  noBodyResponse,
  withObjectKeys,
} from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  askGuidedReviewSchema,
  editGuidedReviewDraftSchema,
  guidedReviewCommentDraftSchema,
  guidedReviewExchangeSchema,
  guidedReviewPostResultSchema,
  guidedReviewSessionSchema,
  guidedReviewSessionViewSchema,
  guidedReviewThreadViewSchema,
  listGuidedReviewsQuerySchema,
  openGuidedReviewSchema,
  openGuidedReviewThreadSchema,
  postGuidedReviewDraftsSchema,
  requestGuidedReviewDraftsSchema,
} from '../guided-review.js'
import { errorResponses, singleStringParam } from './_shared.js'

// Guided PR review routes for the SPA, mounted under `/workspaces/:workspaceId`. See
// GuidedReviewController in @cat-factory/server and backend/docs/adr/0066-guided-pr-review.md. Writes
// return at once; the overview and every answer arrive later through the `guidedReview` event.

const sessionParams = singleStringParam('sessionId')
const threadParams = withObjectKeys(v.object({ sessionId: v.string(), threadId: v.string() }))

export const openGuidedReviewContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/guided-reviews',
  requestBodySchema: openGuidedReviewSchema,
  responsesByStatusCode: { 200: guidedReviewSessionViewSchema, ...errorResponses },
})

export const listGuidedReviewsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/guided-reviews',
  requestQuerySchema: listGuidedReviewsQuerySchema,
  responsesByStatusCode: { 200: v.array(guidedReviewSessionSchema), ...errorResponses },
})

export const getGuidedReviewContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: sessionParams,
  pathResolver: ({ sessionId }) => `/guided-reviews/${sessionId}`,
  responsesByStatusCode: { 200: guidedReviewSessionViewSchema, ...errorResponses },
})

export const deleteGuidedReviewContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: sessionParams,
  pathResolver: ({ sessionId }) => `/guided-reviews/${sessionId}`,
  responsesByStatusCode: { 204: noBodyResponse(), ...errorResponses },
})

export const refreshGuidedReviewContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: sessionParams,
  pathResolver: ({ sessionId }) => `/guided-reviews/${sessionId}/refresh`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: guidedReviewSessionViewSchema, ...errorResponses },
})

export const openGuidedReviewThreadContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: sessionParams,
  pathResolver: ({ sessionId }) => `/guided-reviews/${sessionId}/threads`,
  requestBodySchema: openGuidedReviewThreadSchema,
  responsesByStatusCode: { 200: guidedReviewThreadViewSchema, ...errorResponses },
})

export const getGuidedReviewThreadContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: threadParams,
  pathResolver: ({ sessionId, threadId }) => `/guided-reviews/${sessionId}/threads/${threadId}`,
  responsesByStatusCode: { 200: guidedReviewThreadViewSchema, ...errorResponses },
})

export const askGuidedReviewContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: threadParams,
  pathResolver: ({ sessionId, threadId }) =>
    `/guided-reviews/${sessionId}/threads/${threadId}/messages`,
  requestBodySchema: askGuidedReviewSchema,
  responsesByStatusCode: { 200: guidedReviewExchangeSchema, ...errorResponses },
})

export const requestGuidedReviewDraftsContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: threadParams,
  pathResolver: ({ sessionId, threadId }) =>
    `/guided-reviews/${sessionId}/threads/${threadId}/comment-drafts`,
  requestBodySchema: requestGuidedReviewDraftsSchema,
  responsesByStatusCode: { 200: guidedReviewExchangeSchema, ...errorResponses },
})

const draftParams = withObjectKeys(v.object({ sessionId: v.string(), draftId: v.string() }))

export const editGuidedReviewDraftContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: draftParams,
  pathResolver: ({ sessionId, draftId }) =>
    `/guided-reviews/${sessionId}/comment-drafts/${draftId}`,
  requestBodySchema: editGuidedReviewDraftSchema,
  responsesByStatusCode: { 200: guidedReviewCommentDraftSchema, ...errorResponses },
})

export const postGuidedReviewDraftsContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: sessionParams,
  pathResolver: ({ sessionId }) => `/guided-reviews/${sessionId}/comment-drafts/post`,
  requestBodySchema: postGuidedReviewDraftsSchema,
  responsesByStatusCode: { 200: guidedReviewPostResultSchema, ...errorResponses },
})
