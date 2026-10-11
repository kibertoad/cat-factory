import { computed } from 'vue'
import { githubPatCheckNeedsAttention } from '@cat-factory/contracts'
import { deriveSetupChecklist, type SetupRowId } from '~/utils/setupChecklist'

/**
 * The store-facing half of `utils/setupChecklist.ts`: resolve every probe the checklist reads,
 * and the existing surface each row's action opens.
 *
 * Every action goes to the surface the matching banner or dialog already opens, so the checklist
 * is a new index over the setup the product has, never a second copy of it.
 */
export function useSetupChecklist() {
  const ui = useUiStore()
  const auth = useAuthStore()
  const github = useGitHubStore()
  const workspace = useWorkspaceStore()
  const providerConnections = useProviderConnectionsStore()
  const ai = useAiReadiness()
  const access = useWorkspaceAccess()

  const checklist = computed(() =>
    deriveSetupChecklist({
      model: {
        loaded: ai.ready.value,
        usable: ai.hasUsableModel.value,
        presetBroken: ai.defaultPresetBroken.value,
      },
      sourceControl: {
        available: github.available,
        connected: github.connected,
        patMissing: !!auth.localMode?.githubPatSetupUrl,
        patNeedsAttention:
          github.patCheck !== null && githubPatCheckNeedsAttention(github.patCheck),
      },
      infra: workspace.infraSetup ?? null,
      needingConfig: providerConnections.needingConfig,
    }),
  )

  /** Where each row's action goes: the surface its banner or dialog opens today. */
  const ACTIONS: Record<SetupRowId, () => void> = {
    model: () => ui.openModelProviders(),
    sourceControl: () => {
      const setupUrl = auth.localMode?.githubPatSetupUrl
      if (setupUrl) window.open(setupUrl, '_blank', 'noopener')
      else ui.openGitHub()
    },
    agentExecutor: () => ui.openProviderConnection('runner-pool'),
    testEnvironments: () => ui.openProviderConnection('environment'),
    contentStorage: () => ui.openContentStorageSettings(),
  }

  /**
   * Who sees the checklist: the people who can change what it lists. A member who cannot wire a
   * runner pool gains nothing from a page of things they cannot fix; the queue tells them in one
   * line that the workspace cannot run tasks yet, and who can fix it.
   */
  const canAct = computed(
    () => access.canManageIntegrations.value || access.canManageSettings.value,
  )

  return { checklist, act: (id: SetupRowId) => ACTIONS[id](), canAct }
}
