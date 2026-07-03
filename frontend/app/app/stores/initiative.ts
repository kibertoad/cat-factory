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

  /** Replace the cache from a snapshot (the hydrate fan-out). */
  function hydrate(next: Initiative[] | undefined) {
    if (next === undefined) return
    available.value = true
    const map: Record<string, Initiative> = {}
    for (const initiative of next) map[initiative.blockId] = initiative
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

  function reset() {
    byBlock.value = {}
  }

  return { available, byBlock, all, creating, forBlock, hydrate, upsert, create, load, reset }
})
