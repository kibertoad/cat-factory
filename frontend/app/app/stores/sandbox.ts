import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ModelOption } from '~/types/domain'
import type {
  SandboxAgentKindMeta,
  SandboxExperiment,
  SandboxExperimentDetail,
  SandboxFixture,
  SandboxOverview,
  SandboxPromptVersion,
} from '~/types/sandbox'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The Sandbox (parallel prompt/model testing surface). Loaded on demand when the panel
 * opens (it's an opt-in, secondary surface, not part of the board snapshot): the testable
 * agent-kind catalog, the shipped baselines + stored candidate prompt versions, the
 * fixture library, and experiment definitions. Running an experiment grades every cell
 * with a judge model; `launch` returns the full result grid.
 */
export const useSandboxStore = defineStore('sandbox', () => {
  const api = useApi()

  const available = ref(true)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const agentKinds = ref<SandboxAgentKindMeta[]>([])
  const prompts = ref<SandboxPromptVersion[]>([])
  const fixtures = ref<SandboxFixture[]>([])
  const experiments = ref<SandboxExperiment[]>([])
  const models = ref<ModelOption[]>([])
  /** The matrix cell cap (from the backend overview, so the builder gates on the same limit). */
  const maxCells = ref(100)

  /** The currently-opened experiment's full detail (result grid), if any. */
  const detail = ref<SandboxExperimentDetail | null>(null)
  const launching = ref(false)

  function hydrate(overview: SandboxOverview) {
    agentKinds.value = overview.agentKinds
    prompts.value = overview.prompts
    fixtures.value = overview.fixtures
    experiments.value = [...overview.experiments].sort((a, b) => b.createdAt - a.createdAt)
    maxCells.value = overview.maxCells
  }

  /** Patch one experiment into the list in place (newest-first), without a full reload. */
  function upsertExperiment(experiment: SandboxExperiment) {
    const next = experiments.value.filter((e) => e.id !== experiment.id)
    next.push(experiment)
    experiments.value = next.sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Load the overview + the workspace model catalog. The 503 (feature off) is surfaced. */
  async function load() {
    const ws = useWorkspaceStore()
    if (!ws.workspaceId) return
    loading.value = true
    error.value = null
    try {
      const [overview, modelList] = await Promise.all([
        api.getSandboxOverview(ws.requireId()),
        api.getWorkspaceModels(ws.requireId()),
      ])
      hydrate(overview)
      models.value = modelList
      available.value = true
    } catch (e) {
      const status =
        (e as { statusCode?: number; response?: { status?: number } })?.statusCode ??
        (e as { response?: { status?: number } })?.response?.status
      if (status === 503) {
        available.value = false
      } else {
        error.value = e instanceof Error ? e.message : String(e)
      }
    } finally {
      loading.value = false
    }
  }

  /** Selectable models for the experiment picker (the backend computed `available`). */
  const selectableModels = computed(() => models.value.filter((m) => m.available !== false))

  /** Prompt versions for one agent kind (baselines first, then candidates). */
  function promptsForKind(agentKind: string): SandboxPromptVersion[] {
    return prompts.value.filter((p) => p.agentKind === agentKind)
  }

  /** Fixtures authored for one agent kind, filtered by the catalog's `fixtureKinds`. */
  function fixturesForKind(agentKind: string): SandboxFixture[] {
    const meta = agentKinds.value.find((k) => k.agentKind === agentKind)
    if (!meta) return fixtures.value
    // The backend catalog is the source of truth for the fixture↔kind mapping.
    const wanted = meta.fixtureKinds
    return fixtures.value.filter((f) => wanted.includes(f.kind))
  }

  async function clonePrompt(agentKind: string, basePromptId: string | null, name?: string) {
    const ws = useWorkspaceStore()
    const created = await api.cloneSandboxPrompt(ws.requireId(), { agentKind, basePromptId, name })
    await load()
    return created
  }

  async function saveVersion(parentId: string, systemText: string) {
    const ws = useWorkspaceStore()
    const saved = await api.saveSandboxVersion(ws.requireId(), { parentId, systemText })
    await load()
    return saved
  }

  async function archivePrompt(promptId: string) {
    const ws = useWorkspaceStore()
    await api.archiveSandboxPrompt(ws.requireId(), promptId)
    await load()
  }

  async function createExperiment(input: Parameters<typeof api.createSandboxExperiment>[1]) {
    const ws = useWorkspaceStore()
    const created = await api.createSandboxExperiment(ws.requireId(), input)
    await load()
    return created
  }

  async function openExperiment(experimentId: string) {
    const ws = useWorkspaceStore()
    detail.value = await api.getSandboxExperiment(ws.requireId(), experimentId)
    return detail.value
  }

  async function launch(experimentId: string) {
    const ws = useWorkspaceStore()
    launching.value = true
    try {
      // `launch` returns the full graded grid AND the updated experiment, so patch both in
      // place rather than calling `load()`: a transient failure in that follow-up fetch
      // would otherwise set `error` and hide the freshly-returned result grid behind the
      // error panel (and re-fetch the whole overview + model catalog for nothing).
      const result = await api.launchSandboxExperiment(ws.requireId(), experimentId)
      detail.value = result
      upsertExperiment(result.experiment)
      return result
    } finally {
      launching.value = false
    }
  }

  return {
    available,
    loading,
    error,
    agentKinds,
    prompts,
    fixtures,
    experiments,
    models,
    maxCells,
    selectableModels,
    detail,
    launching,
    load,
    promptsForKind,
    fixturesForKind,
    clonePrompt,
    saveVersion,
    archivePrompt,
    createExperiment,
    openExperiment,
    launch,
  }
})
