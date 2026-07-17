# Initiative: public API expansion (`/api/v1` external surface)

**Status:** in progress (Tier 1 task-lifecycle complete inc. delete; per-key scopes + Tier 2 pipeline discovery landed; Tier 3 notification inbox landed) · **Owner:** core · **Started:** 2026-07-16

> This is the durable source of truth for a multi-PR initiative. Read it first before
> picking up the next slice; update the checklist at the end of each PR.

## Goal & rationale

The key-authenticated external API (`/api/v1/*`, `PublicApiController.ts`) currently
covers two use-cases: headless initiative runs (`POST /initiatives` + job poll/SSE) and
basic board workloads (list services, create/list/read tasks, start a task). That surface
is **fire-and-forget**: an external system can create and start a task but then cannot
edit it, stop it, retry it, watch it live, or even discover which `pipelineId`s are valid
to start it with (`start` demands one when the task has no pin, yet nothing lists them).

The goal is to grow `/api/v1` into a **complete task-lifecycle surface** an external
tracker / CI system / bot can build on — in prioritized slices, each an external
counterpart of a service call that already exists internally (thin contract + controller
work, not new machinery), plus one genuinely new feature (outbound webhooks) once the
lifecycle is complete.

## Target pattern (the reference implementation)

The existing public surface IS the template; every new endpoint copies its shape:

1. **Contract first**: add a `defineApiContract` entry in
   `backend/packages/contracts/src/routes/public-api.ts` (absolute `/api/v1/...` path).
   Request/response schemas live beside the existing `publicTask` / `publicService` /
   `publicJob` schemas in `@cat-factory/contracts` — external resources are **small
   projections, never the raw `Block`/`ExecutionInstance`**.
2. **Handler in `PublicApiController.ts`** via `buildHonoRoute`, authenticating
   in-controller with `resolveKey(c)` (the `/api` prefix bypasses the session gate).
   Delegate to the existing service method on the container — do not reimplement logic.
3. **Headless-safety refusals at admission**: reuse `personalGateForBlock` (individual-
   usage models → 409), `isHeadlessInlinePipeline` / `PARKING_INLINE_KINDS` (no step that
   parks on a human), and the archived-service 409 pattern.
4. **Abuse backstops**: anything that spins up LLM work gets a counted cap (the
   `MAX_ACTIVE_INITIATIVE_RUNS` check-then-act + post-start re-count pattern); reads get
   pagination before they get unbounded.
5. **SSE = bounded poll over the persisted row** (the `GET /jobs/:id/events` pattern:
   `SSE_POLL_MS` / `SSE_MAX_MS` / `SSE_REAUTH_MS` re-verification so a mid-stream key
   revoke cuts the stream). Never a per-facade event-hub wiring — the poll keeps it
   runtime-symmetric by construction.
6. **Scoping**: every read is double-scoped — the key's workspace AND the resource class
   the public surface owns (the `loadPublicJob` pattern: an external key must never read
   an arbitrary in-workspace run).
7. **Tests**: extend the conformance suite's public-API coverage so both runtimes serve
   the new route identically; contract-level validation comes free from Valibot.

## Prioritized checklist

### Tier 1 — complete the task lifecycle (do first)

| #   | Endpoint                                                                                                             | Backing internal capability                                                | Status  | PR      |
| --- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------- | ------- |
| 1   | `PATCH /api/v1/tasks/:taskId` (title/description pre-start edits)                                                    | `boardService.updateBlock` (`updateBlockContract`)                         | ✅ done | this PR |
| 2   | `POST /api/v1/tasks/:taskId/stop`                                                                                    | `executionService.stopRun` (records a retryable `cancelled` terminal)      | ✅ done | this PR |
| 3   | `POST /api/v1/tasks/:taskId/retry` (reuses the `personalGateForBlock` refusal)                                       | `executionService.retry` (resolved from the block's run)                   | ✅ done | this PR |
| 4   | `DELETE /api/v1/tasks/:taskId` (delete task + run history, `admin`-scoped)                                           | `boardService.removeBlock` (idempotent; drops the run via `deleteByBlock`) | ✅ done | this PR |
| 5   | `GET /api/v1/tasks/:taskId/run` — richer run projection (per-step status, subtasks, failure kind/message, PR branch) | `executionRepository.getByBlock` + the new `publicRun` projection          | ✅ done | this PR |
| 6   | `GET /api/v1/tasks/:taskId/events` (SSE, live run progress)                                                          | the jobs-SSE bounded-poll pattern, verbatim                                | ✅ done | this PR |

> **Note on #1:** `updateBlock`'s patch has no `taskType` field (task type is set at creation
> and re-stamped on reparent), so the public PATCH exposes only `title`/`description` — the two
> human-authored, pre-start-editable fields. Widening it would need a new internal capability.

### Tier 2 — discovery metadata the lifecycle needs

| #   | Endpoint                                                                                                                         | Backing internal capability                                                             | Status  | PR      |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------- | ------- |
| 7   | `GET /api/v1/pipelines` — id/name/steps + a headless-startable flag (closes the `pipeline_required`-with-no-way-to-discover gap) | `pipelineService.list` + `isHeadlessInlinePipeline`                                     | ✅ done | this PR |
| 8   | `GET /api/v1/jobs` — list the workspace's initiative jobs (a restarted integration currently loses every job id)                 | `executionRepository` + internal-anchor scoping (`loadPublicJob` generalized to a list) | ⬜ todo |         |
| 9   | Pagination + status/`since` filters on `GET /services/:id/tasks` (and the new `/jobs`)                                           | new bounded list port methods where needed (no JS-side filtering of unbounded reads)    | ⬜ todo |         |

### Tier 3 — eventing & operations

| #   | Endpoint / feature                                                                                                                                                                                            | Backing internal capability                                                                                                                              | Status  | PR      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| 10  | **Outbound webhooks**: register per-key/workspace callback URLs for task transitions + job completion; HMAC-signed, retried delivery                                                                          | new table (D1 ⇄ Drizzle, conformance-asserted) + a webhook `NotificationChannel` behind `CompositeNotificationChannel` (the seam built for exactly this) | ⬜ todo |         |
| 11  | `GET /api/v1/notifications` + `POST …/:id/act\|dismiss` (merge_review / pipeline_complete / ci_failed resolution) — unblocked by key scopes (#13); `act` performs a real GitHub merge so it is `admin`-scoped | `NotificationService` (`listNotificationsContract` / `actNotificationContract` / `dismissNotificationContract`)                                          | ✅ done | this PR |
| 12  | `GET /api/v1/usage` — spend/usage read for external dashboards                                                                                                                                                | `getSpendStatusContract` / `getWorkspaceUsageContract`                                                                                                   | ⬜ todo |         |

### Cross-cutting prerequisite

| #   | Item                                                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                | Status  | PR      |
| --- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| 13  | **Per-key scopes** (`read` / `write` / `admin`) on `public_api_keys` | Inclusive ladder (`read` ⊂ `write` ⊂ `admin`) enforced per-route by `authorize(c, need)` in `PublicApiController` via `scopeSatisfies`; too-low scope → `403 insufficient_scope`. `scope` column D1 ⇄ Drizzle, existing keys backfill to `write` (kept their pre-scope capabilities, no auto-grant of destructive power). Token UI gains a scope selector (default `write`). Unblocked #4; #11 next. | ✅ done | this PR |

### Tier 4 — larger surface, only on demand (deliberately deferred)

| #   | Endpoint / feature                                                                                                                                                                                    | Why deferred                                                                                                                              | Status      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 14  | `POST /api/v1/bootstrap` (headless repo bootstrap)                                                                                                                                                    | container-backed + force-pushes to GitHub — breaks the current "public runs never touch GitHub" invariant; needs scopes + explicit design | ⬜ deferred |
| 15  | Document/requirements ingestion (attach a PRD body at task creation)                                                                                                                                  | wants the documents model exposed externally; scope unclear until a consumer exists                                                       | ⬜ deferred |
| 16  | `GET /api/v1/openapi.json` — SERVE the already-generated spec (`docs/openapi.json` exists, produced by `pnpm gen:openapi` from the Valibot contracts and drift-guarded by `pnpm check:openapi` in CI) | trivial once wanted; today the spec ships as a repo file, an endpoint is only packaging                                                   | ⬜ deferred |

## Conventions & gotchas carried between iterations

- **Small projections only.** External resources (`publicTask`, `publicService`,
  `publicJob`, the new `publicRun`) never expose raw blocks, board internals, or
  credential-bearing fields. Extending a projection is a deliberate contract change.
- **Double-scope every read** (workspace + resource class), per the `loadPublicJob`
  pattern — an external key must never enumerate or read resources the public surface
  didn't create/own, even inside its own workspace.
- **Headless means headless.** Any endpoint that can start/resume LLM work must refuse
  what a headless caller cannot resolve: parking inline kinds, approval gates,
  individual-usage models (`personalGateForBlock` → 409 `individual_model_unsupported`).
- **Check-then-act caps need the post-action re-count** (the
  `MAX_ACTIVE_INITIATIVE_RUNS` lesson): the pre-check alone lets a parallel burst through;
  re-count after committing and roll back over the cap (strict `>` so the boundary start
  survives).
- **Rollback on partial failure leaves nothing for the sweeper** — drop the execution
  BEFORE the anchor block (`rollbackInitiativeRun`), or the stale-run sweeper re-drives a
  run against a deleted block forever.
- **SSE stays a bounded poll** (no event-hub coupling), re-verifying the key every
  `SSE_REAUTH_MS`, emitting an explicit terminal frame (`stopped`) so a client can always
  tell "terminal" from "connection dropped", and treating `paused` (spend gate) as
  non-terminal.
- **Additive under `/api/v1`** — no v2; pre-1.0 back-compat is a non-goal, but the
  external surface is the one place to be deliberate about breaking callers (flag any
  breaking shape change prominently in the changeset).
- **No N+1** in the new list endpoints — a list projection that needs per-item lookups
  gets a batch port method (mirrored D1 ⇄ Drizzle + conformance assertion), never a loop
  of point-reads.
- **Runtimes stay symmetric by construction** — this whole layer lives in
  `@cat-factory/server`; anything that needs persistence (webhooks table, key scopes)
  lands D1 ⇄ Drizzle together with a conformance assertion in the same PR.
- **`act` is `admin`-scoped, the side-effect is shared, and the retry tail stays headless-safe.**
  The notification `act` (#11) can perform a REAL GitHub merge (`merge_review` / `pipeline_complete`),
  so it sits at the top of the ladder like `delete`; `dismiss` is `write`, the list `read`. The
  merge/retry side-effect switch was extracted to `notificationActEffect`
  (`@cat-factory/server`, `modules/notifications/notificationActions.ts`) and is shared by the SPA
  inbox and the public route — do NOT re-inline it. The set of headlessly-actionable types lives
  beside it as `HEADLESS_ACTIONABLE_NOTIFICATION_TYPES` (the four with an automated side-effect);
  the public `act` admits ONLY those and refuses everything else with 409
  `notification_not_actionable` (an informational card that parks a run on an interactive human
  decision would otherwise be silently marked read, losing the reminder — a headless caller
  dismisses it instead). Unlike the interactive SPA `act`, which may mark any card read. A public
  `act` that would RETRY a run (`ci_failed` / `test_failed`) also reuses `personalGateForRun` to
  refuse an individual-usage-model run up front (→ 409 `individual_model_unsupported`), exactly
  like the retry endpoint; the merge tails need no personal credential and run headless (no
  `usr_*` initiator → installation token).
- **Regenerate the OpenAPI spec with every contract change** — `docs/openapi.json` is
  generated from the `/api/v1` Valibot contracts (`pnpm gen:openapi`) and CI fails on
  drift (`pnpm check:openapi`); every slice that adds/changes a public contract commits
  the regenerated spec in the same PR.

## Recommended first slice

Tier 1 items **1–3 + 5–6** plus **#7 (`GET /pipelines`)** in one or two PRs, with **#13
(key scopes)** landed alongside so the mutating endpoints ship gated. Outbound webhooks
(#10) are the flagship follow-up once the lifecycle surface is complete.
