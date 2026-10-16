import { PUBLIC_API_KEY_REACH_EXCEEDED_REASON, type PublicApiKey } from '@cat-factory/contracts'
import { reachCovers } from '@cat-factory/integrations'
import { ForbiddenError, NotFoundError, type PublicApiKeyRecord } from '@cat-factory/kernel'

// Shared by the session-authed key panel and the headless `/api/v1/keys` surface, so the two
// project a key and judge a requested reach identically.

/**
 * A key on the wire. `workspaceId` is the workspace the listing or mint was made for.
 *
 * `secretHash` is the field this exists to leave behind, so it is an explicit projection and never
 * a spread of the row: a future column must not arrive on the wire by default.
 */
export function publicApiKeyToWire(record: PublicApiKeyRecord, workspaceId: string): PublicApiKey {
  return {
    id: record.id,
    accountId: record.accountId,
    workspaceId,
    workspaceIds: record.workspaceIds,
    followsMemberships: record.followsMemberships,
    label: record.label,
    scope: record.scope,
    createdByUserId: record.createdByUserId,
    createdByKeyId: record.createdByKeyId,
    externalIdentity: record.externalIdentity,
    actsAsUserId: record.actsAsUserId,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
  }
}

/**
 * Refuse a requested reach naming any workspace outside `accountId`, in one batched read. A
 * foreign board and a missing one answer the same 404, so the check cannot be used as a probe.
 */
export async function assertWorkspacesInAccount(
  workspaces: { accountIdsOf(ids: string[]): Promise<Record<string, string | null>> },
  accountId: string,
  workspaceIds: string[] | null,
): Promise<void> {
  if (workspaceIds === null) return
  const owners = await workspaces.accountIdsOf(workspaceIds)
  const foreign = workspaceIds.find((id) => owners[id] !== accountId)
  if (foreign !== undefined) {
    throw new NotFoundError('Workspace', foreign, { reason: 'workspace_not_found' })
  }
}

/**
 * Refuse revoking a key the caller's reach does not cover. A key that follows its person's
 * memberships reaches no stored list (its `workspaceIds` is `[]`, which any reach "covers"), so
 * only that person's own key or an account-wide one may retire it.
 */
export function assertMayRevoke(
  holder: { workspaceIds: string[] | null; actsAsUserId: string | null },
  target: PublicApiKeyRecord,
): void {
  if (!target.followsMemberships) {
    assertReachCovers(holder.workspaceIds, target.workspaceIds, 'revoke that key')
    return
  }
  const own = holder.actsAsUserId !== null && holder.actsAsUserId === target.actsAsUserId
  if (!own && holder.workspaceIds !== null) {
    throw new ForbiddenError(
      "This key cannot revoke that key: it follows a person's workspaces, so only that person's " +
        'own key or one reaching the whole account may',
      { reason: PUBLIC_API_KEY_REACH_EXCEEDED_REASON },
    )
  }
}

/** Refuse an operation on a reach the caller's own reach does not cover. */
export function assertReachCovers(
  holder: string[] | null,
  requested: string[] | null,
  action: string,
): void {
  if (!reachCovers(holder, requested)) {
    throw new ForbiddenError(`This key cannot ${action}: it reaches workspaces this key does not`, {
      reason: PUBLIC_API_KEY_REACH_EXCEEDED_REASON,
    })
  }
}
