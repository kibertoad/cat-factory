import type { Ref } from 'vue'
import { ref } from 'vue'
import type { AgentKind, Pipeline } from '~/types/domain'
import type { ConsensusStepConfig, StepGating } from '~/types/consensus'
import type { PipelinePurpose, StepOptions, TesterQualityConfig } from '@cat-factory/contracts'
import { uid } from '~/utils/catalog'

/** A sensible default config when a step is first flipped to consensus in the builder. */
export function defaultConsensusConfig(): ConsensusStepConfig {
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
 * The per-step, index-aligned draft arrays. Every one is kept the same length as `draft` and
 * spliced/reordered in lockstep (see `insertAt` / `removeFromDraft` / `moveUnit`), so grouping
 * their construction keeps that alignment contract — and its documentation — in one place.
 */
export function createDraftStepState() {
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
  return {
    draft,
    draftGates,
    draftEnabled,
    draftThresholds,
    draftConsensus,
    draftGating,
    draftFollowUps,
    draftTesterQuality,
    draftStepOptions,
  }
}

/**
 * Shared reactive state + injected dependencies the pipelines-store draft factories close over.
 * Created once in the `pipelines` store setup and threaded into {@link createPipelineDraftActions}
 * and {@link createPipelinePersistence} so the split operations stay behaviourally identical to the
 * original single-closure store — a size-only extraction mirroring `stores/board/`, not a new seam.
 */
export interface PipelinesContext {
  api: ReturnType<typeof useApi>
  pipelines: Ref<Pipeline[]>
  upsertPipeline: (pipeline: Pipeline) => void
  dropPipeline: (id: string) => void
  draft: Ref<AgentKind[]>
  draftGates: Ref<boolean[]>
  draftEnabled: Ref<boolean[]>
  draftThresholds: Ref<(number | null)[]>
  draftConsensus: Ref<(ConsensusStepConfig | null)[]>
  draftGating: Ref<(StepGating | null)[]>
  draftFollowUps: Ref<(boolean | null)[]>
  draftTesterQuality: Ref<(TesterQualityConfig | null)[]>
  draftStepOptions: Ref<(StepOptions | null)[]>
  draftLabels: Ref<string[]>
  draftPurpose: Ref<PipelinePurpose>
  draftName: Ref<string>
  draftDescription: Ref<string>
  editingId: Ref<string | null>
}
