import {
  answerInitiativeQuestionContract,
  cancelInitiativeContract,
  continueInitiativePlanningContract,
  createInitiativeContract,
  dismissInitiativeFollowUpContract,
  getInitiativeByBlockContract,
  getInitiativeContract,
  listInitiativesContract,
  pauseInitiativeContract,
  probeInitiativePresetContract,
  proceedInitiativePlanningContract,
  promoteInitiativeFollowUpContract,
  resumeInitiativeContract,
  updateInitiativeItemContract,
  updateInitiativePolicyContract,
} from '@cat-factory/contracts'
import type {
  InitiativeExecutionPolicy,
  InitiativePresetInputs,
  PromoteInitiativeFollowUpInput,
  UpdateInitiativeItemInput,
} from '@cat-factory/contracts'
import type { ApiContext } from './context'

/** Initiatives: the long-running multi-task work containers (create + tracker reads). */
export function initiativeApi({ send, ws }: ApiContext) {
  return {
    // Create the initiative-level board block AND its empty entity in one call. The optional
    // `presetId` + `presetInputs` carry the create-form picker's selection (validated against the
    // resolved descriptor and frozen on the entity by the server); absent ⇒ the generic behaviour.
    createInitiative: (
      workspaceId: string,
      body: {
        frameId: string
        title: string
        description?: string
        presetId?: string
        presetInputs?: InitiativePresetInputs
      },
    ) => send(createInitiativeContract, { pathPrefix: ws(workspaceId), body }),

    // Run a preset's repo-detection PREFILL probe against a frame's repo (seeds the create form).
    // Best-effort by contract: `{}` (descriptor defaults) when GitHub is unwired / the frame has no
    // linked repo / the preset has no `detect` hook — so the form never blocks on it.
    probeInitiativePreset: (workspaceId: string, presetId: string, frameId: string) =>
      send(probeInitiativePresetContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { presetId },
        body: { frameId },
      }),

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

    // Execution-loop controls (slice 3): pause / resume / cancel an executing initiative.
    pauseInitiative: (workspaceId: string, blockId: string) =>
      send(pauseInitiativeContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    resumeInitiative: (workspaceId: string, blockId: string) =>
      send(resumeInitiativeContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    cancelInitiative: (workspaceId: string, blockId: string) =>
      send(cancelInitiativeContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    // Follow-up triage + item/policy editing (slice 4): keyed by initiative id.
    promoteInitiativeFollowUp: (
      workspaceId: string,
      initiativeId: string,
      followUpId: string,
      body: PromoteInitiativeFollowUpInput,
    ) =>
      send(promoteInitiativeFollowUpContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { initiativeId, followUpId },
        body,
      }),

    dismissInitiativeFollowUp: (workspaceId: string, initiativeId: string, followUpId: string) =>
      send(dismissInitiativeFollowUpContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { initiativeId, followUpId },
      }),

    updateInitiativeItem: (
      workspaceId: string,
      initiativeId: string,
      itemId: string,
      body: UpdateInitiativeItemInput,
    ) =>
      send(updateInitiativeItemContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { initiativeId, itemId },
        body,
      }),

    updateInitiativePolicy: (
      workspaceId: string,
      initiativeId: string,
      body: InitiativeExecutionPolicy,
    ) =>
      send(updateInitiativePolicyContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { initiativeId },
        body,
      }),
  }
}
