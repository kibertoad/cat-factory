# @cat-factory/sdk

## 0.6.1

### Patch Changes

- 1f14793: Documentation cleanup and consistency: neutral naming across docs, code comments,
  example fixtures and historical changelog entries, with the OpenAPI spec and
  generated SDK clients regenerated so their description strings match. No behaviour
  or API change.

## 0.6.0

### Minor Changes

- 10e0341: Answer the pre-dispatch input gate over the public API, and stop it judging blocks that carry no
  authored task input.

  The gate is the one park that turns on the shape of the TASK rather than the pipeline, so the
  public surface's park enumeration (which reads the step chain) could not see it: a `write`-scope
  key could start a title-only task on a pipeline that parks nowhere and get a run stopped before
  its first dispatch, with `GET /api/v1/runs/:runId/decisions` reporting `parked: true`, nothing to
  answer, and cancel as the only exit. The verdict is now a parked decision of its own, resolvable
  at `POST /api/v1/runs/:runId/decisions/input-gate/resolve` with the same `recheck` / `proceed`
  choices the app offers, and admission composes it in, so a key that cannot answer the park is
  refused up front with a message naming it. Additive on `/api/v1`: OpenAPI `info.version` 1.2.0,
  and the four SDK clients gain `decisions.resolveInputGate`.

  `not_applicable` now covers any block whose description is not authored task input, which is the
  block LEVEL plus the recurring task type rather than a task-type list alone. A run started against
  a frame, module, epic or initiative ANCHOR reads the entity it stands for, not the caption on the
  card, so judging that caption parked every initiative planning run on a field the flow never fills
  in. A task the platform merely CREATED with a real brief (an initiative-spawned item, a ticket
  import) is deliberately still judged.

  Advisory findings are also visible at last: they were recorded on the run and reported over the
  API while rendering nowhere, which left `advisory` mode with nothing to watch.

## 0.5.0

### Minor Changes

- cc17221: Price the three input token classes at their own rates and surface the resulting cost on the run
  and debug surfaces.

  `ModelPrice` gains `cacheReadPerMillion` / `cacheWritePerMillion`, derived from the base input
  rate where an entry names neither. This fixes a spend-gate defect as well as adding a display:
  the ledger previously metered every input token at the fresh rate, so a cache-read-dominated run
  was priced at roughly ten times its real cost and could exhaust a budget it had barely touched.

  The telemetry stores now aggregate one grain finer (`agentKind, phase, provider, model`) so a
  run's rollup can be priced while the model is still attached, and `priceRollupCells` folds the
  model away again, returning the `(agentKind, phase)` cells every consumer already read, now
  carrying `costEstimate`. That collapsed cell is its own type (`LlmRollupCell`), so a reader
  cannot ask it which model it was: after the fold there is no single answer. An unpriceable slice
  reports `null` rather than `0`, and a total containing one propagates that null instead of
  reporting a partial sum as complete.

  Public API (`/api/v1`), additive, `info.version` 1.1.0 → 1.2.0: the debug run overview's LLM
  rollups carry `costEstimate` and the block carries `costCurrency`. The four SDK clients are
  regenerated; the Python and Java manifests are bumped so the new models publish.

  The run's LLM-metrics export now states whether it is `truncated`. It is capped at the newest
  1000 calls, and a cost folded from that slice would be a smaller number that still reads as the
  run's total, so a truncated bundle reports null costs rather than pricing the part it holds.

## 0.4.0

### Minor Changes

- 36b1853: Ticket context is a first-class input to public task creation, and Jira ADF replies are read.

  `POST /api/v1/services/:serviceId/tasks` takes an optional `ticket` (`{ source, ref }`, where
  `ref` is a canonical issue key or a full issue URL). The platform imports that issue and ATTACHES
  it to the new task, the same linkage the app's own create-from-issue produces: each agent step
  re-reads the live issue as context, the writeback path posts a run's clarification questions onto
  it, a reply typed on the ticket resolves against the parked run, and the intake sweep treats the
  issue as taken. Before this a headless intake could only paste the issue into `description`, which
  kept the words and lost all of that.

  Additive on the wire (OpenAPI surface `1.0.0` → `1.1.0`; regenerated in all four SDKs). Two
  refusals are worth knowing about: the ticket is resolved BEFORE the task is created, so an unknown
  source or an issue the tracker will not serve leaves the board untouched rather than producing an
  unlinked task; and a ticket already linked to another task is a `409` carrying
  `details.reason: 'ticket_already_linked'` plus `details.taskId`, which is what lets a redelivering
  integration follow the existing task instead of filing a duplicate. That reason is now also
  emitted by the app's create-from-issue, which previously refused the same condition in prose only.

  One task per ticket now holds under CONCURRENCY, which is what redelivery actually produces. The
  read that refuses has already returned by the time a task is created, so `TaskRepository` gains
  `claimBlockLink` (a conditional write on `linked_block_id`, mirrored D1 and Drizzle with a
  concurrent conformance assertion) and both filing paths go through it. Previously two simultaneous
  filings of one issue both succeeded, and the second silently re-pointed the link, stripping the
  first task of the context it was created with. The headless filing additionally rolls its task
  back off the board when it loses, so retrying on the `409` cannot accumulate duplicates.

  Jira's ADF renderer is also bounded now. A comment body is external structure rather than something
  the vendor's editor produced, and a recursive walk over it was an unbounded stack and, on the
  Worker, an unbounded request budget. It renders under a node and depth budget far above any real
  document and states it when either is hit, rather than stopping where a reader would read the cut
  as the end of the text.

  Separately, Jira Cloud comment webhooks are read as Atlassian Document Format. Jira v3 sends
  comment bodies as an ADF document rather than a string, so every rich-text reply was dropped
  before it reached the review-reply grammar, and silently: an unparsed delivery is acked, so a
  reporter who answered a clarification question in Jira's own editor got nothing recorded and no
  acknowledgement saying so. The bodies now go through the import path's own `adfToMarkdown`, which
  gained the leaf nodes that carry their text in `attrs` (mention, emoji, status, smart link) so a
  name, a state or a link no longer vanishes out of the middle of a sentence.

## 0.3.0

### Minor Changes

- 1106c93: BREAKING (public API, the last permitted break): the final pre-stability polish of `/api/v1`,
  adopted together with the stability commitment (ADR 0032). From this release the public API does
  not change without an incremental migration path and a version change.

  - `POST /api/v1/initiatives` moved to `POST /api/v1/jobs`, unifying the headless job lifecycle
    under one resource root. The SDK group `initiatives` is now `jobs`; the wire schemas renamed to
    `CreatePublicJob` / `PublicJobAccepted`.
  - `publicTask.executionId` renamed to `publicTask.runId`, matching `publicRun.runId` and
    `/api/v1/runs/:runId/...`.
  - `POST /api/v1/tasks/:taskId/start` now requires a `decide`-scope key when the resolved pipeline
    can park on a human decision, the same rule `POST /api/v1/jobs` applies. Existing `write` keys
    that started such pipelines get `403 pipeline_requires_decide_scope`.

  **Check your integrations against this last one before upgrading.** A pipeline parks in three ways,
  and the third is easy to miss: an approval gate on an enabled step, an inline review/brainstorm
  kind, or an unbounded human-wait gate (`human-review`). That third case means the shipped
  **Adaptive build** preset (`pl_full`) now needs a `decide` key, because it carries a risk-gated
  `human-review` step. The unconditional presets (`Standard build`, `Simple build`) never park and
  remain startable with a plain `write` key, as do the pipelines a workspace authored without gates
  or review kinds.

  Mint a `decide`-scope key for any integration that starts parking pipelines. The scope only widens
  what a key may set in motion; it grants no destructive capability (that is `admin`).

## 0.2.0

### Minor Changes

- 8b31fe0: Add official public-API SDK clients for TypeScript, Python, Go and Java (the Java artifact also
  serving Kotlin), plus a cross-SDK smoketest and release gating.

  Models and operation methods are **generated** from `docs/openapi.json` — itself generated from
  the Valibot route contracts — so a client cannot drift from the deployment it talks to. Each SDK's
  transport, error hierarchy, retry policy, pagination helper and SSE reader are hand-written, so a
  contract change never rewrites behaviour and a behaviour fix is never re-applied 38 times in four
  languages. `pnpm gen:sdk` regenerates; `pnpm check:sdk` guards drift and version skew in CI.

  `backend/internal/sdk-smoketest` boots a real Node backend and drives the same scenario through
  all four clients, comparing their observation reports — the only check that can see the four
  disagree.

  **No separate Kotlin SDK, deliberately.** Kotlin's own `@Metadata` cannot be synthesised onto a
  Java jar, but the metadata Kotlin _reads_ can be: the model and resource packages are JSpecify
  `@NullMarked`, Kotlin hard keywords are escaped (`PublicPipeline.public` → `isPublic()`, wire name
  preserved), the error hierarchy is sealed, builders replace absent default arguments, and enums
  tolerate unknown values. A Kotlin caller gets real nullability instead of platform types; what it
  does not get is `copy()`/destructuring on the records.

  Also fills a documentation gap in the published OpenAPI spec: 11 operations (the whole
  `/api/v1/debug/*` surface plus `deletePublicTask`, `listPublicJobs` and `resolvePublicRunJudge`)
  carried no summary or description and were tagged with a catch-all `Public API` tag. They are now
  documented and tagged `Debug` / `Tasks` / `Initiatives` / `Decisions`, so the four generated
  clients inherit real docs.

### Patch Changes

- 8b31fe0: Keep the SDK `User-Agent` version constants in step with their manifests on release.

  `@cat-factory/sdk` is an ordinary workspace package, so changesets bumps
  `sdk/typescript/package.json` when it builds the release PR — but nothing updated the two constants
  derived from that number (the TypeScript transport's `SDK_VERSION`, and Go's `Version`, which
  tracks the TypeScript manifest because a Go module carries no version of its own). Every release PR
  would have been born red on the version-skew half of `check:sdk`.

  `scripts/sync-sdk-versions.mjs` now runs from the root `version` script, the twin of
  `sync-runner-image-tags.mjs`, with the manifest/constant table shared with the guard so the writer
  and the checker cannot drift.

- 8b31fe0: Fix what the SDK clients' request deadline bounds, and how live stream frames reach a caller.

  The four clients disagreed about a stream's lifetime, and two of them were wrong. Go's per-attempt
  `context.WithTimeout` kept running over the response body, so every `Stream` died at `Timeout`
  (30s by default) with `context deadline exceeded` on a run that was healthy. Python's reader called
  `read(1024)` on urllib's `HTTPResponse`, which blocks until it has 1024 bytes — so no frame reached
  the caller until the stream ENDED and they all arrived at once. Both present as the same thing in
  production: a run that silently appears to stall.

  The deadline now bounds the RESPONSE and never a stream, in all four. That is the correct semantic
  for this API rather than a convenience: the deployment writes an SSE frame only when a run's
  projection changes, sends no heartbeat, and a parked run waits for a human indefinitely by design,
  so a quiet stream is the normal state of a healthy one.

  Also in the hand-written halves: a TypeScript caller abort carrying a non-`AbortError` reason is no
  longer retried and reported as a connection failure; `close()` on a stream that was never iterated
  now actually releases the socket; Java stops emitting duplicate `authorization` headers when a
  caller supplies their own, and an unmapped 4xx (402, 413, a status this surface gains later) stays
  the base exception instead of being reported as a deployment fault; Go gains the `TimeoutError` the
  other three already had; every SDK reads both `Retry-After` wire forms; and an auto-pager that is
  handed back the cursor it just sent raises instead of looping forever.

  Generated Go parameter names lose a leading-initialism bug that spelled ten published signatures
  `Cancel(ctx, iD string)`.
