import {
  DataIntegrityError,
  DomainError,
  type DomainErrorCode,
  dataIntegrityFaultOf,
  isDataIntegrityError,
  isDataIntegrityFault,
} from '@cat-factory/kernel'
import { REMOTE_PERSISTENCE_METHODS } from './rpc-allowlist.js'
import {
  checkLibrarySourceScope,
  checkOwnerFieldUpsertScope,
  checkOwnerPairScope,
  checkServiceMountScope,
  checkUsageRecordScope,
} from './rpc-scope.logic.js'

// The mothership-mode persistence RPC wire protocol.
//
// A mothership-mode local node has no main database: it runs the engine locally but
// every org/durable repository call is forwarded to the hosted mothership over ONE
// reflective endpoint (`POST /internal/persistence`). This module is the runtime-neutral
// heart of that spine — the wire envelope, the per-repo method allow-list + scope table,
// and the pure server-side dispatcher. Both the controller (server side) and the remote
// repository proxy (`remoteRepositories.ts`, client side) speak this protocol, and the
// cross-runtime conformance suite asserts a round-trip behaves identically to a direct
// Drizzle/D1 call.
//
// Three correctness traps the envelope is designed around (see the initiative doc):
//   - `undefined` vs `null` must round-trip (e.g. `WorkspaceRepository.accountOf` returns
//     `string | null | undefined`, and the auth gate branches on all three). JSON drops a
//     top-level `undefined`, so the envelope carries an explicit `undef` flag.
//   - `compareAndSwap`/`upsert` bump `execution.rev` IN PLACE on the caller's object. The
//     server mutates its copy; the response echoes the new `rev` (`mutated`) and the client
//     proxy writes it back onto the caller's instance, preserving the optimistic-concurrency
//     contract the engine relies on.
//   - `DomainError`s (`ConflictError`/`NotFoundError`/…) must survive the hop so CAS-retry /
//     404 control flow is preserved: the envelope carries the `code`/`message`/`details` and
//     the client re-throws a `DomainError`.

/** A single reflective persistence call. */
export interface PersistenceRpcRequest {
  repo: string
  method: string
  args: unknown[]
}

/** The new `rev` of an in-place-mutated argument (the `execution` of `upsert`/`compareAndSwap`). */
interface MutatedArg {
  arg: number
  rev: number
}

export type PersistenceRpcResponse =
  | { ok: true; value: unknown; undef?: boolean; mutated?: MutatedArg }
  | { ok: false; error: PersistenceRpcError }

/**
 * A `DomainErrorCode` plus the transport-only codes the RPC layer itself can raise.
 *
 * `data_integrity` is the one non-`DomainError` throw that may NOT be flattened into `internal`.
 * A mothership-mode node runs the engine with no database of its own, so the row decode that
 * recognises a poison run happens on the FAR side of this hop; relayed as an opaque 500 it arrives
 * as a plain `Error`, `isDataIntegrityError` answers false, and the disposal that exists to break
 * the immortal-run loop silently does nothing on exactly the deployment shape that cannot debug it.
 */
export type PersistenceErrorCode =
  | DomainErrorCode
  | 'forbidden'
  | 'unknown_method'
  | 'internal'
  | 'data_integrity'

export interface PersistenceRpcError {
  code: PersistenceErrorCode
  message: string
  details?: Record<string, unknown>
}

// The `Record<PersistenceErrorCode, …>` type keeps this exhaustive — a new error code fails `tsc`
// until it is mapped, exactly like the previous `switch` did.
const ERROR_STATUS: Record<PersistenceErrorCode, number> = {
  not_found: 404,
  validation: 422,
  conflict: 409,
  credential_required: 428,
  forbidden: 403,
  unavailable: 503,
  unauthorized: 401,
  rate_limited: 429,
  unknown_method: 400,
  internal: 500,
  // Internal data corruption, like `internal`: the status class is right and the code is what
  // carries the distinction the caller acts on.
  data_integrity: 500,
}

/** Map an error code to the HTTP status the controller returns (and the client reads). */
export function statusForPersistenceError(code: PersistenceErrorCode): number {
  return ERROR_STATUS[code]
}

// ---------------------------------------------------------------------------
// Scope + allow-list table
// ---------------------------------------------------------------------------

/**
 * How a method's call is bound to an account so the dispatcher can reject anything outside
 * the machine token's `scope.accountIds` (a 404, matching the auth gate's non-leak policy):
 *   - `workspace`     — `args[arg]` is a workspaceId; resolve its owning account.
 *   - `workspaceField`— `args[arg]` is a record with a `workspaceId` string field (an
 *                       `upsert(record)` whose scope key is a property of the record, not a
 *                       positional arg); resolve that workspace's owning account like `workspace`.
 *                       ONLY the top-level `workspaceId` is bound — sibling fields (e.g. a
 *                       record's `blockId`) are NOT scope-validated here, exactly as the raw repo
 *                       upsert doesn't cross-check them. That is safe because the row is stored
 *                       under (and later read by) the bound `workspaceId`, so a stray sibling id
 *                       only ever lands in the caller's own in-scope workspace; the service layer
 *                       (bypassed by the RPC) is where block-existence is enforced.
 *   - `account`       — `args[arg]` IS an accountId.
 *   - `accountField`  — `args[arg]` is a record with an `accountId` string field (an
 *                       `upsert(record)` whose scope key is a property of the record, not a
 *                       positional arg); the accountId IS the account, checked in scope directly
 *                       (the account-owned mirror of `workspaceField`). ONLY the top-level
 *                       `accountId` is bound — sibling fields are NOT scope-validated here, exactly
 *                       as the raw repo upsert doesn't cross-check them; the row is stored under (and
 *                       later read by) the bound `accountId`, so a stray sibling only ever lands in
 *                       the caller's own in-scope account.
 *   - `accountList`   — `args[arg]` is `string[]` of accountIds; ALL must be in scope.
 *   - `selfUser`      — `args[arg]` is a userId; must equal the token's `userId`.
 *   - `user`          — `args[arg]` is a userId whose DISPLAY record is being read; in scope iff
 *                       that user is a CO-MEMBER of one of the token's in-scope accounts (resolved
 *                       server-side from the account rosters). Unlike `selfUser` (which pins the
 *                       token's OWN id) this admits any teammate the caller shares an account with —
 *                       the member-roster display read. A user in no in-scope account (or an
 *                       unresolvable one) fails closed (404, no existence leak).
 *   - `userList`      — `args[arg]` is `string[]` of userIds (the batched roster enrichment); EVERY
 *                       requested user must be a co-member of an in-scope account, so a missing or
 *                       out-of-scope id fails closed — the batched form of `user`. Empty input is
 *                       allowed (it returns empty).
 *   - `visibility`    — `args[arg]` is a `WorkspaceVisibility`; intersected with the token
 *                       scope so a node can never widen its own visibility.
 *   - `block`         — `args[arg]` is a blockId with NO workspace arg; resolve the block's
 *                       owning account server-side (block → home workspace → account).
 *   - `blockList`     — `args[arg]` is `string[]` of blockIds; resolve each block's owning
 *                       account server-side (block → home workspace → account), like `block`
 *                       but batched. EVERY requested id must resolve to an in-scope account,
 *                       so a missing or out-of-scope block fails closed — exactly the outcome
 *                       the per-id `block` rule produced call by call. Empty input is allowed.
 *   - `serviceList`   — `args[arg]` is `string[]` of serviceIds; resolve each service's owning
 *                       account server-side (services are account-owned). EVERY requested id
 *                       must resolve to an in-scope account, so a missing or out-of-scope
 *                       service fails closed. Empty input is allowed (it returns empty).
 *   - `service`       — `args[arg]` is a single serviceId with NO workspace arg; resolve the
 *                       service's owning account server-side (services are account-owned), the
 *                       single-id form of `serviceList`. A missing/out-of-scope service fails
 *                       closed (404, no existence leak).
 *   - `serviceMount`  — `args[arg]` is a `WorkspaceMount` record (a `workspaceMountRepository.upsert`).
 *                       Binds on the mount's `workspaceId` FIELD like `workspaceField`, AND
 *                       ADDITIONALLY enforces the cross-org mount invariant server-side: the mounted
 *                       `serviceId` must be owned by the SAME account as the target workspace. This
 *                       makes "a service can only be mounted within its own organization" (which
 *                       `ServiceMountService.mount` enforces in the service layer) non-bypassable
 *                       over the raw RPC — a machine token that spans several accounts (a user who
 *                       belongs to multiple orgs) cannot plant a cross-org mount by upserting
 *                       directly. A non-object arg, a missing/non-string `workspaceId`/`serviceId`,
 *                       an out-of-scope workspace, or a service whose account differs from the
 *                       workspace's (incl. a missing service) is refused as 404.
 *   - `skillSource`   — `args[arg]` is a skill-SOURCE id (a `skill_sources` row) with no account
 *                       arg; resolve the source's owning account server-side. This is the rule the
 *                       repo-sourced Claude Skills library's sync surface needs: a source id is the
 *                       only key its reconcile/tombstone/pin methods carry, so nothing positional
 *                       binds them. A missing source (or no resolver wired) fails closed (404, no
 *                       existence leak), exactly like `block`/`service`.
 *   - `accountFieldUpsert`
 *                     — the UPSERT form of `accountField`, for a record-keyed write whose conflict
 *                       key is the record's `id` rather than its `accountId`. Binds BOTH the
 *                       declared account (`record.accountId`, exactly like `accountField`) AND — when
 *                       a row with `record.id` already EXISTS — that stored row's owning account,
 *                       resolved server-side by `entity`. An absent row is a CREATE and passes on the
 *                       declared half alone.
 *
 *                       The second half is the whole point. `accountField` is safe only under the
 *                       precondition stated in its own entry: the row is stored under, and later read
 *                       by, the bound `accountId`. An `ON CONFLICT (id) DO UPDATE` that does not
 *                       re-`SET account_id` breaks that precondition — the write lands on whichever
 *                       row already holds that id, under ITS account, not the caller's. A token scoped
 *                       to account A could then name account B's source id, declare `accountId: A` to
 *                       satisfy the field check, and repoint B's row at an attacker-controlled repo;
 *                       B's next sync would fold `SKILL.md` bodies — agent INSTRUCTIONS — from that
 *                       repo into B's catalog. Binding the stored row closes it.
 *
 *                       Prefer `accountField` whenever the write IS keyed by the tenant column (the
 *                       sibling `accountSkillRepository.upsert` conflicts on `(account_id, skill_id)`,
 *                       so a foreign id inserts under the caller's own account and can never mutate
 *                       another tenant's row). Reach for this rule only when the conflict key alone
 *                       decides which row is written.
 *   - `owner`         — `args[kindArg]`/`args[idArg]` are a tenant-library `(ownerKind, ownerId)`
 *                       PAIR (the prompt-fragment library, `ownerKind` ∈ `workspace` | `account`):
 *                       `workspace` → resolve the workspace's owning account (like `workspace`);
 *                       `account` → the ownerId IS an accountId (like `account`). Any other kind, a
 *                       non-string ownerId, or an unresolvable / out-of-scope owner fails closed (404).
 *   - `ownerField`    — `args[arg]` is a library record whose `(ownerKind, ownerId)` are FIELDS (an
 *                       `upsert(record)` whose owner is a property, not positional args). Binds on
 *                       those fields exactly like `owner`; a non-object arg / missing fields fail closed.
 *                       Safe only under the same precondition `accountField` states: the row is stored
 *                       under, and later read by, the bound owner. An id-keyed conflict breaks that, so
 *                       such a write takes `ownerFieldUpsert` below.
 *   - `librarySource` — `args[arg]` is a content-library SOURCE id (a `fragment_sources` /
 *                       `foundational_service_sources` row) with no owner arg; resolve that source's
 *                       owning `(ownerKind, ownerId)` PAIR server-side by `entity` and bind it exactly
 *                       like `owner`. This is what a repo-sourced library's SYNC surface needs: a
 *                       source id is the only key its reconcile / tombstone / pin methods carry, so
 *                       nothing positional binds them. The owner-pair analogue of `skillSource` (skills
 *                       live in ONE tier, so theirs resolves to a bare accountId). A missing source, an
 *                       unresolvable owner, or no resolver wired fails closed (404, no existence leak).
 *   - `ownerFieldUpsert`
 *                     — the UPSERT form of `ownerField`, and the owner-pair analogue of
 *                       `accountFieldUpsert`: for a record-keyed write whose conflict key is the
 *                       record's `id` rather than its owner columns. Binds BOTH the declared owner
 *                       (`record.ownerKind`/`record.ownerId`, exactly like `ownerField`) AND — when a
 *                       row with `record.id` already EXISTS — that stored row's owner pair, resolved
 *                       server-side by `entity`. An absent row is a CREATE and passes on the declared
 *                       half alone; a record with no usable `id` is refused rather than admitted on the
 *                       declared half. See `accountFieldUpsert` for the attack the stored half closes:
 *                       both source tables conflict on `id` alone and never re-`SET` their owner
 *                       columns, so binding only the declared owner would let a token scoped to one
 *                       tenant repoint another tenant's source at a repo it controls, whose Markdown
 *                       bodies the victim's next sync folds into their prompts as guidance.
 *   - `usageRecord`   — `args[arg]` is a `TokenUsageRecord` (the spend ledger's `record`). Binds on
 *                       the row's `workspaceId` FIELD like `workspaceField`, AND ADDITIONALLY pins
 *                       the two DENORMALIZED rollup keys the account- and user-tier budget reads
 *                       index on: `accountId` must be null or exactly the workspace's own owning
 *                       account, and `userId` must be null or the token's user. Without that, a node
 *                       legitimately scoped to one account could stamp ANOTHER account's (or
 *                       teammate's) id onto its ledger rows and exhaust their budget — pausing their
 *                       runs — without touching any workspace it isn't entitled to.
 */
export type ScopeRule =
  | { kind: 'workspace'; arg: number }
  | { kind: 'workspaceField'; arg: number }
  | { kind: 'account'; arg: number }
  | { kind: 'accountField'; arg: number }
  | { kind: 'accountList'; arg: number }
  | { kind: 'selfUser'; arg: number }
  | { kind: 'user'; arg: number }
  | { kind: 'userList'; arg: number }
  | { kind: 'visibility'; arg: number }
  | { kind: 'block'; arg: number }
  | { kind: 'blockList'; arg: number }
  | { kind: 'serviceList'; arg: number }
  | { kind: 'service'; arg: number }
  | { kind: 'serviceMount'; arg: number }
  | { kind: 'skillSource'; arg: number }
  // `entity` names the resolver that binds the STORED row. Skills live in ONE tier, so theirs is
  // the account-keyed form; a library owned by an `(ownerKind, ownerId)` PAIR takes
  // `ownerFieldUpsert` below instead. The exhaustive switch fails to compile until a member is
  // handled.
  | { kind: 'accountFieldUpsert'; arg: number; entity: 'skillSource' }
  | { kind: 'usageRecord'; arg: number }
  | { kind: 'owner'; kindArg: number; idArg: number }
  | { kind: 'ownerField'; arg: number }
  | { kind: 'librarySource'; arg: number; entity: LibrarySourceEntity }
  | { kind: 'ownerFieldUpsert'; arg: number; entity: LibrarySourceEntity }

/**
 * The owner-pair content-library SOURCE tables a `librarySource` / `ownerFieldUpsert` rule resolves
 * against. Each names one source repository, because a source id from one library is meaningless in
 * the other: the discriminator is what stops a fragment-source id being bound through the
 * foundational-service source table (which would resolve to nothing and, without it, would have to
 * fall back to trying both).
 */
export type LibrarySourceEntity = 'fragmentSource' | 'foundationalServiceSource'

/** A content-library source row's owning tier, as the scope check needs it. */
export interface LibrarySourceOwner {
  ownerKind: unknown
  ownerId: unknown
}

/**
 * What a {@link DispatchOptions.resolveLibrarySourceOwner} lookup ANSWERED, as three states rather
 * than a nullable owner.
 *
 * `absent` and `unreadable` are the same VALUE and opposite FACTS, and only `ownerFieldUpsert` can
 * tell them apart from the outside: it admits an absent row as a create (the declared half already
 * bound it) and must refuse an unreadable one, because a table it cannot read cannot say whose row
 * the write would land on. Collapsing the two into `null` is what made a deployment that wires a
 * source table's `upsert` without its `get` — or a library added with a rule and no resolver row —
 * silently drop the stored half and admit the cross-tenant repoint the rule exists to close.
 */
export type LibrarySourceOwnerLookup =
  | { status: 'found'; owner: LibrarySourceOwner }
  /** No such source row: for an id-keyed upsert this is a CREATE. */
  | { status: 'absent' }
  /** This deployment cannot read that source table at all, so nothing may be concluded. */
  | { status: 'unreadable' }

export interface MethodSpec {
  scope: ScopeRule
  /** The argument index whose `rev` the server mutates in place and must echo back. */
  revWriteBack?: number
}

/** repo → method → spec. A method absent here is NOT remotely invocable (default-deny). */
export type PersistenceMethodTable = Record<string, Record<string, MethodSpec>>
/**
 * The mothership-mode persistence allow-list (repo → method → {@link MethodSpec}), extracted to
 * {@link ./rpc-allowlist.js}: it is the initiative's living surface — every slice widens it —
 * while everything else in this file is the stable protocol. Re-exported here so the table's
 * long-standing import path is unchanged.
 */
export { REMOTE_PERSISTENCE_METHODS }

// ---------------------------------------------------------------------------
// Server-side dispatch
// ---------------------------------------------------------------------------

/** A repository registry the mothership reflects over: repo name → repo instance. */
export type PersistenceRegistry = Record<string, Record<string, (...args: unknown[]) => unknown>>

export interface DispatchOptions {
  registry: PersistenceRegistry
  /** The accounts the calling machine token is authorised for. */
  scope: { accountIds: string[]; userId: string }
  /** Resolve a workspace's owning account id (the mothership's `WorkspaceRepository.accountOf`). */
  resolveAccountId(workspaceId: string): Promise<string | null | undefined>
  /**
   * Resolve a block's owning account id (block → home workspace → account). Required for the
   * `block` scope kind; a call hitting that kind with no resolver fails closed (404).
   */
  resolveBlockAccountId?(blockId: string): Promise<string | null | undefined>
  /**
   * Resolve each requested block id's owning account id, keyed by block id (a block that does
   * not exist is absent from the map). Required for the `blockList` scope kind; a call hitting
   * that kind with no resolver fails closed (404).
   */
  resolveBlockAccountIds?(blockIds: string[]): Promise<Map<string, string | null | undefined>>
  /**
   * Resolve each requested service id's owning account id, keyed by service id (a service that
   * does not exist is absent from the map). Required for the `serviceList` scope kind; a call
   * hitting that kind with no resolver fails closed (404).
   */
  resolveServiceAccountIds?(serviceIds: string[]): Promise<Map<string, string | null | undefined>>
  /**
   * Resolve a skill source's owning account id (the mothership's `SkillSourceRepository.get`,
   * projected to its `accountId`). Required for the `skillSource` scope kind; a call hitting that
   * kind with no resolver fails closed (404), like the other entity resolvers.
   */
  resolveSkillSourceAccountId?(sourceId: string): Promise<string | null | undefined>
  /**
   * Resolve a content-library source's owning `(ownerKind, ownerId)` pair (the mothership's
   * `fragmentSourceRepository.get` / `foundationalServiceSourceRepository.get`, projected to the
   * owner columns). ONE resolver taking the table rather than one member per table: the two answer
   * the same question about the same shape, and a second near-identical option is how a new library
   * lands with a rule and no resolver. Required for the `librarySource` and `ownerFieldUpsert` scope
   * kinds; a call hitting either with no resolver fails closed (404), like the other entity
   * resolvers. Answers a {@link LibrarySourceOwnerLookup} rather than a nullable owner so that "no
   * such row" stays distinguishable from "that table is not readable here".
   */
  resolveLibrarySourceOwner?(
    entity: LibrarySourceEntity,
    sourceId: string,
  ): Promise<LibrarySourceOwnerLookup>
  /**
   * Resolve the member userIds of an account (the mothership's `MembershipRepository.listByAccount`,
   * mapped to `userId`s). Required for the `user`/`userList` scope kinds: a requested user is in
   * scope iff they are a co-member of one of the token's in-scope accounts. A call hitting those
   * kinds with no resolver fails closed (404), like the other entity resolvers.
   */
  resolveAccountMemberIds?(accountId: string): Promise<string[]>
  /** The method table to enforce (defaults to the full remote allow-list). */
  table?: PersistenceMethodTable
}

/** The dispatcher's result: an HTTP status plus the wire envelope to relay verbatim. */
export interface DispatchResult {
  status: number
  body: PersistenceRpcResponse
}

const fail = (
  code: PersistenceErrorCode,
  message: string,
  details?: Record<string, unknown>,
): DispatchResult => ({
  status: statusForPersistenceError(code),
  body: { ok: false, error: { code, message, ...(details ? { details } : {}) } },
})

interface VisibilityScope {
  accountIds: string[]
  adminAccountIds: string[]
  ownerUserId: string
  userId: string
}

/**
 * Enforce the allow-list + scope for one call, invoke the method, and build the wire
 * envelope. Pure except for the injected `registry`/`resolveAccountId` IO. A scope
 * violation is reported as 404 (not 403) to match the auth gate's existence-non-leak
 * policy. `DomainError`s thrown by the repository are serialised faithfully; any other
 * throw becomes an opaque 500 (its message suppressed, like the facade error handler).
 */
export async function dispatchPersistenceCall(
  request: PersistenceRpcRequest,
  opts: DispatchOptions,
): Promise<DispatchResult> {
  const table = opts.table ?? REMOTE_PERSISTENCE_METHODS
  // Own-property lookups only: `request.repo`/`request.method` are attacker-controlled, so a
  // bracket access could otherwise resolve an inherited member (`__proto__`, `constructor`,
  // `toString`) to a truthy non-spec value, slip past the `if (!spec)` guard, and crash on
  // `spec.scope` below. `Object.hasOwn` confines the table to its own keys.
  const repoTable = Object.hasOwn(table, request.repo) ? table[request.repo] : undefined
  const spec =
    repoTable && Object.hasOwn(repoTable, request.method) ? repoTable[request.method] : undefined
  if (!spec) {
    return fail('unknown_method', `Method '${request.repo}.${request.method}' is not callable`)
  }
  const repo = opts.registry[request.repo]
  const fn = repo?.[request.method]
  if (typeof fn !== 'function') {
    return fail('unknown_method', `Repository '${request.repo}.${request.method}' is not wired`)
  }
  const args = Array.isArray(request.args) ? [...request.args] : []
  const inScope = (accountId: string | null | undefined): boolean =>
    typeof accountId === 'string' && opts.scope.accountIds.includes(accountId)

  // The set of userIds the token may see the DISPLAY record of: every member of an in-scope
  // account. Computed at most once per dispatch (lazy) and bounded by the token's account scope
  // (not by request data), so it is a fixed-size read, not an N+1 over the requested user list.
  let visibleUsers: Promise<Set<string>> | undefined
  const visibleUserIds = (): Promise<Set<string>> => {
    if (!visibleUsers) {
      visibleUsers = (async () => {
        const set = new Set<string>()
        for (const accountId of opts.scope.accountIds) {
          const members = (await opts.resolveAccountMemberIds?.(accountId)) ?? []
          for (const userId of members) set.add(userId)
        }
        return set
      })()
    }
    return visibleUsers
  }

  // Bind the call to an account and reject anything outside the token scope (404).
  const scopeDenial = await checkCallScope(spec.scope, args, opts, { inScope, visibleUserIds })
  if (scopeDenial) return scopeDenial

  try {
    const value = await fn.apply(repo, args)
    const body: PersistenceRpcResponse = {
      ok: true,
      value: value === undefined ? null : value,
      ...(value === undefined ? { undef: true } : {}),
    }
    if (spec.revWriteBack !== undefined) {
      const mutated = args[spec.revWriteBack] as { rev?: unknown } | undefined
      if (mutated && typeof mutated.rev === 'number') {
        body.mutated = { arg: spec.revWriteBack, rev: mutated.rev }
      }
    }
    return { status: 200, body }
  } catch (err) {
    if (err instanceof DomainError) {
      return fail(err.code, err.message, err.details)
    }
    // A row the mothership cannot decode survives the hop with its FAULT, because that fault is
    // what the node's engine branches on to dispose of a poison run. Reported rather than
    // suppressed for the same reason `DomainError`s are: the message and context describe a row in
    // the caller's OWN scope (already checked above), which this RPC hands over wholesale anyway,
    // so there is nothing here the caller could not have read from the row itself.
    if (isDataIntegrityError(err)) {
      return fail('data_integrity', err.message, {
        fault: dataIntegrityFaultOf(err),
        // Nested, so a context key of its own can never shadow the fault above.
        context: err.context ?? {},
      })
    }
    // Opaque 500 — never leak an internal error's message over the machine API.
    return fail('internal', 'Internal error')
  }
}

/**
 * Enforce a call's scope rule: bind it to an account and reject anything outside the token scope.
 * Returns a `DispatchResult` (always a 404 `denied` — the existence-non-leak policy) when the call
 * is out of scope, or `undefined` when it passes and the method may run. The `visibility` kind
 * additionally narrows `args[rule.arg]` in place (the array is shared with the caller). Pure except
 * for the injected `opts` resolver IO + the two closures (`inScope` / lazy `visibleUserIds`).
 */
async function checkCallScope(
  rule: ScopeRule,
  args: unknown[],
  opts: DispatchOptions,
  helpers: {
    inScope: (accountId: string | null | undefined) => boolean
    visibleUserIds: () => Promise<Set<string>>
  },
): Promise<DispatchResult | undefined> {
  const { inScope } = helpers
  const denied = fail('not_found', 'Not found')
  switch (rule.kind) {
    case 'workspace': {
      // Bind via the workspace's owning account. A workspace that does not exist (or whose
      // account can't be resolved) cannot be scope-checked, so it is refused as 404 — a read
      // that would have returned null/undefined directly becomes a not-found over the machine
      // API. That is the safe choice (no existence leak) and matches the auth gate's policy.
      const workspaceId = args[rule.arg]
      if (typeof workspaceId !== 'string') return denied
      if (!inScope(await opts.resolveAccountId(workspaceId))) return denied
      break
    }
    case 'workspaceField': {
      // The scope key is a `workspaceId` FIELD of the record arg (an `upsert(record)` whose
      // workspaceId is a property, not a positional arg). Bind via that workspace's owning
      // account exactly like `workspace`. A non-object arg, a missing/non-string field, or an
      // unresolvable workspace is refused as 404 — the write targets exactly `record.workspaceId`,
      // so binding on it means the record can only be persisted into an in-scope workspace.
      const record = args[rule.arg]
      const workspaceId =
        record && typeof record === 'object'
          ? (record as { workspaceId?: unknown }).workspaceId
          : undefined
      if (typeof workspaceId !== 'string') return denied
      if (!inScope(await opts.resolveAccountId(workspaceId))) return denied
      break
    }
    case 'account': {
      if (!inScope(args[rule.arg] as string)) return denied
      break
    }
    case 'accountField': {
      // The scope key is an `accountId` FIELD of the record arg (an `upsert(record)` whose
      // accountId is a property, not a positional arg). The accountId IS the account, so it is
      // checked in scope directly — the account-owned mirror of `workspaceField`. A non-object
      // arg or a missing/non-string field is refused as 404; the write targets exactly
      // `record.accountId`, so binding on it means the record can only land in an in-scope account.
      const record = args[rule.arg]
      const accountId =
        record && typeof record === 'object'
          ? (record as { accountId?: unknown }).accountId
          : undefined
      if (typeof accountId !== 'string') return denied
      if (!inScope(accountId)) return denied
      break
    }
    case 'accountList': {
      const ids = args[rule.arg]
      if (!Array.isArray(ids) || !ids.every((id) => inScope(id as string))) return denied
      break
    }
    case 'selfUser': {
      if (args[rule.arg] !== opts.scope.userId) return denied
      break
    }
    case 'visibility': {
      // Never let a node widen its visibility: intersect the requested accountIds with the
      // token scope, and pin the owner to the token user. A `null` (auth-disabled) scope is
      // refused — mothership mode is always scoped.
      const requested = args[rule.arg] as VisibilityScope | null
      if (!requested || typeof requested !== 'object') return denied
      const accountIds = (requested.accountIds ?? []).filter((id) => inScope(id))
      const adminAccountIds = (requested.adminAccountIds ?? []).filter((id) => inScope(id))
      args[rule.arg] = {
        accountIds,
        adminAccountIds,
        ownerUserId: opts.scope.userId,
        userId: opts.scope.userId,
      } satisfies VisibilityScope
      break
    }
    default:
      // The entity-resolver kinds (user/block/service/owner families) bind via a server-side
      // account resolver; they are split out to keep each function under the complexity ceiling.
      return checkEntityCallScope(rule, args, opts, helpers)
  }

  // In scope: let the method run.
  return undefined
}

/**
 * The batched list half of {@link checkEntityCallScope}: the scope kinds that bind a WHOLE list of
 * ids (users / blocks / services), each of which must resolve to an in-scope account. Same contract
 * — a `DispatchResult` (404 `denied`) when out of scope, `undefined` when it passes (an empty list
 * is a no-op read). Split out purely to keep each function under the complexity ceiling; the `never`
 * default keeps the switches jointly exhaustive over `ScopeRule`.
 */
async function checkEntityListCallScope(
  rule: Extract<ScopeRule, { kind: 'userList' | 'blockList' | 'serviceList' }>,
  args: unknown[],
  opts: DispatchOptions,
  helpers: {
    inScope: (accountId: string | null | undefined) => boolean
    visibleUserIds: () => Promise<Set<string>>
  },
): Promise<DispatchResult | undefined> {
  const { inScope, visibleUserIds } = helpers
  const denied = fail('not_found', 'Not found')
  switch (rule.kind) {
    case 'userList': {
      // The batched roster enrichment: EVERY requested user must be a co-member of an in-scope
      // account (the batched form of `user`), so a missing or out-of-scope id fails closed. An
      // empty list is a no-op read (returns empty), so it needs no roster to scope.
      const ids = args[rule.arg]
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) return denied
      if (ids.length === 0) break
      if (!opts.resolveAccountMemberIds) return denied
      const visible = await visibleUserIds()
      for (const id of ids as string[]) {
        if (!visible.has(id)) return denied
      }
      break
    }
    case 'blockList': {
      // Bind via every requested block's owning account (block → home workspace → account),
      // the batched form of `block`. EVERY id must resolve to an in-scope account; a missing
      // or out-of-scope block fails closed — the same outcome the per-id `block` rule produced
      // call by call. An empty list is a no-op read (it returns empty).
      const ids = args[rule.arg]
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) return denied
      if (ids.length === 0) break
      if (!opts.resolveBlockAccountIds) return denied
      const accounts = await opts.resolveBlockAccountIds(ids as string[])
      for (const id of ids as string[]) {
        if (!inScope(accounts.get(id))) return denied
      }
      break
    }
    case 'serviceList': {
      // Bind via every requested service's owning account (services are account-owned). EVERY id
      // must resolve to an in-scope account; a missing or out-of-scope service fails closed. An
      // empty list is a no-op read (it returns empty), so it needs no service to scope.
      const ids = args[rule.arg]
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) return denied
      if (ids.length === 0) break
      if (!opts.resolveServiceAccountIds) return denied
      const accounts = await opts.resolveServiceAccountIds(ids as string[])
      for (const id of ids as string[]) {
        if (!inScope(accounts.get(id))) return denied
      }
      break
    }
    default: {
      // Fail closed: a list kind with no case here must never reach the method unscoped. The
      // `never` binding makes adding a list kind without a case a compile error.
      const _exhaustive: never = rule
      void _exhaustive
      return denied
    }
  }

  // In scope: let the method run.
  return undefined
}

/**
 * The single-ENTITY-ID half of {@link checkEntityCallScope}: the kinds whose argument is one opaque
 * id belonging to an account, bound through a server-side resolver because the call carries no
 * workspace/account of its own. Same contract — a `DispatchResult` (404 `denied`) when out of
 * scope, `undefined` when it passes. A missing entity, or an absent resolver, fails CLOSED in every
 * case: an id that cannot be bound must never reach the method, and 404 (not 403) matches the auth
 * gate's existence-non-leak policy. Split out purely to keep each function under the complexity
 * ceiling; the `never` default keeps the switches jointly exhaustive over `ScopeRule`.
 */
async function checkEntityIdCallScope(
  rule: Extract<ScopeRule, { kind: 'block' | 'service' | 'skillSource' }>,
  args: unknown[],
  opts: DispatchOptions,
  inScope: (accountId: string | null | undefined) => boolean,
): Promise<DispatchResult | undefined> {
  const denied = fail('not_found', 'Not found')
  const id = args[rule.arg]
  if (typeof id !== 'string') return denied
  switch (rule.kind) {
    case 'block': {
      // The block's home workspace's account (the block carries no workspace arg).
      if (!opts.resolveBlockAccountId) return denied
      if (!inScope(await opts.resolveBlockAccountId(id))) return denied
      break
    }
    case 'service': {
      // The service's owning account (services are account-owned) — the single-id form of
      // `serviceList`, reusing the same resolver. A missing service is absent from the map.
      if (!opts.resolveServiceAccountIds) return denied
      if (!inScope((await opts.resolveServiceAccountIds([id])).get(id))) return denied
      break
    }
    case 'skillSource': {
      // The skill source's owning account. The library's sync methods carry a source id and
      // nothing else, so this resolver is the only thing that can bind them.
      if (!opts.resolveSkillSourceAccountId) return denied
      if (!inScope(await opts.resolveSkillSourceAccountId(id))) return denied
      break
    }
    default: {
      const _exhaustive: never = rule
      void _exhaustive
      return denied
    }
  }
  return undefined
}

/**
 * The `accountFieldUpsert` check: bind an id-keyed `upsert(record)` on BOTH the account the record
 * DECLARES and the account that owns the row it would OVERWRITE. See the `accountFieldUpsert` entry
 * on {@link ScopeRule} for why the declared half alone is not enough.
 *
 * The stored half is decided by row EXISTENCE: the resolver yields the row's `accountId`, and yields
 * null/undefined exactly when no such row exists — `skill_sources.account_id` is NOT NULL on both
 * runtimes, so there is no third state where a row exists but cannot be bound. An absent row is a
 * CREATE, which the declared half has already bound. An absent RESOLVER still fails closed, like
 * every other entity-resolved kind.
 */
async function checkAccountFieldUpsertScope(
  rule: Extract<ScopeRule, { kind: 'accountFieldUpsert' }>,
  args: unknown[],
  opts: DispatchOptions,
  inScope: (accountId: string | null | undefined) => boolean,
): Promise<DispatchResult | undefined> {
  const denied = fail('not_found', 'Not found')
  const record = args[rule.arg]
  if (!record || typeof record !== 'object') return denied
  const { accountId, id } = record as { accountId?: unknown; id?: unknown }
  // The declared half — identical to `accountField`.
  if (typeof accountId !== 'string' || !inScope(accountId)) return denied
  // The stored half. A record with no usable conflict key cannot be bound to the row it would
  // write, so it is refused rather than allowed through on the declared half alone.
  if (typeof id !== 'string') return denied
  // A switch, not a ternary: adding an `entity` member must FAIL TO COMPILE here rather than fall
  // through to a silent `undefined` that reads as "no resolver wired" and denies every write.
  let resolveStoredAccountId: DispatchOptions['resolveSkillSourceAccountId']
  switch (rule.entity) {
    case 'skillSource':
      resolveStoredAccountId = opts.resolveSkillSourceAccountId
      break
    default: {
      const _exhaustive: never = rule.entity
      void _exhaustive
      return denied
    }
  }
  if (!resolveStoredAccountId) return denied
  const stored = await resolveStoredAccountId(id)
  // No row ⇒ a create, already bound above. A row ⇒ its owner must be in scope too.
  if (stored != null && !inScope(stored)) return denied
  return undefined
}

/**
 * The entity-resolver half of {@link checkCallScope}: the scope kinds that bind a call via a
 * server-side account resolver (co-membership for users, block/service/skill-source ownership,
 * tenant-library owner pairs). Same contract — a `DispatchResult` (404 `denied`) when out of scope,
 * `undefined` when it passes. Split from the core kinds purely to keep each function under the
 * complexity ceiling; the `never` default keeps the switches jointly exhaustive over `ScopeRule`.
 */
async function checkEntityCallScope(
  rule: Extract<
    ScopeRule,
    {
      kind:
        | 'user'
        | 'userList'
        | 'block'
        | 'blockList'
        | 'service'
        | 'serviceList'
        | 'serviceMount'
        | 'skillSource'
        | 'accountFieldUpsert'
        | 'usageRecord'
        | 'owner'
        | 'ownerField'
        | 'librarySource'
        | 'ownerFieldUpsert'
    }
  >,
  args: unknown[],
  opts: DispatchOptions,
  helpers: {
    inScope: (accountId: string | null | undefined) => boolean
    visibleUserIds: () => Promise<Set<string>>
  },
): Promise<DispatchResult | undefined> {
  const { inScope, visibleUserIds } = helpers
  const denied = fail('not_found', 'Not found')
  switch (rule.kind) {
    case 'user': {
      // Bind via co-membership: the target user's DISPLAY record is readable iff they are a member
      // of one of the token's in-scope accounts. No resolver wired ⇒ fail closed (404), like the
      // other entity resolvers. A user in no in-scope account is refused (no existence leak).
      const userId = args[rule.arg]
      if (typeof userId !== 'string' || !opts.resolveAccountMemberIds) return denied
      if (!(await visibleUserIds()).has(userId)) return denied
      break
    }
    case 'userList':
    case 'blockList':
    case 'serviceList':
      // The batched list-scope kinds (each id must resolve in scope) are split out to keep this
      // function under the complexity ceiling; same contract (404 `denied` / `undefined`).
      return checkEntityListCallScope(rule, args, opts, helpers)
    case 'block':
    case 'service':
    case 'skillSource':
      // The single-ENTITY-ID kinds (an opaque id bound through a server-side account resolver) are
      // split out to keep this function under the complexity ceiling; same contract.
      return checkEntityIdCallScope(rule, args, opts, inScope)
    case 'accountFieldUpsert':
      // Binds the record's DECLARED account and the STORED row's account together; see the rule's
      // entry on `ScopeRule` for why the declared half alone is not enough.
      return checkAccountFieldUpsertScope(rule, args, opts, inScope)
    case 'serviceMount': {
      const denialForMount = await checkServiceMountScope(args[rule.arg], opts, inScope, denied)
      if (denialForMount) return denialForMount
      break
    }
    case 'usageRecord': {
      const denialForUsage = await checkUsageRecordScope(args[rule.arg], opts, inScope, denied)
      if (denialForUsage) return denialForUsage
      break
    }
    case 'owner': {
      // A tenant-library row keyed by an (ownerKind, ownerId) PAIR. Resolve the owning account
      // server-side and reject anything outside the token scope (404, no existence leak):
      //   - 'workspace' → the ownerId is a workspaceId; resolve its owning account (like `workspace`).
      //   - 'account'   → the ownerId IS an accountId (like `account`).
      // Any other kind, a non-string ownerId, or an unresolvable/out-of-scope owner fails closed.
      const denialForOwner = await checkOwnerPairScope(
        args[rule.kindArg],
        args[rule.idArg],
        opts,
        inScope,
        denied,
      )
      if (denialForOwner) return denialForOwner
      break
    }
    case 'ownerField': {
      // The record-based library `upsert(record)` whose (ownerKind, ownerId) are FIELDS of the
      // record, not positional args. Bind on those fields exactly like `owner` — a non-object arg,
      // a missing/non-string field, or an unresolvable/out-of-scope owner is refused as 404, so the
      // row can only ever be persisted under the caller's own in-scope owner.
      const record = args[rule.arg]
      const isObj = record && typeof record === 'object'
      const denialForOwnerField = await checkOwnerPairScope(
        isObj ? (record as { ownerKind?: unknown }).ownerKind : undefined,
        isObj ? (record as { ownerId?: unknown }).ownerId : undefined,
        opts,
        inScope,
        denied,
      )
      if (denialForOwnerField) return denialForOwnerField
      break
    }
    case 'librarySource': {
      // A repo-sourced library's sync method carries only a source id; resolve that source's owning
      // tier PAIR server-side and bind it like `owner` (the owner-pair analogue of `skillSource`).
      const denialForSource = await checkLibrarySourceScope(
        rule.entity,
        args[rule.arg],
        opts,
        inScope,
        denied,
      )
      if (denialForSource) return denialForSource
      break
    }
    case 'ownerFieldUpsert': {
      // Binds the record's DECLARED owner and the STORED row's owner together; see the rule's entry
      // on `ScopeRule` for why the declared half alone is not enough.
      const denialForUpsert = await checkOwnerFieldUpsertScope(
        rule.entity,
        args[rule.arg],
        opts,
        inScope,
        denied,
      )
      if (denialForUpsert) return denialForUpsert
      break
    }
    default: {
      // Fail closed: a `ScopeRule` kind with no case in EITHER switch must NEVER reach the method
      // unscoped. The `never` binding makes adding a kind without a case a compile error.
      const _exhaustive: never = rule
      void _exhaustive
      return denied
    }
  }

  // In scope: let the method run.
  return undefined
}

/** Reconstruct the thrown error from an error envelope (client side). */
export function persistenceErrorToThrowable(error: PersistenceRpcError): Error {
  const domainCodes: DomainErrorCode[] = [
    'not_found',
    'validation',
    'conflict',
    'credential_required',
  ]
  if ((domainCodes as string[]).includes(error.code)) {
    return new DomainError(error.code as DomainErrorCode, error.message, error.details)
  }
  // Rebuilt as the real class, so a mothership-mode node's engine recognises a poison row exactly
  // as a direct-database one does. The fault is decoded through kernel's own predicate: a value
  // this build does not know falls back to `unrecognized_value`, i.e. the reading node declines to
  // destroy a run on a vocabulary it does not share with the mothership.
  if (error.code === 'data_integrity') {
    const details = error.details ?? {}
    const context = details.context
    return new DataIntegrityError(
      error.message,
      context && typeof context === 'object' ? (context as Record<string, unknown>) : {},
      isDataIntegrityFault(details.fault) ? details.fault : 'unrecognized_value',
    )
  }
  return new Error(error.message)
}
