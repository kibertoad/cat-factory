import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { DocInterviewSession } from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Interactive document-interview sessions (WS5), keyed by their anchor BLOCK id. Loaded on
 * demand when the interview window opens (`load`) and patched live from `docInterview` stream
 * events (`upsert`), so an open window follows the interview as the interviewer asks / converges.
 * Not carried in the workspace snapshot (a transient per-run gate, unlike initiatives).
 * Per-workspace; nothing is persisted client-side.
 */
export const useDocInterviewStore = defineStore('docInterview', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  /** The sessions keyed by their anchor block id. */
  const byBlock = ref<Record<string, DocInterviewSession>>({})
  /** True while a window action (continue/proceed) is resuming the run. */
  const resuming = ref(false)

  function forBlock(blockId: string): DocInterviewSession | null {
    return byBlock.value[blockId] ?? null
  }

  /** Patch from a live `docInterview` stream event or a call response (newest write wins). */
  function upsert(session: DocInterviewSession) {
    const existing = byBlock.value[session.blockId]
    if (existing && existing.updatedAt > session.updatedAt) return
    byBlock.value = { ...byBlock.value, [session.blockId]: session }
  }

  /** Re-fetch one block's session (the interview window's load path). */
  async function load(blockId: string) {
    if (!workspace.workspaceId) return
    const session = await api.getDocInterview(workspace.workspaceId, blockId)
    if (session) upsert(session)
  }

  /** Record the human's answer to one pending interview question (no run resume). */
  async function answerQuestion(blockId: string, questionId: string, answer: string) {
    if (!workspace.workspaceId) throw new Error('No active workspace')
    const updated = await api.answerDocInterview(workspace.workspaceId, blockId, questionId, answer)
    upsert(updated)
    return updated
  }

  /** Submit the answers and resume the interview (the interviewer re-runs, may ask more). */
  async function continueInterview(blockId: string) {
    if (!workspace.workspaceId) throw new Error('No active workspace')
    resuming.value = true
    try {
      const updated = await api.continueDocInterview(workspace.workspaceId, blockId)
      upsert(updated)
      return updated
    } finally {
      resuming.value = false
    }
  }

  /** Skip remaining questions: the interviewer converges and the run advances to the writer. */
  async function proceedInterview(blockId: string) {
    if (!workspace.workspaceId) throw new Error('No active workspace')
    resuming.value = true
    try {
      const updated = await api.proceedDocInterview(workspace.workspaceId, blockId)
      upsert(updated)
      return updated
    } finally {
      resuming.value = false
    }
  }

  function reset() {
    byBlock.value = {}
  }

  return {
    byBlock,
    resuming,
    forBlock,
    upsert,
    load,
    answerQuestion,
    continueInterview,
    proceedInterview,
    reset,
  }
})
