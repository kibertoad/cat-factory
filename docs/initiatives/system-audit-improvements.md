# Initiative: system audit — data lifecycle, runtime parity, robustness & coverage

**Status:** in progress (items 1–3 landed) · **Owner:** core · **Started:** 2026-07-11

> This is the durable source of truth for a multi-PR initiative. Read it first before
> picking up the next slice; update the checklist at the end of each PR.

## Goal & rationale

A codebase-wide functionality audit (execution engine, runtime facades, persistence,
harness, SPA stores, e2e/CI) surfaced a bounded set of **less obvious but clearly
beneficial** improvements that no existing tracker owns. The repo is unusually well
self-tracked, so the bulk of this audit's job was **deduplication**: everything already
owned elsewhere is explicitly excluded (see below) and must NOT be re-added here. What
remains clusters into four themes:

- **Data lifecycle** — tables and blobs that grow without bound or orphan permanently on
  normal operations (workspace delete, notification churn). Invisible today, unbounded
  cost tomorrow.
- **Runtime symmetry** — machinery duplicated verbatim across facades, a Node ingest path
  that silently degrades to inline execution, and conformance-suite blind spots where a
  D1 ⇄ Drizzle drift would ship untested.
- **Robustness & correctness** — small, verified gaps: a periodic sweep with an N+1 the
  planned cache can't fix on the Worker, a health endpoint with no readiness signal, one
  frontend store missing the standard anti-clobber guard.
- **Coverage & hygiene** — the largest frontend component has zero e2e coverage, the CI
  lane-gating filters are themselves unguarded, and several docs (including CLAUDE.md)
  have drifted from verified reality.

### Explicitly excluded (already tracked elsewhere — do not re-add)

- Every N+1 / homebrew-cache / hot-path finding in
  [`performance-optimizations.md`](./performance-optimizations.md) items 1–23 (incl. the
  AccountSettings 30s Map, SpendService TTL Maps, `notifications.listOpen` unbounded
  SELECT payload).
- Security findings SEC-1…SEC-11 in
  [`security-hardening-round-2.md`](./security-hardening-round-2.md) (incl. the
  per-isolate auth rate limiter = SEC-4).
- Run-wedge/recovery cases F1–F14 in [`stuck-run-audit.md`](./stuck-run-audit.md).
- The **entire regex→structured-error migration**, owned by
  [`error-message-coverage.md`](./error-message-coverage.md) section I. The one gap this
  audit found there (the installation-token-gone message-regex classifiers) was added to
  THAT tracker as row I7, not here. Item 4 below covers only the code-duplication half
  (hoisting the reconcile loop); its regex conversion is I7's job.
- Cache-slice work ([`caching-layer.md`](./caching-layer.md)), UX items
  ([`ux-papercuts.md`](./ux-papercuts.md) / [`ux-qol-pass.md`](./ux-qol-pass.md)), and the
  strangler items in `docs/refactoring-candidates.md` (e.g. the manifest-driven agent-kind
  migration).
- The deliberately-accepted bounded reference point-reads in
  `AgentContextBuilder.ts:883-905` (documented in code as accepted; listed here so the
  next auditor doesn't re-litigate them).

## Target patterns (copy these, don't invent)

- **Retention prune**: copy an existing sweep pair — a `deleteOlderThan`-shaped port
  method mirrored D1 ⇄ Drizzle, invoked from BOTH
  `backend/runtimes/cloudflare/src/infrastructure/workflows/retention.ts` and
  `backend/runtimes/node/src/retention.ts`, with a conformance prune assertion (copy
  `defineAgentContextSuite`'s prune test shape,
  `backend/internal/conformance/src/agent-context-suite.ts:118`).
- **Guarded sweeper**: the `running`-flag re-entrancy guard in
  `backend/runtimes/node/src/kaizen.ts:28-46` / `githubReconcile.ts:97-112`.
- **Batched port method** instead of a loop point-read: copy
  `ServiceRepository.listByIds` — add the chunked-`IN` method to the kernel port,
  implement in BOTH repos, assert in conformance.
- **Monotonic-refresh store guard**: `stores/workspace.ts`'s sequence guard + its
  `workspace.spec.ts` out-of-order test (the CLAUDE.md live-push coherence rule).
- **Shared runtime machinery**: hoist duplicated facade code into `@cat-factory/server`
  (the `escalateNotifications.ts` / `makeResolveRunRepoContext` precedent) with each
  facade supplying only its driver.
- **e2e spec shape**: seed/trigger over REST, assert only on live pushed UI updates,
  `data-testid` selectors only, `fakeInlineModel.ts` for inline-LLM determinism (see
  `backend/internal/e2e/README.md`).

## Per-item status checklist

Priority: **P1** = correctness/unbounded-growth on a normal operation; **P2** = clear
benefit, bounded blast radius; **P3** = hygiene/polish. Effort S/M/L.

| #   | Pri | Area        | Finding (short)                                                                             | Effort | Status  | PR        |
| --- | --- | ----------- | ------------------------------------------------------------------------------------------- | ------ | ------- | --------- |
| 1   | P1  | retention   | `notifications` never pruned in either facade (upsert/escalate only, no delete)             | M      | ✅ done | #1020     |
| 2   | P1  | retention   | Workspace-delete cascade clears only 7 tables → permanent orphans in ~40 others             | M      | ✅ done | (this PR) |
| 3   | P1  | retention   | Binary-artifact rows + blob bytes of deleted workspaces never reclaimed                     | M      | ✅ done | (this PR) |
| 4   | P2  | parity      | GitHub reconcile loop duplicated verbatim across Node/Worker — hoist to shared server pkg   | S      | ⬜ todo |           |
| 5   | P1  | parity      | Node async GitHub ingest runs inline in the request; add pg-boss-backed queue impls         | M–L    | ⬜ todo |           |
| 6   | P2  | parity      | Node sweeper re-entrancy guards inconsistent (initiativeLoop / recurring / escalation)      | S      | ⬜ todo |           |
| 7   | P2  | conformance | Four retention prunes have no cross-runtime conformance assertion                           | S–M    | ⬜ todo |           |
| 8   | P2  | engine      | Notification-escalation sweep: per-workspace settings point-read (N+1 the cache can't fix)  | M      | ⬜ todo |           |
| 9   | P2  | ops         | Node `/health` is a static 200 — add a `/ready` readiness probe (pool + pg-boss)            | S      | ⬜ todo |           |
| 10  | P2  | frontend    | `provisioningLogs` store: unbounded per-execution map + unguarded out-of-order overwrite    | S      | ⬜ todo |           |
| 11  | P3  | api         | Error code `validation` maps to two HTTP statuses (400 schema vs 422 domain)                | S      | ⬜ todo |           |
| 12  | P1  | e2e         | Requirements-review flow has zero e2e coverage (largest SPA component, 1.2k lines)          | M      | ⬜ todo |           |
| 13  | P2  | e2e         | Inline agent windows (brainstorm/clarity/consensus/doc-interview) have no e2e specs         | M      | ⬜ todo |           |
| 14  | P2  | ci          | `paths-filter` lane-gating globs are unguarded against drift (silent suite skips)           | S      | ⬜ todo |           |
| 15  | P3  | frontend    | Store-level out-of-order clobber specs cover ~5 of ~40 stateful stores — establish the rule | M      | ⬜ todo |           |
| 16  | P2  | docs        | CLAUDE.md "Node GitHub connect/sync still needs the integration on Postgres" note is stale  | S      | ⬜ todo |           |
| 17  | P3  | docs        | `refactoring-candidates.md`/`modularisation.md` stale; the two biggest files untracked      | S      | ⬜ todo |           |
| 18  | P3  | docs        | Convert finished initiatives to ADRs (`custom-initiative-definitions`, `coder-fork`)        | S      | ⬜ todo |           |
| 19  | P2  | frontend    | Accessibility whitespace: no a11y tracker/doc; 48/176 components carry any `aria-*`         | M      | ⬜ todo |           |
| 20  | P3  | frontend    | Close i18n phase X (`utils/catalog.ts` meta tables + 2 pages), retire the progress table    | M      | ⬜ todo |           |

## Detailed findings

### Cluster A — data lifecycle & retention

#### 1. `notifications` never pruned in either facade — P1

`D1NotificationRepository`
(`backend/runtimes/cloudflare/src/infrastructure/repositories/D1NotificationRepository.ts`)
and the Drizzle equivalent (`backend/runtimes/node/src/repositories/notifications.ts`)
expose `get` / `listOpen` / `findOpenByBlock` / `upsert` / `claimForAction` /
`escalateStaleOpen` — and **no delete**. Neither retention sweep
(`cloudflare/src/infrastructure/workflows/retention.ts`, `node/src/retention.ts`) touches
the table, and the workspace-delete cascade doesn't either (item 2). A busy workspace
emits a notification on every waiting/decision/park event, so resolved rows accumulate
forever on a table read on the hot path (`listOpen` per snapshot; the
`idx_notifications_open` partial index keeps reads fast for now, but growth is unbounded).

**Fix:** add `deleteResolvedOlderThan(cutoff)` to the kernel port + both repos, wire into
both retention sweeps under a retention knob (default generous, e.g. 90 days for
resolved/dismissed rows only — never open ones), and add a conformance prune assertion
(pairs with item 7's suite).

#### 2. Workspace-delete cascade incomplete → permanent orphans — P1

Both facades' workspace delete clears the same 7 tables (`workspace_services`,
`services`, `environments`, `agent_runs`, `blocks`, `pipelines`, `workspaces`) —
symmetric, good (`D1WorkspaceRepository.ts:94-142`,
`node/src/repositories/drizzle.ts:345-357`). But there are **zero `ON DELETE CASCADE`
constraints in the D1 migrations** and only a handful of `onDelete` in the Drizzle
schema, so every other workspace-scoped table orphans on delete: `notifications`,
`requirement_reviews`, `consensus_sessions`, `brainstorm_sessions`, `clarity_reviews`,
`kaizen_gradings`, `doc_interview_sessions`, `documents`, `tasks`, `task_connections`,
`workspace_settings`, `workspace_model_defaults`, `tracker_settings`, …. Some
(token_usage, llm_call_metrics, github_commits) self-heal via retention; the
review/session/settings tables have no retention and orphan permanently. The existing
`workspace-delete-cleanup.spec.ts` asserts only the 7 cleared tables, so the omissions
are invisible.

**Fix:** a shared kernel list of workspace-scoped tables driving both cascades (so a new
table can't silently miss the list), + broaden the cleanup spec / conformance assertion
to iterate that list. Deleting the orphans of already-deleted workspaces needs no
migration ceremony (backwards compatibility is a non-goal) — a one-time cleanup in the
same slice is fine.

**Landed (this PR).** `WORKSPACE_SCOPED_TABLES` in
`backend/packages/kernel/src/domain/workspace-cascade.ts` is the single source of truth;
both `D1WorkspaceRepository.delete` and `DrizzleWorkspaceRepository.delete` iterate it
(the D1 facade appends its runtime-only `live_containers`). The bespoke `services` /
mount re-home handling still runs first (it reads `blocks`), then the list, then the root
`workspaces` row. The schema declares essentially no FKs between workspace-scoped tables
(only `users` FKs; D1 doesn't enforce FKs), so the bulk deletes have no ordering
constraints. Guards: a static completeness test
(`node/test/workspace-cascade-completeness.spec.ts`) fails if any primary-schema
`workspace_id` table is neither listed nor an acknowledged special case; the Node cleanup
spec proves representative previously-orphaning tables are reclaimed; and a cross-runtime
conformance assertion (`suite.ts`, "cascades the delete across workspace-scoped tables")
proves no rows survive on **both** D1 and Postgres.

Deliberately deferred / excluded:

- **`binary_artifacts` → item 3.** Its rows are NOT in the list: deleting the metadata row
  without the blob bytes would strand the bytes forever (the row is the only handle on the
  key). It keeps orphaning exactly as before (no regression) until item 3 wires the
  service-layer blob purge.
- **Isolated schemas** (`telemetry` / `sandbox` / `provisioning`) are out of scope: on the
  Worker `telemetry` is a physically separate D1 database, and on Node these are
  append-heavy / short-retention stores reclaimed by their own retention sweeps (e.g.
  `llm_call_metrics`) or the extractable sandbox surface — never by the board-delete
  cascade. The completeness guard filters to `schema === undefined` for this reason.
- **One-time historical orphan cleanup** (rows of already-deleted workspaces) was NOT done
  in this slice — the forward fix is the core value, and pre-1.0 the stale rows are
  acceptable. A follow-up boot/retention sweep could reclaim them if it ever matters.

#### 3. Binary-artifact blobs of deleted workspaces never reclaimed — P1

The artifact retention sweeps (`node/src/retention.ts:180-214` and the Worker analogue in
`cloudflare/src/index.ts:212-243`) iterate `workspaceRepository.listVisible(...)` and
prune each **live** workspace's screenshots/reference images per its
`artifactRetentionDays`. A **deleted** workspace is no longer in `listVisible`, and the
delete cascade (item 2) doesn't touch `binary_artifacts` — so both the metadata rows and
the backing blob bytes (R2 / S3 / filesystem) leak forever. These are the heavy objects,
so this is unbounded object-storage cost with no surfacing.

**Fix:** delete artifacts (rows + blobs via the `BinaryBlobBackend` port) in the
workspace-delete path — the service layer, not bare SQL. Now the clean next slice: item 2
landed the cascade WITHOUT `binary_artifacts` (its rows stay out of `WORKSPACE_SCOPED_TABLES`
precisely so their bytes aren't stranded). Add a `deleteByWorkspace(workspaceId)` to the
`BinaryArtifactStore` + `BinaryArtifactMetadataStore` ports (mirrored D1 ⇄ Drizzle, blobs
first then rows — copy `pruneOlderThan`'s fail-safe ordering), inject
`resolveBinaryArtifactStore` into `WorkspaceService`, and purge in `WorkspaceService.delete`
before `workspaceRepository.delete`. Add a conformance assertion (blob + row gone on both
runtimes).

**Landed (this PR).** `BinaryArtifactStore.deleteByWorkspace(workspaceId)` reclaims every
artifact's rows AND bytes, backed by new `listByWorkspace` / `deleteByWorkspace` methods on
`BinaryArtifactMetadataStore` (mirrored in both `D1BinaryArtifactMetadataStore` and
`DrizzleBinaryArtifactMetadataStore`). The composed-store factory now shares one `reclaim`
helper between `pruneOlderThan` and `deleteByWorkspace` (blobs first, best-effort per object,
then a single bulk row delete on the all-succeeded fast path — a blob delete that throws
keeps its metadata row for a later retry rather than orphaning the bytes).
`WorkspaceService` takes an optional `resolveBinaryArtifactStore` and purges through it in
`delete()` BEFORE the row cascade (best-effort — a blob-backend outage can't wedge the board
delete; the rows survive for a later retention/manual retry). `createCore` already passes the
resolver into `new WorkspaceService(dependencies)`, so both facades wire it for free. Guards:
the cross-runtime `defineBinaryArtifactsSuite` asserts `deleteByWorkspace` removes every
artifact's rows + bytes and scopes by workspace on BOTH D1 and Postgres; a
`WorkspaceService.delete` unit test proves the purge runs before the cascade and that an
unwired resolver / null store / blob outage all still complete the delete. The
`binary_artifacts` note in `workspace-cascade.ts` is updated to point at this purge (no longer
"until that lands").

### Cluster B — runtime symmetry & shared machinery

#### 4. GitHub reconcile loop duplicated verbatim across runtimes — P2

`backend/runtimes/node/src/githubReconcile.ts:36-143` mirrors the Worker's
`sync-consumer.ts` `reconcileStaleRepos` + `isInstallationGoneError` /
`isInstallationTokenGoneError` classifiers verbatim — the Node copy's own comment says
"Mirrors the Worker's `sync-consumer.ts` classification". Two copies of best-effort
per-repo sync, tombstone-on-token-gone, and warn-vs-error log routing, with **no shared
test**: if one copy changes, the other silently diverges (one runtime stops tombstoning
dead installations while the other keeps working — the exact drift the symmetry rule
exists to prevent).

**Fix:** hoist `reconcileStaleRepos` + the classifiers into `@cat-factory/server` (the
`escalateNotifications.ts` precedent), leaving each facade to supply only its driver
(setInterval vs cron/queue). NOTE: converting the classifiers from message-regex to a
structured code is **NOT this item** — that is
[`error-message-coverage.md`](./error-message-coverage.md) row **I7**; land the hoist
first so I7's conversion is a single-file change.

#### 5. Node async GitHub ingest is inline; Cloudflare uses a queue — P1

`backend/runtimes/node/src/gateways.ts:44-60`: `InlineGitHubBackfillScheduler.scheduleBackfill`
returns `false` and `InlineGitHubWebhookIngest.enqueueWebhook` / `queueRepoResync` return
`false`, so the shared controllers run backfills, webhook processing, and resyncs
**synchronously in the HTTP request handler**. On Cloudflare the same operations are
enqueued (`GITHUB_SYNC_QUEUE`) and drained by the queue consumer. A large initial
backfill or a webhook burst on Node blocks the request and risks timeouts / dropped
webhook deliveries. The file header itself names the intended fix ("Async GitHub ingest:
pg-boss `githubBackfill` / `githubWebhook`"), and pg-boss is already booted on Node.

**Fix:** pg-boss-backed implementations of the two gateway seams (the analogue of the
Worker's queue consumer, reusing `GitHubSyncService`), plus an integration assertion that
the enqueue path is taken. This closes the "Async GitHub ingest still falls back to the
inline paths" caveat in CLAUDE.md's Node facade section (update the doc in the same
slice; pairs with item 16).

#### 6. Node sweeper re-entrancy guards inconsistent — P2

`kaizen.ts:28-46` and `githubReconcile.ts:97-112` both guard their `setInterval` sweeps
with a `running` flag ("setInterval would otherwise stack overlapping passes"). The
sweeps most likely to be slow are **unguarded**: `initiativeLoop.ts:44-58` (`runDue`
reconciles child tasks and spawns the next wave — DB-heavy), `recurring.ts:25-39`, and
the notification-escalation timer in `notifications.ts`. If one tick outlasts the
interval, two concurrent `runDue` passes can both observe "no active run" and
double-spawn.

**Fix:** apply the same `running` flag to all three (one tiny PR); consider a tiny shared
`nonOverlapping(fn)` helper in the Node facade so the next sweeper can't forget it.

#### 7. Conformance prune-assertion gaps — P2

Six pruned tables have cross-runtime prune assertions (`agent-context-suite.ts:118`,
`agent-search-queries-suite.ts:92`, `llm-metrics-suite.ts:301`,
`provisioning-log-suite.ts:139`, `password-reset-suite.ts:86`,
`subscription-quota-suite.ts:168` under `backend/internal/conformance/src/`). Four
equally-swept prunes have **none**: `TokenUsageRepository.deleteOlderThan`,
`CommitProjectionRepository.deleteOlderThan` (github_commits),
`PipelineScheduleRepository.pruneRunsBefore`, `SubscriptionActivationRepository.deleteExpired`.
A D1 ⇄ Drizzle drift in an un-asserted prune (wrong column, `<` vs `<=`, missing WHERE)
either deletes live data or never reclaims — silently.

**Fix:** add prune assertions mirroring the existing suites (extend the relevant suite
per table; new prunes from items 1–3 land WITH their assertion, per the standing rule).

### Cluster C — robustness & correctness

#### 8. Notification-escalation sweep N+1 — P2

`backend/packages/server/src/runtime/escalateNotifications.ts:20-26` loads every
workspace (`workspaceService.list(null)`) then calls `settings.service.get(ws.id)` — a
point-read — **inside the loop**, every ~2 minutes on both facades
(`node/src/notifications.ts:26`, `cloudflare/src/index.ts:400`). Distinct from
perf-optimizations item 9 (which caches `WorkspaceSettingsService.get` for the
per-LLM-call path): that cache slice is **pass-through on the Worker** profile
(own-mutable-D1-state rule), so it cannot help this sweep there — every cron tick still
issues N reads for the escalation threshold.

**Fix:** a batched `listByWorkspaceIds` (chunked `IN`) on `WorkspaceSettingsRepository`,
mirrored D1 ⇄ Drizzle + conformance, read once before the loop. Coordinate with perf item
9 so the two slices don't collide on the same port.

#### 9. Node `/health` is a static 200 — P2

`backend/runtimes/node/src/server.ts:79`: `app.get('/health', c => c.json({ status: 'ok' }))`
— always 200 regardless of Postgres pool / pg-boss health. A running node whose pool has
died (or whose pg-boss worker crashed) still reports healthy, so a load balancer can't
drain the broken replica. (Graceful shutdown itself, `server.ts:442-483`, is thorough —
this is only the inbound readiness signal.)

**Fix:** add `/ready` (pool `SELECT 1` + pg-boss state check) distinct from the cheap
liveness `/health`. Node-facade-specific by nature (the Worker has no long-lived process
to probe) — a legitimate asymmetry, note it as such.

#### 10. `provisioningLogs` store: unbounded map + unguarded overwrite — P2

`frontend/app/app/stores/provisioningLogs.ts`: `byExecution` accretes one `LogState` per
execution id and never evicts (slow memory creep across a long board session), and
`loadForExecution` performs an unguarded `s.entries = entries` — the silent poll and a
manual refresh can resolve out of order and clobber the newer result. This is exactly the
out-of-order-overwrite shape the CLAUDE.md live-push rules warn about, minus the
monotonic guard the core stores carry.

**Fix:** per-execution monotonic sequence guard (copy `stores/workspace.ts`) + eviction
of terminal executions' log state, + a store-level out-of-order spec (the item-15
pattern).

#### 11. Error code `validation` maps to two HTTP statuses — P3

`backend/packages/server/src/http/errorHandler.ts:21-52`: `SchemaValidationError` →
**400**, domain `validation` `DomainError` → **422**, both with `code: 'validation'`. The
400 is a deliberate choice (commented), but a client keying off the code sees
inconsistent statuses.

**Fix:** either unify the status or (cheaper) split the code (`schema_validation` vs
`validation`) / document the split in the API docs so the asymmetry is contractual, not
accidental.

### Cluster D — test & CI coverage

#### 12. Requirements-review flow has zero e2e coverage — P1

`RequirementsReviewWindow.vue` is the **largest frontend component (~1,200 lines)** and
drives the most intricate human-in-the-loop flow (answer/dismiss → incorporate →
re-review/redo → proceed/exceeded), yet none of the 25 e2e specs covers it — the e2e
README itself notes no spec asserts on an inline-gate outcome. The inline-model fake seam
(`fakeInlineModel.ts`) already makes the reviewer deterministic; what's missing is a
`data-testid` pass on the window (a behaviour-neutral patch-changeset frontend change per
the e2e rules) and the spec.

**Fix:** testids first, then a spec driving one full loop (raise findings → answer →
incorporate → re-review converge → run advances) asserting only on live pushed updates.

#### 13. Inline agent windows have no e2e specs — P2

`components/{brainstorm,clarity,consensus}/` and the doc-interview window are first-class
features with zero e2e coverage, while the harness for determinism (`fakeInlineModel.ts`)
already exists. Also fold in the explicitly deferred stack-recipes slice-7 wizard spec
(see [`stack-recipes-and-shared-stacks.md`](./stack-recipes-and-shared-stacks.md)) —
already scoped there, just unwritten.

**Fix:** one spec per window, same testid-first mechanics as item 12; each spec seeds its
own workspace per the suite rules.

#### 14. CI `paths-filter` globs unguarded against drift — P2

The entire lane-gating matrix in `.github/workflows/ci.yml` hinges on the `changes` job's
`dorny/paths-filter` globs; a mis-scoped glob **silently skips a suite** (e.g. a change
that should trigger the `eks` lane but matches no filter). Nothing asserts
"a change under path X triggers lane Y".

**Fix:** either a small meta-test (unit-test the filter globs against representative
paths with the same matcher library) or a scheduled filter-ignoring full run
(cron `workflow_dispatch` with all lanes forced) that would surface a lane that only ever
skips. The meta-test is preferred — deterministic and per-PR.

#### 15. Store-level clobber specs cover ~5 of ~40 stateful stores — P3

Only `workspace` / `execution` / `observability` / `agentRuns` / `board` carry the
out-of-order-refresh unit specs the flake rule demands; every other store that both
snapshot-hydrates and live-upserts is unpinned. Incremental, mechanical work with an
established pattern.

**Fix:** establish the rule ("every store with both delivery shapes gets an out-of-order
spec"), then burn down store-by-store — starting with the stores backing live badges
(item 10's `provisioningLogs` first).

### Cluster E — docs & hygiene

#### 16. CLAUDE.md's Node GitHub connect/sync note is stale — P2

CLAUDE.md still says "populating `github_installations` / `github_repos` still needs the
GitHub connect/sync integration on Postgres (the remaining follow-up)". Verified:
`node/src/container.ts:1946,1973` wires `githubInstallationRepository` into the shared
core, `GitHubInstallationService` / `WebhookService` (the upsert/seed paths) are
runtime-neutral, and `githubReconcile.ts` provides the missing-webhook backstop. Either
the follow-up is done (delete the note) or a precise residual gap remains (e.g. the App
install-callback seeding path on Node) — verify end-to-end and state exactly that,
instead of the blanket claim. Also update the "Async GitHub ingest still falls back to
the inline paths" sentence when item 5 lands.

#### 17. `refactoring-candidates.md` / `modularisation.md` stale; biggest files untracked — P3

`ExecutionService.ts` is now ~3,550 lines and `RunDispatcher.ts` ~3,911 — ~40% past the
numbers recorded in `docs/refactoring-candidates.md`, and **neither** is in
`docs/modularisation.md`'s active backlog (which lists smaller files). Frontend counts
are similarly stale (`RequirementsReviewWindow.vue` 978→1,192, `PipelineBuilder.vue`
890→1,040, `ui.ts` 781→1,043). Refresh the numbers and add the two engine files as
explicit split targets so the largest, fastest-growing files stop being untracked.

#### 18. Convert finished initiatives to ADRs — P3

Per the CLAUDE.md tracker→ADR rule: `custom-initiative-definitions.md` is
"near-complete (only slice 4, low-prio/droppable, remains)" — decide slice 4 (drop or
do), then convert to the next free ADR number and `git rm` the tracker.
`coder-fork-decision.md` (PR 1 landed) — either split the remaining chat slice into a
follow-up or close it out the same way. Cheap hygiene that keeps the initiatives list
meaning "active".

#### 19. Accessibility whitespace — P2

48/176 SPA components use any `aria-*` attribute; 31 use `role=`; no tracker, doc, or CI
check covers accessibility at all — a genuine gap given how thoroughly everything else is
tracked. Highest-value surfaces: the Vue-Flow board canvas (keyboard reachability),
off-canvas drawers/modals (focus trap + `aria-modal`), the command bar, and the
notification inbox.

**Fix:** a scoped a11y sweep of those surfaces (not a wholesale audit), plus adopting an
axe-based smoke check in the e2e suite for the shell + one board view so regressions are
caught mechanically.

#### 20. Close i18n phase X — P3

Tracked in detail in `docs/localization.md` (phases 0–9 done, ~117/121 components
migrated); listed here only so this checklist is complete. Remaining: the raw-English
meta tables in `frontend/app/app/utils/catalog.ts` (`STATUS_META`, `agentKindMeta`,
`blockTypeMeta`, `MODULE_META` — enum-keyed, so use the exhaustive-`Record` tier-2
pattern) and `pages/index.vue` + `pages/reset-password.vue`. Then retire the
localization progress table. Translate every locale in the same PR (parity gate).

## Conventions & gotchas for implementers

- **Keep the runtimes symmetric** — every persistence/port change here (items 1, 2, 3, 7, 8) lands D1 ⇄ Drizzle in the same PR with a conformance assertion; that's most of the
  point of this initiative.
- **Retention deletes only terminal state.** Item 1 prunes resolved/dismissed
  notifications only — never `open` ones (they're the actionable inbox). Item 3 deletes
  blobs through the `BinaryBlobBackend` port, not by guessing keys.
- **The workspace-scoped-tables list (item 2) must be additive-safe**: a single shared
  list in kernel that both cascades AND the cleanup test iterate, so a future table
  missing from it fails a test instead of orphaning.
- **Don't touch the regex classifiers under item 4** — the hoist moves them verbatim;
  their conversion to a structured code is `error-message-coverage.md` I7 (sequenced
  after the hoist). The mint-failure message text is regex-load-bearing until then.
- **Item 5 must not change webhook-response semantics**: GitHub expects a fast 2xx; the
  pg-boss enqueue replaces the inline processing, the controller contract stays.
- **e2e items (12, 13): testids first**, as their own behaviour-neutral frontend change +
  patch changeset; specs follow the suite's live-push assertion rules (no reloads, no
  sleeps). A flaky new spec is a blocking bug per CLAUDE.md — deflake at the source.
- **Changesets**: empty for doc-only slices (14, 16–18); patch for `@cat-factory/app`
  testid/i18n changes; per-package otherwise. No executor-harness changes are in scope
  here, so no image bumps.
- **Doc updates ride their code slice** — item 5 updates CLAUDE.md's ingest sentence in
  the same PR; don't leave the docs to a separate cleanup pass (that's how item 16
  happened).
