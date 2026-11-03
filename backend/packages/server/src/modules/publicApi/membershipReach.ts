import type { PublicApiKeyIdentity } from '@cat-factory/integrations'
import type { ServerContainer } from '../../http/env.js'

/**
 * The workspaces a membership-following key reaches on THIS call: every board in the key's account
 * its bound person can see in the app right now, by the same visibility rule the workspace list
 * uses (unrestricted boards of an account they belong to, any board of one they admin, and the
 * restricted boards they hold a member row on). Two reads, and nothing cached across calls, so a
 * membership granted or removed takes effect on the next one.
 */
export async function membershipReachOf(
  container: ServerContainer,
  key: Pick<PublicApiKeyIdentity, 'accountId' | 'actsAsUserId'>,
): Promise<string[]> {
  const userId = key.actsAsUserId
  if (userId === null) return []
  const scopes = await container.accountService.accessibleAccountScopes(userId)
  const inAccount = (ids: string[]) => ids.filter((id) => id === key.accountId)
  const boards = await container.workspaceService.list({
    accountIds: inAccount(scopes.accountIds),
    adminAccountIds: inAccount(scopes.adminAccountIds),
    ownerUserId: userId,
    userId,
  })
  return boards
    .filter((board) => board.accountId === key.accountId)
    .map((board) => board.id)
    .sort()
}
