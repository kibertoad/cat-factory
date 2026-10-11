import { computed } from 'vue'
import type { SetupActor } from '~/utils/setupAudience'

/**
 * The caller as a setup prompt sees them: which app surface they chose, and the board and account
 * grants that decide whether a "configure this" button would let them save. Every input is read
 * from the source the nav gates read too (the role store, `useWorkspaceAccess`, and the accounts
 * store's `isActiveAccountAdmin`), so a setup prompt and the sidebar cannot disagree about who the
 * caller is.
 */
export function useSetupActor() {
  const access = useWorkspaceAccess()
  const uiRole = useUiRoleStore()
  const accounts = useAccountsStore()

  const actor = computed<SetupActor>(() => ({
    fullSurface: uiRole.fullSurface,
    canManageIntegrations: access.canManageIntegrations.value,
    canExecuteRuns: access.canExecuteRuns.value,
    isAccountAdmin: accounts.isActiveAccountAdmin,
    accountsEnabled: accounts.enabled,
  }))

  return { actor }
}
