import { defineApiContract, noBodyResponse, withObjectKeys } from '@toad-contracts/valibot'
import { ContractNoBody } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  askGuidedReviewSchema,
  guidedReviewExchangeSchema,
  guidedReviewSessionViewSchema,
  guidedReviewThreadViewSchema,
  listPublicGuidedReviewsQuerySchema,
  openGuidedReviewSchema,
  openGuidedReviewThreadSchema,
  publicGuidedReviewListSchema,
  requestGuidedReviewDraftsSchema,
} from '../guided-review.js'
import { errorResponses, singleStringParam, withMinScope } from './_shared.js'

// The public guided PR review surface: absolute `/api/v1` paths, authenticated in-controller by a
// public-API key. The same sessions the app's review window drives, so another UI can offer the
// whole experience. Reading is `read`; opening, asking and drafting are `write`, because they
// spend model budget, and nothing here merges or posts on the pull request. Writes answer with
// the persisted state at once; the overview and answers complete later, observable on
// `GET /api/v1/guided-reviews/{sessionId}/events` or by re-reading.

const sessionParams = singleStringParam('sessionId')
const threadParams = withObjectKeys(v.object({ sessionId: v.string(), threadId: v.string() }))

export const openPublicGuidedReviewContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    pathResolver: () => '/api/v1/guided-reviews',
    requestBodySchema: openGuidedReviewSchema,
    responsesByStatusCode: { 200: guidedReviewSessionViewSchema, ...errorResponses },
  }),
)

export const listPublicGuidedReviewsContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestQuerySchema: listPublicGuidedReviewsQuerySchema,
    pathResolver: () => '/api/v1/guided-reviews',
    responsesByStatusCode: { 200: publicGuidedReviewListSchema, ...errorResponses },
  }),
)

export const getPublicGuidedReviewContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: sessionParams,
    pathResolver: ({ sessionId }) => `/api/v1/guided-reviews/${sessionId}`,
    responsesByStatusCode: { 200: guidedReviewSessionViewSchema, ...errorResponses },
  }),
)

export const deletePublicGuidedReviewContract = withMinScope(
  'write',
  defineApiContract({
    method: 'delete',
    requestPathParamsSchema: sessionParams,
    pathResolver: ({ sessionId }) => `/api/v1/guided-reviews/${sessionId}`,
    responsesByStatusCode: { 204: noBodyResponse(), ...errorResponses },
  }),
)

export const refreshPublicGuidedReviewContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: sessionParams,
    pathResolver: ({ sessionId }) => `/api/v1/guided-reviews/${sessionId}/refresh`,
    requestBodySchema: ContractNoBody,
    responsesByStatusCode: { 200: guidedReviewSessionViewSchema, ...errorResponses },
  }),
)

export const openPublicGuidedReviewThreadContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: sessionParams,
    pathResolver: ({ sessionId }) => `/api/v1/guided-reviews/${sessionId}/threads`,
    requestBodySchema: openGuidedReviewThreadSchema,
    responsesByStatusCode: { 200: guidedReviewThreadViewSchema, ...errorResponses },
  }),
)

export const getPublicGuidedReviewThreadContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: threadParams,
    pathResolver: ({ sessionId, threadId }) =>
      `/api/v1/guided-reviews/${sessionId}/threads/${threadId}`,
    responsesByStatusCode: { 200: guidedReviewThreadViewSchema, ...errorResponses },
  }),
)

export const askPublicGuidedReviewContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: threadParams,
    pathResolver: ({ sessionId, threadId }) =>
      `/api/v1/guided-reviews/${sessionId}/threads/${threadId}/messages`,
    requestBodySchema: askGuidedReviewSchema,
    responsesByStatusCode: { 200: guidedReviewExchangeSchema, ...errorResponses },
  }),
)

export const requestPublicGuidedReviewDraftsContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: threadParams,
    pathResolver: ({ sessionId, threadId }) =>
      `/api/v1/guided-reviews/${sessionId}/threads/${threadId}/comment-drafts`,
    requestBodySchema: requestGuidedReviewDraftsSchema,
    responsesByStatusCode: { 200: guidedReviewExchangeSchema, ...errorResponses },
  }),
)
