import {
  answerInitiativeQuestionContract,
  continueInitiativePlanningContract,
  createInitiativeContract,
  getInitiativeByBlockContract,
  getInitiativeContract,
  listInitiativesContract,
  proceedInitiativePlanningContract,
} from '@cat-factory/contracts'
import type { ApiContext } from './context'

/** Initiatives: the long-running multi-task work containers (create + tracker reads). */
export function initiativeApi({ send, ws }: ApiContext) {
  return {
    // Create the initiative-level board block AND its empty entity in one call.
    createInitiative: (
      workspaceId: string,
      body: { frameId: string; title: string; description?: string },
    ) => send(createInitiativeContract, { pathPrefix: ws(workspaceId), body }),

    listInitiatives: (workspaceId: string) =>
      send(listInitiativesContract, { pathPrefix: ws(workspaceId) }),

    getInitiative: (workspaceId: string, initiativeId: string) =>
      send(getInitiativeContract, { pathPrefix: ws(workspaceId), pathParams: { initiativeId } }),

    // The tracker window's load path: the initiative anchored to a board block.
    getInitiativeByBlock: (workspaceId: string, blockId: string) =>
      send(getInitiativeByBlockContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    // Interactive planning (slice 2): answer one interview question (no run resume), then
    // continue (interviewer re-runs, may ask more) or proceed (skip remaining, plan now).
    answerInitiativeQuestion: (
      workspaceId: string,
      blockId: string,
      questionId: string,
      answer: string,
    ) =>
      send(answerInitiativeQuestionContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
        body: { questionId, answer },
      }),

    continueInitiativePlanning: (workspaceId: string, blockId: string) =>
      send(continueInitiativePlanningContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
      }),

    proceedInitiativePlanning: (workspaceId: string, blockId: string) =>
      send(proceedInitiativePlanningContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
      }),
  }
}
