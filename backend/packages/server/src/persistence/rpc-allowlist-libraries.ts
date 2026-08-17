import type { PersistenceMethodTable } from './rpc.js'

// The repo-sourced CONTENT LIBRARY half of the mothership-mode persistence allow-list: prompt
// fragments, Claude Skills and foundational services, with their generated briefs, contract
// manifests and the three source tables their repo sync writes.
//
// Split out of `rpc-allowlist.ts` when that file reached its size budget. These belong together for
// a reason beyond size: all three are tenant-owned catalogs a RUN resolves, all three sync from a
// git repo through a source row, and all three bind through the owner-pair rules (`owner` /
// `ownerField` / `ownerFieldUpsert` / `librarySource`, and the account-keyed `skillSource` twin)
// rather than through a workspace argument. Spread into `REMOTE_PERSISTENCE_METHODS`; the merged
// table is what the dispatcher and the drift guard read.

/** The content libraries' remote surface. See `rpc-allowlist.ts` for the table's contract. */
export const LIBRARY_PERSISTENCE_METHODS: PersistenceMethodTable = {
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
  // `listBySource` (the repo-sync reconcile read) joins them: see the `librarySource` note on
  // `fragmentSourceRepository` below for why the sync surface is no longer deferred.
  promptFragmentRepository: {
    listByOwner: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    get: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    upsert: { scope: { kind: 'ownerField', arg: 0 } },
    softDelete: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    // The source-keyed reconcile pair, mirroring the skill and foundational-service libraries':
    // list a source's live fragments to diff against the repo listing, and tombstone all of them
    // in one write on unlink. Each method carries a source id and nothing else, so the
    // `librarySource` rule resolves that source's owning tier pair server-side (`fragmentSource`
    // names the table it lives in).
    listBySource: { scope: { kind: 'librarySource', arg: 0, entity: 'fragmentSource' } },
    softDeleteBySource: { scope: { kind: 'librarySource', arg: 0, entity: 'fragmentSource' } },
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
  // The fragment-source (repo-linkage) library the SPA lists, links and SYNCS
  // (`FragmentSourceService`), owner scoped exactly like the fragments above. `listByOwner` is bound
  // by the `owner` rule; the sourceId-keyed sync methods by `librarySource`, which resolves a
  // source's owning `(ownerKind, ownerId)` pair server-side.
  //
  // The sync half was deferred on a premise that is no longer true: that a mothership-mode node has
  // no GitHub client. Token delegation gave it one (`DelegatedAppTokenSource` mints the tier's App
  // token over the same machine API), which is what already made the SKILLS library's sync surface
  // remote — so these routes were reachable and broken, the state that is worse than either serving
  // them or hiding them. `librarySource` is `skillSource` generalised to a tier PAIR, because a
  // fragment source can be owned by a workspace as well as an account.
  //
  // `upsert(record)` takes `ownerFieldUpsert`, NOT the plain `ownerField` the fragments above use.
  // This is the gap the skills slice named and could not close: the write conflicts on the `id`
  // ALONE and never re-`SET`s the owner columns, so binding only the DECLARED owner would let an
  // in-scope caller name a foreign source id and repoint another tenant's link at a repo it
  // controls, whose Markdown bodies the victim's next sync folds into their prompts as standards.
  // The rule binds the STORED row's owner too; a create (no such row) still passes on the declared
  // half. `ownerFieldUpsert` is the owner-pair analogue of `accountFieldUpsert` above, and is what
  // any new id-keyed library upsert must use.
  fragmentSourceRepository: {
    listByOwner: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    upsert: { scope: { kind: 'ownerFieldUpsert', arg: 0, entity: 'fragmentSource' } },
    get: { scope: { kind: 'librarySource', arg: 0, entity: 'fragmentSource' } },
    updateSyncState: { scope: { kind: 'librarySource', arg: 0, entity: 'fragmentSource' } },
    softDelete: { scope: { kind: 'librarySource', arg: 0, entity: 'fragmentSource' } },
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
  // This was the FIRST library whose repo-SYNC surface went remote. A sync needs a GitHub client,
  // and a mothership-mode node HAS one (`DelegatedAppTokenSource` mints the account's App token
  // over the same machine API), so its `SkillSourceService` assembles and its link/sync/unlink
  // routes are live. Leaving the sourceId-keyed methods off would leave those routes reachable and
  // broken, which is worse than either serving them or hiding them. `skillSource` is the rule that
  // binds them (skills live in one tier, so it resolves a bare accountId); the sibling
  // libraries have since adopted it, in its owner-pair form (`librarySource`).
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
  // The sourceId-keyed sync methods now bind through `librarySource` (see the fragment library
  // above: the same rule, the same dead premise, and the same node-side GitHub client). What stays
  // OFF is `foundationalServiceSourceRepository.listStale` (the autorefresh sweep's global query)
  // and `listByRepo` (the push-webhook fan-out's), both unscoped across tiers by construction and
  // both running where a delivery ARRIVES, which is never a laptop.
  foundationalServiceRepository: {
    listByOwner: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    get: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    upsert: { scope: { kind: 'ownerField', arg: 0 } },
    softDelete: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    // Lifting a board's suppression of an inherited service. Same owner rule as `softDelete` and
    // the same management surface, so it belongs on the same side of the boundary: leaving it off
    // would let a mothership-mode board opt OUT of an account service with no way back in.
    hardDelete: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    // The source-keyed reconcile pair, mirroring `accountSkillRepository`'s: list a source's live
    // services to diff against the repo, and tombstone all of them in one write on unlink.
    listBySource: {
      scope: { kind: 'librarySource', arg: 0, entity: 'foundationalServiceSource' },
    },
    softDeleteBySource: {
      scope: { kind: 'librarySource', arg: 0, entity: 'foundationalServiceSource' },
    },
  },
  apiContractRepository: {
    listManifestByOwner: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    listByServiceIds: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    replaceForService: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    deleteForService: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
  },
  // `upsert` takes `ownerFieldUpsert` for exactly the reason `fragmentSourceRepository.upsert` does:
  // it conflicts on the `id` alone, so the declared owner does not decide which row is written.
  foundationalServiceSourceRepository: {
    listByOwner: { scope: { kind: 'owner', kindArg: 0, idArg: 1 } },
    upsert: {
      scope: { kind: 'ownerFieldUpsert', arg: 0, entity: 'foundationalServiceSource' },
    },
    get: { scope: { kind: 'librarySource', arg: 0, entity: 'foundationalServiceSource' } },
    updateSyncState: {
      scope: { kind: 'librarySource', arg: 0, entity: 'foundationalServiceSource' },
    },
    softDelete: {
      scope: { kind: 'librarySource', arg: 0, entity: 'foundationalServiceSource' },
    },
  },
}
