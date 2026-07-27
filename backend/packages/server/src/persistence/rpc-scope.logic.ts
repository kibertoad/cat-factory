import type { DispatchOptions, DispatchResult } from './rpc'

/**
 * Token-scope checks for the record/owner-pair {@link ScopeRule} kinds, split out of `rpc.ts` so the
 * dispatch module stays under its size budget. Pure code motion — each function keeps the exact
 * contract it had inline: returns a `DispatchResult` (always the 404 `denied`, per the existence-
 * non-leak policy) when the call is out of scope, and `undefined` when it passes.
 */

/**
 * The `serviceMount` record-based mount `upsert`. Bind on the mount's `workspaceId` FIELD (must be
 * in scope) AND enforce the cross-org mount invariant server-side: the mounted `serviceId` must be
 * owned by the SAME account as the target workspace, so a raw upsert can never plant a cross-org
 * mount — even for a token that spans several accounts (both would be in scope, so a workspace-only
 * check would let one org's service be mounted onto another's board). A non-object arg, a
 * missing/non-string field, an out-of-scope workspace, or a service whose account differs from the
 * workspace's (incl. a missing service) → `denied`, else `undefined`. Split from
 * `checkEntityCallScope` purely to keep each function under the complexity ceiling.
 */
export async function checkServiceMountScope(
  record: unknown,
  opts: DispatchOptions,
  inScope: (accountId: string | null | undefined) => boolean,
  denied: DispatchResult,
): Promise<DispatchResult | undefined> {
  const workspaceId =
    record && typeof record === 'object'
      ? (record as { workspaceId?: unknown }).workspaceId
      : undefined
  const serviceId =
    record && typeof record === 'object' ? (record as { serviceId?: unknown }).serviceId : undefined
  if (typeof workspaceId !== 'string' || typeof serviceId !== 'string') return denied
  if (!opts.resolveServiceAccountIds) return denied
  const workspaceAccount = await opts.resolveAccountId(workspaceId)
  if (!inScope(workspaceAccount)) return denied
  const serviceAccounts = await opts.resolveServiceAccountIds([serviceId])
  const serviceAccount = serviceAccounts.get(serviceId)
  // Same-account: the service must be owned by the workspace's (in-scope) account. Since
  // `workspaceAccount` is already confirmed in scope, requiring equality also keeps the
  // service in scope — a legacy/NULL-account service (never present under a scoped token)
  // won't equal the string account, so it fails closed too.
  if (typeof serviceAccount !== 'string' || serviceAccount !== workspaceAccount) return denied
  return undefined
}

/**
 * Resolve a tenant-library owner PAIR (ownerKind, ownerId) to an account and enforce token scope,
 * shared by the `owner` (positional) and `ownerField` (record-field) kinds. Returns `denied` when
 * the pair is malformed or out of scope, else `undefined`. A `workspace` owner resolves through the
 * workspace's owning account; an `account` owner IS the account; any other kind fails closed.
 */
export async function checkOwnerPairScope(
  ownerKind: unknown,
  ownerId: unknown,
  opts: DispatchOptions,
  inScope: (accountId: string | null | undefined) => boolean,
  denied: DispatchResult,
): Promise<DispatchResult | undefined> {
  if (typeof ownerId !== 'string') return denied
  if (ownerKind === 'workspace') {
    if (!inScope(await opts.resolveAccountId(ownerId))) return denied
  } else if (ownerKind === 'account') {
    if (!inScope(ownerId)) return denied
  } else {
    return denied
  }
  return undefined
}

/**
 * The `workspaceFieldList` BATCH record write (`upsertMany(records)`): every record must bind to an
 * in-scope workspace via its own `workspaceId` FIELD — the batch mirror of `workspaceField`.
 *
 * Refusing the WHOLE call on one bad row, rather than filtering the array down, is deliberate: a
 * partially-applied batch write would leave the caller believing it persisted rows that were
 * silently dropped. A non-array arg, a record with a missing/non-string `workspaceId`, or any
 * out-of-scope workspace → `denied`, else `undefined`.
 */
export async function checkWorkspaceFieldListScope(
  records: unknown,
  opts: DispatchOptions,
  inScope: (accountId: string | null | undefined) => boolean,
  denied: DispatchResult,
): Promise<DispatchResult | undefined> {
  if (!Array.isArray(records)) return denied
  for (const record of records) {
    const workspaceId =
      record && typeof record === 'object'
        ? (record as { workspaceId?: unknown }).workspaceId
        : undefined
    if (typeof workspaceId !== 'string') return denied
    if (!inScope(await opts.resolveAccountId(workspaceId))) return denied
  }
  return undefined
}
