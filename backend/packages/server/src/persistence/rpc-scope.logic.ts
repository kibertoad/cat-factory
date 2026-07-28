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
 * The spend ledger's `tokenUsageRepository.record(record)`. Bind on the row's `workspaceId` FIELD
 * (must be in scope) AND pin the two DENORMALIZED rollup keys the account- and user-tier budget
 * reads index on directly: `accountId` must be absent/null or exactly the workspace's own owning
 * account, and `userId` must be absent/null or the token's user.
 *
 * That second half is the point of the rule. `workspaceField` alone would let a node scoped to
 * account A write ledger rows into its OWN workspace while stamping account B's id (or a
 * teammate's user id) on them — inflating a budget it has no entitlement to and pausing that
 * account's runs, without ever addressing one of its workspaces. Null is allowed because the
 * recorder legitimately writes it when a run has no resolvable account/initiator. A non-object
 * arg, a missing/non-string `workspaceId`, an out-of-scope workspace, or a mismatched
 * account/user id → `denied`, else `undefined`.
 */
export async function checkUsageRecordScope(
  record: unknown,
  opts: DispatchOptions,
  inScope: (accountId: string | null | undefined) => boolean,
  denied: DispatchResult,
): Promise<DispatchResult | undefined> {
  if (!record || typeof record !== 'object') return denied
  const { workspaceId, accountId, userId } = record as {
    workspaceId?: unknown
    accountId?: unknown
    userId?: unknown
  }
  if (typeof workspaceId !== 'string') return denied
  const workspaceAccount = await opts.resolveAccountId(workspaceId)
  if (!inScope(workspaceAccount)) return denied
  if (accountId != null && accountId !== workspaceAccount) return denied
  if (userId != null && userId !== opts.scope.userId) return denied
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
