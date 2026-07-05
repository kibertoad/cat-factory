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
 *   - `accountList`   — `args[arg]` is `string[]` of accountIds; ALL must be in scope.
 *   - `selfUser`      — `args[arg]` is a userId; must equal the token's `userId`.
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
 *   - `owner`         — `args[kindArg]`/`args[idArg]` are a tenant-library `(ownerKind, ownerId)`
 *                       PAIR (the prompt-fragment library, `ownerKind` ∈ `workspace` | `account`):
 *                       `workspace` → resolve the workspace's owning account (like `workspace`);
 *                       `account` → the ownerId IS an accountId (like `account`). Any other kind, a
 *                       non-string ownerId, or an unresolvable / out-of-scope owner fails closed (404).
 *   - `ownerField`    — `args[arg]` is a library record whose `(ownerKind, ownerId)` are FIELDS (an
 *                       `upsert(record)` whose owner is a property, not positional args). Binds on
 *                       those fields exactly like `owner`; a non-object arg / missing fields fail closed.
 */
export type ScopeRule =
  | { kind: 'workspace'; arg: number }
  | { kind: 'workspaceField'; arg: number }
  | { kind: 'account'; arg: number }
  | { kind: 'accountList'; arg: number }
  | { kind: 'selfUser'; arg: number }
  | { kind: 'visibility'; arg: number }
  | { kind: 'block'; arg: number }
  | { kind: 'blockList'; arg: number }
  | { kind: 'serviceList'; arg: number }
  | { kind: 'service'; arg: number }
  | { kind: 'serviceMount'; arg: number }
  | { kind: 'owner'; kindArg: number; idArg: number }
  | { kind: 'ownerField'; arg: number }

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
    // The batched form (the cross-workspace dependency resolution on the run-start path).
    findByIds: { scope: { kind: 'blockList', arg: 0 } },
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
    // The one-live-run-per-block insert used by start/retry/restart. Workspace-scoped like
    // upsert and bumps `execution.rev` in place on the arg-1 instance on a successful insert.
    insertLive: { scope: { kind: 'workspace', arg: 0 }, revWriteBack: 1 },
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
    // The batched form of `getByFrameBlock` — the board-composition read that resolves every
    // frame's service in ONE query (the duplicate-service check when linking a monorepo, and the
    // frame-subtree deletion cleanup in `BoardService`). arg0 is a `frameBlockIds[]` array, so the
    // `blockList` rule resolves each frame block's home workspace's account server-side and fails
    // closed on any missing/out-of-scope id (empty input → empty). The remaining service CRUD +
    // `getByRepo` (the GitHub-sync repo→service link) stay off the SPA path — a later slice.
    listByFrameBlocks: { scope: { kind: 'blockList', arg: 0 } },
    // The org-catalog mount flow reads a single service by id before mounting it onto a board
    // (`ServiceMountService.mount` — the cross-org guard that a service is mounted only within
    // its own account). arg0 is a serviceId with no workspace arg, so the `service` rule resolves
    // its owning account server-side.
    get: { scope: { kind: 'service', arg: 0 } },
  },
  // --- Shared-service mount management surface -------------------------------------
  // The org-catalog / shared-service mounting flow a mothership-mode SPA drives
  // (`ServiceMountService` / `ServiceMountController`): mount / unmount / re-layout a shared
  // account service onto a workspace board. The reads that compose the catalog badge
  // (`listByWorkspace`, `countByServiceIds`) were already exposed; these complete the write
  // surface. `get`/`update`/`remove` take the workspaceId as arg0 (the `workspace` rule); the
  // record-based `upsert(mount)` binds on the mount's `workspaceId` FIELD via the `serviceMount`
  // rule. Each is member-level (the mount endpoints are not admin-gated) and workspace-scoped.
  //
  // Cross-org sharing stays enforced at the RPC layer, NOT only in the (bypassed) service layer:
  // the `serviceMount` rule additionally requires the mounted `serviceId` to be owned by the SAME
  // account as the target workspace, so a raw `upsert` can never plant a cross-org mount — even
  // for a machine token that spans several accounts (a user in multiple orgs). Board composition
  // (`blockRepository.listByServices`, `serviceRepository.listByIds`) stays account-scoped as a
  // second line of defence, but it is no longer the sole guard for the mount invariant.
  workspaceMountRepository: {
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    countByServiceIds: { scope: { kind: 'serviceList', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'serviceMount', arg: 0 } },
    update: { scope: { kind: 'workspace', arg: 0 } },
    remove: { scope: { kind: 'workspace', arg: 0 } },
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
  // Shared stacks are a workspace-scoped, member-level config library (like merge presets): the
  // Infrastructure panel lists/creates/edits/deletes them and the board-load snapshot reads them.
  // All four repository methods take the workspaceId as arg0 — proxied to the mothership like the
  // other workspace libraries. (The bring-up/teardown LIFECYCLE is a host-Docker service action,
  // not a repository method, so it never crosses the machine API.)
  sharedStackRepository: {
    list: { scope: { kind: 'workspace', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspace', arg: 0 } },
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
    // Document-authoring run path (WS1): for a doc-aware kind, `AgentContextBuilder` resolves the
    // workspace's linked TEMPLATE (singular) + EXEMPLAR (list) for the block's `docKind` on each
    // dispatch, so both reads are on the run path exactly like `listByBlock`/`getByUrl`. arg0 is
    // the workspaceId → the `workspace` rule. (The role-link WRITE surface + the whole-workspace
    // list back the management UI, not the run path — they stay mothership-internal for now.)
    getRoleLink: { scope: { kind: 'workspace', arg: 0 } },
    listRoleLinks: { scope: { kind: 'workspace', arg: 0 } },
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
    // The per-`(block, service frame)` discovery read. `AgentContextBuilder.resolveEnvironment`
    // (and `RunDispatcher.attachEnvironmentProjection`) resolve the OWN service frame's env by
    // frame on EVERY container-agent dispatch, so this is on the run path exactly like `getByBlock`
    // — omit it and every such build throws `unknown_method`.
    getByBlockAndFrame: { scope: { kind: 'workspace', arg: 0 } },
    // The frame-less (manual / human-test) fallback behind `readRegistryRecord` — on the same
    // container-agent run path as `getByBlockAndFrame` (the own-frame env resolution falls back to
    // it), so omit it and every such build throws `unknown_method`.
    getFramelessByBlock: { scope: { kind: 'workspace', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    // The workspace-scoped batch read behind `EnvironmentProvisioningService.listHandles`
    // (the environments list endpoint + the frontend UI-test gate's single indexed env read,
    // `AgentContextBuilder.resolveFrontendConfig` — a batch read, not a per-binding point read).
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
  },
  // --- Ephemeral-environment backend connection management surface ----------------
  // The environment provider-connection + per-type infra-handler management panels a mothership-mode
  // SPA drives (`EnvironmentController` → `EnvironmentConnectionService`: connect / list / disconnect
  // a backend, and register / test / re-secret / unregister a per-type engine handler). Its
  // controller mounts under `/workspaces/:workspaceId` and is member-level (not admin-gated), so it
  // follows the same policy as the observability / other settings panels above. Reads/deletes take
  // the workspaceId as arg0 (the `workspace` rule); the record-based `upsert(record)` binds on the
  // record's `workspaceId` FIELD (the `workspaceField` rule — the id is a property, not a positional
  // arg). Exposing these makes the environment-connection settings panels functional (persist +
  // read back the redacted summary) in mothership mode.
  //
  // Safe to expose like the observability connection above: the connection record carries the
  // handler secrets as a SEALED blob (`secretsCipher`) — the repo returns it verbatim (it does NOT
  // decrypt); sealing/decryption live in `EnvironmentConnectionService` under the LOCAL key, so no
  // plaintext credential crosses the machine API and the mothership only ever stores ciphertext (the
  // initiative's "the mothership ENCRYPTION_KEY never reaches the laptop" split holds). What this
  // does NOT yet unlock: actually PROVISIONING an environment in mothership mode — the registry
  // WRITE path (`environmentRegistryRepository.insert`/`update`) + decrypting a remotely-sealed
  // access cipher stay off, the later secrets-delegation slice, exactly like the observability gate
  // probe. The `workspaceField` rule binds only the record's top-level `workspaceId` (see its note
  // above), so a connection row can only ever land in the caller's own in-scope workspace.
  environmentConnectionRepository: {
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    getByWorkspaceAndType: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspaceField', arg: 0 } },
    softDelete: { scope: { kind: 'workspace', arg: 0 } },
  },
  // The workspace-defined custom-manifest-type catalog the infra configurator reads + edits
  // (`EnvironmentConnectionService.listCustomTypes`/`upsertCustomType`/`removeCustomType`, merged
  // with the deployment's registered code types for display). Rows carry NO secrets — just manifest
  // metadata — so the whole CRUD surface is remote. `listByWorkspace`/`remove` take the workspaceId
  // as arg0 (the `workspace` rule); the record-based `upsert(record)` binds on the record's
  // `workspaceId` FIELD (the `workspaceField` rule). Member-level, workspace-scoped — the same policy
  // as the connection surface above, and it completes the environments management panel (the
  // `listHandlers` bundle loads both the connection handlers AND this catalog).
  customManifestTypeRepository: {
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspaceField', arg: 0 } },
    remove: { scope: { kind: 'workspace', arg: 0 } },
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
    // The escalation sweep's batched write (a local node runs the sweep too, so it must proxy
    // like the listOpen + per-row upsert loop it replaced). Workspace-scoped like `upsert`.
    escalateStaleOpen: { scope: { kind: 'workspace', arg: 0 } },
  },
  // --- Repo-bootstrap management / retry / stop surface ---------------------------
  // The bootstrap flow a mothership-mode SPA drives (`BootstrapController` +
  // `AgentRunController`): start a repo bootstrap, read a single job (the board-card poll), and
  // retry / stop a failed or running one. The board-load reads (`listByWorkspace` /
  // `listByServices`) were already exposed; these complete the surface. `get`/`update` take the
  // workspaceId as arg0 (the `workspace` rule); the record-based `insert(record)` binds on the
  // job's `workspaceId` FIELD (the `workspaceField` rule — the id is a property, not a positional
  // arg). Each is member-level (the bootstrap endpoints are not admin-gated) and workspace-scoped —
  // the same policy as the block/pipeline mutations. The `insert` record's sibling ids (`blockId`,
  // `referenceArchitectureId`) are NOT re-validated over the RPC (see the `workspaceField` note):
  // the row is stored under — and later read by — the bound `workspaceId`, and a foreign
  // `referenceArchitectureId` is harmless because the retry run re-resolves it via the
  // workspace-scoped `referenceArchitectureRepository.get` below, which 404s a cross-workspace id.
  bootstrapJobRepository: {
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    listByServices: { scope: { kind: 'serviceList', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    insert: { scope: { kind: 'workspaceField', arg: 0 } },
    update: { scope: { kind: 'workspace', arg: 0 } },
  },
  // The reference-architecture library the bootstrap modal reads + edits, and that a retry
  // re-resolves the base repo from (`referenceArchitectureRepository.get`). Reads/updates/deletes
  // take the workspaceId as arg0 (the `workspace` rule); the record-based `insert(record)` binds on
  // the record's `workspaceId` FIELD (the `workspaceField` rule). Member-level (the reference-arch
  // endpoints are not admin-gated), workspace-scoped — the same policy as the other library editors.
  referenceArchitectureRepository: {
    get: { scope: { kind: 'workspace', arg: 0 } },
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    insert: { scope: { kind: 'workspaceField', arg: 0 } },
    update: { scope: { kind: 'workspace', arg: 0 } },
    softDelete: { scope: { kind: 'workspace', arg: 0 } },
  },
  // The board's run controls (retry / stop a failed or running run) enter through the unified
  // `agent_runs` table: `AgentRunController` calls `getRef(workspaceId, id)` to resolve the run's
  // KIND, then dispatches to the matching service. `getRef` takes the workspaceId as arg0, so it
  // reuses the `workspace` rule (resolve the owning account, reject out-of-scope as 404). Exposing
  // it makes the EXECUTION-run retry/stop path functional in mothership mode — every downstream
  // read+write those services make (`executionRepository.get/deleteByBlock/upsert/markFailed`,
  // `blockRepository.update`, `pipelineRepository.get`, the budget/binary-storage prechecks) is
  // already allow-listed on the run/start path. The bootstrap + env-config-repair retry branches
  // read their own repos (`bootstrapJobRepository.get`, `referenceArchitectureRepository.get`, …),
  // now allow-listed too (see the bootstrap / reference-architecture / env-config-repair management
  // surface above). The sweeper-only `listStale`/`liveRunIds` stay mothership-internal (its cron
  // owns them).
  agentRunRepository: {
    getRef: { scope: { kind: 'workspace', arg: 0 } },
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
  //
  // The Kaizen SCREEN read surface is exposed too, so a mothership-mode SPA can display the
  // grading history + per-run grading status (`KaizenController` → `KaizenService.getOverview` /
  // `listForExecution`, both member-level, read-only, mounted under `/workspaces/:workspaceId`):
  // `listByWorkspace(workspaceId, limit?)` (the screen's bounded history) and
  // `listByExecution(workspaceId, executionId)` (the run-window per-step status). Both take the
  // workspaceId as arg0 (the `workspace` rule). The internal-only single-grade `get(workspaceId,
  // id)` is not on any SPA path (the service never calls it), and `listPending`/`claim` are the
  // background sweep's kind-spanning reads — all stay mothership-internal.
  kaizenGradingRepository: {
    getByStep: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspace', arg: 0 } },
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    listByExecution: { scope: { kind: 'workspace', arg: 0 } },
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
    // The service drops a block's prior review before a fresh review run
    // (`RequirementReviewService.review`). Workspace-scoped on arg0 — completes the repo.
    deleteByBlock: { scope: { kind: 'workspace', arg: 0 } },
  },
  // Interactive document-interview sessions (WS5). The doc-authoring RUN PATH reads the
  // converged brief (`getByBlock`, via the agent-context builder on every doc-writer dispatch),
  // and the interview window reads/persists as the gate iterates. All workspace-scoped on arg0,
  // mirroring the requirement-review surface.
  docInterviewRepository: {
    getByBlock: { scope: { kind: 'workspace', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspace', arg: 0 } },
    deleteByBlock: { scope: { kind: 'workspace', arg: 0 } },
  },
  // The merge lifecycle's kaizen step reads any prior verified model/prompt combo
  // (`getByKey(workspaceId, comboKey)`) to skip re-grading. Workspace-scoped on arg0. The Kaizen
  // screen also lists the whole verified-combo library (`listByWorkspace`, part of the same
  // `getOverview` read) — workspace-scoped, read-only, member-level. The sweep's `upsert` (the
  // streak/verified write) stays off the SPA path — kaizen grading is best-effort in mothership
  // mode until the Phase 5 telemetry/local-first sync lands.
  kaizenVerifiedComboRepository: {
    getByKey: { scope: { kind: 'workspace', arg: 0 } },
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
  },
  // Env-config-repair (a Tester sub-flow) lists a workspace's repair jobs on the run path
  // (`listByWorkspace`), and the board's run controls retry / stop a failed or running repair run:
  // `get`/`update` take the workspaceId as arg0 (the `workspace` rule), the record-based
  // `insert(record)` binds on the job's `workspaceId` FIELD (the `workspaceField` rule). Retry
  // STARTS a fresh run from the failed job's coords, so it reads the prior job (`get`) then inserts
  // a new one; stop patches the running job (`update`). Member-level, workspace-scoped.
  envConfigRepairJobRepository: {
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    insert: { scope: { kind: 'workspaceField', arg: 0 } },
    update: { scope: { kind: 'workspace', arg: 0 } },
  },
  // --- Advanced review / structured-dialogue session surfaces ---------------------
  // The clarity-review (bug-report triage), brainstorm (structured dialogue) and consensus
  // (multi-strategy orchestration) windows mirror the requirements-review surface above: rows
  // scoped by workspace, keyed by block/stage/step, with a live entry per block. A mothership-mode
  // SPA runs and re-reads these reviews, and the services persist/replace them as the window
  // iterates — every method takes the workspaceId as arg0 (the `upsert(workspaceId, review)`
  // signature carries it positionally, so the `workspace` rule binds it, not `workspaceField`).
  // Member-level (none of the review endpoints is admin-gated), workspace-scoped — the same policy
  // as the requirement-review surface. Completes the read+write surface (`getByBlock` /
  // `getByBlockStage` were already exposed for the board load).
  clarityReviewRepository: {
    getByBlock: { scope: { kind: 'workspace', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspace', arg: 0 } },
    deleteByBlock: { scope: { kind: 'workspace', arg: 0 } },
  },
  brainstormSessionRepository: {
    getByBlockStage: { scope: { kind: 'workspace', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspace', arg: 0 } },
    deleteByBlockStage: { scope: { kind: 'workspace', arg: 0 } },
  },
  // Initiatives (the long-running multi-task work container): the create/read surface the
  // board + tracker window use, plus the planning pipeline's ingest writes. Every method is
  // workspaceId-arg0 scoped; the rev-guarded `compareAndSwap` carries the whole entity as
  // arg1 with the expected rev as arg2. `listExecuting` (the cross-workspace cron sweeper
  // read) is deliberately NOT here — it stays mothership-internal.
  initiativeRepository: {
    get: { scope: { kind: 'workspace', arg: 0 } },
    getByBlock: { scope: { kind: 'workspace', arg: 0 } },
    list: { scope: { kind: 'workspace', arg: 0 } },
    insert: { scope: { kind: 'workspace', arg: 0 } },
    compareAndSwap: { scope: { kind: 'workspace', arg: 0 } },
    delete: { scope: { kind: 'workspace', arg: 0 } },
  },
  consensusSessionRepository: {
    get: { scope: { kind: 'workspace', arg: 0 } },
    getByStep: { scope: { kind: 'workspace', arg: 0 } },
    getByBlock: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspace', arg: 0 } },
  },
  // --- Post-release-health / observability settings surface -----------------------
  // The three settings repositories a mothership-mode SPA manages for the post-release-health
  // flow: the (single) observability connection, the per-block monitor/SLO mapping, and the
  // incident-enrichment connection. Their controllers mount under `/workspaces/:workspaceId`
  // and are member-level (not admin-gated), so they follow the same policy as the other
  // settings panels above. Reads/deletes take the workspaceId as arg0 (the `workspace` rule);
  // the record-based `upsert(record)` binds on the record's `workspaceId` FIELD (the
  // `workspaceField` rule — the id is a property, not a positional arg). Exposing them makes
  // the observability / release-health / incident-enrichment editors functional (persist +
  // read back), not read-only, in mothership mode.
  //
  // Scope of what this unlocks: the settings PANELS work end-to-end (save + read back the
  // redacted summary, which never decrypts). The saved connection cannot yet DRIVE a
  // post-release-health gate probe in mothership mode — decrypting the sealed connection cipher
  // at gate-probe time belongs to the later secrets-delegation slice. The connection `get` here
  // returns the FULL record (the sealed `credentials` blob), not the redacted service view: the
  // RPC client is the trusted local node, the blob is sealed and account-scoped, so this matches
  // the existing `environmentRegistryRepository.get` precedent (sealed cipher over the machine
  // API). The record-based `upsert` binds only the top-level `record.workspaceId` (see the
  // `workspaceField` note above) — `releaseHealthConfigRepository`'s `blockId` is NOT
  // re-validated here, so a config can only ever be planted into the caller's own in-scope
  // workspace, never another's.
  observabilityConnectionRepository: {
    get: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspaceField', arg: 0 } },
    delete: { scope: { kind: 'workspace', arg: 0 } },
  },
  releaseHealthConfigRepository: {
    getByBlock: { scope: { kind: 'workspace', arg: 0 } },
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspaceField', arg: 0 } },
    delete: { scope: { kind: 'workspace', arg: 0 } },
  },
  incidentEnrichmentConnectionRepository: {
    get: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspaceField', arg: 0 } },
    delete: { scope: { kind: 'workspace', arg: 0 } },
  },
  // The private package-registry connection (sealed npm/GitHub-Packages entries): the
  // settings panel's list/add/remove and the container dispatch's decrypt-time read all
  // ride get/upsert/delete, workspace-scoped like the observability connection above
  // (same sealed-blob-over-the-machine-API precedent).
  packageRegistryConnectionRepository: {
    get: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspaceField', arg: 0 } },
    delete: { scope: { kind: 'workspace', arg: 0 } },
  },
  // --- VCS / GitHub projection READ surface ---------------------------------------
  // The GitHub read models the SPA's VCS board panels display (repos / branches / PRs /
  // issues), served straight from the local projections by `GitHubService` (`container.github`)
  // — fast, rate-limit-free, and NO GitHub API call, so they run unchanged in mothership mode
  // over the remote-sourced projection repos. Each takes the workspaceId as arg0 (the
  // `workspace` rule); reads only.
  //
  // These same reads are ALSO the run path: `resolveRepoTarget` (which runs on EVERY
  // container-agent dispatch to find a block's repo) reads `githubInstallationRepository.
  // getByWorkspace` FIRST and returns null if there's no installation, THEN walks the
  // `github_repos` projection via `repoProjectionRepository.list` and the block ancestry via
  // `blockRepository.get` / `serviceRepository.getByFrameBlock` (both already remote). So
  // closing the run-path gap for real (non-fake-executor) runs needs BOTH the installation
  // read and `list` — allow-listing `list` alone left the resolver failing one call earlier on
  // the un-remoted installation read. `getByWorkspace` is a member-level read (its own binding
  // or the account-shared one), workspace-scoped on arg0.
  //
  // Deliberately EXCLUDED (a later "GitHub sync + repo-write" slice): the projection WRITE
  // surface — `upsertMany` (the sync/webhook ingest; the mothership owns GitHub sync, since the
  // App + webhooks live there), the board-linkage write `repoProjectionRepository.setMonorepo`,
  // the sync cursors (`getCursor`/`setCursor`, keyed on installationId not
  // workspaceId), and `tombstoneMissing`. `repoProjectionRepository.get` stays off too: it backs
  // only `GitHubService.resolve` for the repo-WRITE endpoints (create-branch / open-PR /
  // merge / comment), and exposing it alone would let create-branch/open-PR perform the real
  // GitHub write and THEN fail on the un-remoted `upsertMany` projection refresh — a worse
  // failure than today's clean pre-write refusal. It comes back with the repo-write slice. The
  // rest of `githubInstallationRepository` (installationId-keyed reads, sync/token writes, the
  // fan-out, the cron `listActive`) also stays off — only the workspace-scoped `getByWorkspace`
  // the run path needs is opened here.
  githubInstallationRepository: {
    getByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
  },
  repoProjectionRepository: {
    list: { scope: { kind: 'workspace', arg: 0 } },
  },
  branchProjectionRepository: {
    listByRepo: { scope: { kind: 'workspace', arg: 0 } },
  },
  pullRequestProjectionRepository: {
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
  },
  issueProjectionRepository: {
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
  },
  // --- Self-hosted runner-backend connection surface ------------------------------
  // The workspace's binding to an "agent runner backend" (the manifest HTTP pool / native
  // Kubernetes runner / …) the runner-pool settings panel manages (`RunnerPoolController` →
  // `RunnerPoolConnectionService`: connect / rotate secrets / disconnect / describe / test).
  // The controller mounts under `/workspaces/:workspaceId` and is member-level (not admin-gated),
  // so it follows the same policy as the observability / environment connection panels above.
  // `getByWorkspace`/`softDelete` take the workspaceId as arg0 (the `workspace` rule); the
  // record-based `upsert(record)` binds on the record's `workspaceId` FIELD (the `workspaceField`
  // rule — the id is a property, not a positional arg). Exposing these makes the runner-backend
  // connection panel functional (persist + read back the safe metadata) in mothership mode.
  //
  // Safe to expose like the observability / environment connections: the record carries the
  // backend credentials as a SEALED blob (`secretsCipher`) — the repo returns it verbatim (it
  // does NOT decrypt); sealing/decryption live in `RunnerPoolConnectionService` under the LOCAL
  // key, so no plaintext credential crosses the machine API and the mothership only ever stores
  // ciphertext (the "the mothership ENCRYPTION_KEY never reaches the laptop" split holds). The
  // `workspaceField` rule binds only the record's top-level `workspaceId`, so a connection row can
  // only ever land in the caller's own in-scope workspace.
  runnerPoolConnectionRepository: {
    getByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspaceField', arg: 0 } },
    softDelete: { scope: { kind: 'workspace', arg: 0 } },
  },
  // --- Binary-artifact metadata surface (visual-confirmation gate) -----------------
  // The metadata rows for stored binary blobs (UI screenshots + the reference design images they
  // are reviewed against) the visual-confirmation gate + the artifact controllers read/write
  // (`ArtifactController` / `HarnessArtifactController`, mounted under `/workspaces/:workspaceId`,
  // member-level). Only the METADATA lives in the relational store (D1 ⇄ Postgres) and is proxied
  // here; the BYTES live in the per-account blob backend (R2 / S3 / fs / …), resolved locally, so
  // they never cross this API. Point reads/deletes take the workspaceId as arg0 (the `workspace`
  // rule); the record-based `insert(record)` binds on the record's `workspaceId` FIELD (the
  // `workspaceField` rule). Every read already filters by the (authenticated) workspaceId, so a
  // row's non-authoritative `executionId`/`blockId` need no separate scope check. The retention
  // sweep (`listOlderThan`/`deleteOlderThan`) stays mothership-internal (the mothership owns
  // durable-state retention), like the other global sweeper methods.
  binaryArtifactMetadataStore: {
    insert: { scope: { kind: 'workspaceField', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    listByExecution: { scope: { kind: 'workspace', arg: 0 } },
    countByExecution: { scope: { kind: 'workspace', arg: 0 } },
    listByBlock: { scope: { kind: 'workspace', arg: 0 } },
    delete: { scope: { kind: 'workspace', arg: 0 } },
  },
  // --- Prompt-fragment library management surface ---------------------------------
  // The tenant-scoped prompt-fragment library (ADR 0006) a mothership-mode SPA curates
  // (`FragmentLibraryController` → `FragmentLibraryService`): list / create / update / delete
  // hand-authored fragments at either tier. The library module assembles from
  // `promptFragmentRepository` ALONE (no connection/secret repo — unlike the document/task
  // integrations, whose modules require a decrypt-inside connection repo and so stay off), and its
  // rows carry NO secrets, so the whole management surface is remote. Every method is keyed by an
  // `(ownerKind, ownerId)` PAIR (`ownerKind` ∈ `workspace` | `account`), bound by the `owner` scope
  // rule (positional pair) / `ownerField` rule (the record's fields on `upsert`): a `workspace`
  // owner resolves its account like the `workspace` rule, an `account` owner IS the accountId — so a
  // machine token scoped to one account can never read/write another tenant's fragments. Both tiers'
  // endpoints are member-level (account-tier routes guard on `requireMember`, NOT `requireAdmin`), so
  // this follows the same member-level policy as the other settings/library panels above.
  //
  // The `sourceId`-keyed `listBySource` stays off — it is the repo-sync fan-out read (the mothership
  // owns GitHub sync; the source service is gated on a GitHub client absent on a mothership node), so
  // it is not on the SPA library-management path here.
  promptFragmentRepository: {
    listByOwner: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    get: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    upsert: { scope: { kind: 'ownerField', arg: 0 } },
    softDelete: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
  },
  // The fragment-source (repo-linkage) library the SPA lists + links (`FragmentSourceService`), owner
  // scoped exactly like the fragments above. `listByOwner` (the sources list) is bound by the `owner`
  // rule; the record-based `upsert(record)` by `ownerField`. The `sourceId`-keyed reads/writes
  // (`get`/`updateSyncState`/`softDelete`) stay off — they back the repo-SYNC management the
  // mothership owns (the source service needs a GitHub client, which a mothership node does not have),
  // so a later GitHub-sync-in-mothership slice opens them with a source→owner resolver.
  fragmentSourceRepository: {
    listByOwner: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    upsert: { scope: { kind: 'ownerField', arg: 0 } },
  },
  // --- Account onboarding read surface --------------------------------------------
  // The two account-scoped READS a mothership-mode SPA's account/members + email-settings panels
  // drive, both member-level (`AccountController` guards them with `requireMember`, NOT
  // `requireAdmin`). arg0 is an accountId → the `account` rule (reject out-of-scope as 404). The
  // account-lifecycle WRITES stay off: `invitationRepository.create`/`setStatus` (inviting/revoking
  // members is admin-gated), its pre-auth `findByTokenHash`/`get` (the unauthenticated accept-invite
  // lookup — never a scoped-token call), and `emailConnectionRepository.upsert`/`softDelete`
  // (connect/disconnect are admin-gated). The email connection `getByAccount` returns the record with
  // its provider key as a SEALED `apiKeyCipher` blob (the repo does NOT decrypt — sealing/decryption
  // live in the email service; delivery is delegated to the mothership), so no plaintext credential
  // crosses the machine API — the same sealed-blob precedent as the observability/runner connections.
  invitationRepository: {
    listByAccount: { scope: { kind: 'account', arg: 0 } },
  },
  emailConnectionRepository: {
    getByAccount: { scope: { kind: 'account', arg: 0 } },
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
    case 'service': {
      // Bind via the service's owning account (services are account-owned; the single-id form of
      // `serviceList`, reusing the same resolver). A missing service is absent from the map, so it
      // is refused as 404 — no existence leak, matching the `serviceList`/`block` rules.
      const serviceId = args[rule.arg]
      if (typeof serviceId !== 'string' || !opts.resolveServiceAccountIds) return denied
      const accounts = await opts.resolveServiceAccountIds([serviceId])
      if (!inScope(accounts.get(serviceId))) return denied
      break
    }
    case 'serviceMount': {
      // The record-based mount `upsert`. Bind on the mount's `workspaceId` FIELD (must be in
      // scope) AND enforce the cross-org mount invariant server-side: the mounted `serviceId`
      // must be owned by the SAME account as the target workspace, so a raw upsert can never
      // plant a cross-org mount — even for a token that spans several accounts (both would be in
      // scope, so a workspace-only check would let one org's service be mounted onto another's
      // board). A non-object arg, a missing/non-string field, an out-of-scope workspace, or a
      // service whose account differs from the workspace's (incl. a missing service) → 404.
      const record = args[rule.arg]
      const workspaceId =
        record && typeof record === 'object'
          ? (record as { workspaceId?: unknown }).workspaceId
          : undefined
      const serviceId =
        record && typeof record === 'object'
          ? (record as { serviceId?: unknown }).serviceId
          : undefined
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
      break
    }
    case 'owner': {
      // A tenant-library row keyed by an (ownerKind, ownerId) PAIR. Resolve the owning account
      // server-side and reject anything outside the token scope (404, no existence leak):
      //   - 'workspace' → the ownerId is a workspaceId; resolve its owning account (like `workspace`).
      //   - 'account'   → the ownerId IS an accountId (like `account`).
      // Any other kind, a non-string ownerId, or an unresolvable/out-of-scope owner fails closed.
      const ownerKind = args[rule.kindArg]
      const ownerId = args[rule.idArg]
      if (typeof ownerId !== 'string') return denied
      if (ownerKind === 'workspace') {
        if (!inScope(await opts.resolveAccountId(ownerId))) return denied
      } else if (ownerKind === 'account') {
        if (!inScope(ownerId)) return denied
      } else {
        return denied
      }
      break
    }
    case 'ownerField': {
      // The record-based library `upsert(record)` whose (ownerKind, ownerId) are FIELDS of the
      // record, not positional args. Bind on those fields exactly like `owner` — a non-object arg,
      // a missing/non-string field, or an unresolvable/out-of-scope owner is refused as 404, so the
      // row can only ever be persisted under the caller's own in-scope owner.
      const record = args[rule.arg]
      const ownerKind =
        record && typeof record === 'object'
          ? (record as { ownerKind?: unknown }).ownerKind
          : undefined
      const ownerId =
        record && typeof record === 'object' ? (record as { ownerId?: unknown }).ownerId : undefined
      if (typeof ownerId !== 'string') return denied
      if (ownerKind === 'workspace') {
        if (!inScope(await opts.resolveAccountId(ownerId))) return denied
      } else if (ownerKind === 'account') {
        if (!inScope(ownerId)) return denied
      } else {
        return denied
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
