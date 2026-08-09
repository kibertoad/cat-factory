# ADR 0030: The `/api/v1` external surface; task lifecycle, discovery, usage, and outbound push

- **Status:** Accepted (implemented)
- **Date:** 2026-07-30
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/server`,
  `@cat-factory/orchestration`, `@cat-factory/integrations`, `@cat-factory/kernel`, both runtime
  facades)

Supersedes the `public-api-expansion` initiative tracker, whose committed scope (Tiers 1–3 plus the
per-key scope prerequisite) is complete. Tier 4 stays deliberately deferred: see Consequences.

> This is the design record. The operator/integrator documentation (key setup, scopes,
> conventions, the full endpoint reference and the webhook delivery contract) is
> [`../public-api.md`](../public-api.md).

## Context

The key-authenticated external API started as two use-cases: headless initiative runs
(`POST /initiatives` + job poll/SSE) and basic board workloads (list services, create/list/read
tasks, start a task). That surface was **fire-and-forget**: an external system could create and
start a task and then could not edit it, stop it, retry it, watch it live, or even discover which
`pipelineId`s were valid to start it with; `start` demanded one when the task carried no pin, yet
nothing listed them.

An integration built on that had to reach for the SPA's session-authed routes or give up. The goal
was a **complete task-lifecycle surface** an external tracker / CI system / bot can build on, grown
in prioritized slices, each the external counterpart of a service call that already existed
internally (thin contract + controller work, not new machinery) plus the one genuinely new
capability the lifecycle implies: a push, so a caller stops polling.

## Decision

`/api/v1` grew to cover the lifecycle end to end, on one repeated shape. Every endpoint:

1. **Declares a contract first** (`contracts/src/routes/public-api.ts`, absolute `/api/v1/…` path),
   whose request/response schemas are **small projections, never the raw `Block` /
   `ExecutionInstance`**: `publicTask`, `publicService`, `publicJob`, `publicRun`,
   `publicPipeline`, `publicUsage`. Extending a projection is a deliberate contract change.
2. **Handles in `PublicApiController.ts`** via `buildHonoRoute`, authenticating in-controller with
   `resolveKey(c)` / `authorize(c, need)` (the `/api` prefix bypasses the session gate) and
   delegating to the service method the SPA already calls.
3. **Refuses at admission what a headless caller cannot resolve**: parking inline kinds, approval
   gates, individual-usage models (`personalGateForBlock` → 409 `individual_model_unsupported`),
   an archived service.
4. **Double-scopes every read**: the key's workspace AND the resource class this surface owns (the
   `loadPublicJob` pattern), so an external key can never enumerate in-workspace resources it did
   not create.
5. **Bounds anything unbounded**: every list is keyset-paginated through the ONE cursor codec in
   `publicApiPaging.ts`, and anything that spins up LLM work gets a counted cap with the
   post-action re-count the `MAX_ACTIVE_INITIATIVE_RUNS` lesson demands.

What shipped, in the order it shipped:

- **Task lifecycle**: `PATCH`/`DELETE /tasks/:taskId`, `POST …/stop`, `POST …/retry`,
  `GET …/run` (a richer per-step projection) and `GET …/events` (SSE).
- **Discovery**: `GET /pipelines` (id/name/steps + a `headlessStartable` flag), `GET /jobs`, and
  pagination + status filters on `GET /services/:id/tasks`.
- **Per-key scopes**: an inclusive `read ⊂ write ⊂ decide ⊂ admin` ladder on `public_api_keys`,
  enforced per route by `authorize(c, need)`; too low → 403 `insufficient_scope`.
- **Notification inbox**: `GET /notifications` + `POST …/:id/act|dismiss`, the external
  counterpart of the SPA inbox, so a caller can resolve the human-gated tails (merge a
  `merge_review` / `pipeline_complete` PR, retry a `ci_failed` / `test_failed` run).
- **Usage**: `GET /usage`: the period's METERED budget position plus the per-model breakdown
  behind it, as ONE resource.
- **Outbound push**: run-lifecycle events on the workspace's registered webhook endpoint.

Three decisions are worth stating on their own.

### `GET /usage` is one resource, and the two cost families stay apart

It serves what `getSpendStatusContract` and `getWorkspaceUsageContract` serve internally, joined:
splitting them would let a caller render a breakdown against a budget read a period-roll apart.
`budget` carries the metered position the spend safeguard itself acts on (including `exceeded`,
which is what PAUSES runs) so an external dashboard can show the same state the SPA does instead
of inferring it from a token count.

Rows keep their `billing` discriminator and are never summed for the caller: a `subscription` row's
`costEstimate` is ILLUSTRATIVE (a flat-rate plan bills nothing per token), so a projection that
added it to metered spend would report money nobody is billed for. Deliberately WORKSPACE tier
only: `accountStatus` / `userStatus` are cross-workspace and per-user, and a workspace-scoped key
must never learn a sibling workspace's spend. That is also why `read` is the whole scope story: the
aggregate names no resource ids and carries no per-user dimension.

### The outbound push extends the EXISTING endpoint rather than adding a second one

> **Amended.** A workspace now registers SEVERAL NAMED endpoints
> (`/api/v1/notification-webhooks/:webhookId`), the singular routes below projecting onto the id
> `default`. What is recorded here still holds and is the reason the amendment is small: all three
> families still share one row shape, one sealed secret per row, one SSRF guard and one
> `signedDelivery.ts` retry core, and a delivery simply fans out over the endpoints subscribed to
> its family. What changed is only the KEY. One endpoint per workspace made a second integration's
> enrolment destructive: registering it overwrote whatever was there, and the only symptom was that
> the previous receiver went quiet. See
> [ADR 0052](./0052-cloudflare-os-gatekeeper.md).

The workspace already registers ONE outbound HTTPS endpoint (`notification_webhooks`,
sealed signing secret, SSRF-guarded, retried) to receive its notification cards. Run-lifecycle
events reuse it: same row, same secret, same guard, same retry budget; an operator registers a
receiver once and chooses which families it hears. Everything interesting about a delivery is a
property of the ENDPOINT, not of the payload, so the retry/SSRF/signature core was extracted to
`signedDelivery.ts` and both families drive it; a second copy would be a second place to get the
SSRF guard subtly wrong. The two bodies are told apart by shape as well as by name (a notification
delivery carries `notification`, a lifecycle delivery carries `event` + `run`).

The push exists because the happy path raises no notification at all: a pipeline whose `merger`
merges its own PR settles with an empty inbox, and that is exactly the outcome a CI system wants to
hear about. The engine reaches the transport through a kernel port (`RunLifecycleSink`) that takes
an ALREADY-PROJECTED event: the engine owns what a run means, so a transport cannot widen what
leaves the deployment by reaching for another field.

**Empty `runEvents` means NONE**, the opposite of the sibling `types` filter. Notifications are what
the endpoint was built to deliver, so an unset filter there means "the sensible defaults"; lifecycle
events are the later addition, and an endpoint registered for parked decisions must not silently
start receiving an event per run. Unconfigured is byte-for-byte the prior behaviour.

### `run.started` is exactly-once; the terminal edges are at-least-once, on purpose

The two edges hook different places because their call graphs differ, and the trade is explicit:

- **`run.started`** fires from `insertLiveRunOrConflict`: the ONE funnel that mints a live run,
  whose insert is the atomic claim (a genuinely concurrent double-start loses there). So it is once
  per run by construction, `retry` and `restartFrom` each announce the FRESH run id they mint, and a
  start path added later inherits it instead of quietly delivering nothing.
- **`run.completed` / `run.failed`** fire from `RunStateMachine.emitInstance`'s terminal branch,
  beside the Kaizen scheduler and the activation cleanup. A run reaches `done` from four
  independent sites, and a hook at each would compile, pass, and silently drift the day a fifth is
  added. The cost is that a durable replay can re-emit a settled run, so delivery is
  **at-least-once** and the body carries a `deliveryId` of `<runId>:<event>` (stable across
  retries and re-deliveries) for the receiver to dedupe on.

That is a deliberate departure from the platform's "atomic claim before an external side effect"
rule, and the distinction is what the effect IS. A merge or a posted review is not idempotent and
not the receiver's to make idempotent, so it earns a claim. A lifecycle push is a statement about a
terminal run, and every part of it a receiver routes or acts on (the ids, the event, the outcome)
is stable across a re-delivery, so the cheap contract is the correct one and it costs no claim table
for the platform to then have to sweep.

**The dedupe key is `deliveryId`, not the body.** Only the observation timestamps (`sentAt` and
`run.occurredAt`) are re-stamped when a replay produces the delivery, so two deliveries of one
transition are not byte-identical and a content hash will not collapse them. Stamping them once and
persisting them would make the body stable, and would mean the claim table this decision exists to
avoid. The contract is documented on `runWebhookDeliverySchema` and pinned by a test.

Two suppressions ride the projection: a headless internal ANCHOR block (the public API's own
initiative run) is skipped exactly as the live SPA push is (its "task" is not a board task and its
title is the caller's brief, and `GET /api/v1/jobs/:id` already serves it) and a block that
vanished under a settling run still yields a usable event, because the ids are what a receiver
routes on and an empty title is honest about what could be read.

## Rationale

- **Counterpart, not reimplementation.** Every route delegates to the service method the SPA
  already drives. That is what kept a lifecycle this wide to contract + controller work, and it is
  why the external and internal surfaces cannot disagree about what `stop` or `act` means. The one
  shared side-effect switch, `notificationActEffect`, is imported by both rather than re-inlined.
- **Scopes before destructive power.** `delete` and notification `act` (which performs a REAL
  GitHub merge) sit at the top of the ladder; existing keys backfilled to `write`, keeping their
  pre-scope capabilities with no auto-grant. Shipping the mutating endpoints ungated and adding
  scopes later would have meant taking capability away from live integrations.
- **Keyset, never offset.** An external caller polls, and an offset page shifts under concurrent
  inserts: a row created between two pages either repeats or is skipped and never seen again. The
  cursor is the `(sortKey, id)` COMPOSITE because a burst of concurrent starts shares a
  millisecond, and it is opaque so its shape can change without a contract break. It is not signed
  and needs no signing: it carries a position, never authority, and every route re-applies its
  full scope regardless of what the cursor says.
- **A push beats a poll for the case that has no timeout.** A parked run waits for a human
  INDEFINITELY by design, and a settled run raises nothing. Both are cases where "the caller will
  notice eventually" is not a design.

### Alternatives considered and rejected

- **A second webhook table keyed per API KEY.** The tracker originally scoped item #10 that way. It
  would have duplicated the endpoint record, the sealed secret, the SSRF guard and the retry loop
  for a granularity nobody asked for: public keys are workspace-scoped anyway, so a per-key
  endpoint distinguishes nothing a per-workspace one does not. _(Still rejected after the named
  collection landed, and for the same reason: the collection re-keyed the ONE table by a
  caller-chosen id rather than adding a second one, so an integration names its own endpoint
  without tying its lifetime to a key it may rotate.)_
- **A claim table for terminal deliveries.** Rejected above: it buys exactly-once for an effect a
  receiver collapses with one `deliveryId` comparison, at the price of a table, a status machine, a
  re-claim TTL and a sweeper on both facades.
- **Per-step lifecycle events.** A firehose: the engine emits on every container poll. The SSE
  endpoints already serve a caller that wants step-level detail, bounded by their own poll.
- **A `since` filter on the TASK list.** Not deliverable: `blocks` carries no creation or update
  timestamp, so a time filter would have to be faked from something that is not one. The list is
  ordered by the stable block id instead: deterministic and safe to page over, but carrying no
  "newest first" meaning. A real `since` means adding `created_at` to the hottest table in the
  system; it stays unbundled until a consumer asks for incremental task polling.
- **Exposing `accountStatus` / `budgetCaps` on `GET /usage`.** Cross-workspace and per-user data
  behind a workspace-scoped key.

## Consequences

- **`/api/v1` is additive forever.** _Superseded by
  [ADR 0034](./0034-public-api-stability.md):_ the "be deliberate, flag it prominently" posture
  became a hard stability commitment (additive freely; anything else needs an incremental
  migration path plus a version change), adopted together with the final pre-stability breaking
  polish (the `/jobs` path unification, `publicTask.runId`, the board-start scope rule).
- **`docs/openapi.json` is generated from these Valibot contracts** (`pnpm gen:openapi`) and CI
  fails on drift (`pnpm check:openapi`). Every change that adds or alters a public contract commits
  the regenerated spec in the same PR, and a new named DTO needs its `COMPONENT_SCHEMAS` +
  `OPERATION_DOCS` entries in `scripts/generate-openapi.mjs`.
- **A new list must follow the paging rules**, which are the ones that bit: read `limit + 1` to
  decide `nextCursor`; digit-check a numeric query param BEFORE coercion (`Number()` accepts `' '`,
  `1e9` and `0x64`); a malformed cursor is a 400 `invalid_cursor`, never a silent fall back to page
  one; a coarse public status filter EXPANDS to the internal statuses it maps from, derived from
  the projection rather than hand-listed; the cursor's sort key must be the exact value the query
  orders by, from the same source; and an id list resolved by a prior read goes down as a SUBQUERY,
  never a dynamic `IN (...)` (D1 hard-rejects a statement over 100 bound parameters).
- **The webhook rows are now read on the run's terminal path**, so their repository is allow-listed
  for mothership mode (`get` / `list` / `put` / `delete`, workspace-scoped). An un-routed method
  there would surface only as a webhook that silently never fires, because every delivery path is
  best-effort. `list` is the one the delivery paths call.
- **Every delivery path stays best-effort but never invisible**: a failure is swallowed and reported
  through the facade's structured logger, naming the endpoint it belonged to, so a broken receiver
  is diagnosable and does not mask a healthy sibling's state.
- **The notification webhooks still have no SPA panel**: they are managed over
  `GET|PUT|DELETE /workspaces/:ws/notification-webhook[s]` behind `integrations.manage`. Their
  consumer is a headless integration whose operator is already using the API; a settings panel is
  worth adding when a human-facing deployment wants one, and it would now carry the `runEvents`
  selector and the endpoint list too.
- **Tier 4 is now one item, not three**: `POST /bootstrap` stays deferred (container-backed and
  force-pushes to GitHub, breaking the "public runs never touch GitHub" invariant), and serving
  `GET /api/v1/openapi.json` stays unbuilt but trivial (the spec already ships as a repo file, so an
  endpoint is only packaging). Document/requirements ingestion at task creation SHIPPED, with the
  decision surface ([ADR 0043](./0043-public-decision-surface.md)): the create
  takes an ordered `documents` list, each entry naming a page in a connected source or carrying the
  text itself. It landed because the gap it names was never really about the documents model: it was
  that this surface had no spec-sized input at all for a run that touches a repository, `description`
  being a task's own framing at 2,000 characters and the 50,000-character `POST /jobs` brief being
  inline-only.
- **The parked-decision surface was INCOMPLETE, and completing it is
  [ADR 0043](./0043-public-decision-surface.md)**: the public
  decision surface answers three park types (requirements review, fork, judge) while the engine has
  more, and both start paths admit (for a `decide`-scope key; since
  [ADR 0034](./0034-public-api-stability.md) the board start applies the same parking rule as
  `POST /jobs`) a run that can park on one of the others. That record ranks the additions, and
  records what was considered and rejected. **Since largely closed**: the tracker's A1–A6 landed,
  so every park a pipeline can carry is answerable except `human-review`, whose answer is a person
  approving the pull request on the VCS host rather than an API call. The tracker stays the place
  to look: it records the two park surfaces that enumeration missed.
- **An incomplete surface must not ADVERTISE what it cannot do.** The `pipeline_requires_decide_scope`
  refusal originally told the operator a `decide` key answers the park through
  `/api/v1/runs/:runId/decisions`, which held for one of the five parks it named: selling a scope
  upgrade that buys a run whose only exit is cancel. It is now built from the pipeline's actual park
  surfaces against `PUBLICLY_ANSWERABLE_PARK_SURFACES` (`publicApiAdmission.ts`), a set kept
  deliberately apart from `PARKING_INLINE_KINDS` so the gap is machine-readable and each slice that
  closes one updates the message by adding a member. Admission itself is unchanged.
