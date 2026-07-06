import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  Initiative,
  InitiativeExecutionPolicy,
  InitiativePresetDescriptor,
  PromoteInitiativeFollowUpInput,
  UpdateInitiativeItemInput,
} from '~/types/domain'

/** The built-in generic preset id (mirrors kernel's `GENERIC_INITIATIVE_PRESET_ID`). */
const GENERIC_PRESET_ID = 'preset_generic'
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
  /**
   * The registered initiative-preset descriptors from the snapshot (built-in generic + any a
   * deployment mixed in). Drives the create picker and — already today — which planning pipeline
   * "Run planning" starts. Empty until a snapshot hydrates it; the SPA falls back to the generic
   * pipeline when a preset can't be resolved.
   */
  const presets = ref<InitiativePresetDescriptor[]>([])

  const all = computed(() => Object.values(byBlock.value))

  function forBlock(blockId: string): Initiative | null {
    return byBlock.value[blockId] ?? null
  }

  /** Resolve a preset descriptor by id (defaulting to the generic preset), or null when unknown. */
  function presetById(presetId: string | undefined): InitiativePresetDescriptor | null {
    return presets.value.find((p) => p.id === (presetId ?? GENERIC_PRESET_ID)) ?? null
  }

  /**
   * The planning pipeline id to start for an initiative: its preset descriptor's
   * `planningPipelineId`. No preset (or the built-in generic) → `pl_initiative`, which is always in
   * the catalog. For a NAMED preset we return `null` (not the generic pipeline) when presets
   * haven't hydrated or the snapshot omitted this descriptor — so the caller keeps "Run planning"
   * disabled rather than silently launching the interviewer over an already-seeded skip-interview
   * initiative.
   */
  function planningPipelineIdFor(initiative: Initiative | null): string | null {
    const presetId = initiative?.presetId
    if (!presetId || presetId === GENERIC_PRESET_ID) return 'pl_initiative'
    return presetById(presetId)?.planningPipelineId ?? null
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

  /** Replace the registered preset descriptors from a snapshot (idempotent on reload). */
  function hydratePresets(next: InitiativePresetDescriptor[] | undefined) {
    if (next === undefined) return
    presets.value = next
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

  /** True while a curation action (promote/dismiss/edit item/edit policy) is in flight. */
  const curating = ref(false)

  async function curate<T>(fn: () => Promise<T>): Promise<T> {
    if (!workspace.workspaceId) throw new Error('No active workspace')
    curating.value = true
    try {
      return await fn()
    } finally {
      curating.value = false
    }
  }

  /** Promote an `open` harvested follow-up into a new pending tracker item. */
  async function promoteFollowUp(
    initiativeId: string,
    followUpId: string,
    input: PromoteInitiativeFollowUpInput,
  ) {
    return curate(async () => {
      const updated = await api.promoteInitiativeFollowUp(
        workspace.workspaceId!,
        initiativeId,
        followUpId,
        input,
      )
      upsert(updated)
      return updated
    })
  }

  /** Dismiss a harvested follow-up. */
  async function dismissFollowUp(initiativeId: string, followUpId: string) {
    return curate(async () => {
      const updated = await api.dismissInitiativeFollowUp(
        workspace.workspaceId!,
        initiativeId,
        followUpId,
      )
      upsert(updated)
      return updated
    })
  }

  /** Edit one tracker item and/or drive its status (retry a blocked item / skip it). */
  async function updateItem(
    initiativeId: string,
    itemId: string,
    input: UpdateInitiativeItemInput,
  ) {
    return curate(async () => {
      const updated = await api.updateInitiativeItem(
        workspace.workspaceId!,
        initiativeId,
        itemId,
        input,
      )
      upsert(updated)
      return updated
    })
  }

  /** Replace the execution policy (concurrency + pipeline rules). */
  async function updatePolicy(initiativeId: string, policy: InitiativeExecutionPolicy) {
    return curate(async () => {
      const updated = await api.updateInitiativePolicy(workspace.workspaceId!, initiativeId, policy)
      upsert(updated)
      return updated
    })
  }

  function reset() {
    byBlock.value = {}
  }

  return {
    available,
    byBlock,
    presets,
    all,
    creating,
    resuming,
    controlling,
    curating,
    forBlock,
    presetById,
    planningPipelineIdFor,
    hydrate,
    hydratePresets,
    upsert,
    create,
    load,
    answerQuestion,
    continuePlanning,
    proceedPlanning,
    control,
    promoteFollowUp,
    dismissFollowUp,
    updateItem,
    updatePolicy,
    reset,
  }
})
