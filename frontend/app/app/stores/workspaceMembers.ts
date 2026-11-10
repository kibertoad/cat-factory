import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useUpsertList } from '~/composables/useUpsertList'
import type { WorkspaceAccessMode, WorkspaceMember, WorkspaceRole } from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The active board's workspace-RBAC roster (member-management, slice 9). Owns the
 * `workspace_members` list plus the board's access-mode flip, sitting BELOW the account
 * tier: an account admin can restrict a board to an explicit member list, while an
 * unrestricted (`account`) board keeps the legacy "every account member sees it" behaviour.
 *
 * Every write requires `members.manage` server-side, so the SPA only mounts this surface
 * (the Members tab in workspace settings) when `useWorkspaceAccess().canManageMembers`.
 * The list is loaded lazily when that panel opens — it is not part of the board snapshot.
 */
export const useWorkspaceMembersStore = defineStore('workspaceMembers', () => {
  const api = useApi()

  const { items: members, upsert: upsertMember } = useUpsertList<WorkspaceMember>({
    key: (m) => m.userId,
  })
  /**
   * The workspace id the currently-committed roster belongs to. The Members panel renders
   * the roster only while this matches its own `workspaceId`, so switching boards never
   * briefly shows the previous board's members before the new load resolves.
   */
  const loadedFor = ref<string | null>(null)
  /**
   * The workspace id whose latest load FAILED, so the panel can end its skeleton and say so.
   * `loadedFor` alone cannot: it is set only on success, so a failed load left it unmatched and
   * the skeleton up for good.
   */
  const failedFor = ref<string | null>(null)
  // Monotonic request token: only the latest-issued load() commits, so a slow, superseded
  // fetch can't clobber a newer board's roster (the ordering hazard the coherence rules warn about).
  let loadSeq = 0

  /**
   * Load the board's member roster (enriched with display details by the backend). A failure
   * is recorded on `failedFor` and rethrown for the caller to report.
   */
  async function load(workspaceId: string) {
    const token = ++loadSeq
    // A new load clears the previous failure, so a retry shows the skeleton while it runs.
    if (failedFor.value === workspaceId) failedFor.value = null
    let roster: WorkspaceMember[]
    try {
      roster = await api.listWorkspaceMembers(workspaceId)
    } catch (error) {
      if (token === loadSeq) failedFor.value = workspaceId
      throw error
    }
    if (token !== loadSeq) return // a newer load() superseded this one; drop the stale result
    members.value = roster
    loadedFor.value = workspaceId
    failedFor.value = null
  }

  /** Add an account member to the board at a workspace role (upsert). */
  async function add(workspaceId: string, userId: string, role: WorkspaceRole) {
    upsertMember(await api.addWorkspaceMember(workspaceId, userId, role))
  }

  /** Change an existing member's workspace role. */
  async function setRole(workspaceId: string, userId: string, role: WorkspaceRole) {
    upsertMember(await api.setWorkspaceMemberRole(workspaceId, userId, role))
  }

  /** Remove a member from the board. */
  async function remove(workspaceId: string, userId: string) {
    await api.removeWorkspaceMember(workspaceId, userId)
    members.value = members.value.filter((m) => m.userId !== userId)
  }

  /**
   * Flip the board's access mode. `restricted` limits it to the roster; `account` restores
   * the legacy behaviour. Patches the board's list row in place so the switcher badge and
   * `activeWorkspace.accessMode` reflect the flip without a re-fetch.
   */
  async function setAccessMode(workspaceId: string, accessMode: WorkspaceAccessMode) {
    const updated = await api.setWorkspaceAccessMode(workspaceId, accessMode)
    const workspace = useWorkspaceStore()
    const row = workspace.workspaces.find((w) => w.id === workspaceId)
    // Merge only the workspace fields (incl. `accessMode`), preserving the row's
    // `viewerRole` list annotation, which the single-workspace response doesn't carry.
    if (row) Object.assign(row, updated)
    return updated
  }

  return { members, loadedFor, failedFor, load, add, setRole, remove, setAccessMode }
})
