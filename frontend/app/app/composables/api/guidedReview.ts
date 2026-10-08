import {
  askGuidedReviewContract,
  deleteGuidedReviewContract,
  getGuidedReviewContract,
  getGuidedReviewThreadContract,
  listGuidedReviewsContract,
  openGuidedReviewContract,
  openGuidedReviewThreadContract,
  refreshGuidedReviewContract,
  requestGuidedReviewDraftsContract,
} from '@cat-factory/contracts'
import type {
  AskGuidedReviewInput,
  OpenGuidedReviewInput,
  OpenGuidedReviewThreadInput,
} from '~/types/domain'
import type { ApiContext } from './context'

/** Guided PR review: sessions, their threads, questions and comment-draft requests. */
export function guidedReviewApi({ send, ws }: ApiContext) {
  return {
    openGuidedReview: (workspaceId: string, body: OpenGuidedReviewInput) =>
      send(openGuidedReviewContract, { pathPrefix: ws(workspaceId), body }),

    listGuidedReviews: (
      workspaceId: string,
      query: { repoId?: string; prNumber?: string; mine?: 'true' | 'false' } = {},
    ) => send(listGuidedReviewsContract, { pathPrefix: ws(workspaceId), queryParams: query }),

    getGuidedReview: (workspaceId: string, sessionId: string) =>
      send(getGuidedReviewContract, { pathPrefix: ws(workspaceId), pathParams: { sessionId } }),

    deleteGuidedReview: (workspaceId: string, sessionId: string) =>
      send(deleteGuidedReviewContract, { pathPrefix: ws(workspaceId), pathParams: { sessionId } }),

    refreshGuidedReview: (workspaceId: string, sessionId: string) =>
      send(refreshGuidedReviewContract, { pathPrefix: ws(workspaceId), pathParams: { sessionId } }),

    openGuidedReviewThread: (
      workspaceId: string,
      sessionId: string,
      body: OpenGuidedReviewThreadInput,
    ) =>
      send(openGuidedReviewThreadContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { sessionId },
        body,
      }),

    getGuidedReviewThread: (workspaceId: string, sessionId: string, threadId: string) =>
      send(getGuidedReviewThreadContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { sessionId, threadId },
      }),

    askGuidedReview: (
      workspaceId: string,
      sessionId: string,
      threadId: string,
      body: AskGuidedReviewInput,
    ) =>
      send(askGuidedReviewContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { sessionId, threadId },
        body,
      }),

    requestGuidedReviewDrafts: (
      workspaceId: string,
      sessionId: string,
      threadId: string,
      instructions = '',
    ) =>
      send(requestGuidedReviewDraftsContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { sessionId, threadId },
        body: { instructions },
      }),
  }
}
