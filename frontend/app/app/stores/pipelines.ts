import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Pipeline } from '~/types/domain'
import type {
  GateConfigForm,
  PipelinePurpose,
  RetiredPipelineWire,
  RunDefaultScope,
} from '@cat-factory/contracts'
import { declaredDefaultPipelineId } from '@cat-factory/contracts'
import { useUpsertList } from '~/composables/useUpsertList'
import { createDraftStepState, type PipelinesContext } from '~/stores/pipelines/context'
import { createPipelineDraftActions } from '~/stores/pipelines/draftActions'
import { createPipelinePersistence } from '~/stores/pipelines/persistence'

/**
 * Saved, reusable pipelines (the pipeline palette) plus the in-progress draft
 * being assembled in the pipeline builder. Saved pipelines live on the backend;
 * the draft is transient client state. The draft doubles as the EDIT surface: a
 * custom pipeline can be loaded into it (`loadForEdit`) and saved back in place,
 * while a built-in is cloned first (`clonePipeline`) into an editable copy.
 *
 * The draft manipulation + persistence operations live in cohesive factories
 * ({@link createPipelineDraftActions} / {@link createPipelinePersistence}, under
 * `stores/pipelines/`) that close over the shared state assembled here — a size-only
 * split mirroring `stores/board/`, not a new seam.
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
  /**
   * The catalog's own NAME per id in {@link catalogVersions}, from the same snapshot field pair.
   * Read only where a catalog entry has no stored row to take a name off (the "new built-ins"
   * advisory and the replacement a retirement points at); everywhere else the stored row's authored
   * name is the answer. Empty for a facade that ships no name map.
   */
  const catalogNames = ref<Record<string, string>>({})
  /**
   * Built-in pipelines WITHDRAWN from the catalog (`retiredPipelines()`), from the workspace
   * snapshot. A stored pipeline whose id appears here is no longer relevant and can be REMOVED —
   * the opposite of a reseed, and the only case where deleting a built-in is allowed (see
   * `usePipelineHealth`). Disjoint from {@link catalogVersions} by construction.
   */
  const retiredPipelines = ref<RetiredPipelineWire[]>([])
  /**
   * The per-step parameters each registered GATE declares, projected from the deployment's gate
   * registry onto the board snapshot. The builder renders a gated step's own config form from
   * these, so what it can save is exactly what run admission validates. Empty on a deployment
   * whose gates declare nothing.
   */
  const gateConfigForms = ref<GateConfigForm[]>([])

  // The per-step, index-aligned draft arrays (kept in lockstep — see `createDraftStepState`).
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
  } = createDraftStepState()
  /** Organizational labels for the pipeline being assembled/edited. */
  const draftLabels = ref<string[]>([])
  /**
   * The use-case classifier of the pipeline being assembled/edited (`build` / `document` /
   * `review` / `research` / `planning`). Drives which task pickers offer the saved pipeline, which
   * agent kinds the builder palette shows (a non-`build` purpose hides the Implementation/Testing
   * kinds) and which saved pipelines the library lists.
   *
   * Never null: `Pipeline.purpose` is mandatory, so a draft is classified from the moment it
   * exists. `build` is the default because it is what an unclassified pipeline has always behaved
   * as, so the dial starts where the old absence pointed rather than at a choice nobody made.
   */
  const draftPurpose = ref<PipelinePurpose>('build')
  const draftName = ref('New pipeline')
  /** Prose description for the pipeline being assembled/edited (shown in the pickers). */
  const draftDescription = ref('')
  /** The id of the pipeline being edited, or null when assembling a brand-new one. */
  const editingId = ref<string | null>(null)

  /**
   * Replace the cached pipelines (and the current built-in catalog versions + names +
   * retirements) from a snapshot. `retired` is applied even when EMPTY, unlike `versions`: an
   * absent list means the facade shipped no retirements, and carrying the previous board's forward
   * would offer a delete for a pipeline this deployment still ships. `names` rides `versions`,
   * being the other half of one read.
   */
  function hydrate(
    next: Pipeline[],
    versions?: Record<string, number>,
    retired?: RetiredPipelineWire[],
    names?: Record<string, string>,
  ) {
    pipelines.value = next
    // The two catalog maps move TOGETHER, because they are one snapshot read split in two and are
    // keyed identically by construction. Assigning names on their own truthiness would let a
    // facade that ships versions and no names leave the previous board's names indexed against
    // this board's ids, which is the one way the pair can disagree.
    if (versions) {
      catalogVersions.value = versions
      catalogNames.value = names ?? {}
    }
    retiredPipelines.value = retired ?? []
  }

  /**
   * Replace the registered gates' declared config forms from a snapshot. Applied even when EMPTY,
   * for the reason `retired` is: carrying the previous board's forward would offer a form for a
   * parameter this deployment's gates do not declare, and a value saved through it would then be
   * refused at save by the very registry that never declared it.
   */
  function hydrateGateConfigForms(forms: GateConfigForm[]) {
    gateConfigForms.value = forms
  }

  function getPipeline(id: string) {
    return pipelines.value.find((p) => p.id === id)
  }

  /**
   * The pipeline id this workspace has DECLARED as its default for a resolution scope, or undefined
   * when no row claims it.
   *
   * The rule itself is `declaredDefaultPipelineId` in `@cat-factory/contracts`, shared with the
   * engine: the SPA pre-selects on its start controls what the backend falls back to when a headless
   * caller names none, and two readings of "the default" is how a Start button comes to run
   * something other than what the board said it would.
   *
   * Undefined is a real answer, not a lookup failure, and each caller composes its own fallback with
   * it: the start controls `defaultBuildPipelineId` (the interface-mode rung), the backend catalog
   * order.
   */
  function declaredDefaultId(scope: RunDefaultScope): string | undefined {
    return declaredDefaultPipelineId(pipelines.value, scope)
  }

  // The draft manipulation + persistence operations, split into cohesive factories sharing the
  // state above (a size-only extraction — behaviour is identical to the former in-closure
  // functions). Persistence drives the draft-lifecycle helpers (`clearDraft`/`loadForEdit`).
  const context: PipelinesContext = {
    api,
    pipelines,
    upsertPipeline,
    dropPipeline,
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
  }
  const draftActions = createPipelineDraftActions(context)
  const persistence = createPipelinePersistence(context, draftActions)

  return {
    pipelines,
    catalogVersions,
    catalogNames,
    retiredPipelines,
    gateConfigForms,
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
    hydrate,
    hydrateGateConfigForms,
    getPipeline,
    declaredDefaultId,
    ...draftActions,
    ...persistence,
  }
})
