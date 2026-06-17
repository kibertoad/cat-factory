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
  }

  function removeFromDraft(index: number) {
    draft.value.splice(index, 1)
  }

  function moveInDraft(from: number, to: number) {
    if (to < 0 || to >= draft.value.length) return
    const [item] = draft.value.splice(from, 1)
    if (item) draft.value.splice(to, 0, item)
  }

  function clearDraft() {
    draft.value = []
    draftName.value = 'New pipeline'
  }

  /** Persist the draft as a new pipeline on the backend. */
  async function saveDraft(): Promise<Pipeline | null> {
    if (draft.value.length === 0) return null
    const pipeline = await api.createPipeline(useWorkspaceStore().requireId(), {
      name: draftName.value.trim() || 'Untitled pipeline',
      agentKinds: [...draft.value],
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
    draftName,
    hydrate,
    getPipeline,
    addToDraft,
    removeFromDraft,
    moveInDraft,
    clearDraft,
    saveDraft,
    removePipeline,
  }
})
