import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as v from 'valibot'
import {
  type AnalystRecipeDraft,
  type MergedRecipeDraft,
  type PreflightResult,
  type ProvisioningRecommendation,
  type ProvisioningSeedDumpCandidate,
  type StackRecipe,
  analystRecipeDraftSchema,
  mergeAnalystRecipeDraft,
  stackRecipeSchema,
} from '@cat-factory/contracts'
import type { Block } from '~/types/domain'
import { apiErrorEnvelope } from '~/composables/api/errors'
import { useBoardStore } from '~/stores/board'
import { useExecutionStore } from '~/stores/execution'
import { useGitHubStore } from '~/stores/github'
import { useInfraConfigStore } from '~/stores/infraConfig'
import { usePipelinesStore } from '~/stores/pipelines'
import { usePreflightsStore } from '~/stores/preflights'
import { useServicesStore } from '~/stores/services'
import { useWorkspaceStore } from '~/stores/workspace'

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
// Since slice 3 of the modular-vue adoption (docs/initiatives/modular-vue-adoption.md) the wizard's
// step NAVIGATION lives in a modular-vue journey (`app/modular/journeys/environmentSetup.ts`), NOT
// here — this store no longer holds a `step` / `STEP_ORDER` / `goToStep`. It is purely the per-frame
// data+action layer the journey's step components drive; `beginForFrame` seeds it when a step first
// targets a frame.

/** The seeded analyst-only pipeline the "run deep analysis" trigger starts against the frame. */
const ANALYSIS_PIPELINE_ID = 'pl_environment_analysis'
/** The analyst agent kind whose `result.custom` carries the drafted recipe. */
const ANALYST_AGENT_KIND = 'environment-analyst'

/** The analyst run's lifecycle as the wizard surfaces it. */
export type AnalysisStatus = 'idle' | 'running' | 'ready' | 'failed'

/** Drop empty arrays / undefined so the persisted recipe stays minimal and schema-valid
 *  (`composeFiles` etc. are `minLength(1)`, so an empty array would 422). */
function pruneRecipe(recipe: StackRecipe): StackRecipe {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(recipe)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value) && value.length === 0) continue
    out[key] = value
  }
  return out as StackRecipe
}

function cloneRecipe(recipe: StackRecipe): StackRecipe {
  return JSON.parse(JSON.stringify(recipe)) as StackRecipe
}

export const useEnvironmentWizardStore = defineStore('environmentWizard', () => {
  const board = useBoardStore()
  const github = useGitHubStore()
  const services = useServicesStore()
  const infra = useInfraConfigStore()
  const execution = useExecutionStore()
  const pipelines = usePipelinesStore()
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

  /** The seeded analyst pipeline, when present in the workspace (else deep analysis is unavailable). */
  const analysisPipeline = computed(() => pipelines.getPipeline(ANALYSIS_PIPELINE_ID))
  const canAnalyze = computed(() => hasRepo.value && analysisPipeline.value !== undefined)

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
    const analystStep = run.steps.find((s) => s.agentKind === ANALYST_AGENT_KIND)
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
  /**
   * Clear all per-frame flow state (detection, working recipe, preflight, save, trial). Shared by
   * `open` and `selectFrame` so re-targeting the wizard at a different frame can't leave a prior
   * frame's `saved`/`composeService`/`exposedPort`/results behind (which would make an unsaved
   * frame render the green "saved" confirmation + offer a trial provision).
   */
  function resetFlowState() {
    detecting.value = false
    detectError.value = false
    recommendation.value = null
    analysisRequested.value = false
    analysisError.value = false
    recipe.value = {}
    composeService.value = ''
    preflightRunning.value = false
    preflightResults.value = null
    preflightError.value = null
    handlerLabel.value = 'Docker Compose'
    exposedPort.value = 80
    saving.value = false
    saveError.value = null
    saved.value = false
    trialing.value = false
    trialError.value = null
    trialStarted.value = false
  }

  /**
   * Seed the data layer for a frame the journey's review step is entering. The
   * journey owns navigation, so this is idempotent by frame: it (re)seeds +
   * detects only when the target frame actually changes, so back-navigating to
   * the review step (or a resume) does NOT clobber the operator's in-progress
   * recipe edits. Selecting a different frame resets the flow for it.
   */
  function beginForFrame(id: string | null) {
    if (frameId.value === id) return
    frameId.value = id
    resetFlowState()
    if (id) void detect()
  }

  /** Re-seed the working recipe from the current merge (detector-only, or +analyst after apply). */
  function seedFromMerged() {
    if (merged.value) recipe.value = cloneRecipe(merged.value.recipe)
    // Default the exposed service to the detector's recommended compose service, when known.
    const recommended = recommendation.value?.composeServiceCandidates?.find((c) => c.recommended)
    if (recommended && !composeService.value) composeService.value = recommended.service
  }

  /** Run checkout-free detection for the frame's repo (non-binding; seeds the working recipe). */
  async function detect() {
    const ctx = repoContext.value
    if (!ctx) {
      detectError.value = true
      return
    }
    const repo = github.repoFor(ctx.githubId)
    if (!repo) {
      detectError.value = true
      return
    }
    detecting.value = true
    detectError.value = false
    try {
      const rec = await infra.detectProvisioning({
        owner: repo.owner,
        repo: repo.name,
        ...(ctx.directory ? { directory: ctx.directory } : {}),
        prefer: 'docker-compose',
      })
      recommendation.value = rec
      // Seed the exposed port + build flag from the detected provisioning where present.
      seedFromMerged()
    } catch {
      detectError.value = true
    } finally {
      detecting.value = false
    }
  }

  /** Fire the analyst-only pipeline against the frame (mirrors how bootstrap runs pl_blueprint). */
  async function startAnalysis() {
    const id = frameId.value
    const pipeline = analysisPipeline.value
    if (!id || !pipeline) {
      analysisError.value = true
      return
    }
    analysisError.value = false
    try {
      await execution.start(id, pipeline)
      analysisRequested.value = true
    } catch {
      analysisError.value = true
    }
  }

  /** Fold the (now-ready) analyst draft into the working recipe (re-seed from the merge). */
  function applyAnalystDraft() {
    seedFromMerged()
  }

  /** Toggle an OS-override / extra compose file into the working recipe's ordered `composeFiles`. */
  function toggleComposeFile(path: string) {
    const files = recipe.value.composeFiles ? [...recipe.value.composeFiles] : []
    const idx = files.indexOf(path)
    if (idx >= 0) files.splice(idx, 1)
    else files.push(path)
    recipe.value = { ...recipe.value, composeFiles: files }
  }

  /** Toggle a `COMPOSE_PROFILES` label into the working recipe. */
  function toggleProfile(profile: string) {
    const profiles = recipe.value.composeProfiles ? [...recipe.value.composeProfiles] : []
    const idx = profiles.indexOf(profile)
    if (idx >= 0) profiles.splice(idx, 1)
    else profiles.push(profile)
    recipe.value = { ...recipe.value, composeProfiles: profiles }
  }

  /**
   * Convert a confirmed seed-dump candidate into a `compose-exec` step that pipes the dump via
   * stdin. The service + command are a best-effort default (the exposed/db service + a `cat`
   * placeholder) the operator refines in the recipe editor — detection can't know the DB client.
   */
  function addSeedStep(candidate: ProvisioningSeedDumpCandidate) {
    const setupSteps = recipe.value.setupSteps ? [...recipe.value.setupSteps] : []
    setupSteps.push({
      kind: 'compose-exec',
      name: `Import seed ${candidate.name}`,
      service: composeService.value || 'db',
      command: ['sh', '-c', 'cat'],
      stdinFile: candidate.path,
    })
    recipe.value = { ...recipe.value, setupSteps }
  }

  /** Replace the working recipe from a raw-JSON edit; returns an error message or null on success. */
  function setRecipeFromJson(text: string): string | null {
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(text)
    } catch (err) {
      return err instanceof Error ? err.message : 'Invalid JSON'
    }
    const result = v.safeParse(stackRecipeSchema, parsedJson)
    if (!result.success) return result.issues.map((i) => i.message).join('; ')
    recipe.value = result.output
    return null
  }

  /** Run the working recipe's declared preflight checks (host-bound; degrades on a non-local facade). */
  async function runPreflight() {
    preflightRunning.value = true
    preflightError.value = null
    try {
      preflightResults.value = await preflights.run(recipe.value.prerequisites ?? [])
    } catch (err) {
      // A 503 is handled inside `preflights.run` (degraded note); anything else is a real failure
      // that must be shown rather than swallowed into an unhandled rejection.
      preflightError.value =
        apiErrorEnvelope(err)?.message ?? (err instanceof Error ? err.message : String(err))
    } finally {
      preflightRunning.value = false
    }
  }

  /**
   * Persist the confirmed config: register the workspace's `docker-compose` handler (so the Deployer
   * can provision it) AND write the recipe onto the service frame's provisioning. The handler carries
   * only the daemon "how" (the exposed service + port); the recipe is the per-service "what/where".
   */
  async function save() {
    const id = frameId.value
    const service = composeService.value.trim()
    if (!id || !service) {
      saveError.value = 'A frame and an exposed compose service are required.'
      return
    }
    // `exposedPort` is a `v-model.number` field, which yields '' (not a number) when cleared. Guard
    // here so an empty/out-of-range port can't reach the handler manifest.
    const port = Number(exposedPort.value)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      saveError.value = 'Enter a valid exposed port (1-65535).'
      return
    }
    saving.value = true
    saveError.value = null
    const pruned = pruneRecipe(recipe.value)
    const build = recommendation.value?.provisioning.composeBuild === true
    const allowHostCommands = (pruned.setupSteps ?? []).some((s) => s.kind === 'host-command')
    try {
      await infra.registerHandler({
        provisionType: 'docker-compose',
        config: {
          engine: 'local-docker',
          manifest: {
            providerId: 'compose',
            label: handlerLabel.value.trim() || 'Docker Compose',
            baseUrl: 'http://localhost',
            auth: { type: 'none' },
            provision: { method: 'POST', pathTemplate: '' },
            response: {},
            providerConfig: {
              service,
              port,
              ...(build ? { build: true } : {}),
              ...(allowHostCommands ? { allowHostCommands: true } : {}),
            },
          },
        },
        secrets: {},
      })
      await board.updateBlock(id, {
        provisioning: {
          type: 'docker-compose',
          ...(pruned.composeFiles?.[0] ? { composePath: pruned.composeFiles[0] } : {}),
          ...(build ? { composeBuild: true } : {}),
          recipe: pruned,
        },
      })
      saved.value = true
    } catch (err) {
      saveError.value =
        apiErrorEnvelope(err)?.message ?? (err instanceof Error ? err.message : String(err))
    } finally {
      saving.value = false
    }
  }

  /** Optional trial: provision the just-saved config for the frame (local-only; live logs shown). */
  async function trialProvision() {
    const id = frameId.value
    if (!id || !saved.value) return
    trialing.value = true
    trialError.value = null
    try {
      const api = useApi()
      const ws = useWorkspaceStore()
      await api.provisionEnvironment(ws.requireId(), { blockId: id })
      trialStarted.value = true
    } catch (err) {
      trialError.value =
        apiErrorEnvelope(err)?.message ?? (err instanceof Error ? err.message : String(err))
    } finally {
      trialing.value = false
    }
  }

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
    beginForFrame,
    detect,
    startAnalysis,
    applyAnalystDraft,
    toggleComposeFile,
    toggleProfile,
    addSeedStep,
    setRecipeFromJson,
    runPreflight,
    save,
    trialProvision,
  }
})
