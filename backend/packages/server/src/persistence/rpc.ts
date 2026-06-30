import { DomainError, type DomainErrorCode } from '@cat-factory/kernel'

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
export interface MutatedArg {
  arg: number
  rev: number
}

export type PersistenceRpcResponse =
  | { ok: true; value: unknown; undef?: boolean; mutated?: MutatedArg }
  | { ok: false; error: PersistenceRpcError }

/** A `DomainErrorCode` plus the transport-only codes the RPC layer itself can raise. */
export type PersistenceErrorCode = DomainErrorCode | 'forbidden' | 'unknown_method' | 'internal'

export interface PersistenceRpcError {
  code: PersistenceErrorCode
  message: string
  details?: Record<string, unknown>
}

/** Map an error code to the HTTP status the controller returns (and the client reads). */
export function statusForPersistenceError(code: PersistenceErrorCode): number {
  switch (code) {
    case 'not_found':
      return 404
    case 'validation':
      return 422
    case 'conflict':
      return 409
    case 'credential_required':
      return 428
    case 'forbidden':
      return 403
    case 'unknown_method':
      return 400
    case 'internal':
      return 500
  }
}

// ---------------------------------------------------------------------------
// Scope + allow-list table
// ---------------------------------------------------------------------------

/**
 * How a method's call is bound to an account so the dispatcher can reject anything outside
 * the machine token's `scope.accountIds` (a 404, matching the auth gate's non-leak policy):
 *   - `workspace`     — `args[arg]` is a workspaceId; resolve its owning account.
 *   - `account`       — `args[arg]` IS an accountId.
 *   - `accountField`  — `args[arg][field]` is an accountId (e.g. a `Membership.accountId`).
 *   - `accountList`   — `args[arg]` is `string[]` of accountIds; ALL must be in scope.
 *   - `selfUser`      — `args[arg]` is a userId; must equal the token's `userId`.
 *   - `visibility`    — `args[arg]` is a `WorkspaceVisibility`; intersected with the token
 *                       scope so a node can never widen its own visibility.
 */
export type ScopeRule =
  | { kind: 'workspace'; arg: number }
  | { kind: 'account'; arg: number }
  | { kind: 'accountField'; arg: number; field: string }
  | { kind: 'accountList'; arg: number }
  | { kind: 'selfUser'; arg: number }
  | { kind: 'visibility'; arg: number }

export interface MethodSpec {
  scope: ScopeRule
  /** The argument index whose `rev` the server mutates in place and must echo back. */
  revWriteBack?: number
}

/** repo → method → spec. A method absent here is NOT remotely invocable (default-deny). */
export type PersistenceMethodTable = Record<string, Record<string, MethodSpec>>

/**
 * The pilot allow-list: the six core domain repositories needed to load a board and start
 * an execution. Cross-service reads (`listByService`/`findById`), global sweeper methods
 * (`listStale`), and high-impact unscoped ops (`workspaceRepository.delete`,
 * `accountRepository.create`) are deliberately EXCLUDED — they are added (with their own
 * scope rules) in later slices, or stay mothership-internal. See the initiative tracker.
 *
 * Admin-gated mutations are also EXCLUDED here. The RPC dispatches over the raw repository,
 * bypassing the service layer that normally enforces per-user role checks — e.g.
 * `AccountService.requireAdmin` guards `accountRepository.rename`/`updateSettings` and
 * `membershipRepository.upsert`/`remove`. A machine token is scoped to whole ACCOUNTS, not to
 * a role within them, so exposing those repo methods would let any account member self-promote
 * to admin or rewrite memberships over the wire. They stay mothership-internal until a later
 * slice adds a role dimension to the scope (or routes them through the service). Only the
 * account/membership READS a board load needs are remotely callable. Board-level mutations
 * (`workspaceRepository.rename`/`setDescription`, block/pipeline/execution CRUD) are
 * member-level in the service layer, so they remain.
 */
export const PILOT_PERSISTENCE_METHODS: PersistenceMethodTable = {
  workspaceRepository: {
    listVisible: { scope: { kind: 'visibility', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    ownerOf: { scope: { kind: 'workspace', arg: 0 } },
    accountOf: { scope: { kind: 'workspace', arg: 0 } },
    rename: { scope: { kind: 'workspace', arg: 0 } },
    setDescription: { scope: { kind: 'workspace', arg: 0 } },
  },
  blockRepository: {
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    insert: { scope: { kind: 'workspace', arg: 0 } },
    update: { scope: { kind: 'workspace', arg: 0 } },
    setService: { scope: { kind: 'workspace', arg: 0 } },
    deleteMany: { scope: { kind: 'workspace', arg: 0 } },
  },
  pipelineRepository: {
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    insert: { scope: { kind: 'workspace', arg: 0 } },
    update: { scope: { kind: 'workspace', arg: 0 } },
    delete: { scope: { kind: 'workspace', arg: 0 } },
  },
  executionRepository: {
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    getByBlock: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspace', arg: 0 }, revWriteBack: 1 },
    compareAndSwap: { scope: { kind: 'workspace', arg: 0 }, revWriteBack: 1 },
    deleteByBlock: { scope: { kind: 'workspace', arg: 0 } },
    markFailed: { scope: { kind: 'workspace', arg: 0 } },
  },
  accountRepository: {
    // Reads only — `rename`/`updateSettings` are admin-gated (see allow-list note above).
    get: { scope: { kind: 'account', arg: 0 } },
    listByIds: { scope: { kind: 'accountList', arg: 0 } },
    findPersonalByUser: { scope: { kind: 'selfUser', arg: 0 } },
  },
  membershipRepository: {
    // Reads only — `upsert`/`remove` are admin-gated (see allow-list note above).
    listByUser: { scope: { kind: 'selfUser', arg: 0 } },
    listByAccount: { scope: { kind: 'account', arg: 0 } },
    get: { scope: { kind: 'account', arg: 0 } },
  },
}

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
  /** The method table to enforce (defaults to the pilot set). */
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
  ownerUserId: string
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
  const table = opts.table ?? PILOT_PERSISTENCE_METHODS
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

  // Bind the call to an account and reject anything outside the token scope (404).
  const denied = fail('not_found', 'Not found')
  const rule = spec.scope
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
    case 'account': {
      if (!inScope(args[rule.arg] as string)) return denied
      break
    }
    case 'accountField': {
      const obj = args[rule.arg] as Record<string, unknown> | undefined
      if (!obj || !inScope(obj[rule.field] as string)) return denied
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
      args[rule.arg] = { accountIds, ownerUserId: opts.scope.userId } satisfies VisibilityScope
      break
    }
    default: {
      // Fail closed: a `ScopeRule` kind with no case above must NEVER reach the method
      // unscoped. The `never` binding makes adding a kind without a case a compile error,
      // and the `return denied` is the runtime backstop if one slips through anyway.
      const _exhaustive: never = rule
      void _exhaustive
      return denied
    }
  }

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
    // Opaque 500 — never leak an internal error's message over the machine API.
    return fail('internal', 'Internal error')
  }
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
  return new Error(error.message)
}
