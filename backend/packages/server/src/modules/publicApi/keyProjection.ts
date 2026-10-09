import { PUBLIC_API_KEY_REACH_EXCEEDED_REASON, type PublicApiKey } from '@cat-factory/contracts'
import { reachCovers } from '@cat-factory/integrations'
import { ForbiddenError, NotFoundError, type PublicApiKeyRecord } from '@cat-factory/kernel'

// Shared by the session-authed key panel and the headless `/api/v1/keys` surface, so the two
// project a key and judge a requested reach identically.

/** A key on the wire. `workspaceId` is the workspace the listing or mint was made for. */
export function publicApiKeyToWire(record: PublicApiKeyRecord, workspaceId: string): PublicApiKey {
  return {
    id: record.id,
    accountId: record.accountId,
    workspaceId,
    workspaceIds: record.workspaceIds,
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
