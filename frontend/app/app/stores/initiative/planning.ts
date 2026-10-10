import type { Ref } from 'vue'
import { ref } from 'vue'
import type { Initiative } from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Shared reactive state + injected dependencies the initiatives-store action factories close
 * over. Created once in the `initiatives` store setup and threaded into
 * {@link createInitiativePlanningActions} / {@link createInitiativeCurationActions} so the split
 * operations stay behaviourally identical to the original single-closure store — a size-only
 * extraction mirroring `stores/board/` and `stores/pipelines/`, not a new seam.
 */
export interface InitiativeActionContext {
  api: ReturnType<typeof useApi>
  workspace: ReturnType<typeof useWorkspaceStore>
  /** Patch an entity a call returned into the by-block cache (newest rev wins). */
  upsert: (initiative: Initiative) => void
}

/**
 * The planning-window actions: answering / dismissing the interviewer's questions, asking it to
 * recommend an answer, and the two loop-resuming controls (continue / proceed). Owns the
 * in-flight flags the window renders its spinners from.
 */
export function createInitiativePlanningActions(ctx: InitiativeActionContext) {
  const { api, workspace, upsert } = ctx

  /** True while a planning-window action (continue/proceed) is resuming the run. */
  const resuming = ref(false)
  /** Question ids the interviewer is currently drafting a recommendation for (window spinner). */
  const recommending: Ref<Set<string>> = ref(new Set())

  /** Record the human's answer to one pending interview question (no run resume). */
  async function answerQuestion(blockId: string, questionId: string, answer: string) {
    if (!workspace.workspaceId) throw new Error('No active workspace')
    const updated = await api.answerInitiativeQuestion(
      workspace.workspaceId,
      blockId,
      questionId,
      answer,
    )
    upsert(updated)
    return updated
  }

  /** Mark a planning question not-relevant (`dismissed`) or reopen it (no run resume). */
  async function setQuestionStatus(
    blockId: string,
    questionId: string,
    status: 'open' | 'dismissed',
  ) {
    if (!workspace.workspaceId) throw new Error('No active workspace')
    const updated = await api.setInitiativeQuestionStatus(
      workspace.workspaceId,
      blockId,
      questionId,
      status,
    )
    upsert(updated)
    return updated
  }

  /**
   * Ask the interviewer to recommend a suggested answer for one pending question. Runs the
   * interviewer LLM inline server-side; the returned entity carries the suggestion on the question.
   * Tracks the in-flight id so the window can show a per-question spinner.
   */
  async function recommendAnswer(blockId: string, questionId: string) {
    if (!workspace.workspaceId) throw new Error('No active workspace')
    recommending.value = new Set(recommending.value).add(questionId)
    try {
      const updated = await api.recommendInitiativeAnswer(
        workspace.workspaceId,
        blockId,
        questionId,
      )
      upsert(updated)
      return updated
    } finally {
      const next = new Set(recommending.value)
      next.delete(questionId)
      recommending.value = next
    }
  }

  /** Submit the answers and resume the interview (the interviewer re-runs, may ask more). */
  async function continuePlanning(blockId: string) {
    if (!workspace.workspaceId) throw new Error('No active workspace')
    resuming.value = true
    try {
      const updated = await api.continueInitiativePlanning(workspace.workspaceId, blockId)
      upsert(updated)
      return updated
    } finally {
      resuming.value = false
    }
  }

  /** Skip remaining questions: the interviewer converges and the run advances. */
  async function proceedPlanning(blockId: string) {
    if (!workspace.workspaceId) throw new Error('No active workspace')
    resuming.value = true
    try {
      const updated = await api.proceedInitiativePlanning(workspace.workspaceId, blockId)
      upsert(updated)
      return updated
    } finally {
      resuming.value = false
    }
  }

  return {
    resuming,
    recommending,
    answerQuestion,
    setQuestionStatus,
    recommendAnswer,
    continuePlanning,
    proceedPlanning,
  }
}
