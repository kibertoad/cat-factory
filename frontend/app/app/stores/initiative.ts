import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Initiative } from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'
import { useBoardStore } from '~/stores/board'

/**
 * Initiative state — the long-running multi-task work containers, keyed by their
 * anchor BLOCK id (the id everything on the board navigates by). Hydrated from the
 * workspace snapshot (`snapshot.initiatives`) and patched live from `initiative`
 * stream events; `create` calls the API and applies the authoritative entity +
 * block the server returns. `available` mirrors the backend's opt-in module (a 503
 * hides the UI). Per-workspace; nothing is persisted client-side.
 *
 * NOTE: distinct from `useTrackerStore` (the workspace's ISSUE-tracker selection) —
 * "tracker" in initiative-land means the initiative's plan/tracker document.
 */
export const useInitiativesStore = defineStore('initiatives', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  /** null = unknown (not probed), true/false = feature on/off. */
  const available = ref<boolean | null>(null)
  /** The entities keyed by their anchor block id. */
  const byBlock = ref<Record<string, Initiative>>({})
  /** True while a create call is in flight (the modal's submit spinner). */
  const creating = ref(false)

  const all = computed(() => Object.values(byBlock.value))

  function forBlock(blockId: string): Initiative | null {
    return byBlock.value[blockId] ?? null
  }

  /**
   * Rebuild the cache from a snapshot (the hydrate fan-out). The snapshot is authoritative
   * for EXISTENCE (entities it omits are dropped — they were deleted), but NOT for freshness:
   * a stale snapshot captured before a live `initiative` event must not regress a newer entity
   * already patched into the store. So for a blockId present in both, keep whichever `rev` is
   * higher — the same live-event-vs-resync race guard `upsert` applies, mirroring the fix the
   * repo's flake note describes for `agentRuns.hydrate`.
   */
  function hydrate(next: Initiative[] | undefined) {
    if (next === undefined) return
    available.value = true
    const map: Record<string, Initiative> = {}
    for (const initiative of next) {
      const existing = byBlock.value[initiative.blockId]
      map[initiative.blockId] = existing && existing.rev > initiative.rev ? existing : initiative
    }
    byBlock.value = map
  }

  /** Patch from a live `initiative` stream event or a call response (newest rev wins). */
  function upsert(initiative: Initiative) {
    const existing = byBlock.value[initiative.blockId]
    if (existing && existing.rev > initiative.rev) return
    byBlock.value = { ...byBlock.value, [initiative.blockId]: initiative }
  }

  /** Create an initiative under a service frame (block + entity in one call). */
  async function create(frameId: string, input: { title: string; description?: string }) {
    if (!workspace.workspaceId) throw new Error('No active workspace')
    creating.value = true
    try {
      const created = await api.createInitiative(workspace.workspaceId, {
        frameId,
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
      })
      useBoardStore().upsert(created.block)
      upsert(created.initiative)
      return created
    } finally {
      creating.value = false
    }
  }

  /** Re-fetch one block's initiative (the tracker window's load path). */
  async function load(blockId: string) {
    if (!workspace.workspaceId) return
    try {
      const initiative = await api.getInitiativeByBlock(workspace.workspaceId, blockId)
      available.value = true
      if (initiative) upsert(initiative)
    } catch (error) {
      const status = (error as { status?: number } | null)?.status
      if (status === 503) available.value = false
      else throw error
    }
  }

  /** True while a planning-window action (continue/proceed) is resuming the run. */
  const resuming = ref(false)

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

  /** True while a loop control (pause/resume/cancel) is in flight. */
  const controlling = ref(false)

  /** Pause / resume / cancel an executing initiative's loop. Applies the returned entity. */
  async function control(blockId: string, action: 'pause' | 'resume' | 'cancel') {
    if (!workspace.workspaceId) throw new Error('No active workspace')
    controlling.value = true
    try {
      const call =
        action === 'pause'
          ? api.pauseInitiative
          : action === 'resume'
            ? api.resumeInitiative
            : api.cancelInitiative
      const updated = await call(workspace.workspaceId, blockId)
      if (updated) upsert(updated)
      return updated
    } finally {
      controlling.value = false
    }
  }

  function reset() {
    byBlock.value = {}
  }

  return {
    available,
    byBlock,
    all,
    creating,
    resuming,
    controlling,
    forBlock,
    hydrate,
    upsert,
    create,
    load,
    answerQuestion,
    continuePlanning,
    proceedPlanning,
    control,
    reset,
  }
})
