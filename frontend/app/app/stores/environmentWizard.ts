import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as v from 'valibot'
import {
  type AnalystRecipeDraft,
  type MergedRecipeDraft,
  type PreflightResult,
  type ProvisioningRecommendation,
  type StackRecipe,
  ENVIRONMENT_ANALYST_AGENT_KIND,
  adHocPipelineIdFor,
  analystRecipeDraftSchema,
  mergeAnalystRecipeDraft,
} from '@cat-factory/contracts'
import type { Block } from '~/types/domain'
import { useBoardStore } from '~/stores/board'
import { useExecutionStore } from '~/stores/execution'
import { useGitHubStore } from '~/stores/github'
import { useInfraConfigStore } from '~/stores/infraConfig'
import { usePreflightsStore } from '~/stores/preflights'
import { useServicesStore } from '~/stores/services'
import type { WizardContext } from '~/stores/environmentWizard/context'
import { createFlowActions } from '~/stores/environmentWizard/flow'
import { createRecipeActions } from '~/stores/environmentWizard/recipe'
import { createSaveActions } from '~/stores/environmentWizard/save'

// The environment setup wizard's cross-step DATA + actions (shared-stacks slice 7). It backs the
// guided flow — pick a service frame → review the recommended `docker-compose` recipe (detector
// facts + the opt-in analyst draft, merged with provenance) → run the machine preflights → save
// (persist the recipe on the frame AND register the workspace's docker-compose handler so the
// Deployer provisions it) → optionally trial-provision the saved config with live logs.
//
// The detector + analyst only RECOMMEND; the human confirms/edits the working `recipe` here and the
// compose provider keys purely on the saved recipe (the build-flag rule). Mirrors the other infra
// stores' idiom; the flow state is a singleton so the wizard's step children share it.
//
// Since slice 3 of the modular-vue adoption (backend/docs/adr/0049-modular-vue-adoption.md) the wizard's
// step NAVIGATION lives in a modular-vue journey (`app/modular/journeys/environmentSetup.ts`), NOT
// here — this store no longer holds a `step` / `STEP_ORDER` / `goToStep`. It is purely the per-frame
// data+action layer the journey's step components drive; `beginForFrame` seeds it when a step first
// targets a frame.
//
// The cross-step actions live in cohesive factories under `stores/environmentWizard/` (flow /
// recipe / save) that close over the shared reactive {@link WizardContext} assembled here — a
// size-only extraction following the `board` store idiom, behaviour is unchanged.

// The "run deep analysis" trigger starts the analyst agent as a SINGLE-KIND run — one step, no
// pipeline — and reads the drafted recipe off that step's `result.custom`. Both the kind and the
// id its run reports come from the shared contract, so the wizard cannot go looking for a run
// under a name the backend stopped using.
const ANALYSIS_PIPELINE_ID = adHocPipelineIdFor(ENVIRONMENT_ANALYST_AGENT_KIND)

/** The analyst run's lifecycle as the wizard surfaces it. */
export type AnalysisStatus = 'idle' | 'running' | 'ready' | 'failed'

export const useEnvironmentWizardStore = defineStore('environmentWizard', () => {
  const board = useBoardStore()
  const github = useGitHubStore()
  const services = useServicesStore()
  const infra = useInfraConfigStore()
  const execution = useExecutionStore()
  const preflights = usePreflightsStore()

  // ---- Target frame -------------------------------------------------------
  // The frame the flow currently targets. Set by `beginForFrame` when a journey
  // step first mounts against a frame; the journey (not this store) owns which
  // step is showing.
  const frameId = ref<string | null>(null)

  // ---- Detection ----------------------------------------------------------
  const detecting = ref(false)
  const detectError = ref(false)
  const recommendation = ref<ProvisioningRecommendation | null>(null)

  // ---- Analyst (deep analysis) --------------------------------------------
  // Set once the wizard fires the analyst pipeline against the frame; the run + its draft are read
  // reactively from the execution store (driven live by the workspace stream).
  const analysisRequested = ref(false)
  const analysisError = ref(false)

  // ---- Working recipe (edited by the human) -------------------------------
  const recipe = ref<StackRecipe>({})
  // Advisory local pick: which compose `services:` key the operator chose (drives the handler's
  // exposed `service` default + the seed-step service). Not persisted on the recipe.
  const composeService = ref<string>('')

  // ---- Preflight ----------------------------------------------------------
  const preflightRunning = ref(false)
  const preflightResults = ref<PreflightResult[] | null>(null)
  // A real (non-503) preflight failure, surfaced so a genuine error isn't indistinguishable from
  // "nothing happened" (a 503 latches `preflights.available` to the degraded note instead).
  const preflightError = ref<string | null>(null)

  // ---- Save (handler + frame recipe) --------------------------------------
  const handlerLabel = ref('Docker Compose')
  const exposedPort = ref(80)
  const saving = ref(false)
  const saveError = ref<string | null>(null)
  const saved = ref(false)

  // ---- Trial provision (optional, local-only) -----------------------------
  const trialing = ref(false)
  const trialError = ref<string | null>(null)
  const trialStarted = ref(false)

  // ---- Derived ------------------------------------------------------------
  /** The workspace's service frames (top-level frame blocks), for the pick step. */
  const serviceFrames = computed<Block[]>(() =>
    board.blocks.filter((b) => b.level === 'frame' && !b.parentId),
  )

  const targetFrame = computed<Block | undefined>(() =>
    frameId.value ? board.blocks.find((b) => b.id === frameId.value) : undefined,
  )

  /** The repo backing the target frame (mirrors ServiceTestConfig's resolution). */
  const repoContext = computed<{ githubId: number; directory?: string | null } | undefined>(() => {
    const id = frameId.value
    if (!id) return undefined
    const svc = services.serviceByFrameBlock[id]
    if (svc?.repoGithubId != null) return { githubId: svc.repoGithubId, directory: svc.directory }
    const r = github.repoForBlock(id)
    return r ? { githubId: r.githubId } : undefined
  })

  const hasRepo = computed(() => repoContext.value !== undefined)

  // Deep analysis needs only a repo to read: the agent is started by KIND, so there is no
  // catalog row for the workspace to be missing (which is what the old `pl_environment_analysis`
  // lookup guarded against).
  const canAnalyze = computed(() => hasRepo.value)

  /** The analyst run for this frame (newest matching instance), read live from the execution store.
   *  Filters the full instance list (not the collapsing `getByBlock`, which returns a single run per
   *  block) so a concurrent non-analyst run on the frame can't mask the analyst pipeline's run. */
  const analystRun = computed(() => {
    const id = frameId.value
    if (!id) return undefined
    const matching = execution.instances.filter(
      (i) => i.blockId === id && i.pipelineId === ANALYSIS_PIPELINE_ID,
    )
    if (matching.length <= 1) return matching[0]
    // A frame transiently holds several analyst runs (a retry's now-dead terminal predecessor
    // re-listed by a stale reconnect snapshot alongside the live/succeeded successor), and
    // `instances` has no reliable order, so a bare `.at(-1)` can return the dead run. Prefer a live
    // run, then the newest succeeded one, before falling back to the last (so a sole failed run
    // still surfaces as failed). Mirrors `execution.getByBlock`'s live-run preference.
    const live = matching.find((i) => i.status !== 'done' && i.status !== 'failed')
    if (live) return live
    const succeeded = matching.filter((i) => i.status === 'done')
    return succeeded.at(-1) ?? matching.at(-1)
  })

  /** The parsed analyst draft off the completed analyst step's `result.custom`, when ready. */
  const analystDraft = computed<AnalystRecipeDraft | null>(() => {
    const run = analystRun.value
    if (!run) return null
    const analystStep = run.steps.find((s) => s.agentKind === ENVIRONMENT_ANALYST_AGENT_KIND)
    if (!analystStep || analystStep.state !== 'done' || analystStep.custom === undefined)
      return null
    const parsed = v.safeParse(analystRecipeDraftSchema, analystStep.custom)
    return parsed.success ? parsed.output : null
  })

  const analysisStatus = computed<AnalysisStatus>(() => {
    if (analysisError.value) return 'failed'
    const run = analystRun.value
    if (run?.status === 'failed') return 'failed'
    if (analystDraft.value) return 'ready'
    if (run || analysisRequested.value) return 'running'
    return 'idle'
  })

  /** The merged, provenance-carrying recipe view (detector facts win; analyst fills gaps). */
  const merged = computed<MergedRecipeDraft | null>(() =>
    recommendation.value
      ? mergeAnalystRecipeDraft(recommendation.value, analystDraft.value ?? undefined)
      : null,
  )

  // ---- Actions ------------------------------------------------------------
  // The cross-step actions are split into cohesive factories sharing the reactive context above (a
  // size-only extraction — behaviour is identical to the former in-closure functions). The internal
  // `resetFlowState` / `seedFromMerged` helpers stay private to the flow factory (they were never
  // part of the public store shape).
  const context: WizardContext = {
    board,
    github,
    infra,
    execution,
    preflights,
    frameId,
    detecting,
    detectError,
    recommendation,
    analysisRequested,
    analysisError,
    recipe,
    composeService,
    preflightRunning,
    preflightResults,
    preflightError,
    handlerLabel,
    exposedPort,
    saving,
    saveError,
    saved,
    trialing,
    trialError,
    trialStarted,
    repoContext,
    merged,
  }
  const flow = createFlowActions(context)
  const recipeActions = createRecipeActions(context)
  const saveActions = createSaveActions(context)

  return {
    // state
    frameId,
    detecting,
    detectError,
    recommendation,
    analysisRequested,
    analysisError,
    recipe,
    composeService,
    preflightRunning,
    preflightResults,
    preflightError,
    handlerLabel,
    exposedPort,
    saving,
    saveError,
    saved,
    trialing,
    trialError,
    trialStarted,
    // derived
    serviceFrames,
    targetFrame,
    repoContext,
    hasRepo,
    canAnalyze,
    analystRun,
    analystDraft,
    analysisStatus,
    merged,
    // actions
    ...flow,
    ...recipeActions,
    ...saveActions,
  }
})
