import { computed, ref } from 'vue'
import { githubPatCheckNeedsAttention } from '@cat-factory/contracts'
import { deriveSetupChecklist, type SetupRow } from '~/utils/setupChecklist'
import { githubPatRemintUrl } from '~/utils/vcs'

/**
 * The store-facing half of `utils/setupChecklist.ts`: resolve every probe the checklist reads,
 * and the existing surface each row's action opens.
 *
 * Every action goes to the surface the matching banner or dialog opens for the same state, so
 * the checklist is a new index over the setup the product has, never a second copy of it.
 */
export function useSetupChecklist() {
  const ui = useUiStore()
  const auth = useAuthStore()
  const github = useGitHubStore()
  const models = useModelsStore()
  const workspace = useWorkspaceStore()
  const providerConnections = useProviderConnectionsStore()
  const ai = useAiReadiness()
  const { actor } = useSetupActor()

  // The catalog is loaded on board open, and a failed load is dropped there on purpose (it stays
  // retryable, see `models.prefetchForBoard`). The checklist is where that failure is stated, so
  // it asks for the catalog itself and keeps the outcome.
  const modelLoadFailed = ref(false)
  async function loadModels() {
    const id = workspace.workspaceId
    if (!id) return
    modelLoadFailed.value = false
    try {
      await models.ensureLoaded(id)
    } catch {
      modelLoadFailed.value = true
    }
  }

  /**
   * Ask every probe the checklist reads, so a row does not wait on a banner that happens to be
   * mounted. Each is single-flighted or load-once in its store, so this costs nothing when the
   * board already asked.
   */
  function refresh() {
    void loadModels()
    void providerConnections.ensureLoaded()
    void github.ensureProbed()
  }

  const patCheck = computed(() => github.patCheck)
  const patProblem = computed<'rejected' | 'underscoped' | null>(() => {
    const check = patCheck.value
    if (!check || !githubPatCheckNeedsAttention(check)) return null
    return check.state === 'token_rejected' ? 'rejected' : 'underscoped'
  })

  const checklist = computed(() =>
    deriveSetupChecklist({
      model: {
        loaded: ai.ready.value,
        loadFailed: modelLoadFailed.value,
        usable: ai.hasUsableModel.value,
        presetBroken: ai.defaultPresetBroken.value,
      },
      sourceControl: {
        available: github.available,
        unavailableCause: github.unavailableCause,
        connected: github.connected,
        patMissing: !!auth.localMode?.githubPatSetupUrl,
        patProblem: patProblem.value,
      },
      infra: workspace.infraSetup ?? null,
      infraOwners: workspace.infraSetupOwners ?? null,
      providers: {
        loaded: providerConnections.loaded,
        needingConfig: providerConnections.needingConfig,
      },
      actor: actor.value,
    }),
  )

  /** The re-mint page the token banner links to, for the token GitHub rejected or under-scoped. */
  function openPatRemint() {
    const check = patCheck.value
    const report = check?.state === 'checked' ? check.report : undefined
    const url = githubPatRemintUrl(
      report?.kind ?? 'unknown',
      report?.webUrl ?? github.connection?.webUrl,
    )
    window.open(url, '_blank', 'noopener')
  }

  /**
   * Where a row's action goes, by row AND state: the surface the matching banner or dialog opens
   * for that state. Null where there is nothing to open (the deployment does not use the area).
   */
  function actionFor(row: SetupRow): (() => void) | null {
    if (row.status === 'not_needed' || row.status === 'checking') return null
    switch (row.id) {
      case 'model':
        if (row.cause === 'probeFailed') return () => void loadModels()
        if (row.status === 'missing') return () => ui.openAiProviderSetup()
        if (row.cause === 'presetBroken') return () => ui.openAiPresetMismatch()
        return () => ui.openModelProviders()
      case 'sourceControl': {
        const setupUrl = auth.localMode?.githubPatSetupUrl
        if (setupUrl) return () => window.open(setupUrl, '_blank', 'noopener')
        if (row.cause === 'rejected' || row.cause === 'underscoped') return openPatRemint
        if (row.cause === 'probeFailed') return () => void github.probe()
        return () => ui.openGitHub()
      }
      case 'agentExecutor':
        return () => ui.openProviderConnection('runner-pool')
      case 'testEnvironments':
        return () => ui.openProviderConnection('environment')
      case 'contentStorage':
        return () => ui.openContentStorageSettings()
      default: {
        const unreachable: never = row.id
        return unreachable
      }
    }
  }

  return { checklist, actionFor, refresh }
}
