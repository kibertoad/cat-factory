import { computed } from 'vue'
import type { WorkspacePermission, WorkspaceRole } from '~/types/domain'

/**
 * The signed-in caller's resolved workspace-RBAC access to the ACTIVE board — the
 * central helper for gating _workspace-scoped_ affordances in the SPA (board editing,
 * run controls, HITL actions, admin settings panels). It reads the `access` the auth
 * gate resolved server-side and attached to the workspace snapshot (`{ role, permissions }`),
 * so the frontend never re-derives the permission math — it consumes the same source of
 * truth the backend enforces against.
 *
 * **Dev-open parity.** When auth is disabled the backend attaches no `access` (it resolves
 * no access object and allows everything), so an absent snapshot access here means dev-open
 * ⇒ `can()` returns `true` for every permission and `role` is `null`. This mirrors the
 * backend's `requirePermission` "absent access with no user ⇒ allow" branch exactly, so the
 * SPA never hides an affordance the backend would have permitted.
 *
 * This is deliberately distinct from the ACCOUNT-scoped admin checks
 * (`accounts.activeAccount?.roles?.includes('admin')`), which stay account-scoped: this
 * composable answers "what can you do inside THIS board", the account check answers "what
 * can you do to the tenant".
 */
export function useWorkspaceAccess() {
  const workspace = useWorkspaceStore()

  /** The caller's effective role on the active board, or `null` in dev-open (auth off). */
  const role = computed<WorkspaceRole | null>(() => workspace.access?.role ?? null)

  /**
   * The permission set the backend granted the caller, or `null` in dev-open. `can()`
   * short-circuits to allow-all when this is null, so a null set is never a "deny".
   */
  const permissions = computed<ReadonlySet<WorkspacePermission> | null>(() =>
    workspace.access ? new Set(workspace.access.permissions) : null,
  )

  /**
   * Whether the caller holds `permission` on the active board. Absent access (dev-open)
   * ⇒ `true` (backend-parity). Use this — never a raw role comparison — so a future
   * custom-role model or an escape-hatch grant is honoured automatically.
   */
  function can(permission: WorkspacePermission): boolean {
    const set = permissions.value
    return set === null || set.has(permission)
  }

  /** Board mutation (blocks CRUD/move/reparent/archive, epics, initiatives, pipelines). */
  const canWriteBoard = computed(() => can('board.write'))
  /** Run lifecycle + all HITL windows (start/stop/merge, retry, decision approvals). */
  const canExecuteRuns = computed(() => can('runs.execute'))
  /** Board configuration (workspace settings, presets, risk/merge policies, observability). */
  const canManageSettings = computed(() => can('settings.manage'))
  /** Integration connections (GitHub/Slack/environments/runner-pool/sources, bootstrap). */
  const canManageIntegrations = computed(() => can('integrations.manage'))
  /** Secrets (vendor credentials, workspace + public API keys, test secrets). */
  const canManageSecrets = computed(() => can('secrets.manage'))
  /** Roster + access-mode flip (workspace member CRUD). */
  const canManageMembers = computed(() => can('members.manage'))

  /**
   * A read-only viewer (resolved a role, but not `>= member`). Distinct from dev-open:
   * `isViewer` is `false` when there is no access object at all, since dev-open sees all.
   */
  const isViewer = computed(() => role.value === 'viewer')
  /** Resolved at least the member tier (or dev-open). */
  const isMember = computed(() => role.value === null || role.value !== 'viewer')
  /** A workspace admin (or dev-open). */
  const isAdmin = computed(() => role.value === null || role.value === 'admin')

  return {
    role,
    permissions,
    can,
    canWriteBoard,
    canExecuteRuns,
    canManageSettings,
    canManageIntegrations,
    canManageSecrets,
    canManageMembers,
    isViewer,
    isMember,
    isAdmin,
  }
}
