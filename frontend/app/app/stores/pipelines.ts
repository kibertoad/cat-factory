import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AgentKind, Pipeline } from '~/types/domain'
import type { ConsensusStepConfig, StepGating } from '~/types/consensus'
import { companionForProducer, isProducerCompanion, uid } from '~/utils/catalog'
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
  /** Per-step estimate gating, kept index-aligned with `draft` (null ⇒ always run). */
  const draftGating = ref<(StepGating | null)[]>([])
  /** Organizational labels for the pipeline being assembled/edited. */
  const draftLabels = ref<string[]>([])
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

  /** Insert a step (with its default per-step config) at `index`, keeping arrays aligned. */
  function insertAt(index: number, kind: AgentKind) {
    draft.value.splice(index, 0, kind)
    draftGates.value.splice(index, 0, false)
    draftEnabled.value.splice(index, 0, true)
    draftThresholds.value.splice(index, 0, null)
    draftConsensus.value.splice(index, 0, null)
    draftGating.value.splice(index, 0, null)
  }

  function addToDraft(kind: AgentKind) {
    insertAt(draft.value.length, kind)
  }

  function removeFromDraft(index: number) {
    draft.value.splice(index, 1)
    draftGates.value.splice(index, 1)
    draftEnabled.value.splice(index, 1)
    draftThresholds.value.splice(index, 1)
    draftConsensus.value.splice(index, 1)
    draftGating.value.splice(index, 1)
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
    const [gat] = draftGating.value.splice(from, 1)
    draftGating.value.splice(to, 0, gat ?? null)
  }

  /** Whether the producer step at `index` currently has its companion attached after it. */
  function hasCompanion(index: number): boolean {
    const companion = companionForProducer(draft.value[index] ?? '')
    return companion !== undefined && draft.value[index + 1] === companion
  }

  /**
   * Toggle the dependent companion on the producer step at `index`: insert it immediately
   * after (turn on) or remove it (turn off). A no-op for a kind that has no companion.
   */
  function toggleCompanion(index: number) {
    const companion = companionForProducer(draft.value[index] ?? '')
    if (!companion) return
    if (draft.value[index + 1] === companion) removeFromDraft(index + 1)
    else insertAt(index + 1, companion)
  }

  /** Toggle estimate gating on/off for the (companion) step at `index`. */
  function toggleDraftGating(index: number) {
    draftGating.value[index] = draftGating.value[index]?.enabled
      ? null
      : { enabled: true, minRisk: 0.5, minImpact: 0.5 }
  }

  /**
   * The draft as a list of "units" for rendering: each non-companion step, with its attached
   * companion folded in (the companion is hidden from the standalone list and surfaced as a
   * toggle on its producer). `index`/`companionIndex` are positions in the raw `draft` arrays.
   */
  const units = computed(() => {
    const out: { index: number; kind: AgentKind; companionIndex: number | null }[] = []
    for (let i = 0; i < draft.value.length; i++) {
      const kind = draft.value[i]
      if (kind === undefined || isProducerCompanion(kind)) continue
      const companion = companionForProducer(kind)
      const companionIndex = companion && draft.value[i + 1] === companion ? i + 1 : null
      out.push({ index: i, kind, companionIndex })
    }
    return out
  })

  /**
   * Move the unit at visible position `from` to `to`, carrying its attached companion. Rebuilds
   * every parallel array by the SAME unit boundaries so they stay index-aligned.
   */
  function moveUnit(from: number, to: number) {
    const u = units.value
    if (to < 0 || to >= u.length || from === to) return
    const reorder = <T>(arr: T[]): T[] => {
      const chunks = u.map((unit) =>
        arr.slice(unit.index, unit.index + (unit.companionIndex !== null ? 2 : 1)),
      )
      const [moved] = chunks.splice(from, 1)
      if (moved) chunks.splice(to, 0, moved)
      return chunks.flat()
    }
    draft.value = reorder(draft.value)
    draftGates.value = reorder(draftGates.value)
    draftEnabled.value = reorder(draftEnabled.value)
    draftThresholds.value = reorder(draftThresholds.value)
    draftConsensus.value = reorder(draftConsensus.value)
    draftGating.value = reorder(draftGating.value)
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
    draftGating.value = []
    draftLabels.value = []
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
    draftGating.value = pipeline.agentKinds.map((_, i) => pipeline.gating?.[i] ?? null)
    draftLabels.value = [...(pipeline.labels ?? [])]
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
      // Only send gating when at least one step has gating enabled.
      ...(draftGating.value.some((g) => g?.enabled) ? { gating: [...draftGating.value] } : {}),
      // Only send labels when there are any.
      ...(draftLabels.value.length ? { labels: [...draftLabels.value] } : {}),
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

  /** Set a pipeline's organizational metadata (labels / archive). Works on built-ins too. */
  async function organize(id: string, body: { labels?: string[]; archived?: boolean }) {
    const updated = await api.organizePipeline(useWorkspaceStore().requireId(), id, body)
    const i = pipelines.value.findIndex((p) => p.id === updated.id)
    if (i >= 0) pipelines.value[i] = updated
    return updated
  }

  const archive = (id: string) => organize(id, { archived: true })
  const unarchive = (id: string) => organize(id, { archived: false })
  const setLabels = (id: string, labels: string[]) => organize(id, { labels })

  return {
    pipelines,
    draft,
    draftGates,
    draftEnabled,
    draftThresholds,
    draftConsensus,
    draftGating,
    draftLabels,
    draftName,
    editingId,
    units,
    hydrate,
    getPipeline,
    addToDraft,
    removeFromDraft,
    moveInDraft,
    moveUnit,
    hasCompanion,
    toggleCompanion,
    toggleDraftGating,
    toggleDraftGate,
    toggleDraftEnabled,
    toggleDraftConsensus,
    setDraftConsensus,
    clearDraft,
    loadForEdit,
    saveDraft,
    clonePipeline,
    removePipeline,
    organize,
    archive,
    unarchive,
    setLabels,
  }
})
