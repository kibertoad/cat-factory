import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AgentKind, Pipeline } from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Saved, reusable pipelines (the pipeline palette) plus the in-progress draft
 * being assembled in the pipeline builder. Saved pipelines live on the backend;
 * the draft is transient client state.
 */
export const usePipelinesStore = defineStore('pipelines', () => {
  const api = useApi()
  const pipelines = ref<Pipeline[]>([])

  /** The chain currently being assembled in the builder. */
  const draft = ref<AgentKind[]>([])
  /** Per-step approval gates, kept index-aligned with `draft`. */
  const draftGates = ref<boolean[]>([])
  const draftName = ref('New pipeline')

  /** Replace the cached pipelines with a server snapshot. */
  function hydrate(next: Pipeline[]) {
    pipelines.value = next
  }

  function getPipeline(id: string) {
    return pipelines.value.find((p) => p.id === id)
  }

  function addToDraft(kind: AgentKind) {
    draft.value.push(kind)
    draftGates.value.push(false)
  }

  function removeFromDraft(index: number) {
    draft.value.splice(index, 1)
    draftGates.value.splice(index, 1)
  }

  function moveInDraft(from: number, to: number) {
    if (to < 0 || to >= draft.value.length) return
    const [item] = draft.value.splice(from, 1)
    if (item) draft.value.splice(to, 0, item)
    const [gate] = draftGates.value.splice(from, 1)
    draftGates.value.splice(to, 0, gate ?? false)
  }

  /** Toggle the approval gate on the draft step at `index`. */
  function toggleDraftGate(index: number) {
    draftGates.value[index] = !draftGates.value[index]
  }

  function clearDraft() {
    draft.value = []
    draftGates.value = []
    draftName.value = 'New pipeline'
  }

  /** Persist the draft as a new pipeline on the backend. */
  async function saveDraft(): Promise<Pipeline | null> {
    if (draft.value.length === 0) return null
    const pipeline = await api.createPipeline(useWorkspaceStore().requireId(), {
      name: draftName.value.trim() || 'Untitled pipeline',
      agentKinds: [...draft.value],
      // Only send gates when at least one step is gated.
      ...(draftGates.value.some(Boolean) ? { gates: [...draftGates.value] } : {}),
    })
    pipelines.value.push(pipeline)
    clearDraft()
    return pipeline
  }

  async function removePipeline(id: string) {
    await api.removePipeline(useWorkspaceStore().requireId(), id)
    pipelines.value = pipelines.value.filter((p) => p.id !== id)
  }

  return {
    pipelines,
    draft,
    draftGates,
    draftName,
    hydrate,
    getPipeline,
    addToDraft,
    removeFromDraft,
    moveInDraft,
    toggleDraftGate,
    clearDraft,
    saveDraft,
    removePipeline,
  }
})
