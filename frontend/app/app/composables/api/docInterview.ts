import {
  answerDocInterviewContract,
  continueDocInterviewContract,
  getDocInterviewContract,
  proceedDocInterviewContract,
} from '@cat-factory/contracts'
import type { ApiContext } from './context'

/** Interactive document-interview session (WS5): load + answer / continue / proceed. */
export function docInterviewApi({ send, ws }: ApiContext) {
  return {
    // The interview window's load path: the session anchored to a board block (or null).
    getDocInterview: (workspaceId: string, blockId: string) =>
      send(getDocInterviewContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    // Answer one interview question (no run resume), then continue (interviewer re-runs, may
    // ask more) or proceed (skip remaining, synthesize the brief and advance to the writer).
    answerDocInterview: (
      workspaceId: string,
      blockId: string,
      questionId: string,
      answer: string,
    ) =>
      send(answerDocInterviewContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
        body: { questionId, answer },
      }),

    continueDocInterview: (workspaceId: string, blockId: string) =>
      send(continueDocInterviewContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    proceedDocInterview: (workspaceId: string, blockId: string) =>
      send(proceedDocInterviewContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),
  }
}
