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

// The `Record<PersistenceErrorCode, …>` type keeps this exhaustive — a new error code fails `tsc`
// until it is mapped, exactly like the previous `switch` did.
const ERROR_STATUS: Record<PersistenceErrorCode, number> = {
  not_found: 404,
  validation: 422,
  conflict: 409,
  credential_required: 428,
  forbidden: 403,
  unknown_method: 400,
  internal: 500,
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
 *   - `account`       — `args[arg]` IS an accountId.
 *   - `accountList`   — `args[arg]` is `string[]` of accountIds; ALL must be in scope.
 *   - `selfUser`      — `args[arg]` is a userId; must equal the token's `userId`.
 *   - `visibility`    — `args[arg]` is a `WorkspaceVisibility`; intersected with the token
 *                       scope so a node can never widen its own visibility.
 *   - `block`         — `args[arg]` is a blockId with NO workspace arg; resolve the block's
 *                       owning account server-side (block → home workspace → account).
 *   - `serviceList`   — `args[arg]` is `string[]` of serviceIds; resolve each service's owning
 *                       account server-side (services are account-owned). EVERY requested id
 *                       must resolve to an in-scope account, so a missing or out-of-scope
 *                       service fails closed. Empty input is allowed (it returns empty).
 */
export type ScopeRule =
  | { kind: 'workspace'; arg: number }
  | { kind: 'account'; arg: number }
  | { kind: 'accountList'; arg: number }
  | { kind: 'selfUser'; arg: number }
  | { kind: 'visibility'; arg: number }
  | { kind: 'block'; arg: number }
  | { kind: 'serviceList'; arg: number }

export interface MethodSpec {
  scope: ScopeRule
  /** The argument index whose `rev` the server mutates in place and must echo back. */
  revWriteBack?: number
}

/** repo → method → spec. A method absent here is NOT remotely invocable (default-deny). */
export type PersistenceMethodTable = Record<string, Record<string, MethodSpec>>

/**
 * The mothership-mode persistence allow-list: the core domain repositories plus the
 * workspace-scoped reads a board load (`GET /workspaces/:id`) and an execution exercise.
 * Every method here binds to an account via its {@link ScopeRule} so a call outside the
 * machine token's scope is refused as 404.
 *
 * The cross-service board-composition reads keyed on `serviceIds[]`/`accountId`
 * (`listByServices`, `serviceRepository.listByIds`/`listByAccount`, `countByServiceIds`) and the
 * entity-id-keyed `blockRepository.findById` are allow-listed here too, each bound by the
 * {@link ScopeRule} `serviceList` / `block` / `account` kinds that resolve the entity's owning
 * account server-side before the scope check.
 *
 * Still EXCLUDED (added in later gate slices, with their own scope rules, or kept
 * mothership-internal):
 *   - `subscriptionActivationRepository.deleteByExecution` — the activation row is the local
 *     `node:sqlite` bucket (per the per-repo checklist), not the remote surface, so it is not
 *     exposed here.
 *   - Global sweeper methods (`listStale`, `deleteOlderThan`) and high-impact unscoped ops
 *     (`workspaceRepository.delete`, `accountRepository.create`).
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
export const REMOTE_PERSISTENCE_METHODS: PersistenceMethodTable = {
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
    // Entity-id-keyed (no workspace arg): resolve the block's home workspace's account server-side.
    findById: { scope: { kind: 'block', arg: 0 } },
    // Cross-service: compose a board's blocks from every service it mounts.
    listByServices: { scope: { kind: 'serviceList', arg: 0 } },
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
    // Cross-service: compose a board's runs from every service it mounts.
    listByServices: { scope: { kind: 'serviceList', arg: 0 } },
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
  // --- Board-load read surface --------------------------------------------------
  // The workspace-scoped reads a `GET /workspaces/:id` snapshot assembles. Each takes the
  // workspaceId as arg0, so they reuse the `workspace` rule (resolve the owning account, reject
  // out-of-scope as 404). Reads only — no mutation is exposed here.
  //
  // The cross-service reads (`*.listByServices`, `countByServiceIds`, `serviceRepository.*`)
  // compose a board from the services it mounts; their arg0 is `serviceIds[]` (the `serviceList`
  // rule resolves each service's owning account) or an `accountId` (the `account` rule).
  serviceRepository: {
    listByIds: { scope: { kind: 'serviceList', arg: 0 } },
    listByAccount: { scope: { kind: 'account', arg: 0 } },
    // The run path resolves the service that owns a frame block (module materialisation /
    // blueprint reconcile). arg0 is a frame BLOCK id, so the `block` rule resolves it to its
    // home workspace's account server-side.
    getByFrameBlock: { scope: { kind: 'block', arg: 0 } },
  },
  workspaceMountRepository: {
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    countByServiceIds: { scope: { kind: 'serviceList', arg: 0 } },
  },
  workspaceSettingsRepository: {
    get: { scope: { kind: 'workspace', arg: 0 } },
    // The workspace-settings panel saves its edits (e.g. the `storeAgentContext` toggle). The
    // settings endpoints are member-level (not admin-gated), workspace-scoped — the same policy
    // as the block/pipeline mutations above. Completes the read+write settings surface.
    upsert: { scope: { kind: 'workspace', arg: 0 } },
  },
  mergePresetRepository: {
    list: { scope: { kind: 'workspace', arg: 0 } },
    // The merge lifecycle resolves a task's merge-threshold preset at run time
    // (`resolveMergePreset` → the merger/requirements gate), reading the workspace default when
    // the task pins none. Workspace-scoped read on the run path.
    getDefault: { scope: { kind: 'workspace', arg: 0 } },
    // `MergePresetService.list` lazily seeds the built-in default for a workspace that has
    // none (a write triggered by the board-load read). Member-level (the preset CRUD is not
    // admin-gated), workspace-scoped — the same policy as the block/pipeline mutations above.
    upsert: { scope: { kind: 'workspace', arg: 0 } },
    // The preset-library editor reads one preset and deletes it. Both take the workspaceId as
    // arg0 and are member-level (the preset CRUD is not admin-gated), completing the merge-preset
    // library management surface (list/getDefault/upsert were already exposed for the board load).
    get: { scope: { kind: 'workspace', arg: 0 } },
    remove: { scope: { kind: 'workspace', arg: 0 } },
  },
  modelPresetRepository: {
    list: { scope: { kind: 'workspace', arg: 0 } },
    // The run-start model resolution (`resolvePresetModelForKind` → the personal-credential
    // gate) reads the workspace's default model preset for the dispatched agent kind.
    getDefault: { scope: { kind: 'workspace', arg: 0 } },
    // `ModelPresetService.list` lazily seeds the built-in defaults for a workspace that has none
    // (a write the board-load read triggers), exactly like `mergePresetRepository.upsert` above.
    upsert: { scope: { kind: 'workspace', arg: 0 } },
    // The model-preset library editor's read-one + delete, the mirror of the merge-preset
    // management pair above. Member-level, workspace-scoped.
    get: { scope: { kind: 'workspace', arg: 0 } },
    remove: { scope: { kind: 'workspace', arg: 0 } },
  },
  // --- Agent-context run-path reads -----------------------------------------------
  // `AgentContextBuilder` resolves a block's LINKED docs/tasks for EVERY container agent step
  // (it builds the agent context on each dispatch), so these reads are on the run path, not just
  // the opt-in document/task integrations' own surfaces. arg0 is the workspaceId → `workspace`
  // rule. The document/task SOURCE-PROVIDER + connection surfaces (connect/list/disconnect) are
  // NOT exposed here — they are a later integration slice; only the block-scoped context reads are.
  documentRepository: {
    listByBlock: { scope: { kind: 'workspace', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    // A URL named in a block's description is resolved against the imported corpus by a
    // canonical-url point lookup (`AgentContextBuilder.resolveLinkedContext`), on the SAME
    // per-dispatch run path as `get`/`listByBlock` above — so it must be allow-listed too
    // (else a task whose description contains any link fails the run with `unknown_method`).
    getByUrl: { scope: { kind: 'workspace', arg: 0 } },
  },
  taskRepository: {
    listByBlock: { scope: { kind: 'workspace', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    // Same as `documentRepository.getByUrl`: a URL in the description resolves against the
    // imported issue corpus by a point lookup on the run path.
    getByUrl: { scope: { kind: 'workspace', arg: 0 } },
  },
  // The agent context also resolves the block's provisioned environment per step
  // (`resolveForBlock`/`get`, both workspace-keyed). Reads only — the connect/provision surface
  // (and decrypting a remotely-sealed env cipher, which needs the mothership's key) is a later slice.
  environmentRegistryRepository: {
    getByBlock: { scope: { kind: 'workspace', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
  },
  serviceFragmentDefaultsRepository: {
    get: { scope: { kind: 'workspace', arg: 0 } },
    // The service-fragment-defaults editor saves the workspace's default fragment set. Member-level,
    // workspace-scoped — completes the read+write surface (`get` was exposed for the board load).
    set: { scope: { kind: 'workspace', arg: 0 } },
  },
  pipelineScheduleRepository: {
    list: { scope: { kind: 'workspace', arg: 0 } },
    getByBlock: { scope: { kind: 'workspace', arg: 0 } },
    listByServices: { scope: { kind: 'serviceList', arg: 0 } },
    // Recurring-pipeline management, all driven by the local node's `RecurringPipelineController`
    // → `RecurringPipelineService` (CRUD + run history + `runNow`). Every method takes the
    // workspaceId as arg0 and is member-level (the schedule endpoints are not admin-gated).
    // `runNow` fires the schedule in-process, so its `fire()` writes (`insertRun`/`updateRun`/
    // `upsert`) are on the path too — the sweeper-only `listDue`/`pruneRunsBefore` stay
    // mothership-internal (its cron owns them). Completes the schedule management surface (the
    // `list`/`getByBlock`/`listByServices` reads were already exposed).
    get: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspace', arg: 0 } },
    remove: { scope: { kind: 'workspace', arg: 0 } },
    insertRun: { scope: { kind: 'workspace', arg: 0 } },
    updateRun: { scope: { kind: 'workspace', arg: 0 } },
    listRuns: { scope: { kind: 'workspace', arg: 0 } },
  },
  trackerSettingsRepository: {
    get: { scope: { kind: 'workspace', arg: 0 } },
    // The tracker-settings editor persists its config. Member-level, workspace-scoped — completes
    // the read+write surface (`get` was exposed for the board load).
    put: { scope: { kind: 'workspace', arg: 0 } },
  },
  notificationRepository: {
    listOpen: { scope: { kind: 'workspace', arg: 0 } },
    // The inbox act/dismiss/escalate flow re-reads a single notification by id after a run
    // settles (`NotificationService`). `get(workspaceId, id)` is workspace-scoped on arg0.
    get: { scope: { kind: 'workspace', arg: 0 } },
    // The merger-less pipeline tail raises a block notification on completion
    // (`pipeline_complete`/`merge_review` → `findOpenByBlock` dedup + `upsertOpenForBlock`), so a
    // run persists its inbox card on the mothership. Workspace-scoped, member-level (the inbox
    // act/dismiss endpoints are not admin-gated) — the same policy as the block/pipeline writes.
    findOpenByBlock: { scope: { kind: 'workspace', arg: 0 } },
    upsertOpenForBlock: { scope: { kind: 'workspace', arg: 0 } },
    // Block-less raises (a card with no `blockId`) and every status transition the inbox
    // performs right after a run settles — act / dismiss / escalate — go through `upsert`
    // (`NotificationService`), not `upsertOpenForBlock`. Workspace-scoped, member-level (the
    // inbox act/dismiss endpoints are not admin-gated) — same policy as the writes above.
    upsert: { scope: { kind: 'workspace', arg: 0 } },
  },
  bootstrapJobRepository: {
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    listByServices: { scope: { kind: 'serviceList', arg: 0 } },
  },
  tokenUsageRepository: {
    totalsSinceForWorkspace: { scope: { kind: 'workspace', arg: 0 } },
  },
  // Telemetry is local-first by design (Phase 5), but two READS are on the synchronous run
  // path before that batch-sync lands — the kaizen grading step summarises an execution's LLM
  // calls. Until Phase 5 they resolve against the mothership's telemetry store. High-volume
  // telemetry WRITES (`record`) stay out of the allow-list — they must never hit the RPC.
  llmCallMetricRepository: {
    summarizeByExecution: { scope: { kind: 'workspace', arg: 0 } },
  },
  // Kaizen grading (the merge lifecycle's quality step) reads its prior grade for a step before
  // (re-)grading and writes the result. Both are workspace-scoped on arg0; the sweeper methods
  // (`listPending`/`claim`) stay mothership-internal.
  kaizenGradingRepository: {
    getByStep: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspace', arg: 0 } },
  },
  // Mixed (workspaceId + blockId/stage): the workspace arg stays the scope key.
  requirementReviewRepository: {
    getByBlock: { scope: { kind: 'workspace', arg: 0 } },
    // The requirements gate reads a review by id (`get(workspaceId, id)`) when driving the
    // parked run (re-review / incorporate). Workspace-scoped on arg0.
    get: { scope: { kind: 'workspace', arg: 0 } },
    // The reviewer/incorporation companion persists the review as the gate iterates.
    // Member-level (the requirement-review endpoints are not admin-gated), workspace-scoped.
    upsert: { scope: { kind: 'workspace', arg: 0 } },
  },
  // The merge lifecycle's kaizen step reads any prior verified model/prompt combo
  // (`getByKey(workspaceId, comboKey)`) to skip re-grading. Workspace-scoped on arg0.
  kaizenVerifiedComboRepository: {
    getByKey: { scope: { kind: 'workspace', arg: 0 } },
  },
  // Env-config-repair (a Tester sub-flow) lists a workspace's repair jobs on the run path.
  envConfigRepairJobRepository: {
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
  },
  clarityReviewRepository: {
    getByBlock: { scope: { kind: 'workspace', arg: 0 } },
  },
  brainstormSessionRepository: {
    getByBlockStage: { scope: { kind: 'workspace', arg: 0 } },
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
  /**
   * Resolve a block's owning account id (block → home workspace → account). Required for the
   * `block` scope kind; a call hitting that kind with no resolver fails closed (404).
   */
  resolveBlockAccountId?(blockId: string): Promise<string | null | undefined>
  /**
   * Resolve each requested service id's owning account id, keyed by service id (a service that
   * does not exist is absent from the map). Required for the `serviceList` scope kind; a call
   * hitting that kind with no resolver fails closed (404).
   */
  resolveServiceAccountIds?(serviceIds: string[]): Promise<Map<string, string | null | undefined>>
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
    case 'accountList': {
      const ids = args[rule.arg]
      if (!Array.isArray(ids) || !ids.every((id) => inScope(id as string))) return denied
      break
    }
    case 'selfUser': {
      if (args[rule.arg] !== opts.scope.userId) return denied
      break
    }
    case 'block': {
      // Bind via the block's home workspace's account, resolved server-side (the block carries
      // no workspace arg). An unresolvable block (missing, or no resolver wired) is refused as
      // 404 — no existence leak, matching the `workspace` rule.
      const blockId = args[rule.arg]
      if (typeof blockId !== 'string' || !opts.resolveBlockAccountId) return denied
      if (!inScope(await opts.resolveBlockAccountId(blockId))) return denied
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
