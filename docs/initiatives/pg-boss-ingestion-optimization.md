# Initiative: pg-boss ingestion optimization (batch queuing, tx ingestion, cross-runtime atomicity)

**Status:** phase 2 landed (batch queuing: V1/B2/B1) · **Owner:** core · **Started:** 2026-07-11

> This is the durable source of truth for a multi-PR initiative. Read it first before
> picking up the next slice; update the checklist at the end of each PR.

## Goal & rationale

The Node facade (`backend/runtimes/node`, inherited by `runtimes/local`) runs durable
execution on **pg-boss v12** (`^12.25.1`). Two pg-boss capabilities are currently unused:

- **Batch queuing** — `boss.insert(queue, jobs[])` inserts many jobs in one round-trip.
  Today every enqueue in the codebase is an individual `boss.send()`; a few call sites
  loop `send` over a collection, and one high-value flow crams an unbounded fan-out into
  a single job instead of decomposing it into many.
- **Same-transaction ingestion** — pg-boss `send`/`insert` accept a `db`/transaction
  client, so a job insert can commit atomically with the domain rows it belongs to.
  Today pg-boss and Drizzle run on **separate connection pools** built from the same
  `connectionString` (`runtimes/node/src/server.ts` vs `runtimes/node/src/db/client.ts`),
  so no enqueue can join a Drizzle transaction even in principle.

This initiative records which call sites genuinely benefit, which do not (and why), and —
the follow-up question that grew out of the analysis — what a **runtime-common atomicity
abstraction** between the Cloudflare and Node facades could look like, given that the two
facades turn out to have structurally identical (and identically non-atomic) write→kick
shapes.

Intended end state:

- The verified batch-queuing candidates use one `insert([...])` per collection instead of
  a `send` loop, and the GitHub backfill is decomposed into per-repo jobs.
- The step-replay idempotency audit has run, and (if it confirms non-idempotent step side
  effects) a step-keyed idempotency-ledger seam exists, mirrored D1 ⇄ Drizzle.
- The rejected options (kernel unit-of-work port; tx-ingestion of the run flows) are
  recorded here with rationale so they are not re-litigated.

## Current-state map (what the analysis established)

### Queue inventory (Node)

| Queue                       | Policy      | Dedup                             | Enqueue sites                                                                                                                       |
| --------------------------- | ----------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `execution.advance`         | `exclusive` | `singletonKey` = execution id     | `PgBossWorkRunner.startRun`/`signalDecision` (`runtimes/node/src/execution/pgBossRunner.ts:74,89`), sweeper re-drives (`:312,:353`) |
| `bootstrap.advance`         | `exclusive` | `singletonKey` = job id           | `PgBossBootstrapRunner.startRun` (`bootstrapRunner.ts:74`), `reenqueueStaleBootstrap` (`:120`)                                      |
| `env-config-repair.advance` | `exclusive` | `singletonKey` = job id           | `PgBossEnvConfigRepairRunner.startRun` (`envConfigRepairRunner.ts:74`), `reenqueueStaleEnvConfigRepair` (`:120`)                    |
| `github.sync`               | default     | none (idempotent upserts instead) | `scheduleBackfill`/`enqueueWebhook`/`queueRepoResync` (`githubSyncRunner.ts:73,87,92`)                                              |

Facts that gate the design space:

- **Every enqueue is `boss.send()`** — `boss.insert`, `sendAfter`, `schedule` are unused
  (all periodic work is `setInterval`/toad-scheduler timers, not pg-boss cron).
- **pg-boss and Drizzle do not share a pool.** `server.ts` builds a `pg.Pool` for Drizzle
  and a separate `new PgBoss({ connectionString })` with its own internal pool. The nine
  existing `db.transaction()` sites are all intra-repository; none wraps an enqueue.
- **The `exclusive` queue policy is the dedup linchpin**: `(name, singletonKey)` is unique
  across `created`/`retry`/`active`, so a duplicate `send` is an `ON CONFLICT DO NOTHING`
  no-op. Any batch-insert change must preserve exactly this semantics.

### The shared write→kick design (both runtimes, deliberate)

Both facades implement the same kernel ports (`WorkRunner`, `BootstrapRunner`,
`EnvConfigRepairRunner`) with the same contract, documented at `pgBossRunner.ts:9-14` and
mirrored by the Worker:

1. The persisted run row (`status: 'running'`) is the **source of truth**.
2. The driver kick — `boss.send` on Node, `workflow.create` on Cloudflare — is a
   **promptness optimisation**, idempotent by run id on both sides (`singletonKey` +
   `exclusive` ⇄ Workflow instance id = run id with the duplicate-create error swallowed,
   `runtimes/cloudflare/src/infrastructure/workflows/WorkflowsWorkRunner.ts:42-52`).
3. The **stale-run sweeper** is the recovery backstop: Node `startStaleRunSweeper`
   (`pgBossRunner.ts:219-372`) ⇄ Worker cron `sweepStuckRuns`
   (`runtimes/cloudflare/src/infrastructure/workflows/sweeper.ts:105`). Both classify the
   run's driver (live / orphaned / missing), re-drive, and hard-fail a run that stays
   unrecoverable past a deadline.

### Non-atomic write→kick seams (verified crash behaviour)

| Flow                                         | Write                                                                      | Kick                           | Crash between recovered?                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `ExecutionService.start`                     | `ExecutionService.ts:1814-1815` (`insertLiveRunOrConflict` + block update) | `:1823` `workRunner.startRun`  | yes — sweeper (both runtimes)                                                                                        |
| `retry` / `restartFromStep` / `resumePaused` | `:3314-3316` / `:3426-3428` / `:3480`                                      | `:3321` / `:3433` / `:3490`    | yes — sweeper                                                                                                        |
| `resolveDecision` + the ~13 signal sites     | decision persisted, `blocked → running` (`:2998-3001` etc.)                | `signalDecision`               | yes — run left `running`; DB write is source of truth                                                                |
| `BootstrapService.bootstrap` / `retry`       | `BootstrapService.ts:290,:337` / `:411,:463`                               | `:342` / `:466`                | yes — sweeper `bootstrap` branch                                                                                     |
| `EnvConfigRepairService.start`               | `EnvConfigRepairService.ts:154`                                            | `:184`                         | yes — sweeper `env-config-repair` branch                                                                             |
| `RecurringPipelineService.fire` history row  | `schedules.insertRun` (`RecurringPipelineService.ts:548`, AFTER the start) | via `executionService.start`   | **gap** — run exists, history row missing on crash between                                                           |
| GitHub webhook / resync / backfill           | none before enqueue (worker writes projections later)                      | `githubSyncRunner.ts:73,87,92` | pg-boss retry only; a pre-enqueue crash loses the delivery → daily GitHub reconcile sweeper is the eventual backstop |

### Cloudflare-side atomicity primitives (for the common-abstraction question)

- D1 has **no interactive transactions** — only `db.batch([...])` (one all-or-nothing
  implicit transaction). Every existing `batch` call is confined to a single repository
  method over one aggregate (`D1ExecutionRepository.insertLive` DELETE+INSERT pair, bulk
  projection upserts, the workspace cascade delete). There is no shared query-runner /
  session / statement-builder seam — repos hold the raw `D1Database` binding and execute
  internally.
- The durable kick (`workflow.create`) is **not a SQL statement and can never join a D1
  batch** — write+kick atomicity is unachievable on Cloudflare, full stop.
- Cloudflare **Workflows steps are at-least-once with respect to side effects**: a step's
  D1 commit can land and the engine crash before checkpointing the step's success, so the
  resumed workflow re-runs the step and re-applies the write. D1 writes are excluded from
  Workflows' automatic replay safety; anything mutating state needs its own idempotency
  handling. The Node pg-boss handler has the same property (a crashed worker's job is
  retried; `driveExecution` re-runs).
- Today, replay safety rests on **ad-hoc idempotency**: the CAS `compareAndSwap` on the
  execution row, `insertLive`'s live-run conflict index, upsert-shaped projections, and
  terminal-state no-op guards. There is no systematic step-effect ledger; no outbox or
  post-commit hook exists on either facade (grep-confirmed).

## Assessment per candidate

### Batch queuing (`boss.insert([...])`)

| #   | Candidate                                   | Where                                                  | Verdict                     | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------- | ------------------------------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Stale-run sweeper re-drive loop             | `pgBossRunner.ts:240-317`                              | **adopt-later** (low value) | Real `send`-per-item loop, but iterations interleave per-run classification (`classifyAdvanceJob`) + reclaim and route to three different queues by kind; batching only the final sends saves little for typically-small N. Do it opportunistically with B2, not as its own slice.                                                                                                                                                                                                                                                                                          |
| B2  | Spend-paused re-drive loop                  | `pgBossRunner.ts:337-358`                              | **adopt**                   | Cleanest fit: uniform options, single queue (`execution.advance`), each item independent. One `insert(QUEUE, jobs)` replaces N round-trips. Gated on V1 (options parity).                                                                                                                                                                                                                                                                                                                                                                                                   |
| B3  | `ExecutionService.resumePaused` fan-out     | `ExecutionService.ts:3468-3496`                        | **adopt-later**             | The loop calls `workRunner.startRun` per run through the kernel port, so batching needs a port-level batch method (e.g. `startRuns(refs[])`) mirrored on the Worker (which would loop `workflow.create` internally — no batch primitive exists there). Cross-runtime signature change for a rare, small-N path; only worth folding into a slice that already touches the port.                                                                                                                                                                                              |
| B4  | GitHub `backfillInstallation` decomposition | `GitHubSyncService.ts:542-549` + `githubSyncRunner.ts` | **adopt (highest value)**   | The whole per-workspace/per-repo fan-out currently runs INSIDE one `github.sync` job capped by `expireInSeconds: 900`; a crash or expiry re-runs the entire backfill from the top. Decompose: the backfill job enumerates repos and enqueues per-repo `resync-repo` jobs via ONE `insert([...])`. Wins: bounded job runtime, per-repo retry granularity, parallel drain across the worker's `localConcurrency`, and closer parity with the Worker's `GitHubBackfillWorkflow` step decomposition. This is a robustness fix wearing a batching hat, not a micro-optimisation. |

### Same-transaction ingestion & the cross-runtime atomicity abstraction

The follow-up question was whether a **common abstraction for atomicity handling** can
span CF and Node instead of rejecting tx-ingestion from the Node side alone. The hard
constraint: on CF the kick can never join a batch, and on Node the kick _can_ join a pg
tx — but only on Node. So "one transaction spanning write+kick" cannot be the common
abstraction. Three shapes were assessed:

| #   | Shape                                                                                                                                                                                                                                       | Verdict                                   | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | **Kernel `UnitOfWork` port** threaded through repos + runners (Node = Drizzle tx + pg-boss `db` option; CF = deferred statement-accumulating `db.batch`)                                                                                    | **rejected**                              | Maximal invasiveness: every participating repo method on BOTH runtimes must change signature (repos execute internally and return domain objects — there are no statement builders to compose). And the payoff is asymmetric: the CF kick still can't join the batch, so the port delivers write+kick atomicity on exactly one runtime — the silent-divergence shape the parity rules exist to prevent.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| B   | **Transactional outbox** (intent row, mirrored D1 ⇄ Drizzle, drained by the existing sweep machinery)                                                                                                                                       | **adopt-later, narrow scope**             | Honest observation: the current design already IS a degenerate outbox — the `status:'running'` run row is the intent record, the idempotent-by-run-id kick is the delivery, and `listStale` + re-drive is the drain. A dedicated outbox table buys only promptness (drain interval < sweep lease) for flows that are already correct. The one genuinely uncovered path is `github.sync` webhook ingest, where the enqueue is the ONLY write (a pre-enqueue crash loses the delivery, and GitHub does not redeliver). Covering it means persisting an ingest row before/with the ack and draining it — a real design change; pursue only if webhook loss is observed in practice (the daily reconcile sweeper currently bounds the damage).                                                                                                                |
| C   | **Step-keyed idempotency ledger** — deterministic key (run id + step name), ledger row committed IN THE SAME D1 batch / pg tx as the step's own writes, `ON CONFLICT DO NOTHING` + guarded mutations so a replayed step is a harmless no-op | **investigate → adopt if audit confirms** | This targets the seam where the two runtimes genuinely share an unsolved problem: **at-least-once replay of step side effects inside the durable driver** (Workflows step replay ⇄ pg-boss job retry). It is runtime-common by construction — the ledger is one table mirrored D1 ⇄ Drizzle; CF realizes "atomic" as ledger-row-in-the-same-`batch`, Node as ledger-row-in-the-same-tx; the kernel seam is "commit these writes atomically, keyed by (run, step)" rather than "give me a transaction". Prerequisite: the audit (item T1) must confirm there ARE step effects that current CAS/upsert idempotency does not already cover — prime suspects are spend-metering increments, notification `raise`, and the `schedules.insertRun` history row. If everything turns out to be naturally idempotent, record that here and close C as unnecessary. |

**Deliberately not pursued** (recorded so it isn't re-litigated):

- **Tx-ingestion of the run flows** (`ExecutionService.start`/`retry`/decision signals,
  `BootstrapService`, `EnvConfigRepairService`): the sweeper is needed anyway (it recovers
  worker crashes mid-drive, which no ingestion-time transaction can address), so wrapping
  the write+enqueue in one tx would remove only the ≤ sweep-interval promptness window of
  an already-recovered crash case — while coupling the runtime-neutral kernel ports to a
  pg transaction type that the Cloudflare facade cannot satisfy. The DB-row-as-source-of-
  truth + idempotent-kick + sweeper design is correct and stays.
- **Shape A** (kernel `UnitOfWork` port), per the table above.

### Adjacent items surfaced by the analysis

- **Pool sharing**: pg-boss can reuse an existing `pg.Pool` (`new PgBoss({ db })`).
  Sharing Drizzle's pool halves the connection footprint and is a prerequisite for ANY
  future `db`-option enqueue. Standalone, low-risk slice; measure connection counts
  before/after. (Watch: pg-boss's maintenance queries would then compete for the Drizzle
  pool — size accordingly.)
- **`RecurringPipelineService.fire` history gap**: `schedules.insertRun` lands after the
  run start, so a crash between leaves a run with no history row. This is a plain
  domain-write ordering/tx concern (both writes are Node-side repository calls), not a
  pg-boss one — fixable independently of everything above.

## Per-item status checklist

| #   | Item                                                                                                                                                                                                                                                                                                  | Depends on               | Status                                                 | PR    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------ | ----- |
| V1  | Verification spike: pg-boss v12 `insert()` option surface — confirm `JobInsert` carries everything `sendOptions()` uses (`singletonKey`, `retryLimit`, `retryDelay`, `retryBackoff`, `expireInSeconds`, `heartbeatSeconds`) and that batch insert respects the `exclusive` policy's ON-CONFLICT dedup | —                        | ✅ done                                                | #1050 |
| B2  | Batch the spend-paused re-drive loop (`pgBossRunner.ts:337-358`) via `insert([...])`                                                                                                                                                                                                                  | V1                       | ✅ done                                                | #1050 |
| B1  | Opportunistically batch the stale-run re-drive sends (`pgBossRunner.ts:240-317`) where kinds/options allow                                                                                                                                                                                            | V1, B2                   | ✅ done                                                | #1050 |
| B4  | Decompose `backfillInstallation` into per-repo `resync-repo` jobs enqueued via one `insert([...])`                                                                                                                                                                                                    | V1                       | ⬜ todo                                                |       |
| B3  | `resumePaused` batch port method (`startRuns(refs[])`), mirrored Worker + Node + conformance assertion                                                                                                                                                                                                | —                        | ⬜ todo (adopt-later; fold into a port-touching slice) |       |
| P1  | Share one `pg.Pool` between Drizzle and pg-boss (`new PgBoss({ db })`); measure connection footprint                                                                                                                                                                                                  | —                        | ⬜ todo                                                |       |
| T1  | **Step-replay idempotency audit**: enumerate engine-step side effects and classify each as naturally idempotent under replay or not (suspects: spend metering increments, notification `raise`, `schedules.insertRun`)                                                                                | —                        | ⬜ todo                                                |       |
| C1  | If T1 confirms gaps: design + land the step-keyed idempotency-ledger seam (kernel port; table mirrored D1 ⇄ Drizzle; CF = same-`batch`, Node = same-tx; conformance assertion)                                                                                                                        | T1                       | ⬜ todo                                                |       |
| R1  | Fix the `RecurringPipelineService.fire` history-row gap (ordering or tx)                                                                                                                                                                                                                              | —                        | ⬜ todo                                                |       |
| O1  | Webhook-ingest outbox (persist-then-drain for `github.sync` webhook deliveries)                                                                                                                                                                                                                       | evidence of webhook loss | ⬜ todo (adopt-later)                                  |       |

## Conventions & gotchas carried between iterations

- **Preserve the `exclusive` dedup semantics under batch insert.** The `singletonKey`
  uniqueness that makes duplicate sends safe is POLICY-GATED (`pgBossRunner.ts:18-24`);
  verify a batch `insert` behaves identically (per-row conflict no-op, not whole-batch
  failure) before converting any loop. **V1 settled this (both statically and executably):**
  pg-boss's `insert()` compiles to a single `INSERT … SELECT FROM json_to_recordset(…) ON
CONFLICT DO NOTHING` (`plans.js insertJobs`) whose conflict is arbitrated by the exclusive
  `job_i6` unique index on `(name, COALESCE(singleton_key,'')) WHERE state <= active AND
policy = 'exclusive'` — so it dedupes PER ROW, never failing the batch, and `JobInsert`
  carries every field `sendOptions()` sets. `insert()` returns `null` unless `returnId: true`
  is passed (the sweeper ignores the return, which is fine). The real-Postgres test
  `stale-run-sweeper.spec.ts` ("batch insert preserves the exclusive per-row dedup") pins
  this invariant. NOTE: never put two rows with the SAME `singletonKey` in one `insert` batch
  — rely on the callers guaranteeing distinct keys (the sweeper's stale set and paused set are
  mutually exclusive states, so its single per-tick batch is always distinct-keyed).
- **The kernel ports stay runtime-neutral.** No pg/Drizzle transaction type may appear in
  `@cat-factory/kernel` port signatures. The atomicity seam, if C1 lands, is expressed as
  "commit atomically, keyed by (run, step)" — each facade supplies the mechanism.
- **The CF kick can never join a batch.** Any design that needs `workflow.create` inside
  a transaction is dead on arrival; rely on the kick's idempotency-by-instance-id instead.
- **Workflows steps (and pg-boss handlers) are at-least-once.** Idempotency keys must be
  deterministic — run id + step name only; never timestamps or random UUIDs (they change
  across replays and defeat the mechanism). Keep a guarded write and its ledger row in ONE
  `step.do` / one batch / one tx — splitting reintroduces the boundary being eliminated.
- **Keep the runtimes symmetric.** Any ledger/outbox table lands D1 ⇄ Drizzle together
  (D1 migration ⇄ `db:generate` migration) with a cross-runtime conformance assertion in
  the SAME change — a facade-parity gap is a showstopper, not a follow-up.
- **Don't batch across retry domains.** pg-boss batch-fetched jobs complete/fail together
  (the reason `batchSize` stays 1 on the advance workers, `pgBossRunner.ts:102-116`);
  batching INSERTS is fine, batching CONSUMPTION of unrelated runs is not.
