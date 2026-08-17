import type { DispatchOptions, DispatchResult, LibrarySourceEntity } from './rpc'

/**
 * The `workspaceList` kind: every named workspace must resolve to an in-scope account. The reads
 * taking one answer with a SUBSET of the list, so binding the INPUT bounds the output: an
 * out-of-scope candidate fails closed rather than being quietly filtered, which would turn the read
 * into a probe for which boards link a repo. An empty list is a no-op read.
 */
export async function checkWorkspaceListScope(
  ids: unknown,
  opts: DispatchOptions,
  inScope: (accountId: string | null | undefined) => boolean,
  denied: DispatchResult,
): Promise<DispatchResult | undefined> {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) return denied
  for (const id of ids as string[]) {
    if (!inScope(await opts.resolveAccountId(id))) return denied
  }
  return undefined
}

/**
 * The `installationList` kind: the connect page's batched annotation read, "which of the ids the
 * provider just offered are already bound here".
 *
 * An id WITH a binding must be in scope; an id with NO binding is admitted, because refusing it
 * would make the read unusable for its only purpose and it discloses nothing the caller did not
 * send. An unreadable table still fails closed, as does a missing resolver.
 */
export async function checkInstallationListScope(
  ids: unknown,
  opts: DispatchOptions,
  inScope: (accountId: string | null | undefined) => boolean,
  denied: DispatchResult,
): Promise<DispatchResult | undefined> {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'number')) return denied
  if (ids.length === 0) return undefined
  if (!opts.resolveInstallationOwner) return denied
  for (const id of ids as number[]) {
    const owner = await opts.resolveInstallationOwner(id)
    if (owner.status === 'absent') continue
    if (owner.status !== 'found' || !inScope(owner.accountId)) return denied
  }
  return undefined
}

/**
 * The `serviceInsert` record write (`registerServiceForFrame`). Bind the DECLARED `accountId` (the
 * row lands there and is later listed from it) AND the `frameBlockId` the service claims.
 *
 * The frame-block half is what stops a service being planted on another org's frame: `resolveRepoTarget`
 * walks frame block → service on every dispatch, and `getByFrameBlock` resolves by frame block id alone,
 * so a foreign row could redirect that org's runs at a repo the caller controls. It is a THREE-state
 * lookup rather than a nullable read because the ordinary case is an absent block: the service row is
 * written BEFORE its frame block exists, so `absent` is the create this rule must admit, while
 * `unreadable` must not be spent as that admission (the same reason `ownerFieldUpsert` gives). Block ids
 * are server-minted, so admitting an unknown one grants nothing: a caller cannot name the id another
 * tenant will later be given.
 */
export async function checkServiceInsertScope(
  record: unknown,
  opts: DispatchOptions,
  inScope: (accountId: string | null | undefined) => boolean,
  denied: DispatchResult,
): Promise<DispatchResult | undefined> {
  if (!record || typeof record !== 'object') return denied
  const { accountId, frameBlockId } = record as { accountId?: unknown; frameBlockId?: unknown }
  if (typeof accountId !== 'string' || !inScope(accountId)) return denied
  if (typeof frameBlockId !== 'string' || !opts.resolveFrameBlockOwner) return denied
  const frame = await opts.resolveFrameBlockOwner(frameBlockId)
  switch (frame.status) {
    case 'found':
      // An existing frame must belong to the SAME account the service declares. Equality, not
      // merely in-scope: a token spanning several accounts would otherwise be able to cross them.
      return frame.accountId === accountId ? undefined : denied
    case 'absent':
      // The frame block has not been written yet — the ordinary creation order.
      return undefined
    case 'unreadable':
      return denied
    default: {
      const _exhaustive: never = frame
      void _exhaustive
      return denied
    }
  }
}

/**
 * The `serviceUpdate` pair (`serviceRepository.update(id, patch)`). Bind the STORED service's owning
 * account, and the account a patch would re-home the service INTO.
 *
 * `ServicePatch` may carry an `accountId`, and a service's account decides which org's catalog offers
 * it for mounting, so an unbound patch would let a caller push an attacker-authored frame into another
 * org's mountable set. An explicit null is refused rather than admitted: an account-less service is the
 * legacy/unscoped row, which no scoped token may create.
 */
export async function checkServiceUpdateScope(
  serviceId: unknown,
  patch: unknown,
  opts: DispatchOptions,
  inScope: (accountId: string | null | undefined) => boolean,
  denied: DispatchResult,
): Promise<DispatchResult | undefined> {
  if (typeof serviceId !== 'string' || !opts.resolveServiceAccountIds) return denied
  const stored = await opts.resolveServiceAccountIds([serviceId])
  if (!inScope(stored.get(serviceId))) return denied
  if (!patch || typeof patch !== 'object') return denied
  if (!Object.hasOwn(patch, 'accountId')) return undefined
  const { accountId } = patch as { accountId?: unknown }
  return typeof accountId === 'string' && inScope(accountId) ? undefined : denied
}

/**
 * The `installationUpsert` record write (App connect / PAT connect). Bind the connector
 * `workspaceId`, the DECLARED `accountId` when the row carries one, and the STORED row's owner.
 *
 * The stored half is the one that is not optional. The write conflicts on `installationId` alone, so
 * naming another org's installation id would repoint its binding at a board the caller controls — the
 * account-takeover `GitHubInstallationService.connect` refuses in the service layer this RPC bypasses.
 * The declared-account half closes the mirror image: an installation row is shared with every board of
 * the account it names, so stamping a foreign account hands that org this connection's credentials.
 */
export async function checkInstallationUpsertScope(
  record: unknown,
  opts: DispatchOptions,
  inScope: (accountId: string | null | undefined) => boolean,
  denied: DispatchResult,
): Promise<DispatchResult | undefined> {
  if (!record || typeof record !== 'object') return denied
  const { workspaceId, accountId, installationId } = record as {
    workspaceId?: unknown
    accountId?: unknown
    installationId?: unknown
  }
  if (typeof workspaceId !== 'string') return denied
  if (!inScope(await opts.resolveAccountId(workspaceId))) return denied
  // A PAT connection stores no account (it binds one board); an App connection stores the
  // connector workspace's, so anything else is a caller stamping an org it does not own.
  if (accountId != null && (typeof accountId !== 'string' || !inScope(accountId))) return denied
  if (typeof installationId !== 'number' || !opts.resolveInstallationOwner) return denied
  const stored = await opts.resolveInstallationOwner(installationId)
  switch (stored.status) {
    case 'found':
      return inScope(stored.accountId) ? undefined : denied
    case 'absent':
      // No binding yet: a connect, already bound by the two declared halves above.
      return undefined
    case 'unreadable':
      return denied
    default: {
      const _exhaustive: never = stored
      void _exhaustive
      return denied
    }
  }
}

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

/**
 * The `librarySource` kind: a repo-sourced content library's SYNC method carries a source id and
 * nothing else, so resolve that source row's owning `(ownerKind, ownerId)` pair server-side and bind
 * it exactly like `owner`. A non-string id, an absent resolver, and a source that does not exist all
 * fail closed — an id that cannot be bound must never reach the method, and 404 (not 403) matches the
 * existence-non-leak policy.
 */
export async function checkLibrarySourceScope(
  entity: LibrarySourceEntity,
  sourceId: unknown,
  opts: DispatchOptions,
  inScope: (accountId: string | null | undefined) => boolean,
  denied: DispatchResult,
): Promise<DispatchResult | undefined> {
  if (typeof sourceId !== 'string' || !opts.resolveLibrarySourceOwner) return denied
  const lookup = await opts.resolveLibrarySourceOwner(entity, sourceId)
  // Only a row that exists AND could be read binds this call: `absent` and `unreadable` both fail
  // closed here, since a sourceId-keyed method has nothing else to bind on.
  if (lookup.status !== 'found') return denied
  return checkOwnerPairScope(lookup.owner.ownerKind, lookup.owner.ownerId, opts, inScope, denied)
}

/**
 * The `ownerFieldUpsert` kind: bind an id-keyed `upsert(record)` on BOTH the owner the record
 * DECLARES and the owner of the row it would OVERWRITE. See the rule's entry on `ScopeRule` for why
 * the declared half alone is not enough.
 *
 * The stored half is decided by row EXISTENCE: an absent row is a CREATE, which the declared half has
 * already bound. A record with no usable conflict key cannot be bound to the row it would write, so it
 * is refused rather than admitted on the declared half alone.
 *
 * "The row does not exist" is therefore an ADMISSION, which is why the lookup answers three states
 * instead of a nullable owner: a table this deployment cannot read (`unreadable`) must not be spent
 * as that admission. Its `accountFieldUpsert` twin gets the same guarantee from selecting its
 * resolver through a `switch` over the entity with a `never` default.
 */
export async function checkOwnerFieldUpsertScope(
  entity: LibrarySourceEntity,
  record: unknown,
  opts: DispatchOptions,
  inScope: (accountId: string | null | undefined) => boolean,
  denied: DispatchResult,
): Promise<DispatchResult | undefined> {
  if (!record || typeof record !== 'object') return denied
  const { ownerKind, ownerId, id } = record as {
    ownerKind?: unknown
    ownerId?: unknown
    id?: unknown
  }
  // The declared half — identical to `ownerField`.
  const denialForDeclared = await checkOwnerPairScope(ownerKind, ownerId, opts, inScope, denied)
  if (denialForDeclared) return denialForDeclared
  if (typeof id !== 'string' || !opts.resolveLibrarySourceOwner) return denied
  // The stored half. A switch, not a truthiness test: the three lookup states have three different
  // dispositions, and adding a fourth must FAIL TO COMPILE here rather than fall through to the
  // admission that `absent` alone has earned.
  const stored = await opts.resolveLibrarySourceOwner(entity, id)
  switch (stored.status) {
    case 'found':
      // A row ⇒ its owner must be in scope too, or this write would overwrite another tenant's.
      return checkOwnerPairScope(
        stored.owner.ownerKind,
        stored.owner.ownerId,
        opts,
        inScope,
        denied,
      )
    case 'absent':
      // No row ⇒ a create, already bound by the declared half above.
      return undefined
    case 'unreadable':
      // Nothing is known about what this write would land on, so nothing may be admitted.
      return denied
    default: {
      const _exhaustive: never = stored
      void _exhaustive
      return denied
    }
  }
}
