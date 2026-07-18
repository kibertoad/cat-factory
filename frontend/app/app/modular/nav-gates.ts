import { computed } from 'vue'
import type { NavGates } from '~/modular/nav-contributions'

/**
 * Build the reactive `gates` service the nav `slotFilter` reads (slice 1 of the
 * modular-vue adoption). Called once from the modular install plugin, where
 * Pinia + composables are available.
 *
 * Returns a plain object whose getters read the host's reactive RBAC /
 * availability state. Passed to the registry as a `service` (by reference, not
 * snapshotted), so when `navSlotFilter` reads `gates.canWriteBoard` inside the
 * `useReactiveSlots` computed the underlying reactive source is tracked — a
 * permission or connection flip re-gates every shell with no `recalculateSlots()`.
 *
 * This mirrors the exact gating the pre-slice-1 `SideBar` computeds encoded (see
 * `useWorkspaceAccess` for the dev-open "absent access ⇒ allow all" parity).
 */
export function createNavGates(): NavGates {
  const access = useWorkspaceAccess()
  const github = useGitHubStore()
  const library = useFragmentLibraryStore()
  const accounts = useAccountsStore()
  const auth = useAuthStore()
  const providerConnections = useProviderConnectionsStore()

  const infrastructureAvailable = computed(
    () =>
      auth.infrastructure != null ||
      auth.localMode?.enabled === true ||
      providerConnections.isAvailable('runner-pool') ||
      providerConnections.isAvailable('environment'),
  )
  const isAccountAdmin = computed(() => accounts.activeAccount?.roles?.includes('admin') ?? false)

  return {
    get canWriteBoard() {
      return access.canWriteBoard.value
    },
    get canManageIntegrations() {
      return access.canManageIntegrations.value
    },
    get canManageSettings() {
      return access.canManageSettings.value
    },
    get githubAvailable() {
      return github.available === true
    },
    get libraryAvailable() {
      return library.available === true
    },
    get infrastructureAvailable() {
      // `integrations.manage` is required to provision/manage infrastructure, so
      // gate the whole section on it too (a member/viewer would only 403 inside).
      return access.canManageIntegrations.value && infrastructureAvailable.value
    },
    get accountsEnabled() {
      return accounts.enabled
    },
    get isAccountAdmin() {
      return isAccountAdmin.value
    },
  }
}
