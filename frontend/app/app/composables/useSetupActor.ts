import { computed } from 'vue'
import type { SetupActor } from '~/utils/setupAudience'

/**
 * The caller as a setup prompt sees them: which app surface they chose, and the board and account
 * grants that decide whether a "configure this" button would let them save. One reading for every
 * setup prompt, so the cards and the line shown to everyone else cannot disagree about who is who.
 */
export function useSetupActor() {
  const access = useWorkspaceAccess()
  const uiRole = useUiRoleStore()
  const accounts = useAccountsStore()

  const actor = computed<SetupActor>(() => ({
    fullSurface: uiRole.fullSurface,
    canManageIntegrations: access.canManageIntegrations.value,
    isAccountAdmin: accounts.activeAccount?.roles?.includes('admin') ?? false,
    accountsEnabled: accounts.enabled,
  }))

  return { actor }
}
