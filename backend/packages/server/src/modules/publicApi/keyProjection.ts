import type { PublicApiKey } from '@cat-factory/contracts'
import type { PublicApiKeyRecord } from '@cat-factory/kernel'

/**
 * Project a stored public-API key onto the secret-free wire resource.
 *
 * ONE projection for both surfaces that expose a key: the session-authed management routes
 * (`PublicApiKeyController`) and the headless provisioning routes (`PublicKeyController`). They
 * had a copy each, which is how a field comes to be echoed on one and silently absent on the
 * other: `externalIdentity` is set by the headless mint and read on both, so a caller listing its
 * keys in the app would have seen every one of them claim to act for nobody.
 *
 * `secretHash` is the field this exists to leave behind. It is the only member of the record the
 * wire type has no place for, so an explicit projection (never a spread of the row) is what keeps
 * a future column from arriving on the wire by default.
 */
export function publicApiKeyToWire(record: PublicApiKeyRecord): PublicApiKey {
  return {
    id: record.id,
    accountId: record.accountId,
    workspaceId: record.workspaceId,
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
