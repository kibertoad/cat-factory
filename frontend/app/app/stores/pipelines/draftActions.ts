import { computed } from 'vue'
import type { AgentKind, Pipeline } from '~/types/domain'
import { companionForProducer } from '~/utils/catalog'
import type { PipelinesContext } from './context'
import { createPipelineGateConfigActions } from './draftGateConfig'
import { createPipelineStepConfigActions } from './draftStepConfig'
import { createPipelineStepOptionActions } from './draftStepOptions'

/**
 * The pipeline-builder draft's STRUCTURE: inserting/removing/reordering steps, the companion
 * folding that turns the flat arrays into renderable units, and `clearDraft` / `loadForEdit`.
 * Extracted from the store setup into a factory closing over the shared {@link PipelinesContext}.
 *
 * The per-step CONFIG toggles (consensus + its group tiers, gates, companions, step options) are
 * the sibling factory in `./draftStepConfig` — a different concern on the same context, and the
 * seam this file was split along when it outgrew the per-function budget. Both are spread into
 * the store, so callers see one flat API exactly as before.
 */
export function createPipelineDraftActions(ctx: PipelinesContext) {
  const {
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
    draftPurpose,
    draftName,
    draftDescription,
    editingId,
  } = ctx

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
    draftPurpose.value = 'build'
    draftName.value = 'New pipeline'
    draftDescription.value = ''
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
    draftPurpose.value = pipeline.purpose
    draftName.value = pipeline.name
    draftDescription.value = pipeline.description ?? ''
    editingId.value = pipeline.id
  }

  return {
    ...createPipelineStepConfigActions(ctx),
    ...createPipelineStepOptionActions(ctx),
    ...createPipelineGateConfigActions(ctx),
    addToDraft,
    removeFromDraft,
    moveInDraft,
    hasCompanion,
    toggleCompanion,
    units,
    moveUnit,
    clearDraft,
    loadForEdit,
  }
}
