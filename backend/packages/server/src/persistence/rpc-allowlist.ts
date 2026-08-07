import type { PersistenceMethodTable } from './rpc.js'

// The mothership-mode persistence ALLOW-LIST — the default-deny table naming every repository
// method a mothership-mode node may invoke over `POST /internal/persistence`, and the scope rule
// that binds each call to an account.
//
// It lives beside the protocol + dispatcher (`rpc.ts`) rather than inside it because the two grow
// on completely different schedules: the protocol is stable, while this table is the initiative's
// living surface — every mothership slice widens it, so it is the file a reader goes to when
// asking "is X reachable from a laptop yet?". Splitting it also keeps `rpc.ts` within the
// file-size budget as the surface keeps growing.
//
// See `docs/initiatives/mothership-mode.md` for the per-repository bucket checklist, and
// `runtimes/node/test/mothership-allowlist.spec.ts` for the drift guard that fails unless EVERY
// Drizzle repository method is either listed here or explicitly classified.

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
 * member-level in the service layer, so they remain. The board mutations that stay OUT are
 * `workspaceRepository.setAccessMode` (the access-mode flip) and `linkAccount` (the legacy-board
 * auto-heal that adopts a board into an account) — both are `members.manage` (admin-tier), so like
 * the account/membership admin mutations they must not be reachable over the role-blind machine RPC.
 */
export const REMOTE_PERSISTENCE_METHODS: PersistenceMethodTable = {
  workspaceRepository: {
    listVisible: { scope: { kind: 'visibility', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    ownerOf: { scope: { kind: 'workspace', arg: 0 } },
    accountOf: { scope: { kind: 'workspace', arg: 0 } },
    // The workspace-RBAC authorization read (the narrow access row that replaces `accountOf`
    // in the gate); workspace-scoped and secret-free, exactly like `accountOf`/`ownerOf`.
    accessRowOf: { scope: { kind: 'workspace', arg: 0 } },
    rename: { scope: { kind: 'workspace', arg: 0 } },
    setDescription: { scope: { kind: 'workspace', arg: 0 } },
    // The account-tier installation fallback (`createTierInstallationResolvers.forAccount`) reads
    // the account's own boards in one batch on the repo-sourced fragment/skill sync path. arg0 is
    // an accountId → the `account` rule, exactly like `serviceRepository.listByAccount`.
    listByAccount: { scope: { kind: 'account', arg: 0 } },
  },
  blockRepository: {
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    insert: { scope: { kind: 'workspace', arg: 0 } },
    update: { scope: { kind: 'workspace', arg: 0 } },
    setService: { scope: { kind: 'workspace', arg: 0 } },
    // The container-resize child translation (`BoardService.resizeBlock`): one arithmetic UPDATE
    // over a parent's direct children. Workspace-scoped like `update`, and remote for the same
    // reason — it is board state, on a path a mothership-mode node serves from a laptop.
    shiftChildPositions: { scope: { kind: 'workspace', arg: 0 } },
    deleteMany: { scope: { kind: 'workspace', arg: 0 } },
    // Entity-id-keyed (no workspace arg): resolve the block's home workspace's account server-side.
    findById: { scope: { kind: 'block', arg: 0 } },
    // The batched form (the cross-workspace dependency resolution on the run-start path).
    findByIds: { scope: { kind: 'blockList', arg: 0 } },
    // Cross-service: compose a board's blocks from every service it mounts.
    listByServices: { scope: { kind: 'serviceList', arg: 0 } },
    // One bounded page of a service frame's task subtree (the public API's paginated task list).
    listServiceTasks: { scope: { kind: 'workspace', arg: 0 } },
    // The public API's in-flight concurrency backstop (`BoardService.countActiveInternalTasks`),
    // checked before a headless "initiative" run starts so a leaked key can't spin up unbounded
    // LLM work. A workspace-scoped SQL COUNT returning a NUMBER — no row content crosses the
    // wire. Completes the headless surface whose paginated reads (`listServiceTasks` above,
    // `executionRepository.listInternal`) are already remote: without it the cap read throws and
    // the mothership-mode node refuses every public-API run start.
    countActiveInternal: { scope: { kind: 'workspace', arg: 0 } },
  },
  pipelineRepository: {
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    insert: { scope: { kind: 'workspace', arg: 0 } },
    // The adoption write (`pipelineAdoption.adoptForRun`, and `reseed`'s absent branch): it sits on
    // the run-START path, so it must be remote from this slice, or a mothership-mode node (which
    // has no `db`) throws the moment a task pinning an un-adopted catalog pipeline is started.
    // Same reasoning as `executionRepository.countActiveByWorkspace` below.
    insertIfAbsent: { scope: { kind: 'workspace', arg: 0 } },
    update: { scope: { kind: 'workspace', arg: 0 } },
    delete: { scope: { kind: 'workspace', arg: 0 } },
  },
  executionRepository: {
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    // Lean live-run projection backing the dispatch guard + resumePaused (workspace-scoped read).
    listLive: { scope: { kind: 'workspace', arg: 0 } },
    // Run admission control's capacity read: a workspace-scoped SQL COUNT returning a NUMBER, so
    // no row content crosses the wire (the same shape as `blockRepository.countActiveInternal`).
    // It sits on the run-START path, which is precisely why it must be remote from the first
    // slice: an unrouted method here would not fail at build or review, it would throw the moment
    // a mothership-mode node — which has no `db` — tried to start a run.
    countActiveByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    // The per-run debug lists' 404 guard: `get` without the row decode. Same scope shape.
    exists: { scope: { kind: 'workspace', arg: 0 } },
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
    // One bounded page of the workspace's headless (`internal`-anchored) runs — the public API's
    // job list. Workspace-scoped like every other list read here.
    listInternal: { scope: { kind: 'workspace', arg: 0 } },
    // One bounded page of ALL the workspace's runs — the remote debugging surface's run index
    // (`GET /api/v1/debug/runs`). Workspace-scoped exactly like `listInternal`; it is wider only
    // in WHICH runs it returns (no `internal` anchor join), and that width is bounded by the same
    // workspace the scope rule already pins. Remote because the runs themselves are org/durable
    // state and live on the mothership even in mothership mode — unlike the per-run TELEMETRY the
    // rest of that surface reads, which stays local by design.
    listRecent: { scope: { kind: 'workspace', arg: 0 } },
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
  // The workspace-RBAC member-tier READS the gate + list path run on every signed request
  // (workspace-rbac slice 3). `get` is the gate's per-request effective-role read — workspace-
  // scoped and secret-free, exactly like `workspaceRepository.accessRowOf`.
  // `getRolesForUserInWorkspaces` is the `GET /workspaces` list-annotation batch read; it is
  // pinned to the CALLER's own id (`selfUser`), so it can only ever return the caller's own
  // membership roles (a board they hold no row in is simply absent — no existence leak), and it
  // returns a serializable `Record` so it round-trips over this RPC. The roster read
  // (`listByWorkspace`/`listWorkspaceIdsForUser`) + the writes (`upsert`/`remove`/
  // `removeByAccountMembership`) stay mothership-internal — the member-management API is a later
  // slice, and the writes are admin-gated (the machine token is role-blind).
  workspaceMemberRepository: {
    get: { scope: { kind: 'workspace', arg: 0 } },
    getRolesForUserInWorkspaces: { scope: { kind: 'selfUser', arg: 0 } },
  },
  // --- Member-display read surface ------------------------------------------------
  // The user DISPLAY records the account members panel enriches its roster with
  // (`AccountService.members` → `userRepository.listByIds(memberIds)`) and the single-user display
  // lookup (`get`). These carry only the presentational `UserRecord` (id / name / email / avatarUrl
  // / createdAt) — NOT the password `secret`, which lives on `UserIdentityRecord` and is reachable
  // only via `getIdentity`/`listIdentities` (kept off, like the other identity/auth reads). So the
  // display reads leak no credential and are safe to proxy.
  //
  // Scope: a userId is not itself an account/workspace, so it is bound by CO-MEMBERSHIP — the `user`
  // rule (single id) / `userList` rule (batch) admit a user iff they are a member of one of the
  // token's in-scope accounts, resolved server-side from the account rosters. The roster read only
  // ever passes ids that ARE members of the (in-scope) account it just listed, so the batch check
  // always passes on the real path; a forged out-of-scope id fails closed (404, no existence leak).
  // The `update` write (profile edit) + the identity/auth reads (`findByIdentity`/`findByEmail`/
  // `getIdentity`/`listIdentities`) stay off — they are the account-lifecycle / login surface, not
  // member display, and the identity reads carry the password secret.
  userRepository: {
    get: { scope: { kind: 'user', arg: 0 } },
    listByIds: { scope: { kind: 'userList', arg: 0 } },
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
    // The real-time fan-out's hot read, and the one method on this table that is NOT a management
    // surface: `FanOutEventPublisher.targets` calls it on EVERY engine event publish to expand the
    // changed block to the set of boards mounting its service. It is therefore load-bearing for
    // mothership mode in a way the others aren't — a mothership-mode node wires the same fan-out
    // decorator, so leaving it off meant every publish rejected with `unknown_method` and the
    // rejection propagated into the run-state emit (`RunStateMachine`), not just into a missed
    // frame. Also drives the mount/unmount live-update of OTHER boards showing the same service
    // (`BoardService`), which was the known gap the mount-management slice left open.
    //
    // arg0 is the ORIGIN workspaceId, so the plain `workspace` rule binds it. The join starts from
    // that in-scope workspace's block and returns workspace IDS only — no row content — and a
    // service can only ever be mounted inside its own account (the `serviceMount` rule makes that
    // non-bypassable), so the result set can never span an account the token doesn't hold.
    listWorkspaceIdsMountingBlock: { scope: { kind: 'workspace', arg: 0 } },
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
  // ONLY the non-secret config read. The run path needs the account-wide `allowInitiatorPat`
  // floor (`createInitiatorPatGate`), and without this a mothership node would silently not
  // enforce it — a parity gap in a security control, which is the worse of the two failures.
  //
  // `getByAccount` stays mothership-internal and its reasoning is untouched: the machine token
  // scopes ACCOUNTS not ROLES and the RPC bypasses the service layer's `requireAdmin`, so
  // proxying the full row would let any account member pull the sealed secret blob.
  // `getConfigByAccount` selects the `config` column alone, so there is no secret to expose —
  // which is exactly the "or routes them through the service" escape the sibling comment
  // anticipated. `upsert` (an admin write) and `listAll` (the unscoped sweeper) stay off.
  accountSettingsRepository: {
    getConfigByAccount: { scope: { kind: 'account', arg: 0 } },
  },
  // Per-user settings (the user-tier spend budget). Self-scoped: a user reads/writes only their
  // OWN row (the `selfUser` rule requires args[0] to equal the token's userId), so both the
  // read (snapshot + spend gate) and the write (the user's own budget edit) are safe over RPC —
  // no admin gating is involved, unlike the account-tier budget (see accountRepository note).
  // Invariant: the user-tier gate/snapshot always passes the CALLER's own userId here — a run's
  // initiator is the mothership laptop's signed-in user (single-user token), and the snapshot
  // passes the viewer's id — so `selfUser` matches by construction. If that ever diverged the
  // read would be denied (404 → the remote proxy throws); the snapshot assembly reads these
  // best-effort (degrading the tier to absent) so a scope mismatch can't 500 the board load.
  userSettingsRepository: {
    get: { scope: { kind: 'selfUser', arg: 0 } },
    upsert: { scope: { kind: 'selfUser', arg: 0 } },
  },
  // Per-user in-app tutorial progress: the same self-scoped shape as `userSettingsRepository`
  // above, and remote for the same reason — it is per-PERSON state whose entire purpose is to
  // follow them across machines, so a `local-sqlite` copy would be one more browser profile
  // rather than a fix, and a mothership-mode laptop reading only its own copy would re-ask the
  // launch question and re-make every contextual offer. `selfUser` requires args[0] to equal the
  // token's userId, and every call site here passes the CALLER's own id (the controller reads it
  // off the session, the snapshot passes the viewer's), so the rule matches by construction.
  // No secrets, no admin gating: `remove` is the user's own "Reset progress".
  tutorialProgressRepository: {
    get: { scope: { kind: 'selfUser', arg: 0 } },
    upsert: { scope: { kind: 'selfUser', arg: 0 } },
    remove: { scope: { kind: 'selfUser', arg: 0 } },
  },
  riskPolicyRepository: {
    list: { scope: { kind: 'workspace', arg: 0 } },
    // The merge lifecycle resolves a task's merge-threshold preset at run time
    // (`resolveRiskPolicy` → the merger/requirements gate), reading the workspace default when
    // the task pins none. Workspace-scoped read on the run path.
    getDefault: { scope: { kind: 'workspace', arg: 0 } },
    // Board CREATION writes the built-in preset library, and `RiskPolicyService` repairs a board
    // that predates that. Member-level (the preset CRUD is not admin-gated), workspace-scoped:
    // the same policy as the block/pipeline mutations above.
    upsert: { scope: { kind: 'workspace', arg: 0 } },
    // The preset-library editor reads one preset and deletes it. Both take the workspaceId as
    // arg0 and are member-level (the preset CRUD is not admin-gated), completing the merge-preset
    // library management surface (list/getDefault/upsert were already exposed for the board load).
    get: { scope: { kind: 'workspace', arg: 0 } },
    remove: { scope: { kind: 'workspace', arg: 0 } },
  },
  // The merge TRACK RECORD is the evidence side of the same merge policy, and every one of its
  // methods takes the workspaceId as arg0 — so the whole surface is proxied, workspace-scoped and
  // member-level exactly like the preset library above. It has to be: `MergeResolver` reads the
  // classification and writes the record ON THE RUN PATH, so a mothership-mode node with these
  // unproxied would resolve every per-class rule against an empty record set (silently reverting
  // to the score ceilings) and lose every merge decision it made.
  mergeTrackRecordRepository: {
    // Run path: the merger step's decision write (first-write-wins) + the notification card's
    // record lookup.
    insertIfAbsent: { scope: { kind: 'workspace', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    getByExecution: { scope: { kind: 'workspace', arg: 0 } },
    // The block-scoped merge controls resolve a block's most recent record to settle + tag it.
    getLatestByBlock: { scope: { kind: 'workspace', arg: 0 } },
    // External-merge attribution from the webhook ingest, keyed by `(repoId, prNumber)`.
    getByPullRequest: { scope: { kind: 'workspace', arg: 0 } },
    // Settling a decision + recording the reviewer-effort tag.
    patch: { scope: { kind: 'workspace', arg: 0 } },
    // The preset editor's per-class stats (ONE aggregate for every class).
    rollupByClass: { scope: { kind: 'workspace', arg: 0 } },
  },
  // The settled-gate projection is written BY THE ENGINE, on the run path, as each polling gate
  // reaches a terminal verdict — the same shape as the merge track record above, and proxied for
  // the same reason: a mothership-mode node runs the gates, so leaving this unproxied would make
  // the gate/CI-fixer attempt statistics permanently empty for every mothership deployment while
  // the dashboard section still rendered, which is the "an un-wired writer reads as zero" trap
  // the projection exists to avoid in the first place.
  //
  // It is deliberately NOT in the local-first `telemetry` bucket: nothing reads it on the node
  // (the dashboard read is admin-gated on the mothership), so a `node:sqlite` copy would be a
  // write-only store whose rows the operator could never see.
  //
  // `record(row)` binds on the record's own `workspaceId` FIELD, so a row can only ever land in
  // the caller's in-scope workspace. Member-level, matching the run path that produces it. The
  // account-scoped `statsSince` read and the `deleteOlderThan` prune stay mothership-internal
  // (admin-gated dashboard read; cron-owned prune).
  gateOutcomeRepository: {
    record: { scope: { kind: 'workspaceField', arg: 0 } },
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
    // (a write the board-load read triggers), the same member-level workspace-scoped write as
    // `riskPolicyRepository.upsert` above.
    upsert: { scope: { kind: 'workspace', arg: 0 } },
    // The model-preset library editor's read-one + delete, the mirror of the merge-preset
    // management pair above. Member-level, workspace-scoped.
    get: { scope: { kind: 'workspace', arg: 0 } },
    remove: { scope: { kind: 'workspace', arg: 0 } },
  },
  // Per-workspace agent system-prompt overrides — durable org state (an edit changes how every
  // run in the workspace behaves), so `remote` like the preset libraries above. `head` is on the
  // RUN path, not just the editor's: `AgentContextBuilder` resolves the live revision on EVERY
  // dispatch, so omitting it would fail an agent step with `unknown_method` rather than merely
  // dimming a panel.
  agentPromptRepository: {
    listRevisions: { scope: { kind: 'workspace', arg: 0 } },
    listRevisionsByKinds: { scope: { kind: 'workspace', arg: 0 } },
    listHeads: { scope: { kind: 'workspace', arg: 0 } },
    head: { scope: { kind: 'workspace', arg: 0 } },
    append: { scope: { kind: 'workspace', arg: 0 } },
  },
  // Per-workspace, per-agent-kind generation settings (the output-token ceiling) — durable org
  // state on exactly the same footing as the prompt overrides above, so `remote`. `get` is on the
  // RUN path: `AgentContextBuilder` resolves the dispatched kind's ceiling on EVERY dispatch, so
  // omitting it would fail an agent step with `unknown_method` rather than merely dimming a panel.
  workspaceAgentSettingsRepository: {
    get: { scope: { kind: 'workspace', arg: 0 } },
    list: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspace', arg: 0 } },
    remove: { scope: { kind: 'workspace', arg: 0 } },
  },
  // Which registered reusable operations a workspace HIDES: durable org state, so `remote` like
  // the two above. `list` is on the BOARD LOAD path (the snapshot filters the projected task-type
  // catalog through it) AND on the creation path (the refusal), so omitting it would fail every
  // board load on a mothership-mode node rather than merely dimming a settings screen. The
  // descriptors themselves stay node-local by design (a task type is inseparable from the code
  // registered beside it; see `backend/docs/reusable-operations.md`), which is exactly why the
  // per-workspace CHOICE about them has to travel: the catalog is code and the hide-list is data.
  taskTypeSuppressionRepository: {
    list: { scope: { kind: 'workspace', arg: 0 } },
    suppress: { scope: { kind: 'workspace', arg: 0 } },
    restore: { scope: { kind: 'workspace', arg: 0 } },
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
    // The batched counterpart to `get`, mirroring `taskRepository.listByRefs` below: attaching a
    // LIST of documents resolves them in one read rather than a point-read per document. arg0 is
    // the workspaceId → the `workspace` rule.
    listByRefs: { scope: { kind: 'workspace', arg: 0 } },
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
    // The batched counterpart to `get`: `AgentContextBuilder.resolveLinkedContext` resolves the
    // tracker issues a block's description names (Jira keys, `owner/repo#N` refs) in ONE
    // chunked-`IN` read. It is invoked UNCONDITIONALLY on every container-agent dispatch (the
    // call isn't guarded on there being any refs), so it is on the run path exactly like `get`
    // — omit it and EVERY such build fails the run with `unknown_method`. arg0 is the
    // workspaceId → the `workspace` rule.
    listByRefs: { scope: { kind: 'workspace', arg: 0 } },
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
  // The workspace's ONE outbound webhook endpoint: the management surface (get/put/delete behind
  // `integrations.manage`) and the two delivery paths that read it — the notification channel and
  // the run-lifecycle sink. The sink is why this is no longer optional: it reads on the run's
  // TERMINAL emit, and an un-routed method there fails on a laptop as a webhook that silently
  // never fires (both delivery paths are best-effort, so the refusal is swallowed by design).
  // `get`/`delete` take the workspaceId as arg0; the record-based `put(record)` binds on the
  // record's `workspaceId` FIELD, so a row can only ever land in the caller's own in-scope
  // workspace. Safe to expose: the repo returns the signing secret SEALED and never decrypts it
  // (sealing/decryption live in the service and the delivery paths under the LOCAL key), so no
  // plaintext credential crosses the machine API.
  notificationWebhookRepository: {
    get: { scope: { kind: 'workspace', arg: 0 } },
    put: { scope: { kind: 'workspaceField', arg: 0 } },
    delete: { scope: { kind: 'workspace', arg: 0 } },
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
    // The block-less dedup lookup for deployment/workspace-wide cards (`platform_health`). A
    // local node runs the platform-health sweep too, so it proxies this like `findOpenByBlock`.
    // Workspace-scoped, member-level — same policy as the reads above.
    findOpenByType: { scope: { kind: 'workspace', arg: 0 } },
    upsertOpenForBlock: { scope: { kind: 'workspace', arg: 0 } },
    // Block-less raises (a card with no `blockId`) and every status transition the inbox
    // performs right after a run settles — act / dismiss / escalate — go through `upsert`
    // (`NotificationService`), not `upsertOpenForBlock`. Workspace-scoped, member-level (the
    // inbox act/dismiss endpoints are not admin-gated) — same policy as the writes above.
    upsert: { scope: { kind: 'workspace', arg: 0 } },
    // The inbox `act` flow atomically claims the open card (`open` → `acted`) BEFORE running
    // its side effect, so a mothership node must proxy the claim like the surrounding
    // get/upsert. Workspace-scoped, member-level — same policy as `upsert`.
    claimForAction: { scope: { kind: 'workspace', arg: 0 } },
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
    // The usage report (Usage settings tab) — one workspace-scoped GROUP BY read, same
    // scoping as the workspace spend rollup above.
    usageBreakdownForWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    // Account/user budget-tier rollups (docs/initiatives/tiered-budgets.md), read on the spend
    // gate + the snapshot. Account-scoped and self-user-scoped respectively, mirroring the
    // account read + the per-user settings read above.
    totalsSinceForAccount: { scope: { kind: 'account', arg: 0 } },
    totalsSinceForUser: { scope: { kind: 'selfUser', arg: 0 } },
    // The spend LEDGER WRITE. This is the one repository that looks like telemetry and is not:
    // it is the org's BUDGET SAFEGUARD, and the three rollups above — which the spend gate reads
    // REMOTELY before every run — sum exactly these rows. Keeping the write laptop-local (the
    // rest of the telemetry bucket's home, PR 5) would make every local run invisible to the
    // workspace/account/user budget it must answer to, so the gate would under-enforce until a
    // batch sync caught up. One small row per metered call, no bodies.
    //
    // `usageRecord` — NOT the plain `workspaceField` rule — because the row carries the
    // DENORMALIZED `accountId`/`userId` the account- and user-tier rollups read directly: bound
    // on `workspaceId` alone, an in-scope node could stamp another account's id onto its rows and
    // exhaust that account's budget (pausing its runs) without ever touching its workspaces. The
    // rule pins both to what the caller already is.
    record: { scope: { kind: 'usageRecord', arg: 0 } },
    // The two batched forecast reads (`meteredSpendByWorkspaceSince` /
    // `meteredSpendByAccountSince`) stay OFF, like the sweeper-only reads above. They take a SET
    // of scope ids spanning the whole deployment and exist for the spend-alert sweep, which runs
    // on the mothership beside the ledger it reads; there is no per-workspace caller to scope
    // them to, and a node has no business asking about tenants it does not own.
  },
  // The rest of the telemetry bucket is LOCAL-FIRST (docs/initiatives/mothership-mode.md, PR 5):
  // a mothership-mode node writes and reads its per-call LLM metrics, agent-context snapshots,
  // performed web searches, provisioning log and modeled quota cycles in its own `node:sqlite`
  // telemetry store, so NONE of those repositories is remotely callable. `summarizeByExecution`
  // used to be the one exception — a run-path stopgap resolving against the MOTHERSHIP's
  // telemetry store, which on a mothership-mode node is empty of that node's calls, so it could
  // only ever report zeros; the local store now serves it, and the entry is gone rather than
  // left as dead surface.
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
    // Every read-modify-write on a review (answer / dismiss / recommendation / incorporate)
    // rides the rev-guarded conditional write, so a mothership-mode SPA that can't reach it
    // could not edit a review at all. Workspace-scoped on arg0, entity as arg1.
    compareAndSwap: { scope: { kind: 'workspace', arg: 0 } },
    // A fresh review run atomically replaces the block's prior one
    // (`RequirementReviewService.review`). Workspace-scoped on arg0 — completes the repo.
    replaceForBlock: { scope: { kind: 'workspace', arg: 0 } },
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
  // The ephemeral-environment SELF-TEST run store (`environment_test_runs`): a member-level,
  // workspace-scoped run-path diagnostic (`EnvironmentTestService` — start / durable poll /
  // stop, plus the snapshot's in-flight-runs read `listRunningByWorkspace`). The whole repo is
  // remote: `get`/`updateIfRunning`/`listRunningByWorkspace` take the workspaceId as arg0 (the
  // `workspace` rule); the record-based `insert(record)` binds on the run's `workspaceId` FIELD
  // (the `workspaceField` rule). The sweeper-only cross-workspace `listStale` stays
  // mothership-internal (its cron owns it), per the global-sweeper exclusion above. The GitHub
  // half of the self-test (branch create/delete via `resolveRunRepoContext`) rides mothership
  // GitHub token delegation (`/internal/github/installation-token`), not this table. What
  // still gates a FULL mothership-mode self-test: the provisioning WRITES
  // (`environmentRegistryRepository.insert`/`update`) stay off until the secrets-delegation
  // slice, so the run's provisioning stage fails cleanly there — the store itself is proxied
  // so the runs surface, clean up, and complete the moment that slice lands.
  environmentTestRunRepository: {
    get: { scope: { kind: 'workspace', arg: 0 } },
    insert: { scope: { kind: 'workspaceField', arg: 0 } },
    updateIfRunning: { scope: { kind: 'workspace', arg: 0 } },
    listRunningByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
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
    compareAndSwap: { scope: { kind: 'workspace', arg: 0 } },
    replaceForBlock: { scope: { kind: 'workspace', arg: 0 } },
  },
  brainstormSessionRepository: {
    getByBlockStage: { scope: { kind: 'workspace', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspace', arg: 0 } },
    compareAndSwap: { scope: { kind: 'workspace', arg: 0 } },
    replaceForBlockStage: { scope: { kind: 'workspace', arg: 0 } },
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
  // The consensus-GROUP library — authored, durable board config (which models review a task
  // and at what estimate bar), so `remote` like the preset libraries above rather than a local
  // knob. `listByIds` is on the RUN path, not just the editor's: `AgentContextBuilder` resolves
  // a tiered step's group set on EVERY dispatch, so omitting it would fail an agent step with
  // `unknown_method` instead of merely dimming a settings panel.
  consensusGroupRepository: {
    list: { scope: { kind: 'workspace', arg: 0 } },
    listByIds: { scope: { kind: 'workspace', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspace', arg: 0 } },
    remove: { scope: { kind: 'workspace', arg: 0 } },
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
  // The SENSITIVE per-service test credentials, keyed by service-frame block like
  // `releaseHealthConfigRepository` above. `credentials` rides a SEALED blob (sealed/decrypted
  // in the service under the LOCAL key), so no plaintext crosses the machine API — the same
  // precedent as the observability / package-registry connections. The inspector CRUD
  // (`getByBlock`/`deleteByBlock`) + the run-path frame read (`getByBlock`) are workspace-scoped
  // on arg0; the record-based `upsert` binds on its `workspaceId` FIELD. `listByWorkspace` has no
  // consumer yet, so it stays pending (marked in the allow-list completeness test).
  testSecretsRepository: {
    getByBlock: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspaceField', arg: 0 } },
    deleteByBlock: { scope: { kind: 'workspace', arg: 0 } },
  },
  // The PER-WORKSPACE CAPABILITY CREDENTIALS — the tenant-scoped home for the secrets a registered
  // tool server / generative binary integration declares by name. `credentials` rides a SEALED
  // blob (sealed/decrypted in the service under the LOCAL key), so no plaintext crosses the
  // machine API — the same precedent as `testSecretsRepository` above. This is org state a RUN
  // resolves, so `remote` is the only bucket that works: a mothership-mode node has no `db` of its
  // own, and a credential the operator set on the mothership must reach the dispatch that needs
  // it. The settings CRUD and the dispatch-time read are the SAME methods, all workspace-scoped
  // on arg0 except the record-based `upsert` and `compareAndSwap`, which bind on the record's
  // `workspaceId` FIELD. The rev-guarded pair (`compareAndSwap`/`deleteIfRev`) carries the
  // checklist's per-key writes: the row is ONE blob, so without them a mothership-mode SPA could
  // only ever save a key by blindly overwriting a concurrent editor's.
  capabilityCredentialRepository: {
    get: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspaceField', arg: 0 } },
    compareAndSwap: { scope: { kind: 'workspaceField', arg: 0 } },
    deleteIfRev: { scope: { kind: 'workspace', arg: 0 } },
    delete: { scope: { kind: 'workspace', arg: 0 } },
  },
  // The PER-WORKSPACE OAUTH GRANTS a board holds against remote MCP tool servers. Sealed exactly
  // like the credentials above (opened in the service under the LOCAL key), so no token crosses
  // the machine API, and `remote` for the identical reason: the grant is org state a RUN resolves,
  // and a mothership-mode node has no `db` to keep it in — a connection an operator made on the
  // mothership has to reach the dispatch that needs the token. The connect/disconnect CRUD and the
  // dispatch's refresh are the SAME methods; everything is workspace-scoped on arg0 except the
  // record-based `upsert`/`compareAndSwap`, which bind on the record's `workspaceId` FIELD. The
  // rev-guarded `compareAndSwap` is what makes a refresh safe across two nodes rather than two
  // requests, which is precisely the case a mothership deployment makes ordinary.
  mcpOAuthGrantRepository: {
    get: { scope: { kind: 'workspace', arg: 0 } },
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspaceField', arg: 0 } },
    compareAndSwap: { scope: { kind: 'workspaceField', arg: 0 } },
    delete: { scope: { kind: 'workspace', arg: 0 } },
  },
  // The per-service PRE-PR VALIDATION CHECKS, keyed by service-frame block like
  // `releaseHealthConfigRepository` above. Nothing sealed — the commands are operator-authored
  // shell strings that run inside the run's own container — so the plain record crosses the
  // machine API. The inspector CRUD (`getByBlock`/`listByWorkspace`/`delete`) and the dispatch's
  // frame read (`getByBlock`) are workspace-scoped on arg0; the record-based `upsert` binds on
  // its `workspaceId` FIELD.
  validationConfigRepository: {
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
  // fan-out, the cron `listActive`) also stays off — only the two SCOPED reads the run path needs
  // are opened here.
  //
  // `listActiveForAccount` is the second: the account-tier installation lookup
  // (`createTierInstallationResolvers.forAccount`) every repo-sourced library's sync and the skill
  // run path's resource fetch go through. It exists precisely BECAUSE the cron `listActive` cannot
  // be exposed — a global read across every tenant answers a single-account question, and no scope
  // rule can bind an argument-less method. The scoped form takes the accountId as arg0 (the
  // `account` rule) and returns only rows bound to that account or to one of its own boards.
  githubInstallationRepository: {
    getByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    listActiveForAccount: { scope: { kind: 'account', arg: 0 } },
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
  // Model-GENERATED condensed briefs for long standards (`FragmentBriefService`), read and
  // written on the RUN path: a mothership-mode implementer dispatch resolves them alongside the
  // fragment bodies above, so leaving them off would silently fold full standards on every turn
  // of every local loop — the exact cost this feature exists to remove. `remote`, not
  // `local-first`: they are org-durable derived state (a condensation an account paid a model
  // for, reused by every board in it), not per-user runner telemetry. The rows hold model output
  // condensing a standard the same token already reads in full through `promptFragmentRepository`,
  // so they widen no exposure, and every method is keyed by the same `(ownerKind, ownerId)` pair —
  // bound by the `owner` rule (positional) / `ownerField` rule (the record's fields on `upsert`),
  // so a token scoped to one account can neither read nor overwrite another tenant's briefs.
  fragmentBriefRepository: {
    listByOwner: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    upsert: { scope: { kind: 'ownerField', arg: 0 } },
    delete: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
  },
  // The fragment-source (repo-linkage) library the SPA lists + links (`FragmentSourceService`), owner
  // scoped exactly like the fragments above. `listByOwner` (the sources list) is bound by the `owner`
  // rule; the record-based `upsert(record)` by `ownerField`. The `sourceId`-keyed reads/writes
  // (`get`/`updateSyncState`/`softDelete`) stay off — they back the repo-SYNC management the
  // mothership owns (the source service needs a GitHub client, which a mothership node does not have),
  // so a later GitHub-sync-in-mothership slice opens them with a source→owner resolver.
  //
  // KNOWN GAP, tracked in `docs/initiatives/mothership-mode.md`: `upsert` has the same id-keyed
  // conflict shape the skills library's source upsert does (`ON CONFLICT (id) DO UPDATE`, no
  // re-`SET` of the owner columns), so plain `ownerField` binds only the DECLARED owner and an
  // in-scope caller naming a foreign source id can repoint another tenant's fragment source at a
  // repo it controls. The fix is the `ownerField` analogue of `accountFieldUpsert` below — it needs
  // a source→owner-PAIR resolver (`(ownerKind, ownerId)`, not a bare accountId) plus its own
  // round-trip tests, which is why it is not folded in here. Do NOT copy `ownerField` onto a new
  // id-keyed upsert in the meantime.
  fragmentSourceRepository: {
    listByOwner: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    upsert: { scope: { kind: 'ownerField', arg: 0 } },
  },
  // --- Repo-sourced Claude Skills library (ADR 0024) ------------------------------
  // Skills live in ONE tier — the ACCOUNT — so every method here binds on an accountId rather
  // than the `(ownerKind, ownerId)` pair the fragment library uses: positionally via the `account`
  // rule, on a record's `accountId` FIELD via `accountField` / `accountFieldUpsert`, or (the sync
  // surface) via the `skillSource` rule, which resolves a source id to its owning account
  // server-side. A machine token scoped to one account can therefore neither read nor write another
  // tenant's skills.
  //
  // Remote rather than `telemetry` or `local-sqlite` for the reason the bucket test names: what
  // READS this is a RUN. `SkillRunResolver` resolves the picked skill (and ADR 0029's declared
  // `{ catalogSkillId }` capabilities) out of `accountSkillRepository` at every dispatch, and
  // `skillResolver` is a HARD dependency for a `skill` step — so leaving the catalog off would
  // not merely blank a panel, it would fail every skill-running dispatch on a mothership-mode
  // node with `unknown_method`. The rows carry no secrets (a `SKILL.md` body plus a resource
  // manifest of `{ path, sha, size }`); the resource BODIES are fetched from the repo at
  // dispatch and never stored, so nothing credential-bearing crosses the machine API.
  //
  // UNLIKE the fragment / foundational-service libraries, the repo-SYNC surface is remote here
  // too. Those deferred theirs because a sync needs a GitHub client — but a mothership-mode node
  // HAS one (`DelegatedAppTokenSource` mints the account's App token over the same machine API),
  // so its `SkillSourceService` assembles and its link/sync/unlink routes are live. Leaving the
  // sourceId-keyed methods off would leave those routes reachable and broken, which is worse than
  // either serving them or hiding them. `skillSource` is the rule that binds them; the sibling
  // libraries can adopt it when their own sync surface lands.
  accountSkillRepository: {
    // Catalog reads: the account library panel, the pipeline builder's skill picker, and the RUN
    // path (`SkillCatalogService.list`/`get`, behind the per-account `skillCatalog` cache slice).
    listByAccount: { scope: { kind: 'account', arg: 0 } },
    get: { scope: { kind: 'account', arg: 0 } },
    // Sync writes. `upsert(record)` binds on the record's `accountId` FIELD, so a synced skill can
    // only ever land under an in-scope account. Plain `accountField` is sufficient HERE (and NOT for
    // `skillSourceRepository.upsert` below) because this write conflicts on `(account_id, skill_id)`
    // on both runtimes: the bound account is part of the key, so a foreign `skillId` inserts a fresh
    // row under the caller's own account and can never mutate another tenant's. `softDelete(accountId,
    // skillId, at)` is positional.
    upsert: { scope: { kind: 'accountField', arg: 0 } },
    softDelete: { scope: { kind: 'account', arg: 0 } },
    // The source-keyed reconcile pair: list a source's live skills to diff against the repo, and
    // tombstone all of them in one write on unlink. Both bind through `skillSource`.
    listBySource: { scope: { kind: 'skillSource', arg: 0 } },
    softDeleteBySource: { scope: { kind: 'skillSource', arg: 0 } },
  },
  // The repo-linkage rows the library panel lists and the sync pins its head commit on.
  // `listByAccount` is positional; the three sourceId-keyed methods bind through `skillSource`.
  //
  // `upsert(record)` takes `accountFieldUpsert`, NOT the plain `accountField` its sibling above uses,
  // because this write conflicts on the `id` ALONE and does not re-`SET account_id` (D1
  // `ON CONFLICT (id) DO UPDATE`, Drizzle `target: skillSources.id`). The row it lands on is therefore
  // chosen by the id, not by the bound account — so binding only the DECLARED `accountId` would let a
  // token scoped to account A name account B's source id, declare its own account to pass the check,
  // and repoint B's link at an attacker-controlled repo; B's next sync folds that repo's `SKILL.md`
  // bodies — agent INSTRUCTIONS — into B's catalog. `accountFieldUpsert` additionally binds the STORED
  // row's account, so an existing foreign row is refused while a create (no such row) still passes.
  //
  // `listByRepo` is deliberately absent: it is the GLOBAL `(repoOwner, repoName)` → sources reverse
  // lookup the push-webhook fan-out uses, spanning every account by construction, so no rule can
  // bind it. It runs on the mothership (which receives the webhook), never on a laptop — the same
  // "unscoped, mothership-internal" bucket as `slackConnectionRepository.getByTeam`.
  skillSourceRepository: {
    listByAccount: { scope: { kind: 'account', arg: 0 } },
    get: { scope: { kind: 'skillSource', arg: 0 } },
    upsert: { scope: { kind: 'accountFieldUpsert', arg: 0, entity: 'skillSource' } },
    updateSyncState: { scope: { kind: 'skillSource', arg: 0 } },
    softDelete: { scope: { kind: 'skillSource', arg: 0 } },
  },
  // --- Foundational services (backend/docs/adr/0031-foundational-services.md) -----------
  // The tiered catalog of shared capabilities an Architect designs against, and the API contract
  // documents its consumers lazily read. Both are `(ownerKind, ownerId)`-keyed org/durable state
  // — the `remote` bucket by default — and every method here binds with the same `owner` /
  // `ownerField` rules the prompt-fragment library uses, so a token scoped to one account can
  // neither read nor overwrite another tenant's catalog.
  //
  // Remote rather than `telemetry` or `local-sqlite` for the reason the bucket test names: what
  // READS this is a RUN. A mothership-mode node dispatching an architect step resolves the merged
  // catalog over this RPC, and its coder resolves the declared services' contract documents the
  // same way — so a catalog that lived only on the laptop would make every design on a
  // mothership-mode deployment silently see an empty catalog and rebuild capabilities the org
  // already runs. `listByServiceIds` is the hot one (once per consumer dispatch) and is already a
  // single chunked `IN` query, so it stays one round trip over the wire too.
  //
  // The sourceId-keyed sync methods (`listBySource`, `softDeleteBySource`, the source repo's
  // `get`/`updateSyncState`/`softDelete`/`listStale`) stay OFF, exactly as the fragment library's
  // do: they back the repo-SYNC the mothership owns (a sync needs a GitHub client, which a
  // mothership-mode node does not have), and none of them carries an `(ownerKind, ownerId)` pair
  // for a rule to bind — a source→owner resolver is what a later sync-in-mothership slice owes.
  foundationalServiceRepository: {
    listByOwner: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    get: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    upsert: { scope: { kind: 'ownerField', arg: 0 } },
    softDelete: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    // Lifting a board's suppression of an inherited service. Same owner rule as `softDelete` and
    // the same management surface, so it belongs on the same side of the boundary: leaving it off
    // would let a mothership-mode board opt OUT of an account service with no way back in.
    hardDelete: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
  },
  apiContractRepository: {
    listManifestByOwner: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    listByServiceIds: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    replaceForService: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    deleteForService: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
  },
  foundationalServiceSourceRepository: {
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
  // --- Slack integration management surface ---------------------------------------
  // The Slack integration settings a mothership-mode SPA manages (`SlackController` →
  // `SlackConnectionService` / `SlackSettingsService` / `SlackMemberMappingService`): connect /
  // disconnect the per-account Slack workspace, edit the per-workspace notification routing, and
  // maintain the per-account GitHub-user → Slack-member mapping. The controller mounts under
  // `/workspaces/:workspaceId` and is member-level (not admin-gated), so it follows the same policy
  // as the observability / environment / runner-pool connection panels above.
  //
  // Safe to expose exactly like those connection surfaces: the Slack bot token rides a SEALED blob
  // (`tokenCipher`) — the repo returns it verbatim (it does NOT decrypt); sealing/decryption live in
  // the Slack service/channel under the LOCAL key, so no plaintext credential crosses the machine
  // API and the mothership only ever stores ciphertext (the "mothership ENCRYPTION_KEY never reaches
  // the laptop" split holds). The settings + member-mapping rows carry NO secrets at all.
  //
  // Scope of what this unlocks: the settings PANELS work end-to-end (connect / disconnect / route /
  // map + read back the redacted connection view). What it does NOT change: mothership-side Slack
  // DELIVERY of a notification raised by a hosted teammate — that reads + decrypts the token on the
  // mothership, which cannot open a laptop-sealed blob, so it rides the later secrets-delegation
  // slice, exactly like the observability gate probe. Local delivery (the run's own node raised the
  // notification and holds the local key) is unaffected.
  //
  // `slackConnectionRepository` is per-ACCOUNT: `getByAccount`/`softDelete` take the accountId as
  // arg0 (the `account` rule — the local service resolves the workspace → account via the already
  // remote `workspaceRepository.accountOf`, then calls with that in-scope accountId), and the
  // record-based `upsert(record)` binds on the record's `accountId` FIELD (the new `accountField`
  // rule). `getByTeam` is NOT here: it is a GLOBAL teamId → connection lookup used only by the
  // inbound OAuth callback / event webhook, which run on the mothership (never the laptop) and
  // cannot be account-scoped — it stays mothership-internal (classified `sweeper` in the drift
  // guard, the same "unscoped, mothership-internal" bucket as `repoProjectionRepository.listByInstallation`).
  slackConnectionRepository: {
    getByAccount: { scope: { kind: 'account', arg: 0 } },
    upsert: { scope: { kind: 'accountField', arg: 0 } },
    softDelete: { scope: { kind: 'account', arg: 0 } },
  },
  // Per-workspace notification routing (channel per notification kind + a mentions flag). No
  // secrets. `getByWorkspace` takes the workspaceId as arg0 (the `workspace` rule); the
  // record-based `upsert(record)` binds on the record's `workspaceId` FIELD (the `workspaceField` rule).
  slackSettingsRepository: {
    getByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    upsert: { scope: { kind: 'workspaceField', arg: 0 } },
  },
  // Per-account GitHub-user → Slack-member mapping (for @-mentions). No secrets. Both methods take
  // the accountId as arg0 positionally (`upsert(accountId, entries, at)` — a positional accountId,
  // not a record), so the `account` rule binds both.
  slackMemberMappingRepository: {
    getByAccount: { scope: { kind: 'account', arg: 0 } },
    upsert: { scope: { kind: 'account', arg: 0 } },
  },
}

/**
 * The repositories a mothership-mode node serves from its OWN store instead of the RPC: the
 * LOCAL-FIRST telemetry bucket (docs/initiatives/mothership-mode.md, product decision 5). They are
 * written on the hot path of every LLM call, container dispatch, web search and provisioning
 * attempt — a per-call network round trip there would be a tax on every run — and read back by the
 * observability panel, the board's per-step rollups and the provisioning "View logs" surfaces,
 * which want THIS machine's history.
 *
 * Declared HERE, beside the allow-list, because the two are complements and their failure modes are
 * silent in opposite directions: the remote registry is TOTAL (every unnamed repository becomes a
 * remote proxy), so a telemetry repository left off this list resolves to a proxy whose every call
 * the allow-list answers with `unknown_method` — writes vanish into the best-effort recorders and
 * reads come back empty, with nothing failing. Naming the bucket in one place lets the local
 * facade's composition be TYPED by it (so it cannot half-wire) and the drift guard assert the two
 * tables stay disjoint.
 *
 * Note the deliberate absence of `tokenUsageRepository`: the spend ledger has this bucket's write
 * profile but is the org's budget SAFEGUARD, whose rollups the spend gate reads remotely — see its
 * `record` entry above.
 */
export const LOCAL_FIRST_PERSISTENCE_REPOSITORIES = [
  'llmCallMetricRepository',
  'agentContextSnapshotRepository',
  'agentSearchQueryRepository',
  'agentToolCallRepository',
  'provisioningLogRepository',
  'subscriptionQuotaCycleRepository',
] as const

/** A repository name in {@link LOCAL_FIRST_PERSISTENCE_REPOSITORIES}. */
export type LocalFirstPersistenceRepository = (typeof LOCAL_FIRST_PERSISTENCE_REPOSITORIES)[number]
