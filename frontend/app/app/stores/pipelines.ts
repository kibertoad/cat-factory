import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AgentKind, Pipeline } from '~/types/domain'
import type { ConsensusStepConfig } from '~/types/consensus'
import { uid } from '~/utils/catalog'
import { useWorkspaceStore } from '~/stores/workspace'

/** A sensible default config when a step is first flipped to consensus in the builder. */
function defaultConsensusConfig(): ConsensusStepConfig {
  return {
    enabled: true,
    strategy: 'specialist-panel',
    participants: [
      { id: uid('cp'), role: 'Pragmatist', systemFraming: 'Favour the simplest viable approach.' },
      {
        id: uid('cp'),
        role: 'Skeptic',
        systemFraming: 'Probe risks, edge cases and failure modes.',
      },
    ],
  }
}

/**
 * Saved, reusable pipelines (the pipeline palette) plus the in-progress draft
 * being assembled in the pipeline builder. Saved pipelines live on the backend;
 * the draft is transient client state. The draft doubles as the EDIT surface: a
 * custom pipeline can be loaded into it (`loadForEdit`) and saved back in place,
 * while a built-in is cloned first (`clonePipeline`) into an editable copy.
 */
export const usePipelinesStore = defineStore('pipelines', () => {
  const api = useApi()
  const pipelines = ref<Pipeline[]>([])

  /** The chain currently being assembled in the builder. */
  const draft = ref<AgentKind[]>([])
  /** Per-step approval gates, kept index-aligned with `draft`. */
  const draftGates = ref<boolean[]>([])
  /** Per-step enable flags, kept index-aligned with `draft` (false ⇒ skipped at run). */
  const draftEnabled = ref<boolean[]>([])
  /**
   * Per-step companion thresholds, kept index-aligned with `draft`. Not editable in the
   * builder UI today, but carried through edits so an existing pipeline's thresholds
   * survive a save.
   */
  const draftThresholds = ref<(number | null)[]>([])
  /** Per-step consensus configs, kept index-aligned with `draft` (null ⇒ standard agent). */
  const draftConsensus = ref<(ConsensusStepConfig | null)[]>([])
  const draftName = ref('New pipeline')
  /** The id of the pipeline being edited, or null when assembling a brand-new one. */
  const editingId = ref<string | null>(null)

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
    draftEnabled.value.push(true)
    draftThresholds.value.push(null)
    draftConsensus.value.push(null)
  }

  function removeFromDraft(index: number) {
    draft.value.splice(index, 1)
    draftGates.value.splice(index, 1)
    draftEnabled.value.splice(index, 1)
    draftThresholds.value.splice(index, 1)
    draftConsensus.value.splice(index, 1)
  }

  function moveInDraft(from: number, to: number) {
    if (to < 0 || to >= draft.value.length) return
    const [item] = draft.value.splice(from, 1)
    if (item) draft.value.splice(to, 0, item)
    const [gate] = draftGates.value.splice(from, 1)
    draftGates.value.splice(to, 0, gate ?? false)
    const [on] = draftEnabled.value.splice(from, 1)
    draftEnabled.value.splice(to, 0, on ?? true)
    const [th] = draftThresholds.value.splice(from, 1)
    draftThresholds.value.splice(to, 0, th ?? null)
    const [cons] = draftConsensus.value.splice(from, 1)
    draftConsensus.value.splice(to, 0, cons ?? null)
  }

  /** Toggle the consensus mechanism on the draft step at `index` (default config / off). */
  function toggleDraftConsensus(index: number) {
    draftConsensus.value[index] = draftConsensus.value[index] ? null : defaultConsensusConfig()
  }

  /** Replace the consensus config of the draft step at `index` (builder editor edits). */
  function setDraftConsensus(index: number, config: ConsensusStepConfig | null) {
    draftConsensus.value[index] = config
  }

  /** Toggle the approval gate on the draft step at `index`. */
  function toggleDraftGate(index: number) {
    draftGates.value[index] = !draftGates.value[index]
  }

  /** Enable/disable the draft step at `index` without removing it. */
  function toggleDraftEnabled(index: number) {
    draftEnabled.value[index] = draftEnabled.value[index] === false
  }

  function clearDraft() {
    draft.value = []
    draftGates.value = []
    draftEnabled.value = []
    draftThresholds.value = []
    draftConsensus.value = []
    draftName.value = 'New pipeline'
    editingId.value = null
  }

  /** Load an existing (custom) pipeline into the draft so it can be edited in place. */
  function loadForEdit(pipeline: Pipeline) {
    draft.value = [...pipeline.agentKinds]
    draftGates.value = pipeline.agentKinds.map((_, i) => pipeline.gates?.[i] ?? false)
    draftEnabled.value = pipeline.agentKinds.map((_, i) => pipeline.enabled?.[i] ?? true)
    draftThresholds.value = pipeline.agentKinds.map((_, i) => pipeline.thresholds?.[i] ?? null)
    draftConsensus.value = pipeline.agentKinds.map((_, i) => pipeline.consensus?.[i] ?? null)
    draftName.value = pipeline.name
    editingId.value = pipeline.id
  }

  /** The optional arrays to send, omitting the ones that are at their defaults. */
  function draftPayload() {
    return {
      name: draftName.value.trim() || 'Untitled pipeline',
      agentKinds: [...draft.value],
      // Only send gates when at least one step is gated.
      ...(draftGates.value.some(Boolean) ? { gates: [...draftGates.value] } : {}),
      // Only send enabled when at least one step is disabled (default is all-on).
      ...(draftEnabled.value.some((e) => e === false) ? { enabled: [...draftEnabled.value] } : {}),
      // Only send thresholds when at least one step pins an explicit value.
      ...(draftThresholds.value.some((t) => t != null)
        ? { thresholds: [...draftThresholds.value] }
        : {}),
      // Only send consensus when at least one step is consensus-enabled.
      ...(draftConsensus.value.some((c) => c?.enabled)
        ? { consensus: [...draftConsensus.value] }
        : {}),
    }
  }

  /** Persist the draft: update the pipeline being edited, else create a new one. */
  async function saveDraft(): Promise<Pipeline | null> {
    if (draft.value.length === 0) return null
    const wsId = useWorkspaceStore().requireId()
    const payload = draftPayload()
    if (editingId.value) {
      const updated = await api.updatePipeline(wsId, editingId.value, payload)
      const i = pipelines.value.findIndex((p) => p.id === updated.id)
      if (i >= 0) pipelines.value[i] = updated
      clearDraft()
      return updated
    }
    const pipeline = await api.createPipeline(wsId, payload)
    pipelines.value.push(pipeline)
    clearDraft()
    return pipeline
  }

  /** Clone any pipeline (built-in or custom) into an editable copy, ready to edit. */
  async function clonePipeline(id: string): Promise<Pipeline> {
    const clone = await api.clonePipeline(useWorkspaceStore().requireId(), id)
    pipelines.value.push(clone)
    loadForEdit(clone)
    return clone
  }

  async function removePipeline(id: string) {
    await api.removePipeline(useWorkspaceStore().requireId(), id)
    pipelines.value = pipelines.value.filter((p) => p.id !== id)
    if (editingId.value === id) clearDraft()
  }

  return {
    pipelines,
    draft,
    draftGates,
    draftEnabled,
    draftThresholds,
    draftConsensus,
    draftName,
    editingId,
    hydrate,
    getPipeline,
    addToDraft,
    removeFromDraft,
    moveInDraft,
    toggleDraftGate,
    toggleDraftEnabled,
    toggleDraftConsensus,
    setDraftConsensus,
    clearDraft,
    loadForEdit,
    saveDraft,
    clonePipeline,
    removePipeline,
  }
})
