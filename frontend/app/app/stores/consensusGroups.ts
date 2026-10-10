import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  ConsensusGroup,
  CreateConsensusGroupInput,
  UpdateConsensusGroupInput,
} from '~/types/consensus'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The workspace's consensus-GROUP library: the reusable, estimate-gated review panels a pipeline
 * step escalates to. Hydrated from the workspace snapshot (like the model presets) and managed
 * from the Model Configuration settings screen; the pipeline builder reads it to offer a step's
 * tier set.
 *
 * A workspace that has authored no group simply has nothing to escalate to, and every consensus
 * step runs the inline participants written on it — so an empty library is a valid, quiet state,
 * not an error.
 */
export const useConsensusGroupsStore = defineStore('consensusGroups', () => {
  const api = useApi()

  const groups = ref<ConsensusGroup[]>([])

  function hydrate(list: ConsensusGroup[]) {
    groups.value = [...list].sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Whether the workspace has any tier to escalate to (drives the builder's empty state). */
  const hasGroups = computed(() => groups.value.length > 0)

  /** Resolve ids to groups, dropping any the library no longer holds. */
  function resolve(ids: readonly string[] | undefined): ConsensusGroup[] {
    if (!ids?.length) return []
    return ids
      .map((id) => groups.value.find((g) => g.id === id))
      .filter((g): g is ConsensusGroup => !!g)
  }

  /**
   * The estimate bar a group sets, as a display number: the highest threshold it names, or null
   * when it is ungated (the unconditional floor tier). Mirrors kernel's `consensusGroupBar`,
   * which returns -1 for the same case — the sentinel exists so an ungated group SORTS below
   * every gated one, which is a ranking concern the UI doesn't share.
   */
  function barFor(group: ConsensusGroup): number | null {
    if (!group.gating.enabled) return null
    const thresholds = [
      group.gating.minComplexity,
      group.gating.minRisk,
      group.gating.minImpact,
    ].filter((t): t is number => t !== undefined)
    return thresholds.length ? Math.max(...thresholds) : null
  }

  async function create(input: CreateConsensusGroupInput) {
    const ws = useWorkspaceStore()
    const created = await api.createConsensusGroup(ws.requireId(), input)
    await ws.refresh()
    return created
  }

  async function update(groupId: string, patch: UpdateConsensusGroupInput) {
    const ws = useWorkspaceStore()
    const updated = await api.updateConsensusGroup(ws.requireId(), groupId, patch)
    await ws.refresh()
    return updated
  }

  async function remove(groupId: string) {
    const ws = useWorkspaceStore()
    await api.deleteConsensusGroup(ws.requireId(), groupId)
    await ws.refresh()
  }

  return { groups, hasGroups, hydrate, resolve, barFor, create, update, remove }
})
