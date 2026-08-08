// ---------------------------------------------------------------------------
// Who a workspace-scoped notification is addressed to, when the channel has to name
// PEOPLE rather than a destination (email today; any future per-person transport).
//
// It is the same question `resolveWorkspaceAccess` answers, asked over a roster instead
// of about one caller, so it is derived from the SAME rules and lives beside them: a
// second, looser reading of who can see a board would mail a task's contents to someone
// the board itself hides it from. Account membership is the prerequisite, an account
// admin always qualifies, and a `workspace_members` row only counts for someone who is
// still an account member (an orphaned row is inert, exactly as it is for access).
//
// Pure, so both facades and the tests agree without a store.
// ---------------------------------------------------------------------------

import type { AccountRole } from './types.js'
import type { WorkspaceAccessRow } from './workspace-access.js'

/** One account membership as the audience rules read it. */
export interface AudienceAccountMember {
  userId: string
  roles: AccountRole[]
}

export interface NotificationAudienceInput {
  /** The board's access row (owning account, legacy owner, access mode). */
  workspace: WorkspaceAccessRow
  /** Every membership in the board's owning account. Empty for a legacy board. */
  accountMembers: AudienceAccountMember[]
  /** The user ids holding an explicit `workspace_members` row on this board. */
  workspaceMemberUserIds: string[]
}

/**
 * The user ids a workspace notification may be delivered to, de-duplicated and in a
 * stable order (account roster order, then the member rows).
 *
 *  - Legacy / unscoped board (`accountId === null`): its owner alone.
 *  - `accessMode: 'account'`: every account member (a member ROW is an upgrade-only
 *    overlay there, so it adds nobody).
 *  - `accessMode: 'restricted'`: the account admins plus the account members who hold a
 *    member row.
 */
export function notificationAudienceUserIds(input: NotificationAudienceInput): string[] {
  const { workspace, accountMembers, workspaceMemberUserIds } = input
  if (workspace.accountId === null) {
    return workspace.ownerUserId ? [workspace.ownerUserId] : []
  }
  if (workspace.accessMode === 'account') {
    return unique(accountMembers.map((m) => m.userId))
  }
  const rostered = new Set(workspaceMemberUserIds)
  return unique(
    accountMembers
      .filter((m) => m.roles.includes('admin') || rostered.has(m.userId))
      .map((m) => m.userId),
  )
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)]
}
