import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AgentKind, Pipeline } from '~/types/domain'
import type { ConsensusStepConfig, StepGating } from '~/types/consensus'
import type { StepOptions, TesterQualityConfig } from '@cat-factory/contracts'
import { companionForProducer, uid } from '~/utils/catalog'
import { useUpsertList } from '~/composables/useUpsertList'
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
  const {
    items: pipelines,
    upsert: upsertPipeline,
    remove: dropPipeline,
  } = useUpsertList<Pipeline>({ key: (p) => p.id })
  /**
   * Current built-in catalog versions (`seedPipelines()`), keyed by pipeline id, from the
   * workspace snapshot. A built-in whose stored `version` is below its catalog value here has
   * a newer definition available (see `usePipelineHealth`).
   */
  const catalogVersions = ref<Record<string, number>>({})

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
  /**
   * Per-step Follow-up companion toggle, kept index-aligned with `draft`. Only meaningful on
   * a `coder` step; `false` disables the companion there (default/true ⇒ enabled).
   */
  const draftFollowUps = ref<(boolean | null)[]>([])
  /**
   * Per-step test quality-control companion config, kept index-aligned with `draft`. Only
   * meaningful on a Tester step (`tester-api`/`tester-ui`); `null`/absent means "enabled, no
   * gating" (the QC companion is on by default), `{ enabled: false }` disables it, and an
   * entry with `gating` makes it conditional on the task estimate.
   */
  const draftTesterQuality = ref<(TesterQualityConfig | null)[]>([])
  /**
   * Per-step options bag, kept index-aligned with `draft`: the extensible home for new per-step
   * parameters (see `StepOptions`). `null`/absent per step ⇒ that step's defaults. Today the only
   * field is `autoRecommend` (requirements-review); by convention we store ONLY deviations from a
   * default, so an entry exists only when a step opts out of something.
   */
  const draftStepOptions = ref<(StepOptions | null)[]>([])
  /** Organizational labels for the pipeline being assembled/edited. */
  const draftLabels = ref<string[]>([])
  const draftName = ref('New pipeline')
  /** The id of the pipeline being edited, or null when assembling a brand-new one. */
  const editingId = ref<string | null>(null)

  /** Replace the cached pipelines (and the current built-in catalog versions) from a snapshot. */
  function hydrate(next: Pipeline[], versions?: Record<string, number>) {
    pipelines.value = next
    if (versions) catalogVersions.value = versions
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
    draftFollowUps.value.splice(index, 0, null)
    draftTesterQuality.value.splice(index, 0, null)
    draftStepOptions.value.splice(index, 0, null)
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
    draftFollowUps.value.splice(index, 1)
    draftTesterQuality.value.splice(index, 1)
    draftStepOptions.value.splice(index, 1)
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
    const [fu] = draftFollowUps.value.splice(from, 1)
    draftFollowUps.value.splice(to, 0, fu ?? null)
    const [tq] = draftTesterQuality.value.splice(from, 1)
    draftTesterQuality.value.splice(to, 0, tq ?? null)
    const [so] = draftStepOptions.value.splice(from, 1)
    draftStepOptions.value.splice(to, 0, so ?? null)
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
      : { enabled: true, minRisk: 0.5, minImpact: 0.5, onMissingEstimate: 'run' }
  }

  /**
   * The draft as a list of "units" for rendering: each step is one unit, EXCEPT a companion
   * that sits immediately after its producer — that companion is folded into the producer's
   * unit (`companionIndex`) and surfaced as a toggle on it, not a standalone row. The backend
   * now REJECTS a companion that is not immediately after its producer (strict adjacency in
   * `validatePipelineShape`), so a saved pipeline never has one — but a stray companion that
   * still shows up in the draft (e.g. a pre-existing pipeline saved before adjacency was
   * enforced) is emitted as its own standalone unit so it stays visible and removable/
   * reorderable into a valid shape rather than being silently dropped — and, crucially, so
   * every `draft` index belongs to exactly one unit, which is what lets {@link moveUnit}
   * reorder by unit boundaries without ever dropping a step.
   * `index`/`companionIndex` are positions in the raw `draft` arrays.
   */
  const units = computed(() => {
    const out: { index: number; kind: AgentKind; companionIndex: number | null }[] = []
    let folded = -1 // draft index already consumed as the previous unit's adjacent companion
    for (let i = 0; i < draft.value.length; i++) {
      const kind = draft.value[i]
      if (kind === undefined || i === folded) continue
      const companion = companionForProducer(kind)
      const companionIndex = companion && draft.value[i + 1] === companion ? i + 1 : null
      if (companionIndex !== null) folded = companionIndex
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
    draftFollowUps.value = reorder(draftFollowUps.value)
    draftTesterQuality.value = reorder(draftTesterQuality.value)
    draftStepOptions.value = reorder(draftStepOptions.value)
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

  /** Toggle the Follow-up companion on the draft (coder) step at `index` (default on → off). */
  function toggleDraftFollowUps(index: number) {
    // Default (null/true) is enabled, so the first toggle disables it (false); toggle back to null.
    draftFollowUps.value[index] = draftFollowUps.value[index] === false ? null : false
  }

  /**
   * Toggle the test quality-control companion on the draft (Tester) step at `index`. The
   * companion is enabled by default (a `null` entry), so the first toggle disables it
   * (`{ enabled: false }`, dropping any gating) and the next restores the default.
   */
  function toggleDraftTesterQuality(index: number) {
    draftTesterQuality.value[index] =
      draftTesterQuality.value[index]?.enabled === false ? null : { enabled: false }
  }

  /**
   * Toggle estimate gating on/off for the QC companion on the draft (Tester) step at `index`.
   * A no-op while the companion is disabled (nothing to gate). Enabling gating pins the config
   * to `{ enabled: true, gating }` so the thresholds are editable; disabling drops back to the
   * default `null` (enabled, ungated).
   */
  function toggleDraftTesterQualityGating(index: number) {
    const cur = draftTesterQuality.value[index]
    if (cur?.enabled === false) return
    draftTesterQuality.value[index] = cur?.gating?.enabled
      ? null
      : {
          enabled: true,
          gating: { enabled: true, minRisk: 0.5, minImpact: 0.5, onMissingEstimate: 'run' },
        }
  }

  /** Enable/disable the draft step at `index` without removing it. */
  function toggleDraftEnabled(index: number) {
    draftEnabled.value[index] = draftEnabled.value[index] === false
  }

  /** Whether auto-recommendation is on for the draft (requirements-review) step at `index`. */
  function draftAutoRecommendEnabled(index: number): boolean {
    return draftStepOptions.value[index]?.autoRecommend !== false
  }

  /**
   * Toggle the requirements-review auto-recommendation on the draft step at `index`. It is on by
   * default, so we store ONLY the opt-out (`{ autoRecommend: false }`); toggling back drops the
   * flag. Merges with any other future StepOptions fields rather than clobbering the whole bag.
   */
  function toggleDraftAutoRecommend(index: number) {
    const next: StepOptions = { ...draftStepOptions.value[index] }
    if (draftAutoRecommendEnabled(index)) next.autoRecommend = false
    else delete next.autoRecommend
    draftStepOptions.value[index] = Object.keys(next).length ? next : null
  }

  function clearDraft() {
    draft.value = []
    draftGates.value = []
    draftEnabled.value = []
    draftThresholds.value = []
    draftConsensus.value = []
    draftGating.value = []
    draftFollowUps.value = []
    draftTesterQuality.value = []
    draftStepOptions.value = []
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
    draftFollowUps.value = pipeline.agentKinds.map((_, i) => pipeline.followUps?.[i] ?? null)
    draftTesterQuality.value = pipeline.agentKinds.map(
      (_, i) => pipeline.testerQuality?.[i] ?? null,
    )
    draftStepOptions.value = pipeline.agentKinds.map((_, i) => pipeline.stepOptions?.[i] ?? null)
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
      // Only send followUps when at least one step disables it (default is on, so only the
      // explicit `false` opt-outs are worth persisting).
      ...(draftFollowUps.value.some((f) => f === false)
        ? { followUps: [...draftFollowUps.value] }
        : {}),
      // Only send testerQuality when at least one Tester step deviates from the default
      // (companion disabled, or an estimate gate configured) — the default (null/enabled,
      // ungated) is not worth persisting.
      ...(draftTesterQuality.value.some((q) => q?.enabled === false || q?.gating?.enabled)
        ? { testerQuality: [...draftTesterQuality.value] }
        : {}),
      // ALWAYS send stepOptions, unlike the legacy per-step arrays above. Those omit-when-default,
      // which means an update can never CLEAR them (an omitted field reads as "keep existing"), so
      // toggling the last opt-out back to its default on a saved pipeline would silently not
      // persist. Sending the aligned array always lets `update` overwrite; the backend normalizes
      // an all-default array away (stores nothing), so this is a no-op on create / all-default.
      stepOptions: draftStepOptions.value.map((o) => o ?? null),
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
      upsertPipeline(updated)
      clearDraft()
      return updated
    }
    const pipeline = await api.createPipeline(wsId, payload)
    upsertPipeline(pipeline)
    clearDraft()
    return pipeline
  }

  /** Clone any pipeline (built-in or custom) into an editable copy, ready to edit. */
  async function clonePipeline(id: string): Promise<Pipeline> {
    const clone = await api.clonePipeline(useWorkspaceStore().requireId(), id)
    upsertPipeline(clone)
    loadForEdit(clone)
    return clone
  }

  async function removePipeline(id: string) {
    await api.removePipeline(useWorkspaceStore().requireId(), id)
    dropPipeline(id)
    if (editingId.value === id) clearDraft()
  }

  /**
   * Reseed a built-in pipeline from the backend's current catalog definition: restores its
   * canonical structure + version (adopting an update, or repairing a drifted/invalid copy)
   * while preserving its labels/archive state. Replaces the pipeline in the cache.
   */
  async function reseed(id: string): Promise<Pipeline> {
    const updated = await api.reseedPipeline(useWorkspaceStore().requireId(), id)
    upsertPipeline(updated)
    if (editingId.value === id) clearDraft()
    return updated
  }

  /** Set a pipeline's organizational metadata (labels / archive). Works on built-ins too. */
  async function organize(id: string, body: { labels?: string[]; archived?: boolean }) {
    const updated = await api.organizePipeline(useWorkspaceStore().requireId(), id, body)
    upsertPipeline(updated)
    return updated
  }

  const archive = (id: string) => organize(id, { archived: true })
  const unarchive = (id: string) => organize(id, { archived: false })
  const setLabels = (id: string, labels: string[]) => organize(id, { labels })

  return {
    pipelines,
    catalogVersions,
    draft,
    draftGates,
    draftEnabled,
    draftThresholds,
    draftConsensus,
    draftGating,
    draftFollowUps,
    draftTesterQuality,
    draftStepOptions,
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
    toggleDraftFollowUps,
    toggleDraftTesterQuality,
    toggleDraftTesterQualityGating,
    draftAutoRecommendEnabled,
    toggleDraftAutoRecommend,
    toggleDraftEnabled,
    toggleDraftConsensus,
    setDraftConsensus,
    clearDraft,
    loadForEdit,
    saveDraft,
    clonePipeline,
    removePipeline,
    reseed,
    organize,
    archive,
    unarchive,
    setLabels,
  }
})
