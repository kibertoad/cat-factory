# @cat-factory/local-server

## 0.105.4

### Patch Changes

- Updated dependencies [cec0c3e]
  - @cat-factory/contracts@0.235.0
  - @cat-factory/kernel@0.235.0
  - @cat-factory/integrations@0.126.0
  - @cat-factory/orchestration@0.202.0
  - @cat-factory/server@0.214.0
  - @cat-factory/node-server@0.168.0
  - @cat-factory/agents@0.110.5
  - @cat-factory/gitlab@0.15.29
  - @cat-factory/executor-harness@1.90.0

## 0.105.3

### Patch Changes

- Updated dependencies [8cbf1a7]
  - @cat-factory/contracts@0.234.0
  - @cat-factory/integrations@0.125.0
  - @cat-factory/server@0.213.0
  - @cat-factory/agents@0.110.4
  - @cat-factory/gitlab@0.15.28
  - @cat-factory/kernel@0.234.2
  - @cat-factory/orchestration@0.201.2
  - @cat-factory/node-server@0.167.2
  - @cat-factory/executor-harness@1.90.0

## 0.105.2

### Patch Changes

- Updated dependencies [ee6601e]
  - @cat-factory/contracts@0.233.0
  - @cat-factory/orchestration@0.201.1
  - @cat-factory/server@0.212.1
  - @cat-factory/agents@0.110.3
  - @cat-factory/gitlab@0.15.27
  - @cat-factory/integrations@0.124.1
  - @cat-factory/kernel@0.234.1
  - @cat-factory/node-server@0.167.1
  - @cat-factory/executor-harness@1.90.0

## 0.105.1

### Patch Changes

- Updated dependencies [937d4af]
  - @cat-factory/contracts@0.232.0
  - @cat-factory/kernel@0.234.0
  - @cat-factory/orchestration@0.201.0
  - @cat-factory/server@0.212.0
  - @cat-factory/integrations@0.124.0
  - @cat-factory/node-server@0.167.0
  - @cat-factory/agents@0.110.2
  - @cat-factory/gitlab@0.15.26
  - @cat-factory/executor-harness@1.90.0

## 0.105.0

### Minor Changes

- 2580fee: Add OTLP log export: the platform's own structured log lines can now be shipped to the same
  OpenTelemetry endpoint as its traces and metrics.

  A new kernel `LogSink` port lets a facade install a second destination on the logging adapter,
  and `@cat-factory/observability-otel` implements it as a fetch-based exporter POSTing OTLP log
  records to `{endpoint}/v1/logs`. Lines keep their field names, carry their `child`-bound
  correlation ids, and a line naming an `executionId` is stamped (through the same `deriveTraceId`
  the spans go through, not a second copy of it) with that run's trace id and a sampled flag, so
  logs and traces join in the backend.

  Observability may not become a new failure class, so the drain path is total and the send chain
  is terminated: a field that cannot be read or serialised is reported in place of its value rather
  than escaping into the chain, where a rejection would have silenced the exporter permanently and,
  on Node, exited the process through the unhandled-rejection guard. The shutdown flush is bounded
  so it cannot outlast a SIGTERM grace period.

  Opt-in on top of the existing exporter: `OTEL_LOGS=true` plus `OTEL_ENABLED=true` and an
  endpoint, with `OTEL_LOGS_MAX_BATCH_SIZE` and (Node only) `OTEL_LOGS_FLUSH_INTERVAL_MS`.
  `LOG_LEVEL` governs what is exported. Nothing changes for a deployment that has not opted in.

### Patch Changes

- Updated dependencies [2580fee]
- Updated dependencies [eb4ca17]
  - @cat-factory/kernel@0.233.0
  - @cat-factory/server@0.211.0
  - @cat-factory/node-server@0.166.0
  - @cat-factory/contracts@0.231.0
  - @cat-factory/orchestration@0.200.0
  - @cat-factory/executor-harness@1.90.0
  - @cat-factory/agents@0.110.1
  - @cat-factory/gitlab@0.15.25
  - @cat-factory/integrations@0.123.6

## 0.104.1

### Patch Changes

- 1f14793: Documentation cleanup and consistency: neutral naming across docs, code comments,
  example fixtures and historical changelog entries, with the OpenAPI spec and
  generated SDK clients regenerated so their description strings match. No behaviour
  or API change.
- 2619d79: MCP maturation slice 1: every declared tool server is either served or STATED.

  A dispatch now checks the running harness's MCP TRANSPORTS, not just whether it speaks MCP, so an
  `http` server on a Codex run (whose client is stdio-only) is dropped under a new
  `transport_unsupported` reason instead of being advertised in the prompt and then silently skipped by
  the harness's TOML writer. Boot validation and the capability-credential checklist now enumerate
  `AgentKindRegistry.kindsWithCapabilities()` (every kind declaring a capability on its own
  registration, plus every kind named by `assignSkills` / `assignToolServers`), so a server attached to
  a built-in such as `coder` reaches the same refusals and the same operator checklist as a registered
  kind's own. New checks: a transport/harness combination no run could serve, an `allowedTools` entry
  that is not a single tool name (the harness joins the list with commas), and a per-dispatch server
  budget, both dimensions of which warn at boot and drop the excess under `over_budget` at dispatch.
  The harness exempts `mcp__*` calls from the no-edit progress bound and bounds them with their own
  `JOB_MAX_CONSECUTIVE_MCP_CALLS` streak, plus a `JOB_MAX_CONSECUTIVE_NON_ACTION_CALLS` backstop shared
  by every no-edit-exempt family (each per-family streak resets on a call outside its family, so
  interleaving two of them was bounded only by the job's wall-clock ceiling).

  OPERATORS UPGRADING: capabilities attached by `assignSkills` / `assignToolServers` were previously
  not boot-validated at all, so a declaration that is now an ERROR (a cleartext off-loopback endpoint,
  a reserved credential key, an unregistered id, a malformed server id or tool name) turns a
  deployment that used to start into one that refuses to. That is the intent of the change, and each
  message names the kind and the declaration to fix.

  INTERNAL BREAK: `UnavailableToolServer['reason']` gains `transport_unsupported` and `over_budget`, so
  a deployment rendering that union exhaustively must map them. Runner image bumped to 1.89.0.

- Updated dependencies [1f14793]
- Updated dependencies [2619d79]
  - @cat-factory/contracts@0.230.1
  - @cat-factory/kernel@0.232.0
  - @cat-factory/agents@0.110.0
  - @cat-factory/server@0.210.0
  - @cat-factory/orchestration@0.199.0
  - @cat-factory/integrations@0.123.5
  - @cat-factory/node-server@0.165.1
  - @cat-factory/executor-harness@1.90.0
  - @cat-factory/gitlab@0.15.24

## 0.104.0

### Minor Changes

- e7e4404: Reusable operations, slice 2: one descriptor-driven form vocabulary behind both surfaces that have
  one, and a custom task type's collected values are now checked against what it declares.

  An initiative preset and a custom task type had grown the same feature twice, and the task type was
  the poorer copy: four input types against eight, no defaults, no conditional visibility, no shared
  validation, and two near-identical Vue renderers. So a form an org could express as a preset was
  unexpressible as an operation, and nothing but the create form enforced a `required` marker or an
  option list. `contracts/src/form-fields.ts` is now the union both draw on (the field shape, the
  filled-value bag, and the pure visibility / validation / sanitization / prose-rendering rules), with
  each surface declaring only which input types it admits. `password` is excluded for a task type by
  construction rather than by convention: a collected value is folded into prompts, projected onto the
  board snapshot and captured in telemetry, so a secret belongs in the capability-credential store.

  `taskTypeFields.custom` widens from `string | number` to the shared bag (adding booleans and
  multi-select `string[]`), and the prompt fold renders the new shapes through the same renderer the
  form review uses, so a multi-select reads as its option captions rather than its stored enum values.
  Rows are read back through an unvalidated JSON parse, so nothing existing breaks and there is nothing
  to migrate. Two INTERNAL breaks ride along, in the bounds the shared bag carries that the old
  untyped record did not: a bag KEY is now capped at 80 characters and a string VALUE at 2000, so a
  value longer than that (only reachable through a bespoke `formPanel`, since a declared `maxLength`
  cannot exceed the same bound) is refused on the way in.

  `BoardService.addTask` now validates a registered type's bag against its descriptor and freezes only
  the declared, currently-visible answers, so one rule covers the SPA, the internal API and (from the
  public-API slice) a headless caller. An ABSENT bag is checked against an empty one, because a
  required field is unanswered whether the caller sent `custom: {}` or no `custom` key at all: a check
  the caller can opt out of by sending nothing is not a check. **Behaviour change for a deployment
  that registers an operation with required fields**: any path creating such a task without its
  parameters (an initiative item's `spawn`, a script) now gets a 422 where it previously created a
  task whose operation brief was empty. Three cases still deliberately pass through unchecked: a
  built-in type (schema-typed fields, already validated), a type this process does not register (a
  supported row, since task types are node-local by design and degrading data must not brick
  creation), and a descriptor declaring a bespoke `formPanel`, which owns its own bag.

  The richer vocabulary brings new ways for a descriptor to break itself, so boot validation now
  refuses a create form that structurally cannot be filled: a duplicate field key, an optionless
  `select`/`checkbox-group`, or a `showWhen` gating a field on a key the type does not declare (which
  would hide that field forever). Each is fully known from the registration and silent at run time,
  unlike a `defaultFragmentIds` id, which stays a warning because a tenant-tier fragment is invisible
  at boot. Both surfaces are held to that bar by one checker, so an initiative preset's create form is
  validated at boot for the first time (all three facades pass the registry).

  Behaviour change worth reviewing: a custom task type's `select` field renders as a dropdown rather
  than a button row, since it is now the shared renderer, and a form with many options needed that
  anyway. The path-invalid message moved from `initiative.create.pathInvalid` to `common.pathInvalid`,
  carrying each locale's existing translation.

  One unfilled value is now dropped rather than frozen, on both surfaces. Validation short-circuits on
  a value that says nothing, so a `false` on a text field, a blank string or an empty multi-select
  reached the freeze having passed no type check; sanitization now drops them, which stops a
  wrong-typed answer reaching agents as the operation's own brief (`notes: false` rendered as
  `Notes: No`). The one exception is an explicit `false` on a `checkbox`, which is the opt-OUT of a
  default-ON toggle and the one unfilled value that is an answer.

### Patch Changes

- Updated dependencies [e7e4404]
  - @cat-factory/contracts@0.230.0
  - @cat-factory/kernel@0.231.0
  - @cat-factory/orchestration@0.198.0
  - @cat-factory/node-server@0.165.0
  - @cat-factory/agents@0.109.2
  - @cat-factory/gitlab@0.15.23
  - @cat-factory/integrations@0.123.4
  - @cat-factory/server@0.209.1
  - @cat-factory/executor-harness@1.88.0

## 0.103.3

### Patch Changes

- Updated dependencies [10e0341]
- Updated dependencies [10e0341]
  - @cat-factory/contracts@0.229.0
  - @cat-factory/kernel@0.230.0
  - @cat-factory/orchestration@0.197.0
  - @cat-factory/server@0.209.0
  - @cat-factory/node-server@0.164.0
  - @cat-factory/agents@0.109.1
  - @cat-factory/gitlab@0.15.22
  - @cat-factory/integrations@0.123.3
  - @cat-factory/executor-harness@1.88.0

## 0.103.2

### Patch Changes

- Updated dependencies [fccb1df]
  - @cat-factory/contracts@0.228.0
  - @cat-factory/kernel@0.229.0
  - @cat-factory/agents@0.109.0
  - @cat-factory/orchestration@0.196.0
  - @cat-factory/gitlab@0.15.21
  - @cat-factory/integrations@0.123.2
  - @cat-factory/server@0.208.2
  - @cat-factory/node-server@0.163.2
  - @cat-factory/executor-harness@1.88.0

## 0.103.1

### Patch Changes

- Updated dependencies [437a0c6]
  - @cat-factory/contracts@0.227.0
  - @cat-factory/integrations@0.123.1
  - @cat-factory/agents@0.108.3
  - @cat-factory/gitlab@0.15.20
  - @cat-factory/kernel@0.228.1
  - @cat-factory/orchestration@0.195.3
  - @cat-factory/server@0.208.1
  - @cat-factory/node-server@0.163.1
  - @cat-factory/executor-harness@1.88.0

## 0.103.0

### Minor Changes

- 43fd5c0: Route platform-health alerts to the workspace's outbound webhook as their own event family, so
  on-call tooling can be paged by the deployment watching itself.

  A workspace's registered endpoint gains an `alertEvents` filter beside `types` and `runEvents`,
  carrying `platform_health.firing` when the health sweep's set of tripped conditions changes and
  `platform_health.resolved` when it observes the account recover. Empty means none, like
  `runEvents`: subscribing a receiver to alerts is always explicit.

  The `platform_health` notification CARD could already be named in the `types` filter, and for a
  human overseer it still should be. It is not safe to page on: a card is re-delivered when a human
  acts on it or dismisses it, which is indistinguishable on the wire from the sweep clearing it
  because the deployment recovered. These edges come from the sweep's own verdict, and carry each
  condition's observed value and threshold (which the card deliberately omits, since its payload is
  its dedup identity).

  Each delivery is identified by `<cardId>:<event>:<transition>[:<reasons>]`, where the transition
  ordinal is counted on the card row itself. Neither simpler key works: a condition set recurs within
  one incident (`{A}` → `{A,B}` → `{A}`), so keying on the set drops the page saying it subsided,
  while keying on a timestamp pages twice whenever two of the deployment's sweepers observe one
  transition. `occurredAt` is the sweep's own observation of the transition rather than anything read
  off the card, whose `createdAt` is preserved across a re-raise and so names when the incident
  opened.

  Internal break: `NotificationWebhookRecord` gains a required `alertEvents` field, and the
  `notification_webhooks` table gains an `alert_events` column on both runtimes. Existing rows
  default to `[]`, so every registered endpoint keeps its current behaviour byte-for-byte.

  The `platform_health` notification payload gains an optional `platformAlertTransition`, which
  carries that ordinal and so also lets a caller reading `GET /api/v1/notifications` line a card up
  against the alert deliveries it received. That is an ADDITIVE public-API change: the OpenAPI
  `info.version` goes to 1.3.0 and the four SDK clients plus the MCP facade regenerate, with no
  existing field renamed, retyped or removed. A card written before this ships carries no ordinal and
  its next transition simply starts the count at 1.

### Patch Changes

- Updated dependencies [43fd5c0]
  - @cat-factory/kernel@0.228.0
  - @cat-factory/contracts@0.226.0
  - @cat-factory/integrations@0.123.0
  - @cat-factory/server@0.208.0
  - @cat-factory/node-server@0.163.0
  - @cat-factory/executor-harness@1.88.0
  - @cat-factory/agents@0.108.2
  - @cat-factory/gitlab@0.15.19
  - @cat-factory/orchestration@0.195.2

## 0.102.1

### Patch Changes

- Updated dependencies [0456066]
  - @cat-factory/contracts@0.225.0
  - @cat-factory/kernel@0.227.0
  - @cat-factory/agents@0.108.1
  - @cat-factory/gitlab@0.15.18
  - @cat-factory/integrations@0.122.2
  - @cat-factory/orchestration@0.195.1
  - @cat-factory/server@0.207.1
  - @cat-factory/node-server@0.162.1
  - @cat-factory/executor-harness@1.88.0

## 0.102.0

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

### Patch Changes

- Updated dependencies [f1a6cb3]
- Updated dependencies [cc17221]
- Updated dependencies [889a497]
- Updated dependencies [3605630]
  - @cat-factory/orchestration@0.195.0
  - @cat-factory/contracts@0.224.0
  - @cat-factory/kernel@0.226.0
  - @cat-factory/agents@0.108.0
  - @cat-factory/node-server@0.162.0
  - @cat-factory/server@0.207.0
  - @cat-factory/gitlab@0.15.17
  - @cat-factory/integrations@0.122.1
  - @cat-factory/executor-harness@1.88.0

## 0.101.3

### Patch Changes

- Updated dependencies [bbc51fa]
- Updated dependencies [36b1853]
  - @cat-factory/orchestration@0.194.0
  - @cat-factory/integrations@0.122.0
  - @cat-factory/node-server@0.161.1
  - @cat-factory/server@0.206.0
  - @cat-factory/contracts@0.223.0
  - @cat-factory/kernel@0.225.0
  - @cat-factory/executor-harness@1.88.0
  - @cat-factory/agents@0.107.1
  - @cat-factory/gitlab@0.15.16

## 0.101.2

### Patch Changes

- Updated dependencies [413095f]
  - @cat-factory/contracts@0.222.0
  - @cat-factory/kernel@0.224.0
  - @cat-factory/agents@0.107.0
  - @cat-factory/orchestration@0.193.0
  - @cat-factory/server@0.205.0
  - @cat-factory/node-server@0.161.0
  - @cat-factory/gitlab@0.15.15
  - @cat-factory/integrations@0.121.2
  - @cat-factory/executor-harness@1.88.0

## 0.101.1

### Patch Changes

- Updated dependencies [04e44f8]
  - @cat-factory/contracts@0.221.0
  - @cat-factory/kernel@0.223.0
  - @cat-factory/orchestration@0.192.0
  - @cat-factory/server@0.204.0
  - @cat-factory/node-server@0.160.0
  - @cat-factory/agents@0.106.8
  - @cat-factory/gitlab@0.15.14
  - @cat-factory/integrations@0.121.1
  - @cat-factory/executor-harness@1.88.0

## 0.101.0

### Minor Changes

- 175f78f: Security hardening round 2, P1: close SEC-3, SEC-4 and SEC-5 (docs/initiatives/security-hardening-round-2.md).

  - **Machine tokens are revocable (SEC-5).** Every `POST /auth/machine-token` mint is recorded on
    the new `machine_nodes` roster (kernel `MachineNodeRepository`; D1 migration
    `0077_machine_nodes.sql` ⇄ Drizzle `machineNodes`), the new shared machine gate
    (`verifyMachineRequest`) checks the revocation tombstone on every `/internal/*` machine surface
    plus the WS subscribe handshake, and the owner drives `GET /auth/machine-nodes` /
    `POST /auth/machine-nodes/:nodeId/revoke`. A revoked node id can never be re-minted and a
    foreign node id cannot be taken over, enforced by the roster WRITE itself (a guarded
    `ON CONFLICT ... WHERE`) so two concurrent mints of one id cannot leave a row whose owner did
    not mint it. A mothership with no roster wired refuses to mint at all, since an unrecorded token
    could never be revoked; a roster read that fails refuses the call rather than serving it, and on
    the WS handshake answers 503 (retry) rather than crashing the upgrade. Rows prune once past
    their latest signed `exp`.
  - **The password throttle is durable and spoof-resistant (SEC-4).** Attempts land in the new
    cross-replica `auth_attempts` ledger (kernel `AuthAttemptRepository`; D1 migration
    `0078_auth_attempts.sql` ⇄ Drizzle `authAttempts`) with a per-`ip:email` burst cap AND a per-IP
    aggregate that catches one-password-many-emails credential stuffing; the in-process Map remains
    only as the store-outage backstop. WHICH header carries the client address is a per-facade
    decision behind `ServerContainer.resolveClientAddress`: Node reads the socket peer, and
    `x-forwarded-for` (rightmost hop, `AUTH_TRUST_PROXY_HOPS` deep) only under the new
    `AUTH_TRUST_PROXY=true`; the Worker reads `cf-connecting-ip`, which is authentic only there.
    Addresses are normalised before keying (port stripped, non-IP refused, IPv6 bucketed to its
    /64). The 429 carries `details.reason: 'auth_attempts'` and `retryAfterSeconds`, and both a trip
    and a store outage are counted (`auth.throttle.limited`, `auth.throttle.store_unavailable`).
    Completes the durable-auth-rate-limiting initiative, now ADR 0032.
  - **Local-runner hosts are loopback-only by default (SEC-3). BEHAVIOUR BREAK:** registering or
    calling a locally-run model endpoint on a private-LAN host (RFC1918 / ULA / mDNS `.local`) now
    requires the operator opt-in `LOCAL_MODELS_ALLOW_LAN=true` on hosted deployments; single-tenant
    local mode defaults the opt-in on. The policy binds the write boundary, the test probe and every
    run-time redirect hop, so an existing LAN row on a hosted deployment is refused instead of
    silently serving an internal-network SSRF surface. Such a row is now also reported on the
    endpoint itself (`LocalModelEndpoint.urlBlockedReason`) and its models are withheld from the
    picker, so the failure surfaces in settings rather than mid-run.
  - **BEHAVIOUR BREAK (SEC-3):** a runner base URL may no longer carry a query string, a `#`
    fragment or `.`/`..` path segments, and `*.localhost` subdomains are no longer accepted (plain
    `localhost` still is). A base URL ending in `#` made the fixed `/models` and `/chat/completions`
    suffixes inert, which turned both server-side forwards into an arbitrary-path request against
    whatever listens on loopback; endpoint URLs are now composed through one validating helper
    rather than concatenated. Every refusal carries a machine-readable
    `LocalRunnerUrlReason` the SPA maps to translated copy.

### Patch Changes

- Updated dependencies [c8ba2cd]
- Updated dependencies [807e442]
- Updated dependencies [807e442]
- Updated dependencies [175f78f]
- Updated dependencies [807e442]
  - @cat-factory/orchestration@0.191.0
  - @cat-factory/contracts@0.220.0
  - @cat-factory/kernel@0.222.0
  - @cat-factory/integrations@0.121.0
  - @cat-factory/server@0.203.0
  - @cat-factory/node-server@0.159.0
  - @cat-factory/agents@0.106.7
  - @cat-factory/gitlab@0.15.13
  - @cat-factory/executor-harness@1.88.0

## 0.100.1

### Patch Changes

- Updated dependencies [1106c93]
  - @cat-factory/contracts@0.219.0
  - @cat-factory/orchestration@0.190.0
  - @cat-factory/server@0.202.0
  - @cat-factory/agents@0.106.6
  - @cat-factory/kernel@0.221.1
  - @cat-factory/gitlab@0.15.12
  - @cat-factory/integrations@0.120.1
  - @cat-factory/node-server@0.158.1
  - @cat-factory/executor-harness@1.88.0

## 0.100.0

### Minor Changes

- f63145d: A deployment can now declare its capability-credential chain store-ONLY, and the operator surface
  describes the chain that was actually composed instead of asserting a default beside it.

  `capabilityCredentialEnvironmentFallback: false` on any facade (`start` / `startLocal` /
  `createWorker`) composes the per-workspace sealed store with no environment resolver behind it. That
  is the multi-tenant shape: with the fallback on, a workspace that has typed nothing silently
  authenticates its runs as whoever set the deployment's variable and bills that vendor account, which
  is the single-tenant answer the store exists to replace. The default is unchanged, because whether a
  hosted deployment should ship store-only is a product call.

  The chain is now composed once, at each facade's composition root, by `buildToolSecretChain`, which
  returns the resolver together with what it consults. The credential checklist reads that rather than
  hard-coding "the environment may still answer", so a blank row means the same thing on the surface
  and in the dispatch path. Both executor builders take that composed chain as a REQUIRED dependency:
  the only default they could have carried is the deployment environment alone, which silently drops
  the per-workspace store, and a default is only safe where the safe answer is the convenient one.

  Compatibility breaks, none of which affect a deployment using the documented facade seams:

  - `environmentFallback` on the capability-credentials view is optional rather than always present,
    and absent is a real answer: a deployment that supplied its own `ToolSecretResolver` replaced the
    chain, so whether it reads the environment is not knowable here, and both guesses fail silently in
    opposite directions.
  - The Worker's process-wide `registerToolSecretResolverFactory` is replaced by
    `registerToolSecretPolicy({ createResolver?, environmentFallback? })`.
  - `resolveToolSecrets` is required on `WorkerExecutorDeps` and `NodeContainerExecutorDeps`. Only a
    deployment assembling an executor without its facade's composition root passed neither; it now
    calls `buildToolSecretChain` itself, which is also what gets it the description the credential
    checklist renders.

### Patch Changes

- Updated dependencies [f63145d]
- Updated dependencies [3b88f66]
  - @cat-factory/contracts@0.218.0
  - @cat-factory/server@0.201.0
  - @cat-factory/node-server@0.158.0
  - @cat-factory/orchestration@0.189.0
  - @cat-factory/integrations@0.120.0
  - @cat-factory/kernel@0.221.0
  - @cat-factory/agents@0.106.5
  - @cat-factory/gitlab@0.15.11
  - @cat-factory/executor-harness@1.88.0

## 0.99.2

### Patch Changes

- Updated dependencies [7f86f07]
- Updated dependencies [7f86f07]
  - @cat-factory/contracts@0.217.0
  - @cat-factory/integrations@0.119.0
  - @cat-factory/server@0.200.0
  - @cat-factory/kernel@0.220.0
  - @cat-factory/node-server@0.157.1
  - @cat-factory/agents@0.106.4
  - @cat-factory/gitlab@0.15.10
  - @cat-factory/orchestration@0.188.3
  - @cat-factory/executor-harness@1.88.0

## 0.99.1

### Patch Changes

- Updated dependencies [87161e8]
  - @cat-factory/contracts@0.216.0
  - @cat-factory/kernel@0.219.0
  - @cat-factory/server@0.199.0
  - @cat-factory/node-server@0.157.0
  - @cat-factory/agents@0.106.3
  - @cat-factory/gitlab@0.15.9
  - @cat-factory/integrations@0.118.1
  - @cat-factory/orchestration@0.188.2
  - @cat-factory/executor-harness@1.88.0

## 0.99.0

### Minor Changes

- 96ad850: Per-workspace capability credentials: the secrets a tool server or generative binary integration
  declares are now stored per TENANT, sealed at rest, instead of only being read off the deployment's
  environment.

  An environment variable is a single-tenant answer: one process serves many workspaces, so one
  variable served them all: every tenant's runs authenticated as whoever set it, no tenant could bring
  its own vendor account, and rotating one tenant's key was a redeploy that rotated everyone's. Every
  other credential in the platform is already a per-tenant sealed row; capabilities were the subsystem
  that had not caught up.

  New: `capability_credentials` (D1 + Postgres), `CapabilityCredentialsService`,
  `createWorkspaceToolSecretResolver` / `composeToolSecretResolvers`, and a `secrets.manage`-gated
  `/workspaces/:workspaceId/capability-credentials` surface that lists which credentials the
  deployment's registered capabilities DECLARE alongside which this workspace has stored. Deleting a
  board reclaims its stored credentials with the rest of its workspace-scoped rows.

  No behaviour change for an existing deployment: the environment resolver is composed BEHIND the
  store per key, so a workspace that has stored nothing resolves exactly as before. The SPA panel is
  the next slice; the API is usable now.

- 96ad850: Close the tool-secret boundary, and give `ToolSecretResolver` a facade seam.

  **Behaviour break (deliberate).** A capability credential (a tool server's `secretKeys`, a
  generative binary integration's `credential.key`) may no longer be LOOKED UP BY an environment
  variable the platform itself reads. Such a definition names both the key it wants and the endpoint
  that key is sent to, so `{ key: 'ENCRYPTION_KEY', usage: 'Authorization: Bearer <value>' }` was a
  registration that booted clean and injected the deployment's master sealing key into a
  prompt-injectable agent process. It is now refused at declaration (a schema issue for a generative
  integration, a `reserved_credential_key` boot error for a tool server) and again at dispatch, where
  the capability is reported to the agent as unavailable: a tool server under its own
  `reserved_secret` reason, kept apart from `missing_secret` because the two need opposite fixes.

  **New `envName`.** The floor binds the LOOKUP key alone. A declaration that needs a specific
  variable in the process it configures sets `envName` beside its `key`
  (`{ key: 'ACME_GITHUB_TOKEN', envName: 'GITHUB_PERSONAL_ACCESS_TOKEN' }`), and that name is held
  only to the narrower toolchain rule, since it reads nothing. Without the split the reserved
  families would make the commonest MCP servers unusable with no workaround open to a deployment,
  because `GITHUB_`, `SLACK_` and `AWS_` cover names the platform does not read and a vendor's own
  SDK does. A deployment that named a platform variable as its lookup key now fails at boot rather
  than silently; a deployment that needs the vendor's name in the process keeps it via `envName`.

  **New seam.** `startLocal`, `start` and `createWorker` each take a `createToolSecretResolver`
  factory, defaulting to the platform's own chain (the per-workspace credential store in front of
  `createEnvToolSecretResolver(env)`). Reaching the port used to mean abandoning the facade and
  reassembling the boot sequence, so the per-workspace credential store the port was designed for,
  and the `allowKeys` bound its own documentation recommended, were both unreachable. On the Worker
  the option registers the resolver process-wide (`registerToolSecretResolverFactory`), because a
  Worker builds a container per entry point and container agents are dispatched by the durable
  driver, which sees no option held on the app.

  Also: the Node executor's default env resolver now reads the injected `env` rather than
  `process.env` directly, so an embedded boot or a test that supplies one is no longer bypassed.

### Patch Changes

- Updated dependencies [96ad850]
- Updated dependencies [96ad850]
  - @cat-factory/contracts@0.215.0
  - @cat-factory/kernel@0.218.0
  - @cat-factory/integrations@0.118.0
  - @cat-factory/server@0.198.0
  - @cat-factory/node-server@0.156.0
  - @cat-factory/agents@0.106.2
  - @cat-factory/orchestration@0.188.1
  - @cat-factory/gitlab@0.15.8
  - @cat-factory/executor-harness@1.88.0

## 0.98.1

### Patch Changes

- Updated dependencies [4c26c01]
  - @cat-factory/contracts@0.214.0
  - @cat-factory/kernel@0.217.0
  - @cat-factory/orchestration@0.188.0
  - @cat-factory/server@0.197.0
  - @cat-factory/agents@0.106.1
  - @cat-factory/gitlab@0.15.7
  - @cat-factory/integrations@0.117.2
  - @cat-factory/node-server@0.155.1
  - @cat-factory/executor-harness@1.88.0

## 0.98.0

### Minor Changes

- 924c6f9: Let a mothership-mode node read the deployment's generative binary integrations from the mothership instead of from its own build.

  `BinaryGeneratorRegistry` shipped registry-only, which meant a mothership deployment — two processes — had to register its integrations on both entry points, with the copies matching only while both ran the same build. A local node one build behind is the normal state of running one, and the resulting failure was both loud and misattributed: the pipeline builder's picker is fed from the workspace snapshot the mothership serves, so a human selects an integration from the product's own picker and every run of that step is then refused by the node with `unknown_generator` — naming a step configuration that is correct, with the half-wired deployment invisible in the message.

  The new kernel `BinaryGeneratorSource` port (`views()` + batched `documentsFor(ids)`) mirrors `FoundationalBuiltinSource` file for file: `GET /internal/binary-generators` (+ `POST .../contracts`) is machine-token gated, mounted on both facades, and reads this process's OWN registry; `HttpBinaryGeneratorSource` throws on every unreadable outcome — a transport error, a refusal, the 404 of a mothership older than the node — rather than answering with an empty set. A mothership-mode node injects it and no longer consults its own registry for a run, warning at boot naming any ids it will ignore; the registry is still boot-validated and is what the route serves when the process is itself a mothership.

  The disposition differs from the estate's in the one place that matters. Those integrations gate ADMISSION, not just prompt enrichment, so an unreachable source is re-thrown as a 503-shaped, retryable `binary_generators_unreachable` and never softened to an empty set — which would refuse correctly configured steps as `unknown_generator` for the duration of an outage. That refusal carries translated copy of its own: user-reachable 503 reasons now live in a `UNAVAILABLE_REASONS` union with an exhaustive `Record` in the SPA, because the status class's generic wording ("this deployment has not configured the capability") is the same misattribution one layer up.

  The best-effort readers keep their own dispositions. The dispatch brief injects nothing, which the trait guidance already defines as "do not attempt any upload; report it". The settled-step read-back records the artifacts and the storage-side verdict — both resolve against the workspace catalog, which an unreachable mothership says nothing about — and marks only the generative judgement withheld, via a new `BinaryOutputReport.generatorsUnverified` rendered as its own warning line. An empty `unknownGenerators` means "every claimed id checked out", so the two may not be spelled alike.

  Within one dispatch the two halves of a selection share ONE `views()` read (`memoizeBinaryGeneratorViews`), scoped to that read wave and discarded with it — one round trip instead of two, with no staleness window to reason about. The workspace snapshot's projection joins the board-load read wave rather than following it, for the same reason.

  The workspace snapshot's picker projection reads the same source, because routing only the engine would have moved the drift to the surface that OFFERS the id rather than removing it. It carries a new `binaryGeneratorsUnavailable` flag for the state a list cannot express: an empty picker is a claim about the deployment's build, and acting on it during an outage sends someone to the wrong repository. The SPA renders that as its own message and disables the selector rather than reporting the selection as invalid.

  Version floor: a node on this release needs a mothership new enough to serve the route. An older one answers 404, which surfaces as an outage rather than as a deployment that registers nothing.

### Patch Changes

- Updated dependencies [924c6f9]
  - @cat-factory/contracts@0.213.0
  - @cat-factory/kernel@0.216.0
  - @cat-factory/agents@0.106.0
  - @cat-factory/orchestration@0.187.0
  - @cat-factory/server@0.196.0
  - @cat-factory/node-server@0.155.0
  - @cat-factory/gitlab@0.15.6
  - @cat-factory/integrations@0.117.1
  - @cat-factory/executor-harness@1.88.0

## 0.97.0

### Minor Changes

- 233e279: Register generative binary integrations (image / music / video generation APIs) in a deployment's own code, and let binary-generating agent steps select them.

  `BinaryGeneratorRegistry` is a new app-owned registry beside the foundational-service one: an integration declares the content types it produces (`image | audio | video | 3d | document`), its media types, endpoint, API contracts and the credential it needs BY NAME. A step picks from it via `stepOptions.binaryOutput.generatorIds` and states the content types it must deliver via `.modalities`; run admission refuses an unregistered id or an uncovered content type under the new `binary_output_generator_invalid` conflict reason. The agent's `.cat-context/binary-output/brief.md` now leads with a Generation section describing each integration, and the credential value reaches only that job's agent process (job body `generatorSecrets`), never a prompt or the telemetry snapshot.

  All three facades take the registry as their own DI option (`binaryGeneratorRegistry`), so a deployment registers integrations on Node and local exactly as on the Worker, and each facade boot-validates the instance it was handed. A new `registry-seams` guard derives the app-owned registry set from `CoreDependencies` and holds each one to a declared route, so the next registry cannot land threaded on one runtime and inert on another.

  The SPA follows the shapes through: the binary-output step picker offers the generative selection (from the workspace snapshot's new `binaryGenerators`, identity only — never a credential key name) and mirrors both new refusals inline, and the report names the integration that produced each artifact plus any the deployment does not register.

  Breaking, pre-1.0: `PipelineStep.binaryOutputs` gains a required `unknownGenerators` array, so reports recorded before this change no longer parse — an affected step's declaration record is re-created on its next run. `ToolSecretResolver.resolve` takes a discriminated `subject` (`tool-server` | `binary-generator`) in place of `serverId`; a deployment implementing that port per workspace must update its signature, and one passing `allowKeys` to the env-backed default must extend the list to cover its integrations' credential keys or they resolve to nothing.

- 54d531d: Count the deployment's operational EVENTS, and let the health alerts see a dead one.

  The platform-observability projection answers "how are the runs doing" by aggregating
  `agent_runs`. It structurally cannot answer what an operator asks during an incident — how often
  container dispatch is failing, whether the sweeper is re-driving more than it was, whether a queue
  is draining — because none of those are rows in a table. A new kernel `OperationalMetrics` port
  counts them, and the OTLP platform exporter ships them as delta sums beside the existing gauges.
  Wired at the sweepers, the container seam, the trace sinks, the notification webhook and every
  app-cache read; `agent_runs` gained a persisted `redrive_count`, so "was this run re-driven three
  times?" is answerable after the process (or the isolate) that did it is gone.

  `platform_health` gained three conditions. The important one is zero-throughput: every existing
  condition divides by runs and goes silent at zero, so a deployment that stopped accepting work
  read identically to a quiet healthy one. Alongside it, a dominant-failure-kind condition (100%
  `evicted` and 100% `agent` produce the same failure rate and need opposite fixes) and one that
  alerts on the sweepers themselves, since a wedged sweeper makes every other signal stale without
  making any of them fire. A sweep pass reports its rate and its failure streak through ONE call
  (`SweepHealthTracker.recordFailure`), and the Worker drives its crons through a `SweepTick` that
  is the facade-symmetric twin of Node's `startSweeper` — so both runtimes cover the same set of
  sweepers, and the tick's counters are flushed after its passes have settled rather than before.

  Also: retention pruning is now isolated per table (one sick table used to abort the whole pass,
  indefinitely, and report zeroes indistinguishable from an empty table); `/ready` round-trips
  pg-boss's own connection instead of trusting a process-local boolean, and the Worker gained a
  bindings-probing `/ready`; and every pg-boss queue is created with a dead-letter sibling whose
  depth rides the `queue.depth` gauge under `state: dead_letter`, with an hourly sweep logging the
  source queue to go and look at.

### Patch Changes

- Updated dependencies [233e279]
- Updated dependencies [54d531d]
  - @cat-factory/contracts@0.212.0
  - @cat-factory/kernel@0.215.0
  - @cat-factory/agents@0.105.0
  - @cat-factory/orchestration@0.186.0
  - @cat-factory/server@0.195.0
  - @cat-factory/node-server@0.154.0
  - @cat-factory/executor-harness@1.88.0
  - @cat-factory/integrations@0.117.0
  - @cat-factory/gitlab@0.15.5

## 0.96.2

### Patch Changes

- Updated dependencies [87ed4f9]
  - @cat-factory/contracts@0.211.0
  - @cat-factory/server@0.194.0
  - @cat-factory/agents@0.104.3
  - @cat-factory/gitlab@0.15.4
  - @cat-factory/integrations@0.116.4
  - @cat-factory/kernel@0.214.1
  - @cat-factory/orchestration@0.185.2
  - @cat-factory/node-server@0.153.2
  - @cat-factory/executor-harness@1.86.2

## 0.96.1

### Patch Changes

- 3435bd1: Drop the version-pinned model ids from the harness's `model` doc comment. It read
  `e.g. claude-opus-4-8 / gpt-5.5-codex` — and `gpt-5.5-codex` was never a valid Codex slug,
  so the example pointed at a model that cannot run. A pinned example rots on every vendor
  release for no benefit: the field's contract is "the vendor's own id, not a catalog id",
  which the comment now states directly instead of illustrating.

  Comment-only, but it lands under `executor-harness/src`, so the image tag is bumped
  (1.86.0 → 1.86.1) with the three pins synced. **Publishing still requires
  `pnpm image:publish` + `pnpm deploy` from `deploy/backend`** — reusing a tag does not roll
  out, which is the whole reason the tag moves.

- 3435bd1: Refresh the model catalog against what the providers actually serve (Aug 2026). Several
  curated entries pointed at ids their provider has since retired, so the model was
  un-runnable rather than merely dated:

  - **Cloudflare Workers AI**: `@cf/meta/llama-3.1-8b-instruct` and `@cf/moonshotai/kimi-k2.5`
    were deprecated on 30 May 2026. `cloudflare-llama` now serves `llama-4-scout` (131K,
    tool calling) and the `kimi-k2.5` entry is removed. The `conflict-resolver` routing
    default on BOTH runtimes pointed at the deprecated K2.5 and moves to K2.6. Adds
    `gpt-oss-120b` and `glm-flash` (GLM-4.7 Flash) as the missing open-weights and
    cheap-tier options.
  - **ChatGPT / Codex**: `gpt-5.5-codex` and `gpt-5.4-codex` were never valid Codex
    `--model` slugs (the `-codex` family ended at GPT-5.3), so both entries failed with
    `Unknown model`. The catalog now carries the GPT-5.6 tiers Codex actually serves —
    `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` — plus plain `gpt-5.5`. **The `gpt-5.4`
    entry is removed** (Codex retires it for ChatGPT sign-ins on 31 Aug 2026); a block
    pinned to it falls through to the workspace/deployment default.
  - **DeepSeek**: the `deepseek-chat` alias was retired on 24 Jul 2026 in favour of the V4
    pair. The `deepseek` entry moves to `deepseek-v4-flash` (1M context) across its direct,
    OpenRouter and subscription flavours, and `deepseek-v4-pro` gains direct + OpenRouter
    flavours beside its Cloudflare one.
  - **OpenRouter**: `google/gemini-3-pro` no longer exists on the gateway — the `gemini`
    entry moves to `google/gemini-3.1-pro-preview`. Adds gateway routes for GLM-5.2 and
    Qwen, and a `kimi-k3` entry.
  - Claude Sonnet moves from 4.6 to 5; Qwen's direct flavour from `qwen3-max` to
    `qwen3.7-max`.

  Spend pricing gains per-model entries for every Workers AI model that is billed per
  token rather than by neuron. **GLM-5.2 — the architect/reviewer routing default — and the
  DeepSeek R1 distill had none, so they were metering at the near-free neuron rate and
  escaping the budget gate.**

- Updated dependencies [3435bd1]
- Updated dependencies [3435bd1]
  - @cat-factory/executor-harness@1.86.2
  - @cat-factory/kernel@0.214.0
  - @cat-factory/node-server@0.153.1
  - @cat-factory/agents@0.104.2
  - @cat-factory/gitlab@0.15.3
  - @cat-factory/integrations@0.116.3
  - @cat-factory/orchestration@0.185.1
  - @cat-factory/server@0.193.1

## 0.96.0

### Minor Changes

- 70b4339: Serve a mothership-mode node's run telemetry back down from the mothership when its own store holds
  none. Telemetry is local-first, captured on the laptop and pruned there on a short window, with a
  finished run's rows carried up by the ingest sweep — both halves of which are about the WRITE
  direction. What that left was a node rendering two kinds of run blank: one whose local rows had been
  pruned, and (the larger case the plan under-stated) one that was never local at all. A mothership-mode
  SPA shows the whole org's board, so most runs a developer opens were driven by a hosted teammate or
  another laptop, and every one of them showed an empty observability panel, a zero token rollup and no
  web-search log — with nothing anywhere reporting a problem, because that is exactly what a run which
  spent nothing looks like.

  `POST /internal/telemetry/read` is the ingest's dual: a machine-authed, account-scoped endpoint
  serving a CLOSED table of per-method-bounded, run-scoped reads. It is its own endpoint rather than
  allow-listed persistence-RPC methods for ADR 0009's reason plus a sharper one — the persistence
  registry resolves a repository WHOLE, so admitting a telemetry repo's reads there would route its
  hot-path writes over the network, which is the entire thing the local-first bucket exists to prevent.
  `listByExecution` is deliberately absent from the table on all three sinks (no cursor, so it is the
  un-resumable bulk read the bucket forbids); the node drains the paged reads instead, which is what
  the two new kernel port methods are for. An over-cap limit is refused, never clamped, and the
  scope-bound workspace is stamped as the call's first argument rather than trusted from the caller.

  On the laptop the rule is local-wins where local is WHOLE — not merely where it is non-empty. The
  distinction is a third blank-run case: the prune deletes by capture time, so a run straddling the
  cutoff keeps its newer rows and loses its older ones, and the store then answers, with nothing
  looking missing, with a strict subset. A short list is bad and the rollup is worse, because a token
  total that is simply too low carries no hint that it is short. A subset is undetectable after the
  fact, so the prune records it as it happens and that record is what makes a local answer
  authoritative: lists stitch across the two stores on the shared keyset, while counts and the rollup
  come wholly from the mothership, since a partial local aggregate and a complete remote one cannot be
  merged. Capture is not decorated at all. A failed fallback throws rather than degrading back into the
  empty answer it was called to replace — the one hot-path caller already treats a metrics read as
  best-effort, so an outage costs a board counter and never a run, and the aggregate reads carry a
  short round-trip budget precisely because that caller awaits them on the emit path.

  A page inside its row cap can still serialize past the response backstop, so that is treated as
  routine rather than as a fault: the mothership still refuses rather than shortening (a truncated page
  is one the node would treat as complete), but under its own code, and the drain re-asks smaller on
  the same cursor, losing nothing. It terminates because the backstop is derived from the two capture
  ceilings rather than picked — a one-row page can never be refused for size.

  Compatibility break: `LlmCallMetricRepository` and `AgentContextSnapshotRepository` each gain a
  required `listRunPage` method, so an out-of-tree implementation of either port must add it. The local
  telemetry store gains a `telemetry_pruned_runs` table, created on open; an existing store simply
  starts recording from its next prune, and until then reports itself complete, which is the same
  answer it gave before.

### Patch Changes

- Updated dependencies [70b4339]
  - @cat-factory/kernel@0.213.0
  - @cat-factory/orchestration@0.185.0
  - @cat-factory/server@0.193.0
  - @cat-factory/node-server@0.153.0
  - @cat-factory/executor-harness@1.86.0
  - @cat-factory/agents@0.104.1
  - @cat-factory/gitlab@0.15.2
  - @cat-factory/integrations@0.116.2

## 0.95.0

### Minor Changes

- f31c644: Serve the foundational-service catalog's `builtin` tier over the mothership machine API. A
  mothership deployment is two processes, so a code-registered estate had to be registered on both
  entry points and the copies matched only while both ran the same build — with a local node one
  build behind being the normal case, and the skew silent (a run's catalog simply omits a service,
  which reads like an Architect judging it irrelevant).

  The tier is now read through the kernel `FoundationalBuiltinSource` port: the in-process registry by
  default, `GET /internal/foundational-services` (+ the batched
  `POST /internal/foundational-services/contracts`) on a mothership-mode node, which no longer consults
  its own registry and warns at boot naming any ids it ignores. The remote read throws rather than
  answering with an empty tier — on the 404 from a mothership older than the node, and on a 200 whose
  payload it cannot read — and the injected context files STATE that outage rather than being omitted
  (`FoundationalCatalogRead` / `FoundationalIndexRead` gain an `unavailable` variant), so a best-effort
  dispatch cannot turn the throw back into "no shared services are registered".

  Compatibility break (pre-1.0, no shim): `FoundationalServiceCatalogService` takes `builtins`
  (a `FoundationalBuiltinSource`) in place of `registry`; wrap a registry with
  `registryBuiltinSource(registry)`. `CoreDependencies.foundationalServiceRegistry` and the facade
  options are unchanged.

### Patch Changes

- 4ac6960: Refresh the dependency tree — direct and transitive — to the latest versions that satisfy the `minimumReleaseAge` supply-chain gate, staying within each dependency's compatible major.

  - **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.37 → ^7.0.47`, `@ai-sdk/anthropic`/`@ai-sdk/openai@^4.0.2x → ^4.0.27`, `@ai-sdk/openai-compatible@^3.0.14 → ^3.0.20`, `@ai-sdk/provider@^4.0.3 → ^4.0.4`, `@ai-sdk/amazon-bedrock@^5.0.32 → ^5.0.40`.
  - **Runtime deps**: `pg-boss@^12.26.3 → ^12.26.4`, `@aws-sdk/client-s3@^3.1095.0 → ^3.1101.0`, `@nuxtjs/i18n@^10.5.0 → ^10.6.0`, `@vueuse/core@^14.3.0 → ^14.4.0`.
  - **Tooling**: `wrangler@^4.114.0 → ^4.118.0`, `@cloudflare/workers-types@^5.20260726.1 → ^5.20260801.1`, `oxlint@^1.75.0 → ^1.76.0`, `oxfmt@^0.60.0 → ^0.61.0`, `knip@^6.29.0 → ^6.31.0`, `turbo@^2.10.7 → ^2.10.8`, `vue-tsc@^3.3.8 → ^3.3.9`, `@playwright/test@^1.62.0 → ^1.62.1`, `@types/node@^26.1.1 → ^26.1.2`, `@types/pg@^8.20.0 → ^8.20.3`.

  No `minimumReleaseAgeExclude` entries were added: every bump above already satisfies the gate. The `@cat-factory/executor-harness` and `@cat-factory/deploy-harness` deps are deliberately untouched, since they feed the published runner images and bumping them is a separate image-bumping change. `hono`'s declared range therefore stays at `^4.12.32` (sherif requires one version workspace-wide, and the harness declares it) while the lockfile still resolves 4.12.33 within that range.

- Updated dependencies [f31c644]
- Updated dependencies [4ac6960]
- Updated dependencies [4ac6960]
- Updated dependencies [874d684]
  - @cat-factory/kernel@0.212.0
  - @cat-factory/agents@0.104.0
  - @cat-factory/orchestration@0.184.0
  - @cat-factory/server@0.192.0
  - @cat-factory/node-server@0.152.0
  - @cat-factory/executor-harness@1.86.0
  - @cat-factory/integrations@0.116.1
  - @cat-factory/contracts@0.210.1
  - @cat-factory/gitlab@0.15.1

## 0.94.2

### Patch Changes

- 769a3d9: Close the PR-deep-review parity gap on GitLab: `FetchGitLabClient` now implements
  `listChangedFiles`, `getPullRequestHeadRef`, `getPullRequestHeadSha` and `createReview`. All four
  are optional on the `VcsClient` port and every consumer degrades silently without them, so a
  GitLab deployment previously ran the review flow to completion while the merge track record
  classified every run `unknown` (never matching a per-class merge rule) and the selected findings
  never reached the merge request. Cross-provider conformance now asserts their presence.

  Two breaking shapes ride along, both because a provider that cannot answer must say so rather than
  answer zero:

  - **`GitHubChangedFile.additions` / `deletions` are now `number | null`.** Null means the host did
    not report a count — GitLab withholds the hunk the counts are derived from for an oversized diff,
    and these render straight into the reviewer's prompt, where `+0/-0` describes a file nobody
    touched. GitHub still reports a real `0` for a binary it cannot line-count, and the conformance
    suite pins both. A consumer folding null to `0` must now do so deliberately. GitHub's own mapper
    moves to `githubProjection.toChangedFileProjection` (`@cat-factory/integrations`) so the decision
    sits beside its GitLab counterpart rather than inline in the fetch client.
  - **`logger` is REQUIRED on the GitLab facade builders** (`buildGitLabEngineClient`,
    `buildGitLabConnectClient`, `registerGitLab`) and is kernel's `Logger` rather than a bespoke
    `{ warn }`. It was optional, and consequently no composition root passed one — leaving the page-cap
    truncation warning unreachable in production, on the very reads a review is sliced from. The local
    facade now builds its client through the shared `buildGitLabEngineClient` instead of assembling the
    same pair by hand, so it cannot miss the next thing that builder gains.

- Updated dependencies [769a3d9]
  - @cat-factory/gitlab@0.15.0
  - @cat-factory/kernel@0.211.0
  - @cat-factory/agents@0.103.0
  - @cat-factory/integrations@0.116.0
  - @cat-factory/server@0.191.2
  - @cat-factory/node-server@0.151.2
  - @cat-factory/executor-harness@1.84.0
  - @cat-factory/orchestration@0.183.1

## 0.94.1

### Patch Changes

- Updated dependencies [be7135c]
  - @cat-factory/server@0.191.1
  - @cat-factory/executor-harness@1.84.0
  - @cat-factory/node-server@0.151.1

## 0.94.0

### Minor Changes

- 876ee2d: Foundational services gain a deployment tier, honest operation indexing, and set-level contract
  validation.

  A deployment can now register its shared-capability estate in CODE, on the app-owned
  `FoundationalServiceRegistry` injected like `PipelineRegistry` / `TaskTypeRegistry`. Registrations
  resolve as the catalog's lowest-precedence `builtin` tier — no rows, so they are present from a
  workspace's first request and cannot drift from the definitions — and are validated at boot against
  the same schema and document checks the REST write boundary applies. An account or workspace row of
  the same id still wins, and either tier can suppress an inherited service: the suppression
  sub-resource is now mounted at BOTH scopes, since an account inherits the deployment tier exactly as
  a board inherits its account's.

  A contract set is validated as a SET rather than per document: a set declared as a TypeScript
  contract format must contain at least one document referencing that library, so the schema modules a
  contract imports can be registered as what they are. A `files`-mode repo source does the same for
  the modules its link explicitly names; folder and directory scans are unchanged.

  Contract MODULE operations are indexed. A `@toad-contracts/core` module is read statically
  (`method` + a literal/template `pathResolver`), and what the extractor could not read is reported
  through `omittedOperations` rather than passing as a complete list. Where a format is not read at
  all, that is now stated instead of rendering as "declares no operations".

  Kernel gains `isContractModulePath`, so a caller asking whether a file could be part of a contract
  module GRAPH reads the same extension list `detectContractFormat` branches on instead of declaring
  its own.

  The enforced capability tags (`asset-storage`, `generation-context`) moved to
  `@cat-factory/contracts` so registrants and the SPA import the same vocabulary, and the write
  boundary refuses a tag that misses one by case or separators.

  Breaking, and deliberate: the merged catalog read (`GET /workspaces/:ws/foundational-services/resolved`)
  no longer carries `ownerKind`, `sourceId`, `sourcePath`, `pinnedCommit`, `createdAt` or `updatedAt` —
  a `builtin` entry has none of them, and filling them with placeholders would read as fact. Those
  fields remain on the per-tier management read. Existing stored `toad-contract` rows keep their empty
  operation index until their next upload or repo sync re-indexes them.

### Patch Changes

- Updated dependencies [73708cf]
- Updated dependencies [876ee2d]
  - @cat-factory/contracts@0.210.0
  - @cat-factory/kernel@0.210.0
  - @cat-factory/integrations@0.115.0
  - @cat-factory/orchestration@0.183.0
  - @cat-factory/server@0.191.0
  - @cat-factory/node-server@0.151.0
  - @cat-factory/agents@0.102.0
  - @cat-factory/gitlab@0.14.23
  - @cat-factory/executor-harness@1.84.0

## 0.93.8

### Patch Changes

- Updated dependencies [0a1170e]
  - @cat-factory/contracts@0.209.0
  - @cat-factory/kernel@0.209.0
  - @cat-factory/agents@0.101.0
  - @cat-factory/gitlab@0.14.22
  - @cat-factory/integrations@0.114.4
  - @cat-factory/orchestration@0.182.2
  - @cat-factory/server@0.190.3
  - @cat-factory/node-server@0.150.1
  - @cat-factory/executor-harness@1.84.0

## 0.93.7

### Patch Changes

- Updated dependencies [d320539]
  - @cat-factory/contracts@0.208.0
  - @cat-factory/kernel@0.208.0
  - @cat-factory/agents@0.100.0
  - @cat-factory/node-server@0.150.0
  - @cat-factory/gitlab@0.14.21
  - @cat-factory/integrations@0.114.3
  - @cat-factory/orchestration@0.182.1
  - @cat-factory/server@0.190.2
  - @cat-factory/executor-harness@1.84.0

## 0.93.6

### Patch Changes

- Updated dependencies [9e5f785]
  - @cat-factory/contracts@0.207.0
  - @cat-factory/kernel@0.207.0
  - @cat-factory/agents@0.99.0
  - @cat-factory/orchestration@0.182.0
  - @cat-factory/gitlab@0.14.20
  - @cat-factory/integrations@0.114.2
  - @cat-factory/server@0.190.1
  - @cat-factory/node-server@0.149.1
  - @cat-factory/executor-harness@1.84.0

## 0.93.5

### Patch Changes

- 8fbc0b5: Serve the repo-sourced Claude Skills library (ADR 0024) over the mothership-mode persistence RPC —
  catalog reads and the repo-sync surface alike — so a local node with no main database can list,
  sync and RUN a skill.

  This was not a blank panel. `skillResolver` is a hard dependency for a `skill` step (and for the
  declared `{ catalogSkillId }` capabilities of ADR 0029), so an un-routed skill catalog failed the
  dispatch, and it failed partially: a skill with no sibling resources resolved from the catalog
  alone while one with resources threw out of the resource fetch, so the feature read as wired. The
  sync half went remote too — unlike the prompt-fragment library, whose sync stays mothership-owned
  because "a mothership node has no GitHub client", a mothership node now reaches GitHub by token
  delegation, so its skill link/sync/unlink routes were live and broken rather than absent.

  Adds a `skillSource` scope rule: the sync methods carry a source id and nothing else, so nothing
  positional binds them; it resolves the source's owning account server-side (memoised, sharing its
  read with the dispatched call). The global `skillSourceRepository.listByRepo` — the push-webhook
  reverse lookup across every account — stays mothership-internal.

  Adds `accountFieldUpsert` alongside it, for a record-keyed write whose conflict key is the record's
  `id` rather than its `accountId`. `accountField` binds only the account a record DECLARES, which is
  sufficient only while the row is stored under that account — an `ON CONFLICT (id) DO UPDATE` that
  does not re-`SET account_id` instead writes whichever row already holds that id, under its own
  account. The new rule binds the stored row too, so a token scoped to one account can no longer name
  another's source id and repoint their link at a repo it controls (whose `SKILL.md` bodies the other
  tenant's next sync would fold into their catalog as agent instructions); an absent row is a create
  and still passes.

  A misconfiguration now also reports itself correctly: the persistence controller's per-request memo
  overrides are applied only for repositories the deployment actually wires, so a mothership without
  the library answers `... is not wired` instead of a scope 404 that reads as a missing row.

  `GitHubInstallationRepository` gains `listActiveForAccount`, the account-scoped form of the cron
  `listActive`. The account-tier installation lookup every repo-sourced library resolves its GitHub
  credential through read EVERY tenant's installations and filtered in JS — unexposable over an
  account-scoped machine API, and unbindable by any scope rule since the method takes no arguments.
  The narrowing ("bound to the account directly, or to one of its own boards") now runs in SQL on
  both runtimes, ordered so they pick the same row, and the resolver makes one query where it made
  two.

  Both ends of a mothership deployment must have the skill/fragment library enabled: the mothership
  reflects the skill repositories into its machine-API registry only when its own library is
  configured, exactly as it does for fragments.

- Updated dependencies [8fbc0b5]
  - @cat-factory/kernel@0.206.0
  - @cat-factory/agents@0.98.0
  - @cat-factory/server@0.190.0
  - @cat-factory/node-server@0.149.0
  - @cat-factory/integrations@0.114.1
  - @cat-factory/orchestration@0.181.1
  - @cat-factory/contracts@0.206.1
  - @cat-factory/executor-harness@1.84.0
  - @cat-factory/gitlab@0.14.19

## 0.93.4

### Patch Changes

- Updated dependencies [5511cdc]
  - @cat-factory/contracts@0.206.0
  - @cat-factory/kernel@0.205.0
  - @cat-factory/agents@0.97.0
  - @cat-factory/integrations@0.114.0
  - @cat-factory/orchestration@0.181.0
  - @cat-factory/server@0.189.0
  - @cat-factory/node-server@0.148.0
  - @cat-factory/gitlab@0.14.18
  - @cat-factory/executor-harness@1.84.0

## 0.93.3

### Patch Changes

- Updated dependencies [1441041]
- Updated dependencies [1441041]
  - @cat-factory/contracts@0.205.0
  - @cat-factory/kernel@0.204.0
  - @cat-factory/orchestration@0.180.0
  - @cat-factory/node-server@0.147.0
  - @cat-factory/agents@0.96.1
  - @cat-factory/gitlab@0.14.17
  - @cat-factory/integrations@0.113.9
  - @cat-factory/server@0.188.1
  - @cat-factory/executor-harness@1.84.0

## 0.93.2

### Patch Changes

- Updated dependencies [0b52df7]
  - @cat-factory/contracts@0.204.0
  - @cat-factory/kernel@0.203.0
  - @cat-factory/agents@0.96.0
  - @cat-factory/orchestration@0.179.0
  - @cat-factory/server@0.188.0
  - @cat-factory/node-server@0.146.0
  - @cat-factory/gitlab@0.14.16
  - @cat-factory/integrations@0.113.8
  - @cat-factory/executor-harness@1.84.0

## 0.93.1

### Patch Changes

- Updated dependencies [b816b6d]
  - @cat-factory/executor-harness@1.84.0

## 0.93.0

### Minor Changes

- 9c6ce7a: Mothership mode: carry a finished run's telemetry up to the mothership.

  Telemetry on a mothership-mode node is captured locally, which until now meant it stayed there: a
  hosted teammate opening a run a developer drove saw an empty observability panel, zero token
  rollups and no web-search log, and the rows vanished when the node's short retention window came
  round. A new machine-authed `POST /internal/telemetry/ingest` (mounted on both facades, gated and
  account-scoped exactly like the persistence RPC) accepts a bounded batch of a run's captured rows,
  and a background sweep on the node uploads each run once it has gone quiet.

  The mothership STAMPS the batch's scope-bound workspace and run onto every row it stores, so a node
  can only ever file telemetry for a run in a workspace it can already reach. Appends are idempotent
  by row id — a new `recordMany` on the three run-scoped telemetry ports, mirrored across D1, Drizzle
  and the local `node:sqlite` store — which is what makes a lost-ack chunk safely retryable.

  Note the deliberate asymmetry between `record` and `recordMany`: only the batch append ignores a
  duplicate id, because only the batch is retried. A batch over the per-request caps is refused
  rather than truncated, since the node treats a success as "this range is stored".

  That last rule is what makes the sweep's success path load-bearing, so two things follow from it.
  A node with no machine token yet rejects with the new `MachineTokenUnavailableError` instead of
  resolving an empty result, which would have read as "this run had no rows" and let the local prune
  delete telemetry that never left the laptop. And batches are budgeted by BYTES as well as row
  count, because the mothership refuses on either — a page built to the row cap alone could sit
  permanently over the body cap. A row too large to post even by itself is skipped and reported
  rather than retried into a stall.

### Patch Changes

- Updated dependencies [9c6ce7a]
  - @cat-factory/kernel@0.202.0
  - @cat-factory/server@0.187.0
  - @cat-factory/node-server@0.145.0
  - @cat-factory/executor-harness@1.82.0
  - @cat-factory/agents@0.95.1
  - @cat-factory/gitlab@0.14.15
  - @cat-factory/integrations@0.113.7
  - @cat-factory/orchestration@0.178.1

## 0.92.2

### Patch Changes

- Updated dependencies [54e6a45]
- Updated dependencies [08e9bcc]
- Updated dependencies [a7aae8a]
  - @cat-factory/agents@0.95.0
  - @cat-factory/contracts@0.203.0
  - @cat-factory/orchestration@0.178.0
  - @cat-factory/server@0.186.0
  - @cat-factory/kernel@0.201.1
  - @cat-factory/integrations@0.113.6
  - @cat-factory/node-server@0.144.2
  - @cat-factory/gitlab@0.14.14
  - @cat-factory/executor-harness@1.82.0

## 0.92.1

### Patch Changes

- Updated dependencies [16fd126]
  - @cat-factory/orchestration@0.177.1
  - @cat-factory/integrations@0.113.5
  - @cat-factory/node-server@0.144.1
  - @cat-factory/server@0.185.2
  - @cat-factory/executor-harness@1.82.0

## 0.92.0

### Minor Changes

- 8c40f33: Record an inline harness-CLI step's model calls PER CALL and LIVE, instead of one lumped row at exit.

  A local-mode document run reported **0 model calls for eight minutes** and then, when it was killed,
  **one row of zero tokens** beside a failure message stating it had burned 896.7k. Both readings came
  from the same cause: an inline step served by a harness CLI is not one model call. `doc-researcher`
  on a host `claude` login runs a whole tool loop — a measured run made 16 calls over 8 minutes —
  behind ONE `doGenerate`, and the instrumentation middleware wrapped around that boundary can only
  ever see the boundary.

  Three consequences, each a different way of being wrong about the same run:

  - **One row for sixteen calls.** `message_count` 2 and `tool_count` 0 on a row whose loop used tools
    throughout, `total_ms` 497316 for "one call", and the fifteen intermediate turns' bodies nowhere.
    The container inline transport dropped its per-call metrics for the same reason: nothing on
    `InlineCliResult` could carry them.
  - **Nothing at all until the subprocess exits.** `wrapGenerate` is a post-hoc hook with no
    `wrapStream` sibling, and the spawn settles only in `child.on('close')`. So the run was dark for
    its whole duration — precisely when someone is watching it.
  - **Zeros whenever it was killed.** The middleware's error path has no usage to attach (a rejection
    carries none), so the row read `total_tokens 0`. What the run spent survived only inside the free
    text of `error_message`, through a deliberately lossy formatter — `896.7k` is not recoverable as an
    integer even in principle.

  **The model now files its own calls, and the middleware stands down.** `CliInlineLanguageModel` takes
  the facade's `InlineLlmCallRecorder` and records each call the CLI reports the moment it arrives, then
  declares `reportsOwnLlmCalls` so `InstrumentedModelProvider` returns it unwrapped — two producers for
  one call would double every token in the step's rollup, and of the two the middleware's is the less
  truthful. The model is ASKED rather than a facade told, because the instrumentation is composed
  OUTSIDE the wrap that substitutes the model (it has to be, or it sees nothing that wrap serves) and
  cannot know what the inner wrap returned.

  **The per-call fold is imported, not re-implemented.** Claude Code emits one envelope per content
  BLOCK, each repeating that call's usage, so folding by `message.id` first is the difference between 31
  calls and 117 — a measured 1.47M tokens inflated to 5.53M. The container harness had already solved
  that, along with the prompt-transcript reconstruction and the routing of subagent turns off the
  parent's chain; local carried a lesser copy of only the usage half, which is exactly why the two
  paths disagreed about how many calls a step had made. `@cat-factory/executor-harness` now exports
  that fold as the `./claude-call-aggregator` subpath and local drives it, so there is ONE
  implementation.

  **Sharing it made the backend a second DRIVER of a reconstruction that had only ever run in a
  container**, and two of its properties are memory rules there rather than niceties. The transcript is
  retained only to `MAX_TRANSCRIPT_CHARS` (512 KiB, the store's own body cap — past that the retention
  could only ever be thrown away), stating what it stopped retaining rather than ending mid-conversation;
  and assembling bodies at all is a switch, off when `LLM_RECORD_PROMPTS` is. Unlike every other body,
  these are BUILT rather than merely passed as a thunk — the growing history, re-serialised per call — so
  a body the store will drop has to be refused at the source. Unbounded, this is the same fault
  `OUTPUT_TAIL_RETAIN_CHARS` already refuses one screen away: hundreds of MB parked in the orchestrator
  process, on precisely the runs worth diagnosing.

  Also: the tag-then-scope attribution precedence is now one shared `resolveInlineAttribution`, since
  two producers apply it; `InlineLlmCall` carries an optional `turnIndex`, real for a harness-CLI call
  and absent for a plain `generateText`; every row names the model the CLI says SERVED that call
  (`call.model ?? requested`, as `makeHarnessCallRecorder` already did — cost is derived per row from
  `(model, token classes)`, and a CLI serves some calls with a cheaper model of its own); and
  `ModelProviderResolverWrapDeps.recordInlineCall` is required-but-nullable, so a facade that FORGOT it
  fails at typecheck rather than shipping a deployment that silently reports no model activity.

  Degradations are stated rather than papered over. The step-level row carries the SHORTFALL — the
  terminal cumulative usage minus what the per-call rows accounted for — which covers three cases with
  one rule: a CLI that narrates nothing (`codex exec`) gets the single row the SDK boundary knows, a
  fully-narrated step gets none (one there would double every token), and a PART-narrated step gets the
  remainder rather than losing it. That last case is why it is a shortfall and not a lump: an older CLI
  build, or a turn that errored before reporting usage, leaves a step whose uncosted turns would
  otherwise simply vanish. An uncosted turn is never filed as a zero-token row, and that rule lives with
  the model, so it holds for the host CLI's stream and a container job's terminal metrics alike. A killed
  step still gets one `ok: false` row at the ordinal after its last completed call, with zero tokens,
  which is now TRUE of it: it stands for the interrupted call, and everything the run really spent is
  already on record. Every fold step is isolated, because the reader runs inside the spawn's `stdout`
  listener and its flush on the killed path runs BEFORE the failure is enriched with the burn clause.

  **Deliberately still open:** the spend LEDGER. `token_usage` is written from the agent result on the
  success path only, so a failed step writes no ledger row on either transport and the budget rollups
  stay blind to what it burned. Closing that needs the failure-path recording seam in orchestration,
  covering the container path in the same change — not a fourth pass over the inline provider.

  `@cat-factory/executor-harness` now emits declarations (`declaration: true`), because the new subpath
  is a `dist` import rather than the compile-only source `./embed` is.

### Patch Changes

- Updated dependencies [8c40f33]
  - @cat-factory/executor-harness@1.82.0
  - @cat-factory/node-server@0.144.0
  - @cat-factory/orchestration@0.177.0
  - @cat-factory/agents@0.94.0
  - @cat-factory/kernel@0.201.0
  - @cat-factory/server@0.185.1
  - @cat-factory/gitlab@0.14.13
  - @cat-factory/integrations@0.113.4

## 0.91.4

### Patch Changes

- Updated dependencies [9d303f0]
  - @cat-factory/contracts@0.202.0
  - @cat-factory/kernel@0.200.0
  - @cat-factory/orchestration@0.176.0
  - @cat-factory/server@0.185.0
  - @cat-factory/agents@0.93.0
  - @cat-factory/node-server@0.143.0
  - @cat-factory/gitlab@0.14.12
  - @cat-factory/integrations@0.113.3
  - @cat-factory/executor-harness@1.80.0

## 0.91.3

### Patch Changes

- Updated dependencies [0bffe55]
- Updated dependencies [1cd9d73]
  - @cat-factory/contracts@0.201.0
  - @cat-factory/kernel@0.199.0
  - @cat-factory/orchestration@0.175.0
  - @cat-factory/server@0.184.0
  - @cat-factory/node-server@0.142.4
  - @cat-factory/agents@0.92.0
  - @cat-factory/gitlab@0.14.11
  - @cat-factory/integrations@0.113.2
  - @cat-factory/executor-harness@1.80.0

## 0.91.2

### Patch Changes

- Updated dependencies [cfda954]
- Updated dependencies [d9789f9]
  - @cat-factory/node-server@0.142.3
  - @cat-factory/kernel@0.198.0
  - @cat-factory/agents@0.91.0
  - @cat-factory/orchestration@0.174.0
  - @cat-factory/contracts@0.200.0
  - @cat-factory/executor-harness@1.80.0
  - @cat-factory/gitlab@0.14.10
  - @cat-factory/integrations@0.113.1
  - @cat-factory/server@0.183.1

## 0.91.1

### Patch Changes

- Updated dependencies [123ac6f]
  - @cat-factory/agents@0.90.0
  - @cat-factory/contracts@0.199.0
  - @cat-factory/executor-harness@1.80.0
  - @cat-factory/integrations@0.113.0
  - @cat-factory/kernel@0.197.0
  - @cat-factory/orchestration@0.173.0
  - @cat-factory/server@0.183.0
  - @cat-factory/node-server@0.142.2
  - @cat-factory/gitlab@0.14.9

## 0.91.0

### Minor Changes

- 550a7fe: Supervise an inline host-CLI run by how long it is STUCK, not by how long it works.

  `spawnCliExec` armed one 300s timer at spawn and never touched it again, so the budget bounded the
  whole run: an inline step was killed for being SLOW rather than for being stuck, with nothing a
  deployment could set to say otherwise. The observed failure is a `doc-researcher` on the ambient
  `claude` CLI killed at exactly 5 minutes having made 53 model calls, burned 2.9M tokens and run 24
  tool calls — legitimate work, mid-turn — and every retry died the same way, so the step could never
  complete. That also made it permanently unaccounted for: usage reaches `token_usage` from a call
  that COMPLETED, so a step that dies on every attempt records nothing however much it spent, which
  is what "the run shows zero model calls" actually meant.

  Two budgets now, because "hung" and "long" are different failures with opposite fixes:

  - an **idle** window (`LOCAL_INLINE_CLI_IDLE_TIMEOUT_MS`, default 300000) re-armed by every chunk on
    either stream, so it measures the gap between bytes. `stream-json` narrates a healthy `claude`
    continuously, so silence this long is a real symptom while elapsed time never was.
  - an absolute **ceiling** (`LOCAL_INLINE_CLI_MAX_TIMEOUT_MS`, default 3600000) for the run that
    narrates forever and therefore never looks idle — the one case an idle window cannot bound.

  Both still reject as a `timeout` (unchanged for callers), but they say different things: the idle
  kill names the silence it overran, the ceiling kill names the ceiling and the variable that raises
  it. The idle message drops the redundant silence clause it would otherwise restate. The FIRST kill
  wins: every trigger stays armed until the child closes, so an abort landing inside the SIGKILL
  grace period used to overwrite the reason and surface a supervised kill as a user cancellation.

  New in `@cat-factory/server`: `parseTimerEnvMs`, the validator for an env var that becomes a
  `setTimeout` delay, beside the `parseNumericEnv` it is deliberately stricter than. A plain numeric
  knob is right to accept `0` / `-1` / `1.5`; a timer budget is not, and neither is a value above
  `MAX_TIMER_DELAY_MS` (2147483647) — Node truncates a larger delay to **1ms** rather than saturating,
  so the number an operator types meaning "effectively no ceiling" is exactly the one that would kill
  every supervised run within milliseconds, while reporting the enormous ceiling it claims to have
  hit. Every unusable spelling now warns and defers to the built-in default.

  The incoherent-pair warning (a ceiling below the idle window makes the idle watchdog unreachable, so
  a stuck CLI is reported as a slow one and the operator raises the wrong number) now compares the
  EFFECTIVE budgets rather than only the explicitly-set ones — lowering just the ceiling is the likelier
  single-knob edit, and gating on both being present let exactly that case through in silence.

### Patch Changes

- Updated dependencies [550a7fe]
  - @cat-factory/server@0.182.0
  - @cat-factory/executor-harness@1.78.0
  - @cat-factory/node-server@0.142.1

## 0.90.4

### Patch Changes

- Updated dependencies [99412e2]
  - @cat-factory/contracts@0.198.0
  - @cat-factory/kernel@0.196.0
  - @cat-factory/integrations@0.112.0
  - @cat-factory/server@0.181.0
  - @cat-factory/node-server@0.142.0
  - @cat-factory/agents@0.89.1
  - @cat-factory/gitlab@0.14.8
  - @cat-factory/orchestration@0.172.1
  - @cat-factory/executor-harness@1.78.0

## 0.90.3

### Patch Changes

- Updated dependencies [1904eb8]
  - @cat-factory/kernel@0.195.0
  - @cat-factory/agents@0.89.0
  - @cat-factory/orchestration@0.172.0
  - @cat-factory/server@0.180.0
  - @cat-factory/executor-harness@1.78.0
  - @cat-factory/gitlab@0.14.7
  - @cat-factory/integrations@0.111.2
  - @cat-factory/node-server@0.141.1

## 0.90.2

### Patch Changes

- f9db6a6: Record the inline LLM calls that local mode serves from a host CLI, and stop filing run-scoped
  inline calls under a null execution id.

  The inline `llm_call_metrics` feeder was applied as the innermost provider wrap, so local mode's
  subscription-inline harness — which answers a Claude Code / Codex ref with its own
  `CliInlineLanguageModel` rather than delegating — was invisible to it. With `LOCAL_NATIVE_INLINE`
  on (the default), every inline step on a host `claude`/`codex` login recorded zero calls while the
  same step on a metered API model recorded fine. Separately, ten of the twelve inline call sites
  tagged only the workspace, so their rows landed with `execution_id = NULL`: in the store, but
  absent from every run-scoped read.

  Attribution also no longer trusts a settled run: `resolveBlockRunContext` drops the execution id
  once the run is terminal (keeping the initiator), because `block.executionId` is the block's LAST
  run rather than necessarily a live one. A stale id would report an inline call's spend against a
  finished run's rollup, and unlike a null nothing about a wrong-but-plausible id looks wrong.

  Compatibility breaks (pre-1.0, no shims):

  - `createScopedModelProviderResolver` no longer takes `instrument`, and the instrumentation and
    concurrency-limiter wraps are no longer exported individually. Apply the new
    `wrapResolverWithTelemetry(resolver, { instrument, limiter })` on top of the resolver — after any
    facade wrap that can substitute a resolved model. It owns the ORDER of the two wraps, which is
    load-bearing and which nothing in the type system holds: reversed, the composition still
    type-checks and still records every non-substituted call. Replace a `wrapResolverWithLimiter`
    call with the `limiter` field (build it with `vendorConcurrencyLimiterFromEnv`; it stays a
    pass-through when nothing is capped).
  - `createNodeModelProviderResolver` builds the BASE resolver only; its `instrument` and
    `workspaceSettingsRepository` parameters are gone, and the env-built trace-sink instrument it
    used to fall back to is now the exported `inlineInstrumentFromEnv(env, workspaceBodiesEnabled)`.
    A deployment assembling its own container composes the two — and MUST: a caller that merely drops
    the removed arguments compiles fine and silently stops instrumenting its inline calls.
  - `InlineInstrumentation` is now exported from `agents/modelProviderResolver` rather than derived
    from `ScopedModelProviderOptions['instrument']` (same shape, same import path from the package
    root).
  - `FragmentBriefService.resolveBriefs` takes its run on an options object (`{ executionId }`)
    rather than as a third positional argument.
  - `@cat-factory/agents` additionally exports `LimitedModelProvider`, so a facade wiring test can
    assert the wrapper it composed.

- Updated dependencies [f9db6a6]
  - @cat-factory/server@0.179.0
  - @cat-factory/node-server@0.141.0
  - @cat-factory/agents@0.88.0
  - @cat-factory/kernel@0.194.0
  - @cat-factory/orchestration@0.171.1
  - @cat-factory/executor-harness@1.78.0
  - @cat-factory/gitlab@0.14.6
  - @cat-factory/integrations@0.111.1

## 0.90.1

### Patch Changes

- 28ad35a: Respect the target repository's own pull-request template: a PR-opening coding dispatch now finds
  it and the agent fills it in, instead of the platform's free-form briefing.

  Neither GitHub nor GitLab applies a template to an API-created pull request — that only happens for
  a human opening one in the web form — so the platform's pull requests were the only ones on a repo
  silently missing the structure its reviewers expect, with nothing failing or warning to say so.

  The harness discovers the template from the checkout it already has (`.github/PULL_REQUEST_TEMPLATE.md`
  and GitHub's root/`docs/` and multi-template-directory variants, plus GitLab's
  `.gitlab/merge_request_templates/`; case-insensitive, both hosts' conventions probed whatever the
  repo's provider) and folds it into the prompt of the agent that just did the work, which writes its
  `.cat-pr-description.md` as the filled template. Where the template asks for something the platform's
  briefing guidance does not, the template wins. Repos shipping no template are byte-for-byte
  unaffected.

  A filled template's headings are the REPO's, so the sentinel is read back with the leading-`#` title
  rule switched off: a template whose first heading is its only level-1 one would otherwise have that
  heading lifted as the pull request's title, replacing the platform's own and deleting the heading
  from the body. A template symlinked out of the checkout is refused rather than read, since this is
  the one repo-chosen path the harness reads without the agent asking for it.

  A directory holding SEVERAL templates with no `default` is deliberately left alone: that directory
  exists so a human can choose per pull request, and picking one arbitrarily would file every run's
  work under whichever name sorts first while looking deliberate.

  Bumps the runner image to `1.77.0` (harness `src/**` changed).

- Updated dependencies [28ad35a]
  - @cat-factory/executor-harness@1.78.0

## 0.90.0

### Minor Changes

- be7fe66: Let a deployment declare its infra dependencies in code: `startNode`/`startLocal` take
  `seedSharedStacks`, and a compose layer can now be an inline document or a file in another repo.

  A `StackRecipe`'s and a `SharedStack`'s `composeFiles` entries are now `ComposeFileRef`s — a bare
  in-repo path (unchanged, still the common case) or an explicit `ComposeSource`: `inline` (the
  compose document itself) or `repo` (a path in another `owner/name`, read without cloning it). A
  stack whose layers are all inline / foreign owns no repository, so `SharedStack.cloneUrl` is
  nullable.

  An `inline` layer may name where it is materialized, and that path is host-escape guarded on every
  path that accepts one: a layer that would land outside the checkout is refused when the shared
  stack is SAVED (`details.reason: 'compose_layer_escapes_checkout'`) and again before any layer is
  read or written, alongside the recipe path's existing pre-daemon check.

  Breaking (pre-1.0): `SharedStack.cloneUrl` is `string | null` rather than `string`, and
  `composeFiles` entries widen from `string` to `string | ComposeSource`. D1 migration `0070`
  rebuilds `shared_stacks` to relax the `clone_url` NOT NULL; the Drizzle mirror does the same. No
  data changes — every existing row keeps its clone URL and its plain-path layers.

### Patch Changes

- Updated dependencies [be7fe66]
  - @cat-factory/contracts@0.197.0
  - @cat-factory/kernel@0.193.0
  - @cat-factory/integrations@0.111.0
  - @cat-factory/orchestration@0.171.0
  - @cat-factory/node-server@0.140.0
  - @cat-factory/agents@0.87.2
  - @cat-factory/gitlab@0.14.5
  - @cat-factory/server@0.178.2
  - @cat-factory/executor-harness@1.76.2

## 0.89.0

### Minor Changes

- 65e0299: Make a killed inline CLI run account for what it spent.

  A local-mode `doc-researcher` step failed with `claude timed out after 300000ms` and nothing else.
  Four attempts had actually run — 31 model calls, 1.47M tokens, 1.32M of it cache-read — and every
  one of them was billed and recorded nowhere: a failed step writes no `token_usage` row on either
  transport. So the run read as idle. `agent_runs` sat at `rev=1`, no container was alive, no usage
  existed, and the only surviving account of what the agent had done was the CLI's own session
  transcript under the developer's `~/.claude`. Concluding "it was working the whole time" took
  mining that transcript by hand.

  Two gaps lined up. The watchdog and abort paths rejected with the bare fact that the budget had
  elapsed, discarding the stdout they were holding — the same defect the previous fix addressed for
  the non-zero-exit path and left untouched on these two. And the runner took `--output-format json`,
  whose single result object exists only if the CLI reaches the END, so a killed run had no usage to
  recover even in principle.

  **The inline `claude` runner streams.** `--output-format stream-json --verbose`, as the container
  harness already runs it, instead of the one-shot `json`. The terminal `result` event carries the
  same fields the single object did, so the success path is unchanged and still treats the CLI's own
  cumulative figure as authoritative; the difference is that a killed run now leaves a partial stream
  to account for itself with.

  **Every bad end carries its evidence.** `spawnCliExec` rejects with a `CliExecFailure` naming how
  the run died (`timeout` / `aborted` / `exit`), and the vendor runner appends what its fold observed:
  `claude timed out after 300000ms; silent for 69s; burned 1.45M tokens (1.40M cache-read) across 2
model calls`. When the model was never reached it says `no model call completed` — the distinction
  the old message could not make, and the first fork in the road between a stalled CLI and one that
  never got going. The enriched throw stays a `CliExecFailure`, so `reason` is readable on the error a
  caller catches and not only one link down the `cause` chain.

  **The stream is CONSUMED, never buffered.** `spawnCliExec` grew a `CliExecOptions.onLine` observer;
  supplying one replaces body retention, and the claude runner feeds a stateful `ClaudeStreamFold`
  that holds a bounded summary (per-call usage, the terminal event) rather than the stream. That is
  load-bearing rather than tidy: `stream-json` output is unbounded in a way the one-shot `json` object
  never was — every assistant envelope, every `tool_use` input and every tool_result, for as long as
  the watchdog allows — and this runner bypasses permissions, so a stalled tool-using run would have
  parked hundreds of MB in the orchestrator process, on precisely the runs this change exists to
  diagnose. Only a bounded tail is kept, for the failure message. The container harness's `streamCli`
  retains no body for the same reason. Because the fold outlives the rejection, the evidence no longer
  has to ride on the error — which is also why the failure carries no output.

  Two consequences of parsing what used to be an opaque body. Both streams are decoded with
  `setEncoding('utf8')` rather than per-`Buffer`, since a multi-byte character split across a chunk
  boundary decodes to replacement characters and these lines are handed to `JSON.parse` — one unlucky
  boundary would have silently dropped an event, and its usage, from the fold. And the final line is
  flushed on close, because it has no terminator in the two cases that matter: a clean run whose
  terminal `result` event is the last thing written, and a killed one cut mid-JSON.

  **Silence is measured rather than inferred from the exit.** Mirroring the container harness's
  breadcrumb and its 30s threshold, so a fast failure gains no true-but-useless "said nothing"
  clause. The wording claims only what this channel supports — the child's own stdout/stderr — so it
  says "silent", not the harness's "no activity", which also counts keep-alive beats.

  Envelopes are folded by `message.id` before summing. Claude Code emits one envelope per CONTENT
  BLOCK, each repeating that one call's `usage`, so summing per envelope multiplies the burn: on the
  run above, 117 envelopes carried 31 real calls and the naive sum inflated 1.47M tokens to 5.53M
  (3.8x). `docs/initiatives/token-burn-instrumentation.md` records the container harness falling into
  exactly this trap; `claude-call-aggregator.ts` is the fix it landed. Only usage that PARSES is
  folded, so the call count means "calls that reported a burn" — counting envelopes that merely
  carried a `usage` key would produce "burned 0 tokens across 3 model calls", contradicting the
  `no model call completed` branch it sits beside.

  Behaviour change worth flagging: local mode now invokes `claude` with `--output-format stream-json
--verbose`. A CLI build that doesn't support the streaming format would fail where it previously
  succeeded.

  Deliberately still open: the tokens are SURFACED, not ledgered. A failed step writes no
  `token_usage` row on either transport, so the spend gate and quota rollups remain blind to them.
  Closing that needs a failure-path recording seam in orchestration, which should cover the container
  path in the same change rather than growing this one.

## 0.88.9

### Patch Changes

- Updated dependencies [83fd037]
  - @cat-factory/kernel@0.192.0
  - @cat-factory/contracts@0.196.0
  - @cat-factory/orchestration@0.170.0
  - @cat-factory/executor-harness@1.76.2
  - @cat-factory/agents@0.87.1
  - @cat-factory/gitlab@0.14.4
  - @cat-factory/integrations@0.110.5
  - @cat-factory/server@0.178.1
  - @cat-factory/node-server@0.139.1

## 0.88.8

### Patch Changes

- Updated dependencies [7248b72]
- Updated dependencies [449d856]
  - @cat-factory/contracts@0.195.0
  - @cat-factory/kernel@0.191.0
  - @cat-factory/agents@0.87.0
  - @cat-factory/orchestration@0.169.0
  - @cat-factory/server@0.178.0
  - @cat-factory/node-server@0.139.0
  - @cat-factory/gitlab@0.14.3
  - @cat-factory/integrations@0.110.4
  - @cat-factory/executor-harness@1.76.2

## 0.88.7

### Patch Changes

- 4ecb25c: Record inline (non-proxied) LLM calls into `llm_call_metrics`, so an inline agent step's model
  activity is visible in-app instead of only in an external trace backend.

  `InstrumentedModelProvider` was the one LLM feeder that wrote to no repository: it called
  `traceSink.recordGeneration` and nothing else. So every inline call site — the judges, consensus,
  the requirements writer, the fragment selector, the fork chat, and the inline agent kinds
  (`doc-researcher`, `doc-outliner`, the document interviewer) — was invisible to
  `ObservabilityPanel`, to a step's token rollup and to `/api/v1/debug/*`. A run made entirely of
  inline steps reported zero model activity no matter what it spent, on the surfaces an operator
  actually opens. This is the coverage half of C2 in `docs/initiatives/observability-logging-gaps.md`
  (slice 5.6); its privacy half landed earlier.

  The provider now has a second exit, the kernel `InlineLlmCallRecorder` port, implemented by
  orchestration's `makeInlineCallRecorder` over the same `LlmObservabilityService` the proxy and the
  subscription harnesses already feed — so all three producers converge on one store rather than a
  third recording path being invented.

  Two things a reviewer should look at closely. First, the provider takes **exactly one** exit per
  call: the service behind the recorder performs the trace-sink fan-out itself, so a recorded call
  must not also be emitted to the provider's own sink — doing both would double every inline
  generation on Langfuse/OTel. Because that invariant binds two objects a facade could easily build
  from different sinks (which typechecks, and merely splits the trace), neither facade assembles the
  pair: `createInlineInstrumentation` composes both exits from one sink instance, and leaves the
  provider's `traceSink` as the fallback for a call carrying no `workspaceId` (the metric store is
  workspace-scoped, so such a call has no row to be filed under — the same deliberate fail-open the
  body gate already takes for an untagged call). Second, bodies now reach the recorder ungated: the
  service applies the identical `LLM_RECORD_PROMPTS` + `storeAgentContext` gate from the same kernel
  factory, plus `redactSecrets` and the prompt delta chain. Re-gating in the provider was rejected
  because it would withhold text the store is entitled to keep and restore the two-places-one-rule
  shape that produced C2's privacy half in the first place; instead the bodies cross as thunks and
  `record` resolves its gate before touching one, so a prompts-off deployment never serialises a
  prompt that is about to be discarded.

  **A second, pre-existing instance of C2's privacy half is fixed here too.** On both runtimes
  `makeHarnessCallRecorder`'s `LlmObservabilityService` was built with no `workspaceSettingsRepository`,
  and an absent repository makes `createStoreAgentContextGate` a constant `true` — so a subscription
  harness's full `stream-json` prompt and response were retained for a workspace that had explicitly
  opted out. It went unnoticed because that failure is silent by construction: nothing errors, the
  rows simply keep their bodies. Both facades now thread the repository. Existing rows are not
  rewritten; the fix applies from the next recorded call.

  The row mapping deliberately reports what an inline call does not know rather than filling
  proxy-shaped fields with plausible values: `turnIndex` null, `httpStatus` null, `phase` `''`,
  `streaming` false, and `upstreamMs === totalMs` so the derived overhead is a real 0. Conformance
  pins each of those on both runtimes' real stores, since each is one a store could quietly flatten.
  Anything reading these rows should expect inline calls in the unattributed `phase=""` slice —
  `backend/docs/debug-api.md` and the `investigate-telemetry` skill now say so.

  **A live bug on the existing trace-sink path is fixed on the way through:** the inline feeder read
  `finishReason` as a bare string, but the current AI-SDK spec reports it as `{ unified, raw }` — so
  every inline call has been exporting `finishReason: null`, which reads in telemetry as "the
  provider didn't say" rather than as a parse miss. It survived because the tests fed the reader a
  hand-rolled result carrying the shape the reader wanted; they now drive the SDK's own
  `MockLanguageModelV3` through a real `generateText`, which is what surfaced it. Both provider test
  suites are consolidated into the one beside the class (they had drifted into two packages).

  Behaviour note: an `InstrumentedModelProvider` built with neither exit wired now throws at
  construction. Nothing in-tree does that, and it would previously have been a silent no-op wrapper
  that still satisfied the facades' wiring assertions.

- Updated dependencies [4ecb25c]
  - @cat-factory/kernel@0.190.0
  - @cat-factory/agents@0.86.0
  - @cat-factory/orchestration@0.168.0
  - @cat-factory/server@0.177.0
  - @cat-factory/node-server@0.138.0
  - @cat-factory/executor-harness@1.76.2
  - @cat-factory/gitlab@0.14.2
  - @cat-factory/integrations@0.110.3

## 0.88.6

### Patch Changes

- Updated dependencies [7ed2bc0]
  - @cat-factory/contracts@0.194.0
  - @cat-factory/kernel@0.189.0
  - @cat-factory/agents@0.85.0
  - @cat-factory/orchestration@0.167.0
  - @cat-factory/server@0.176.0
  - @cat-factory/node-server@0.137.0
  - @cat-factory/gitlab@0.14.1
  - @cat-factory/integrations@0.110.2
  - @cat-factory/executor-harness@1.76.2

## 0.88.5

### Patch Changes

- 2d43c1f: Run the executor-harness and smoketest-harness unit suites in CI.

  The unit lane is `pnpm -r run test:run`, and neither package defined that alias — so 560
  executor-harness tests and 15 smoketest-harness tests had never run in CI. Their
  `benchmark-harness` / `deploy-harness` siblings each carry an alias identical to their own `test`
  script for exactly this reason, and there is no history of it being removed from either laggard,
  so this reads as an omission rather than a decision.

  Only `test:acceptance` ran before, in the Container acceptance lane, which covers the Docker
  end-to-end path and none of the unit surface: the watchdogs, the failure classifier, the
  call-metric aggregator, git auth/checkout/PR, redaction, the progress guard, validation and the
  reproduction proof.

  Both default vitest configs are already unit-only and offline (`include: ['test/*.test.ts']`, with
  the Docker suite in its own config), so they belong in that lane as-is.

  `package.json` is an executor image source, so the harness version and its three pins move with
  it — no source under `src/` changed, so the new image is byte-identical in behaviour to the one
  it replaces.

- Updated dependencies [2d43c1f]
- Updated dependencies [85efc27]
- Updated dependencies [9794c19]
  - @cat-factory/executor-harness@1.76.2
  - @cat-factory/contracts@0.193.0
  - @cat-factory/kernel@0.188.0
  - @cat-factory/orchestration@0.166.0
  - @cat-factory/server@0.175.0
  - @cat-factory/gitlab@0.14.0
  - @cat-factory/agents@0.84.2
  - @cat-factory/integrations@0.110.1
  - @cat-factory/node-server@0.136.1

## 0.88.4

### Patch Changes

- 5b19dab: Make a silently-failing agent run say what happened.

  An agent step failed in local mode with `claude exited with code 1: ` — the exit code, a colon,
  and nothing after it — plus `Phase timings: starting=0s, clone=1s, agent=564s. Failed in agent
phase; no tool had completed yet`. Every piece of evidence that would have identified it was
  either discarded or unreachable: no watchdog had fired (so it was not classified as a hang), the
  cold-start diagnostic recorded at the 120s mark had no consumer outside the container log, the
  CLI's session transcript died with its per-run config home, and the container was removed the
  moment the job settled. The retry succeeded, which is the worst outcome for diagnosis — nothing
  left to inspect and no reason to believe it won't recur.

  Three things now carry the evidence the harness already had:

  **A bad CLI exit carries the CLI's own report.** Both agent CLIs report a terminal failure on
  STDOUT inside their event stream — Claude Code's `result` event, Codex's last agent message — and
  leave stderr EMPTY. `streamCli` rejected with the stderr tail alone, so an upstream refusal (quota,
  rate limit, a provider outage the CLI retried out on) was rendered as an exit code and a dangling
  colon, while the explanation sat in a local variable only the success path read. The rejection now
  folds that report in, says `(no stderr output)` rather than trailing off, and names the SIGNAL when
  one killed the process instead of rendering "code null" — which is the first fork in the road
  between "the CLI gave up" and "something killed the container".

  **The failure detail says how quiet the run had gone.** Exit status cannot distinguish a crash
  from a stall: both are non-zero with an empty stderr. Phase timing plus silence can. The
  breadcrumb now adds `silent for 564s`, or `no activity at all in 564s` when the run never
  produced a byte — suppressed under 30s, and on an inactivity kill whose own message already states
  the window it waited out, so it appears only where it changes the diagnosis. It is worded as
  ACTIVITY rather than agent output because that is what the channel carries: the activity-silent
  phases (dependency install, pre-PR validation, the reproduction proof, the frontend stand-up) feed
  it synthetic keep-alive beats to hold the inactivity watchdog off, so a run that beat every 30s
  through its install and then died has been heard from even though the agent never spoke.

  **The cold-start diagnostic reaches the run.** ADR 0026 D4 asks for it to be surfaced on the step;
  it was recorded on the job view and logged in the container, where a developer reading a failed run
  in the SPA never sees it. It is now folded into the failure `detail`, the one failure field the
  backend already carries onto the step — no new field on every transport hop. Surfacing it on a
  still-RUNNING view (the early warning) stays open as observability-logging-gaps slice 5.5.

  The local runtime's native inline runner had the same defect in miniature: it runs
  `claude -p --output-format json`, whose error JSON also lands on stdout, and its non-zero-exit
  branch kept only stderr — so the in-band `is_error` check its caller performs was unreachable
  exactly when the CLI exited non-zero. It now reports whichever stream spoke, scrubbed through
  `redactSecrets` at the emit site: that message carries raw command output, and on this path stdout
  holds the model's own text, which is strictly more exposed than the stderr the sibling in the
  container harness was already redacting.

  **`describeProcessExit` is a new kernel export**, the shared sentence for how a subprocess ended.
  The `null`-code-means-signal distinction is operational knowledge rather than formatting, and it
  was about to exist in two hand-written copies; a third and fourth transport (pooled runner, K8s
  pod, native host process) report process exits too and should inherit it rather than rediscover
  it. The executor-harness keeps a pinned copy because the container image can depend on no
  workspace package — the same arrangement `host-markdown` has, held equal by a conformity test.

  Behaviour change to be aware of: the non-zero-exit message shape is different (`(no stderr
output)`, a `killed by SIGKILL` variant, an appended report). Nothing classifies on it — the
  backend reads the structured `failureCause`, and the string-fallback classifiers were deleted in
  error-message-coverage I5 — but a human-facing string that appeared in past runs has changed.

  Deliberately NOT changed: the failure still classifies as the generic `agent` cause. `llm-upstream`
  exists and is documented as exactly this case, but the only signal available for it is the CLI's
  `result` prose plus a `subtype` whose vocabulary is not contractual — classifying on that would
  reintroduce the string matching I5 deleted, and a wrong structured cause is worse than a generic
  one because the backend acts on it. Surfacing the report is what makes the follow-up decidable.

- Updated dependencies [57e1195]
- Updated dependencies [5b19dab]
- Updated dependencies [5b19dab]
  - @cat-factory/executor-harness@1.76.0
  - @cat-factory/contracts@0.192.0
  - @cat-factory/kernel@0.187.0
  - @cat-factory/integrations@0.110.0
  - @cat-factory/orchestration@0.165.0
  - @cat-factory/server@0.174.0
  - @cat-factory/node-server@0.136.0
  - @cat-factory/agents@0.84.1
  - @cat-factory/gitlab@0.13.36

## 0.88.3

### Patch Changes

- Updated dependencies [e087b40]
  - @cat-factory/contracts@0.191.0
  - @cat-factory/kernel@0.186.0
  - @cat-factory/agents@0.84.0
  - @cat-factory/orchestration@0.164.0
  - @cat-factory/server@0.173.0
  - @cat-factory/node-server@0.135.0
  - @cat-factory/gitlab@0.13.35
  - @cat-factory/integrations@0.109.6
  - @cat-factory/executor-harness@1.74.0

## 0.88.2

### Patch Changes

- 0eacaa2: Move private package registries into the Infrastructure window, and stop requiring package scopes.

  The registries a checkout installs from are part of where agent containers RUN, not an optional
  external system a workspace links in, so they are now a tab of the Infrastructure window
  (alongside Agent containers / Test environments / Shared stacks) rather than an Integrations-hub
  row with a modal of its own. The tab still gates on the module's own probe, so an unconfigured
  backend shows no dead tab. `ui.infrastructureTab` is typed against the window's full tab
  vocabulary rather than the two provider-connection kinds, so the non-connection tabs (shared
  stacks, package registries) are reachable by deep link instead of only by opening the window and
  clicking across.

  Package scopes are now OPTIONAL on an entry, and leaving them empty is often the right answer: an
  npmrc scope mapping is all-or-nothing, so routing `@org` to a private registry makes every
  `@org/*` package resolve from it — which breaks an organisation that publishes part of that scope
  publicly. A scope-less entry still emits the registry host's `_authToken` line, which is all a
  checkout needs whenever the ROUTING is already settled elsewhere: the repository commits its own
  `.npmrc` (project config wins over the user config the harness writes), single dependencies carry
  a named-registry prefix (`"@acme/private": "gh:^1.0.0"` — pnpm >= 11.1.0, pnpm/pnpm#11324), or the
  vendor simply IS the default registry, where a scope mapping back to `registry.npmjs.org` was
  always a no-op and only the credential was missing. The form explains this next to the field and
  previews the scopes it parsed, so an empty save reads as deliberate rather than as a field that
  silently swallowed what was typed.

  Compatibility: a scope-less entry needs harness image `1.73.0` or newer. Note the blast radius —
  an older image does not skip the entry, it fails `parseJob`, so EVERY container dispatch in that
  workspace dies (`packageRegistries[i].scopes must be a non-empty array`), not just dependency
  installs. The backend has no signal for what image a pool pins, so this cannot be gated
  server-side: a self-hosted runner pool must be updated before a workspace configures a scope-less
  entry. Deployments on the managed image are carried by the pin bump in this release.

  Also: a package-registries read that fails for any reason OTHER than the module being
  unconfigured now propagates instead of being swallowed, so the panel reports it. Previously a
  `503` (no module) and an unreachable backend both rendered as an empty, silent surface — and with
  the panel behind an availability-gated tab, the second case had no surface at all.

- Updated dependencies [0eacaa2]
  - @cat-factory/contracts@0.190.0
  - @cat-factory/executor-harness@1.74.0
  - @cat-factory/orchestration@0.163.1
  - @cat-factory/agents@0.83.1
  - @cat-factory/gitlab@0.13.34
  - @cat-factory/integrations@0.109.5
  - @cat-factory/kernel@0.185.1
  - @cat-factory/server@0.172.2
  - @cat-factory/node-server@0.134.2

## 0.88.1

### Patch Changes

- Updated dependencies [1fa8ef7]
  - @cat-factory/orchestration@0.163.0
  - @cat-factory/kernel@0.185.0
  - @cat-factory/agents@0.83.0
  - @cat-factory/server@0.172.1
  - @cat-factory/node-server@0.134.1
  - @cat-factory/executor-harness@1.72.0
  - @cat-factory/gitlab@0.13.33
  - @cat-factory/integrations@0.109.4

## 0.88.0

### Minor Changes

- 8251a99: Give every request and every container job a correlation id.

  Both facades now mount a shared request middleware as their FIRST middleware — ahead of CORS and
  the per-request container build, so a CORS denial and the Worker's misconfiguration fallback are
  covered too. It adopts a bounded, safe `X-Request-Id` from the caller or mints one, echoes it on
  the response, puts it in **every error envelope**, binds `{ requestId, method, path }` on a
  request-scoped child logger, and emits one line per request: `info` on success, `warn` on a 4xx
  (naming the mapped error code), `error` on a 5xx. Previously only unexpected 500s were logged at
  all, so a 4xx spike — a validation regression, an RBAC denial, a conflict loop — left no
  server-side trace and a user report had nothing to join against. `/health` and `/ready` drop to
  `debug` when they succeed, so an orchestrator's probes don't bury the request stream.

  `X-Request-Id` is allow-listed inbound (so a caller that already has an id propagates it rather
  than the backend minting a second one for the same request) and newly EXPOSED outbound, so a
  browser can read it off the response.

  The **misconfiguration fallback backend** is covered on every facade. The Worker inherits the
  middleware because it serves the fallback from inside `createApp`, but Node/local swap in the
  whole `createMisconfiguredApp` — so that app mounts it itself, or the one deployment shape an
  operator is actively debugging is the only one serving requests with no id and no request line.

  Across the workflow↔container seam, `workspaceId` and `executionId` now ride the agent job body
  and the harness binds them onto its per-job logger beside `jobId` — the two halves of a run
  previously shared no id and were stitched only by a job-id naming convention. This covers EVERY
  dispatcher of the `agent` kind, not just the execution path: `ContainerRepoBootstrapper` and
  `ContainerEnvConfigRepairer` hand-build their bodies, and a bootstrap is a first-class agent run
  (same table, same retry surface), so leaving them out would have left their containers' logs
  joinable to nothing. Neither has a separate execution row, so the job id doubles as the run id.

  `ContainerAgentExecutor` gained a bound logger and logs the seam's transitions (dispatched /
  dispatch-failed / poll-failed / running at `debug` / settled). A dispatch OR poll that throws is
  now reported: those are the failure classes nothing downstream can account for, because the job
  either never gets a handle or the transport fault is recorded against no job at all.

  Only the request PATHNAME is ever logged, never the raw URL, and a client-supplied id is refused
  unless it is short and `[\w\-=]+` — both are untrusted text going straight into a log stream, and
  query strings carry the WebSocket `?ticket=` and OAuth `?code=`. An unexpected fault's STACK is
  scrubbed with `redactSecrets` in its own right, not just its message: a stack's first line is
  `Error: <message>` verbatim, so attaching it raw beside the scrubbed `err` would republish
  exactly what the scrub just removed.

### Patch Changes

- Updated dependencies [8251a99]
  - @cat-factory/server@0.172.0
  - @cat-factory/node-server@0.134.0
  - @cat-factory/executor-harness@1.72.0

## 0.87.1

### Patch Changes

- f0be8a7: Retire the three shapes that let phase 2's defects happen, without changing behaviour.

  Both durable drivers now fail a run through one shared `RunFailure` value
  (`failureFromAdvanceError` / `failureFromResult` / `failureFromDriver`) instead of positional
  arguments each assembles itself. Every one of those parameters carried a default, so a driver
  that stopped short still compiled and recorded `null` — which is how the Cloudflare driver came
  to drop `AgentFailure.reason` on every path while its runtime-neutral twin forwarded it. An
  omitted field is now a typecheck failure.

  Controllers guard through two shared total accessors, `requireCapability` and `requireUser`
  (`@cat-factory/server`'s `http/guards.ts`, the siblings of `param()`, and exported from the
  package root alongside `param`). The per-controller `requireX(c): Module | null` forced every
  route to restate `if (!x) return unavailable()`, and 51 controllers had each declared their own
  copy of the thrower to satisfy it; making the accessor total deletes the guard line at ~300 call
  sites. Each has an `assert*` twin for a route that needs a capability wired but reads nothing off
  it, so the guard never reads as a discardable no-op statement.

  `createStoreAgentContextGate` moves to `@cat-factory/kernel` (`StoreAgentContextGate`) and is
  now the single implementation of the per-workspace body-capture rule, shared by the proxied
  (`LlmObservabilityService`) and inline (`InstrumentedModelProvider`) paths. Phase 2 gave the
  inline path a gate but wrote the rule a second time in a second package, leaving the two free to
  drift apart exactly as they had.

  Breaking (pre-1.0, no migration): `createStoreAgentContextGate` is no longer exported from
  `@cat-factory/server` — import it from `@cat-factory/kernel`. Its dependency shape is unchanged.

- Updated dependencies [f0be8a7]
  - @cat-factory/kernel@0.184.0
  - @cat-factory/server@0.171.0
  - @cat-factory/agents@0.82.4
  - @cat-factory/orchestration@0.162.0
  - @cat-factory/node-server@0.133.1
  - @cat-factory/executor-harness@1.70.0
  - @cat-factory/gitlab@0.13.32
  - @cat-factory/integrations@0.109.3

## 0.87.0

### Minor Changes

- a8cc6b2: Roll a run's model spend up by the PHASE that spent it, so "why did this small task cost a million
  tokens" is a breakdown rather than a guess. The per-call phase axis already existed; what was
  missing was the aggregate that reads it.

  Each phase reports its turns, the three input classes, its output, and a **carry cost**: each
  call's total input counted once for every later turn in the SAME conversation that had to re-send
  it. That is the figure a plain token sum cannot produce — it separates a phase that read a lot from
  a phase that made everything after it expensive, which is precisely the distinction between "trim
  the prompt" and "cut the turns". It is a proxy: comparable between one run's phases, meaningless as
  an absolute.

  It surfaces two ways, both folds over one aggregate: `step.metrics.byPhase` on every pipeline step
  (pushed live, rendered as a run-level table in the model-activity panel) and `llm.byPhase` on the
  remote debugging overview (`GET /api/v1/debug/runs/:runId`), ordered costliest-first. The
  unattributed `""` phase is always a row, never a dropped one — a run metered by a channel with no
  phase concept must not read as a run that spent nothing outside the agent.

  Compatibility break: `LlmCallMetricSummary` (the `LlmCallMetricRepository.summarizeByExecution`
  row) is now keyed by `(agentKind, phase)` rather than by `agentKind` alone, and carries
  `carryCostTokens`. Consumers fold it with the new kernel helpers (`foldRollupTotals`,
  `foldRollupsByAgentKind`, `foldRollupsByPhase`) instead of indexing it directly. No migration: the
  aggregate reads only columns that already exist on both telemetry stores.

### Patch Changes

- Updated dependencies [a8cc6b2]
  - @cat-factory/contracts@0.189.0
  - @cat-factory/kernel@0.183.0
  - @cat-factory/orchestration@0.161.0
  - @cat-factory/node-server@0.133.0
  - @cat-factory/agents@0.82.3
  - @cat-factory/gitlab@0.13.31
  - @cat-factory/integrations@0.109.2
  - @cat-factory/server@0.170.1
  - @cat-factory/executor-harness@1.70.0

## 0.86.0

### Minor Changes

- ac832b9: Add a read-only remote run-debugging API (`/api/v1/debug/*`) so an agent outside the browser can
  diagnose a run: a keyset-paginated run index, a per-run overview (steps, per-sink availability +
  counts, SQL-aggregated LLM rollups, precomputed diagnostic signals), and bounded drill-downs into
  the run's model calls, agent-context dispatches, performed web searches and provisioning event log.

  Bodies are opt-in and byte-budgeted, sliced in SQL so an un-previewed page reads no body bytes at
  all, and every truncation reports what it left out. The surface needs only a `read`-scope public API
  key.

  Root-causing is server-side work, not client-side paging: the LLM-call list takes a `?contains=`
  body search (SQL LIKE/ILIKE, case-insensitive, wildcards literal) whose matched rows report a
  per-body `matchOffset`; point reads take `?bodyOffset=` so the middle and tail of a large body are
  reachable (every body slice now also states its `offset`); the call point read's `?view=messages`
  parses the stored prompt delta into per-message rows with independent budgets; and the overview
  gains a `failure_outside_model_calls` signal pointing a failed-run-with-clean-calls investigation
  at tool execution, which records no calls of its own.

  Spend is attributable, not just countable: every call row carries the `phase` that spent it (the
  agent's own edit loop, a pre-PR validation repair round, a reproduction-proof repair round, …) and
  its `turnIndex` within that job, and `?phase=` narrows the page in SQL like `?agentKind=` does. So
  "the pipeline did work this task never needed" is one request rather than a client-side grouping over
  the whole run. The EMPTY phase is a queryable value, not "no filter" — it selects the unattributed
  slice (an older harness image, an inline call, the un-phased proxy path), which is otherwise
  unreachable; and `turnIndex` stays `null` rather than 0 where the producing channel has no turn
  concept, so a proxied call is never faked into "the first turn".

  All four bounded reads land in the local `node:sqlite` telemetry store too, so the surface works
  unchanged in mothership mode, where telemetry is local-first and these pages never cross the machine
  RPC (routing a page over a long run would be exactly the bulk read that bucket exists to forbid).

  Compatibility break: `ProvisioningLogQuery.before` (a bare `createdAt` keyset) is replaced by a
  composite `cursor: { createdAt, id }`, and the matching `?before=` query param is removed from
  `GET /workspaces/:ws/provisioning-logs` (the SPA never sent it). The old form dropped rows sharing
  a millisecond between pages, which is the common case for a log written in bursts.

### Patch Changes

- Updated dependencies [ac832b9]
  - @cat-factory/contracts@0.188.0
  - @cat-factory/kernel@0.182.0
  - @cat-factory/orchestration@0.160.0
  - @cat-factory/server@0.170.0
  - @cat-factory/node-server@0.132.0
  - @cat-factory/agents@0.82.2
  - @cat-factory/gitlab@0.13.30
  - @cat-factory/integrations@0.109.1
  - @cat-factory/executor-harness@1.70.0

## 0.85.2

### Patch Changes

- Updated dependencies [22d82ac]
  - @cat-factory/contracts@0.187.0
  - @cat-factory/kernel@0.181.0
  - @cat-factory/integrations@0.109.0
  - @cat-factory/server@0.169.0
  - @cat-factory/agents@0.82.1
  - @cat-factory/gitlab@0.13.29
  - @cat-factory/orchestration@0.159.2
  - @cat-factory/node-server@0.131.1
  - @cat-factory/executor-harness@1.70.0

## 0.85.1

### Patch Changes

- e18cfa2: Error identity now survives the trip from where a failure happens to where a user reads it.

  A run that dies on a thrown error carries that error's machine-readable `details.reason` onto
  its `AgentFailure` on both runtimes — previously the Cloudflare driver dropped `reason` on every
  path (and the container post-mortem `detail` on evictions), so the SPA's remedies could never
  fire in production. The wire vocabulary gains `UnavailableError` (503), `UnauthorizedError`
  (401) and `RateLimitedError` (429), and the 113 hand-rolled error envelopes across the HTTP
  layer are migrated onto it, so a 503/401/429 can now carry a `reason` code at all.

  Breaking (pre-1.0, no migration): `POST /signup` now answers 409 (`conflict`) for an
  already-registered email and 422 (`validation`) for a rejected password, instead of flattening
  both onto 400. The LLM proxy no longer returns the raw upstream exception text on a failed
  in-process call, and every proxy error envelope now carries a `code`.

  Privacy fix: inline (non-proxied) LLM calls now honour the per-workspace `storeAgentContext`
  opt-out before shipping prompt/response bodies to an external trace sink, matching the proxied
  path. A workspace that had opted out was still exporting its inline bodies to Langfuse/OTel.

- Updated dependencies [e18cfa2]
- Updated dependencies [01d4b6c]
  - @cat-factory/kernel@0.180.0
  - @cat-factory/server@0.168.0
  - @cat-factory/agents@0.82.0
  - @cat-factory/orchestration@0.159.1
  - @cat-factory/node-server@0.131.0
  - @cat-factory/executor-harness@1.70.0
  - @cat-factory/gitlab@0.13.28
  - @cat-factory/integrations@0.108.1

## 0.85.0

### Minor Changes

- b75a08a: Stamp every `llm_call_metrics` row with the run PHASE that spent it and its TURN ordinal, so a
  run's token burn can be attributed to the slice that caused it — the agent's own edit loop, a
  pre-PR validation repair round, a reproduction-proof repair round — instead of piling into one
  figure per agent kind (token-burn instrumentation, slice 2).

  The phase comes from whoever owns the boundary, never from a downstream guess: the harness's job
  registry stamps it on each streamed call as it is emitted, and the Pi path — whose calls are
  metered server-side by the proxy — carries it on the URL Pi is pointed at
  (`${proxyBaseUrl}/phase/<phase>`, rewritten per pass), since Pi makes those requests from a config
  with no per-request header to set. The proxy therefore serves completions on a second, optional
  phase-tagged path; the plain path is unchanged and its calls are recorded as unattributed.

  The backend advertises that route on the job body (`proxyPhasePath`, the same shape as
  `webSearch`) and the harness tags the URL only when told, so an image paired with an older backend
  — a runner pool pins its own harness image, and `LOCAL_HARNESS_IMAGE` overrides the recommended
  pin — falls back to the plain path instead of posting every model call to a 404.

  `LlmCallMetric` gains `phase: string` (`''` = unattributed, a real slice of the rollup rather
  than a dropped row) and `turnIndex: number | null` (the harness's job-scoped `seq`; NULL where the
  producing channel has no turn concept, so a proxied call is never faked into "turn 0").
  `HarnessCallMetric` gains an optional `phase`, read leniently off a runner pool's envelope.
  Both telemetry stores gain the two columns (D1 `0004_llm_call_phase_turn` ⇄ a Drizzle migration);
  existing rows keep the unattributed default and are not backfilled — the table is pruned to a
  3-day window, so they churn out on their own.

- 56128e2: Mothership mode: telemetry is now local-first, so a mothership-mode run finally produces the
  observability it is supposed to.

  Previously the five telemetry repositories resolved to the remote registry, where none of their
  methods is (or should be) allow-listed: every write came back `unknown_method` — swallowed by the
  best-effort recorders — and every read came back empty, so the observability panel, the per-step
  token rollups, the web-search log and the provisioning "View logs" surfaces were blank on a
  mothership-mode node with nothing failing anywhere.

  A mothership-mode node now writes and reads its per-call LLM metrics, agent-context snapshots,
  performed web searches, provisioning log and modeled subscription quota cycles in its own
  `node:sqlite` telemetry store (`telemetry.sqlite`, override `LOCAL_MOTHERSHIP_TELEMETRY_DB`), and
  prunes it to the deployment's configured retention windows. The bucket is composed into the
  repository registry once (`createRemoteRepositoryRegistry`'s new `localFirst` map), so every
  consumer resolves it with no per-consumer wiring.

  Two boundary changes ride with it:

  - `tokenUsageRepository.record` is now remotely callable, under a new `usageRecord` scope rule. The
    spend ledger has the telemetry write profile but is the org's budget safeguard, and the spend gate
    already reads its rollups remotely — a laptop-local ledger would leave local runs invisible to the
    budget they must answer to. The rule pins the row's denormalized `accountId`/`userId` to the
    caller, so a node cannot inflate another account's or teammate's budget.
  - `llmCallMetricRepository.summarizeByExecution` is no longer remotely callable: it was a run-path
    stopgap against the mothership's telemetry store, which holds none of a laptop's calls, so it
    could only ever report zeros for the run that produced them.

  Batch-ingesting a finished run's telemetry up to the mothership (so hosted teammates can read it,
  and it survives the local prune) is the remaining half of this initiative slice.

### Patch Changes

- 3057db1: Carry the `phase` / `turnIndex` telemetry axes through the mothership-mode local sqlite store.
  The axes and the store landed in separate PRs that were each green alone, so `main` was left
  unable to build the local runtime.
- Updated dependencies [b75a08a]
- Updated dependencies [56128e2]
- Updated dependencies [3057db1]
  - @cat-factory/executor-harness@1.70.0
  - @cat-factory/contracts@0.186.0
  - @cat-factory/kernel@0.179.0
  - @cat-factory/integrations@0.108.0
  - @cat-factory/orchestration@0.159.0
  - @cat-factory/server@0.167.0
  - @cat-factory/node-server@0.130.0
  - @cat-factory/agents@0.81.1
  - @cat-factory/gitlab@0.13.27

## 0.84.2

### Patch Changes

- Updated dependencies [9d965c9]
- Updated dependencies [8a9f311]
  - @cat-factory/contracts@0.185.0
  - @cat-factory/kernel@0.178.0
  - @cat-factory/agents@0.81.0
  - @cat-factory/integrations@0.107.3
  - @cat-factory/server@0.166.2
  - @cat-factory/node-server@0.129.1
  - @cat-factory/orchestration@0.158.0
  - @cat-factory/gitlab@0.13.26
  - @cat-factory/executor-harness@1.68.0

## 0.84.1

### Patch Changes

- Updated dependencies [58e06a2]
  - @cat-factory/contracts@0.184.0
  - @cat-factory/kernel@0.177.0
  - @cat-factory/orchestration@0.157.0
  - @cat-factory/node-server@0.129.0
  - @cat-factory/agents@0.80.1
  - @cat-factory/gitlab@0.13.25
  - @cat-factory/integrations@0.107.2
  - @cat-factory/server@0.166.1
  - @cat-factory/executor-harness@1.68.0

## 0.84.0

### Minor Changes

- 65b87c1: Agent kinds can now declare CAPABILITIES: the skills they apply (procedural playbooks — bundled in
  the deployment's own package, or referenced from the account's repo-synced catalog) and the tool
  servers they may call (MCP, stdio or HTTP). Both are registered on the same app-owned
  `AgentKindRegistry` and referenced by id from any number of kinds, or attached to a BUILT-IN kind
  with `assignSkills` / `assignToolServers`. Tool-server credentials are declared by name and
  resolved at dispatch through the new kernel `ToolSecretResolver` port (both facades wire the
  deployment-environment resolver by default), so a value never reaches a prompt or the run's
  telemetry snapshot. See `backend/docs/adr/0029-agent-kind-capabilities.md`.

  BREAKING (pre-1.0, no migration): `AgentRunContext.skill` is now `skills` (an array),
  `PipelineStep.skillVersion` is now `skillVersions`, and the harness job body's `skill` field is now
  `skills` alongside the new `mcpServers`.

  OPERATORS — self-hosted runner pools must be moved to the `1.67.0` harness image. A pool still
  running an older image parses the job body with the old singular `skill` field, so the new
  `skills` array is dropped on the floor. On Pi/codex that degrades quietly (their prompt still
  carries the folded-in instructions), but a leased-credential claude-code run is told in its prompt
  that the skill "is installed for this step" while nothing was installed — a blind run rather than a
  failed one. `mcpServers` is dropped the same way, which surfaces as an agent that was promised
  tools it does not have.

  SECURITY NOTE for a deployment that installs agent packages it did not author: a tool-server
  definition names both the credential it wants and the endpoint it talks to, and the default
  `createEnvToolSecretResolver` will resolve any key off the deployment environment. On the Worker
  that is a real widening (`env` is not otherwise ambient to a registration). Pass
  `createEnvToolSecretResolver(env, { allowKeys: [...] })` to confine it.

### Patch Changes

- Updated dependencies [65b87c1]
- Updated dependencies [df48cb0]
  - @cat-factory/executor-harness@1.68.0
  - @cat-factory/orchestration@0.156.0
  - @cat-factory/contracts@0.183.0
  - @cat-factory/agents@0.80.0
  - @cat-factory/kernel@0.176.0
  - @cat-factory/server@0.166.0
  - @cat-factory/node-server@0.128.0
  - @cat-factory/gitlab@0.13.24
  - @cat-factory/integrations@0.107.1

## 0.83.0

### Minor Changes

- b30cc6e: Make the three LLM input-token classes orthogonal in telemetry: `promptTokens` is now FRESH
  (uncached) input only, with `cacheReadTokens` and `cacheWriteTokens` carried beside it, so total
  input is their sum. A cache read is priced ~0.1x base input and a cache write 1.25-2x, so the old
  lumped `cachedPromptTokens` made a run re-writing its prefix every turn indistinguishable from one
  riding a warm cache.

  BREAKING (telemetry only, no migration path by design): `cachedPromptTokens` is dropped from
  `llmCallMetricSchema`, `llmCallActivitySchema`, `stepMetricsSchema` and the metrics export, and
  `cached_prompt_tokens` is dropped from both telemetry stores. `HarnessCallMetric.cachedInputTokens`
  becomes `cacheReadTokens` + `cacheWriteTokens`, and `inlineResult.usage` gains the same split.
  `llm_call_metrics` is pruned to a 3-day window, so rows carrying the old inclusive `prompt_tokens`
  semantics churn out on their own; `cacheHitRate` is now `(read + write) / (fresh + read + write)`
  and no longer needs its clamp. `cachedTokensFromUsage` is replaced by `readInputTokenClasses`,
  which returns all three classes from one usage payload (reconciling the inclusive and exclusive
  provider shapes internally, so no caller has to know which it is holding), and
  `ProxyCallObservation.cachedPromptTokens` becomes `inputTokens: InputTokenClasses`.

### Patch Changes

- Updated dependencies [b30cc6e]
  - @cat-factory/executor-harness@1.66.0
  - @cat-factory/contracts@0.182.0
  - @cat-factory/kernel@0.175.0
  - @cat-factory/agents@0.79.0
  - @cat-factory/integrations@0.107.0
  - @cat-factory/orchestration@0.155.0
  - @cat-factory/server@0.165.0
  - @cat-factory/node-server@0.127.0
  - @cat-factory/gitlab@0.13.23

## 0.82.3

### Patch Changes

- 5abcb9e: Drain the remaining silent promise drops in the backend and stop them regrowing. Every
  `.catch(() => {})` in `backend/packages` and `backend/runtimes` now goes through
  `runBestEffort`, so a swallowed failure leaves one `warn` naming the operation with its cause
  attached, and `scripts/check-silent-catch.mjs` fails CI on a new one (a drop that genuinely needs
  no report annotates itself with `// silent-catch-ok: <reason>`). The guard counts every spelling
  of an empty handler, including a body holding only a comment — which caught two further drops:
  the mothership event relay (`HttpMachineEventClient.publish`, which additionally now treats a
  REFUSED publish as a failure rather than a delivery, so an expired machine token stops reading as
  success) and the web-search query recorder.

  `RepoOpContext` gains a required `logger`, which closes the spec-promotion hole: a tester run that
  verified requirements but promoted none used to be indistinguishable from one that had nothing to
  promote. `RunDispatcher`, `DeployerStepController` and `InitiativeLoopService` gain the logger they
  previously had no way to report through — so an issue-writeback drop, a leaked provisioning lease
  and a permanently-failing initiative tick are all visible now. `ExecutionWorkflow` binds its run
  correlation once with `logger.child` and scrubs its poll-failure causes with `redactSecrets`.

- Updated dependencies [c47eb66]
- Updated dependencies [5abcb9e]
  - @cat-factory/integrations@0.106.0
  - @cat-factory/contracts@0.181.0
  - @cat-factory/kernel@0.174.0
  - @cat-factory/server@0.164.0
  - @cat-factory/agents@0.78.0
  - @cat-factory/orchestration@0.154.0
  - @cat-factory/node-server@0.126.3
  - @cat-factory/gitlab@0.13.22
  - @cat-factory/executor-harness@1.64.4

## 0.82.2

### Patch Changes

- bead6df: Stop two ways a run could sit wedged with nothing left to move it.

  A self-hosted runner pool that lost a job now says so. A poll that 404s (or 410s), and a scheduler
  status that names a reclaimed runner (`evicted` / `preempted` / `oomkilled` / `node_lost` / …), are
  read as the RUNNER going away rather than the job failing, so the step is re-dispatched instead of
  burning the run's whole ~70-minute poll budget and dying `timeout`. A job-level failure vocabulary
  (`error` / `cancelled` / `timeout` / …) and a success vocabulary (`completed` / `succeeded` / …)
  likewise end the poll loop honestly; a status word that matches nothing still keeps the driver
  waiting, since wrongly killing a live run is the worse mistake. A pool is asked to route stickily
  by job id, so an eviction recovery now dispatches under a FRESH id (as the deploy path already
  did) — reusing it would have routed the retry back to the job whose runner just died, making the
  recovery a no-op for pool-backed runs.

  A manifest that defines no `release` template — or no status path — reports the gap on its
  connection test in Settings, and logs it once at registration. Each gap crosses the wire as a
  code, so the SPA renders translated copy rather than backend prose.

  The merge-review and pipeline-complete notifications are now raised BEFORE the block flips to
  `pr_ready`. Raising second meant that if the card failed to raise, the run failed but the task was
  already sitting in `pr_ready` with an empty inbox: a PR-ready task with no review action and
  nothing to re-drive it.

  Breaking for anyone importing them directly: `runnersLogic.mapJobState` is replaced by
  `runnersLogic.classifyJobStatus`, which returns `{ state, evicted? }`;
  `runnersLogic.manifestWarnings` and `RunnerBackendProvider.warnings` return
  `{ code, message }` objects rather than strings. The `(container evicted or crashed)` wording every
  transport had copied is now kernel's `CONTAINER_EVICTION_ERROR`.

- Updated dependencies [bead6df]
  - @cat-factory/integrations@0.105.0
  - @cat-factory/contracts@0.180.0
  - @cat-factory/kernel@0.173.0
  - @cat-factory/orchestration@0.153.1
  - @cat-factory/server@0.163.2
  - @cat-factory/node-server@0.126.2
  - @cat-factory/agents@0.77.1
  - @cat-factory/gitlab@0.13.21
  - @cat-factory/executor-harness@1.64.4

## 0.82.1

### Patch Changes

- Updated dependencies [a04f609]
  - @cat-factory/agents@0.77.0
  - @cat-factory/orchestration@0.153.0
  - @cat-factory/server@0.163.1
  - @cat-factory/node-server@0.126.1
  - @cat-factory/executor-harness@1.64.4

## 0.82.0

### Minor Changes

- 6dbd864: Introduce a central, pino-backed structured logger behind a kernel `Logger` port, so the whole
  domain engine can log — previously only `@cat-factory/server` and the runtime facades could, which
  forced the domain packages to swallow failures silently.

  - **New**: `Logger` / `noopLogger` / `createRecordingLogger` (`@cat-factory/kernel`,
    `ports/logging.ts`), and `runBestEffort` / `describeError` (`shared/best-effort.ts`) as the
    replacement for `.catch(() => {})`. `@cat-factory/server` exports `createPinoLogger`,
    `parseLogLevel`, `setLogLevel` and `getLogLevel` alongside the process-wide `logger`.
  - **`LOG_LEVEL`** is now honoured (`process.env` on Node/local, a wrangler var on the Worker);
    it was previously read from a global nothing ever assigned.
  - **Node/local** register `unhandledRejection`/`uncaughtException` guards and subscribe to
    pg-boss's `error` event (an unhandled one on an EventEmitter throws). The guards add the
    structured line only — both still exit non-zero, matching what Node already did (since Node 15
    an unhandled rejection is raised as an uncaught exception), so process lifetime is unchanged.

  **Breaking (pre-1.0, no shims):**

  - The logger's calling convention is now **message-first**: `logger.warn(msg, fields)`, not pino's
    `logger.warn(fields, msg)`. `Logger` is the kernel port type, no longer pino's own.
  - Every ad-hoc logger interface is **removed**, not deprecated: `PrReportLogger`,
    `PlatformMetricsSweepLogger`, `GitHubDocsLogger`, `OtelLogger`, `OtlpLogger`, `LangfuseLogger`,
    `ResetLogger`, `InfraSetupLogger`, `PlatformHealthSweepLogger`, `KeyFingerprintLogger`,
    `GateWiringLogger`, `DriveLogger`, `PropagatorLogger`. Every `logger?:` dependency now takes the
    kernel `Logger`.
  - `@cat-factory/node-server` no longer exports `pinoKeyFingerprintLogger` (the shapes match, so the
    bridge is gone). `@cat-factory/orchestration`'s `Core` gains a required `logger`.
  - **`CoreDependencies.logger` is REQUIRED**, not optional. A facade or harness assembling the bag
    by hand must pass one (`noopLogger` if it does not care) or it will not typecheck — the guard
    that would have caught the Worker shipping with no logger wired at all.

  Also fixes `MergeTrackRecordService.classify` losing the repo identity when `listChangedFiles`
  throws, which permanently broke external-merge attribution for that record.

### Patch Changes

- Updated dependencies [71ea4ec]
- Updated dependencies [68f0edd]
- Updated dependencies [71ea4ec]
- Updated dependencies [6dbd864]
  - @cat-factory/orchestration@0.152.0
  - @cat-factory/contracts@0.179.0
  - @cat-factory/kernel@0.172.0
  - @cat-factory/agents@0.76.0
  - @cat-factory/integrations@0.104.0
  - @cat-factory/server@0.163.0
  - @cat-factory/node-server@0.126.0
  - @cat-factory/gitlab@0.13.20
  - @cat-factory/executor-harness@1.64.4

## 0.81.2

### Patch Changes

- Updated dependencies [3260f2d]
  - @cat-factory/executor-harness@1.64.4
  - @cat-factory/agents@0.75.2
  - @cat-factory/orchestration@0.151.1
  - @cat-factory/server@0.162.1
  - @cat-factory/node-server@0.125.1

## 0.81.1

### Patch Changes

- 9d8fe9b: Close the lost-update race on the iterative-review stores (race-condition audit 2.5).

  A requirements / clarity / brainstorm review is ONE JSON blob holding every finding, and every mutation used to load it, edit one item and force-write the whole row back. Two writers inside that window — two people answering different findings, a dismissal landing inside the (slow) incorporation LLM call, the Requirement-Writer's fill pass racing a human accept — left only the last writer's edit. Because incorporation refuses to run while any finding is still `open`, a lost dismissal wedged the loop on a finding that was in fact settled.

  - **`rev` + `compareAndSwap` on all three review stores** (D1 migration `0065` ⇄ Drizzle): the conditional write lands only while the stored revision still matches the one the caller read, and never inserts, so a review a fresh run replaced can't be resurrected.
  - **Every read-modify-write routes through `mutateReview`** (load → apply → CAS, reloading and RE-APPLYING the mutation on the winner's snapshot when it loses), including the two paths that held a snapshot across an LLM call (`incorporate`, `reReview`) and all four recommendation paths.
  - **`deleteByBlock` + `upsert` is replaced by an atomic `replaceForBlock` / `replaceForBlockStage`**, a single conflict-targeted upsert against a new UNIQUE index on `(workspace_id, block_id[, stage])` (D1 migration `0066` ⇄ Drizzle, healing pre-existing duplicates before constraining). Two review runs for one block could previously interleave their delete/insert pairs and leave TWO live reviews, so the window loaded one while the parked run's decision keyed to the other. The racy delete method is removed from the port (and the mothership persistence allow-list) so it can't be reintroduced.
  - **A contended give-up throws `ReviewContendedError`** (new, a `ConflictError` subclass): a 409 for an HTTP caller, and a re-drive signal for the durable driver, whose incorporation cycle mutation carries the output of an LLM call the run has already paid for.

  Compatibility break (pre-1.0, no shim): the `RequirementReviewRepository` / `ClarityReviewRepository` / `BrainstormSessionRepository` ports drop `deleteByBlock`/`deleteByBlockStage` and gain `compareAndSwap` + `replaceForBlock`/`replaceForBlockStage`; the review wire shapes gain `rev`. Existing rows read as `rev = 0`, which is exactly what the new column defaults to. Migration `0066` DELETES duplicate live reviews for a block (keeping the newest, the one `getByBlock` already returned) before adding the constraint — the superseded duplicates were unreachable.

- Updated dependencies [15905ab]
- Updated dependencies [9d8fe9b]
  - @cat-factory/executor-harness@1.64.2
  - @cat-factory/agents@0.75.1
  - @cat-factory/contracts@0.178.0
  - @cat-factory/kernel@0.171.0
  - @cat-factory/orchestration@0.151.0
  - @cat-factory/server@0.162.0
  - @cat-factory/node-server@0.125.0
  - @cat-factory/gitlab@0.13.19
  - @cat-factory/integrations@0.103.3

## 0.81.0

### Minor Changes

- 2ed7b50: Complete mothership-mode real-time in both directions, and fix the fan-out read that made every mothership-mode publish fail.

  - **Inbound event subscription (`GET /internal/events/subscribe/:workspaceId`).** A mothership-mode node can now RECEIVE org activity, not just publish it — a hosted teammate's run, or a peer laptop's, animates the local board live instead of waiting for a manual refresh. The mothership side is not a new fan-out: the machine-authed handshake is handed to the SAME per-workspace realtime transport the browser stream uses (`gateways.realtime.upgrade`), so a subscribed node is just another socket in the workspace's room and the Cloudflare Durable Object needed no change. Authorisation is the shared `authorizeMachineSubscribe` (machine-audience pin first, then capability, then the workspace → account scope with a uniform 404), reached by the Worker through the shared controller and by Node from its HTTP-server `upgrade` listener — the same split, and the same reason, as the browser stream's `?ticket=`.
  - **Demand-driven on the laptop.** `MothershipEventSubscriber` holds one upstream stream per workspace with at least one local subscriber, driven by a new room-transition seam on `NodeRealtimeHub`; an idle node holds none, and it never needs to enumerate the org's workspaces. Inbound events are broadcast to the bare hub (never back through the layered propagator, which would re-publish them upstream), and the node's stable `?cid=` is now stamped as the outbound publish's `originConnectionId` — replacing the originating tab's id, which means nothing on the mothership — so a node's own events are not fanned back down to it.
  - **The subscription keeps itself honest.** Liveness is client-driven because the two mothership runtimes disagree about who provides it: a Node mothership pings at the protocol level and reaps a dead socket, while a Cloudflare mothership's hibernating Durable Object never pings — so a half-open socket there would never fire `close` and the workspace would stay dark indefinitely while the node still believed it was subscribed. The subscriber therefore heartbeats and drops a socket that has been silent past an idle deadline, treating any inbound frame (its `"ping"` auto-answered at the Cloudflare edge, or Node's own protocol ping) as proof of life. A refused handshake is now reported rather than swallowed, rate-limited so an unbounded retry stays visible without flooding, and the reconnect backoff is jittered so a fleet doesn't retry in lockstep after a mothership restart.
  - **Fix: `workspaceMountRepository.listWorkspaceIdsMountingBlock` was not remotely callable.** `FanOutEventPublisher` calls it on EVERY engine event publish, and a mothership-mode node wires the same decorator, so the call came back `unknown_method`, the remote proxy threw, and the rejection propagated out of the run-state emit. It is now allow-listed under the `workspace` rule (it returns workspace ids only, and a service can only be mounted inside its own account). `blockRepository.countActiveInternal` is allow-listed alongside it, completing the headless public-API surface whose paginated reads were already remote.
  - The persistence allow-list moved into its own module (`persistence/rpc-allowlist.ts`) — same exported name and import path, but the initiative's fast-growing surface no longer shares a file with the stable protocol.

### Patch Changes

- Updated dependencies [2ed7b50]
  - @cat-factory/server@0.161.0
  - @cat-factory/node-server@0.124.0
  - @cat-factory/executor-harness@1.64.0

## 0.80.6

### Patch Changes

- Updated dependencies [cf2779a]
- Updated dependencies [5e5d409]
  - @cat-factory/contracts@0.177.0
  - @cat-factory/agents@0.75.0
  - @cat-factory/executor-harness@1.64.0
  - @cat-factory/server@0.160.0
  - @cat-factory/kernel@0.170.0
  - @cat-factory/orchestration@0.150.1
  - @cat-factory/gitlab@0.13.18
  - @cat-factory/integrations@0.103.2
  - @cat-factory/node-server@0.123.1

## 0.80.5

### Patch Changes

- Updated dependencies [1947062]
  - @cat-factory/contracts@0.176.0
  - @cat-factory/kernel@0.169.0
  - @cat-factory/orchestration@0.150.0
  - @cat-factory/server@0.159.0
  - @cat-factory/node-server@0.123.0
  - @cat-factory/agents@0.74.1
  - @cat-factory/gitlab@0.13.17
  - @cat-factory/integrations@0.103.1
  - @cat-factory/executor-harness@1.62.0

## 0.80.4

### Patch Changes

- Updated dependencies [fb71506]
  - @cat-factory/executor-harness@1.62.0
  - @cat-factory/agents@0.74.0
  - @cat-factory/server@0.158.0
  - @cat-factory/orchestration@0.149.2
  - @cat-factory/node-server@0.122.4

## 0.80.3

### Patch Changes

- Updated dependencies [1c12289]
  - @cat-factory/contracts@0.175.0
  - @cat-factory/kernel@0.168.0
  - @cat-factory/integrations@0.103.0
  - @cat-factory/agents@0.73.2
  - @cat-factory/gitlab@0.13.16
  - @cat-factory/orchestration@0.149.1
  - @cat-factory/server@0.157.3
  - @cat-factory/node-server@0.122.3
  - @cat-factory/executor-harness@1.60.0

## 0.80.2

### Patch Changes

- Updated dependencies [55747c5]
  - @cat-factory/contracts@0.174.0
  - @cat-factory/orchestration@0.149.0
  - @cat-factory/agents@0.73.1
  - @cat-factory/gitlab@0.13.15
  - @cat-factory/integrations@0.102.2
  - @cat-factory/kernel@0.167.1
  - @cat-factory/server@0.157.2
  - @cat-factory/node-server@0.122.2
  - @cat-factory/executor-harness@1.60.0

## 0.80.1

### Patch Changes

- Updated dependencies [cab85c5]
  - @cat-factory/contracts@0.173.0
  - @cat-factory/agents@0.73.0
  - @cat-factory/kernel@0.167.0
  - @cat-factory/orchestration@0.148.0
  - @cat-factory/server@0.157.1
  - @cat-factory/gitlab@0.13.14
  - @cat-factory/integrations@0.102.1
  - @cat-factory/node-server@0.122.1
  - @cat-factory/executor-harness@1.60.0

## 0.80.0

### Minor Changes

- 8afa4ae: Inbound tracker webhooks: push-driven issue intake, and answering a parked requirements review
  from the ticket.

  Two asymmetries in the task-source layer close together, because they share a transport.

  **1. Intake was pull-only.** An issue entered the system when a recurring `bug-intake` schedule
  fired or a human imported it, so intake latency was the schedule interval and every idle poll cost
  a tracker API call. A new receiver — `POST /webhooks/tasks/:source/:workspaceId` — copies the
  GitHub VCS webhook path step for step: verify HMAC over the RAW body before any parse, ack 202
  fast, hand the parsed event to the facade's queue (a Cloudflare Queue on the Worker ⇄ the pg-boss
  `tracker.sync` queue on Node), and fall back to inline handling when neither is bound.

  **2. The question loop was half-duplex.** `postReviewQuestions` already posted a parked review's
  findings onto the linked issue, each with its stable id — but answers could only arrive in-app or
  over `/api/v1/runs/:runId/decisions`, so a reporter who lives in Jira had to switch surfaces.
  Those ids were designed for exactly this reply path; it is now built. This completes slice 2b of
  `docs/initiatives/headless-clarification-loop.md`.

  **A qualifying issue event FIRES the matching schedule; it does not re-implement intake.** The
  tempting shape — "the event names an issue, so import and link it" — forks a second intake path
  that would drift from `BugIntakeService`'s predicate handling, batched dedup, replace-link, pickup
  mark and block seeding. Instead a pure `issueEventMatchesIntake` predicate decides whether the
  event qualifies for a schedule's `issueIntake` config, and a match calls the same `fire` the cron
  sweeper calls. Consequences, all deliberate: the fired run may pick a **different, older** issue
  than the one that triggered it (intake is oldest-first fair queueing — the webhook drains the queue
  promptly, it does not reorder it); overlap protection is inherited, so a burst of deliveries cannot
  start a second run over a parked one; and the trigger is **non-forced**, so an on-demand schedule is
  never webhook-fired and an individual-usage model still refuses — `force` is the human run-now lever
  and a webhook has no human present. The predicate deliberately **fails open** on a field the payload
  omits: a false positive costs one no-op run, a false negative costs silent intake latency.

  **The recurring schedule is unchanged and stays on** as the reconciliation sweep for missed
  deliveries — the same webhook + sweeper duality as GitHub sync + `sweepStuckRuns`. Push is the fast
  path, never the only path.

  **Ticket replies use an explicit grammar, never natural-language guessing:**

  ```
  @cat-factory answer <itemId> <free text to end of line>
  @cat-factory dismiss <itemId>
  @cat-factory proceed | stop | extra-round
  ```

  Only lines whose first token is the trigger are interpreted, so a human can answer and discuss in
  one comment; an `answer` continues onto following lines until the next trigger. A comment with no
  trigger line is ignored entirely. Every mutation routes through the SAME service methods the SPA
  and `PublicDecisionController` call (`RequirementReviewService.replyToItem` / `setItemStatus`, then
  `executionService.requirementsReview.{incorporate,proceed,resolveExceeded}`), so the park's
  CAS/approval-id arbitration and the task's merge-preset knobs apply identically — there is no
  parallel mutation path into the engine. A reply that leaves nothing open auto-incorporates, and the
  issue gets a follow-up comment naming what was applied, what is still outstanding, and what was
  rejected and why.

  **Configuration is per connection and needs no new table.** The webhook secret rides the
  connection's existing sealed credential bag, managed through
  `GET|POST|PATCH|DELETE /workspaces/:ws/task-sources/:source/webhook` (behind `integrations.manage`)
  and returned exactly once. `POST` mints or rotates; `PATCH` edits the reply allow-list WITHOUT
  rotating, because tightening that list is what an operator does when a tracker turns out to be more
  public than they thought and answering it with a silently rotated secret would take deliveries down
  until they re-pasted it into the vendor. The workspace rides the URL path because a tracker delivery carries no
  installation id to resolve one from, and scanning every workspace's connections for one whose
  secret verifies would be a deployment-wide N+1 on every unauthenticated POST. **An unconfigured
  secret fails closed** — an empty HMAC key is one an attacker also has.

  Reply text is untrusted third-party input, and on a public repo anyone can write it. Three layers:
  the platform's own comments are refused first — by the vendor bot flag where there is one, and by
  a structural marker check everywhere, since Linear flags no bots and the default allow-list admits
  any author (an acknowledgement that could re-enter its own ingest is an unbounded comment loop, not
  a duplicate: each carries a fresh comment id, so the ingest claim cannot stop it). Then the
  connection's optional `webhookReplyAllow` list — an
  unauthorized reply is dropped **silently**, with no follow-up, because replying would confirm the
  hook exists and hand an attacker an oracle. Reply text becomes `item.reply`, the same field the SPA
  writes, capped and `redactSecrets`-scrubbed before it persists; the grammar has no verb reaching
  outside the review. Everything rendered back crosses kernel's `hostMarkdown` boundary, exactly like
  the PR verification report.

  Idempotency is an atomic claim on a new `tracker_comment_ingests` table
  (`(workspace, source, externalId, commentId)`, D1 ⇄ Drizzle), taken **before** anything is applied
  — every tracker redelivers and every queue retries, so without it one reporter comment would answer
  the same finding twice. It copies the `review_question_posts` design verbatim, including its answer
  to "what if the claimer dies": a `failed` row is re-claimable, `applied` is terminal, and a
  `pending` one is re-claimable once abandoned. A claim that ERRORS propagates rather than being read
  as "already ingested" — the apply is idempotent precisely so the queue can retry it, and swallowing
  the error would drop a reporter's answer while reporting a successful dedup. Both stores are pinned
  by a new cross-runtime parity
  suite, alongside conformance assertions that drive the whole receiver → gateway → service chain on
  each facade.

  Providers own their vendor parsing behind a new optional `TaskSourceProvider.webhook` capability
  (Jira, Linear and GitHub Issues ship one), exactly as VCS providers own theirs; a source without it
  never receives deliveries. Design, decisions and the per-slice checklist:
  `docs/initiatives/tracker-webhook-intake.md`.

### Patch Changes

- Updated dependencies [8afa4ae]
  - @cat-factory/contracts@0.172.0
  - @cat-factory/kernel@0.166.0
  - @cat-factory/integrations@0.102.0
  - @cat-factory/orchestration@0.147.0
  - @cat-factory/server@0.157.0
  - @cat-factory/node-server@0.122.0
  - @cat-factory/agents@0.72.3
  - @cat-factory/gitlab@0.13.13
  - @cat-factory/executor-harness@1.60.0

## 0.79.2

### Patch Changes

- Updated dependencies [200fb4d]
  - @cat-factory/kernel@0.165.1
  - @cat-factory/server@0.156.2
  - @cat-factory/agents@0.72.2
  - @cat-factory/gitlab@0.13.12
  - @cat-factory/integrations@0.101.4
  - @cat-factory/orchestration@0.146.2
  - @cat-factory/node-server@0.121.2
  - @cat-factory/executor-harness@1.60.0

## 0.79.1

### Patch Changes

- Updated dependencies [323b6cf]
  - @cat-factory/integrations@0.101.3
  - @cat-factory/orchestration@0.146.1
  - @cat-factory/server@0.156.1
  - @cat-factory/node-server@0.121.1
  - @cat-factory/executor-harness@1.60.0

## 0.79.0

### Minor Changes

- f0e9bab: Public API (`/api/v1`) Tier 2: a new `GET /jobs` list, and bounded keyset pagination + filters on
  the service-task list.

  - **`GET /api/v1/jobs`** (new, `read`-scoped) lists the workspace's headless initiative jobs,
    newest first, with `?limit=` / `?cursor=` / `?status=` / `?since=`. It closes the gap where an
    integration that lost its stored job ids — a restart, a redeploy — could never re-discover its
    own in-flight runs, since `GET /jobs/:id` needs an id it no longer has. Scoped exactly like the
    single-job read: the `internal`-anchor predicate is applied **in SQL** (a join to the anchor
    block), so an external key can never enumerate the workspace's ordinary board runs.
  - **`GET /api/v1/services/:serviceId/tasks`** gains `?limit=` / `?cursor=` / `?status=`. It was
    previously unbounded: it read the ENTIRE board and filtered the service subtree in JS, so a
    large service returned every task in one response and paid a full board read per request. The
    bound, the subtree and the status filter now all live in SQL.

  **Breaking wire change:** `GET /api/v1/services/:serviceId/tasks` now returns **at most 50 tasks
  per response** (previously: all of them) and carries a new required `nextCursor` field. A caller
  that relied on one response containing every task must now page until `nextCursor` is null.
  `GET /api/v1/jobs`'s default page is 25; both accept `?limit=` up to a hard ceiling of 100.

  Pagination is **keyset, not offset** — an external caller polls, so an offset page shifts under
  concurrent inserts and a row created between two pages either repeats or is skipped and never
  seen again. The cursor is opaque on the wire and carries the `(sortKey, id)` composite, so a burst
  of runs sharing a millisecond pages correctly instead of losing the ties. A malformed cursor is a
  `400 invalid_cursor`, never a silent re-serve of page 1.

  Job ordering is chronological (`created_at DESC`). **Task ordering is by the stable block id, not
  chronological**, and there is deliberately no `since` filter on the task list: the `blocks` table
  carries no creation timestamp, so a time filter would have to be faked. See
  `docs/initiatives/public-api-expansion.md` for what adding one would cost.

  Backed by two new repository port methods — `ExecutionRepository.listInternal` and
  `BlockRepository.listServiceTasks` — implemented on **both** the D1 and Drizzle stores and pinned
  by new cross-runtime conformance assertions, so a store that ordered differently, dropped the
  `internal` join, or mishandled the keyset fails a test rather than silently mis-serving an
  integration. Each resolves its scope in ONE query (the `internal` anchor join; the frame's modules
  as a subquery rather than a bound id list, which D1's 100-parameter ceiling would reject on a
  service with ~96 modules).

  Two adjacent fixes the lists depend on:

  - `ExecutionInstance.createdAt` is now projected from the `agent_runs.created_at` COLUMN instead of
    the run's `detail` JSON, and an insert adopts the instance's own stamp. The two used to be
    separate `clock.now()` calls milliseconds apart, so a keyset cursor minted from the entity named
    a position slightly ahead of the row it pointed at — silently skipping any run inserted in that
    window whenever two starts landed in the same millisecond. The redundant `detail.createdAt` is
    gone (stale copies on existing rows are simply ignored, then dropped on the next write).
  - `BoardService.addTask` now enforces the same containment rule `canReparent` applies on a move: a
    task may only be created under a service frame or a module. A task parented to an `epic` /
    `initiative` grouping node was structurally orphaned — invisible to any reader that resolves a
    service subtree, including this task list.

  The `human-test` / `visual-confirmation` gate step-state schemas moved out of
  `contracts/src/execution.ts` into their own `human-verdict-gates.ts` module (re-exported from the
  package root, so no import path changes): merging `main` pushed `execution.ts` past the file-size
  budget, and the two human-verdict gates are the cohesive seam — they share a `rounds` history and a
  transient `pendingAction` that the polling gates' `GateStepState` does not have.

### Patch Changes

- Updated dependencies [0f7cba1]
- Updated dependencies [f0e9bab]
  - @cat-factory/orchestration@0.146.0
  - @cat-factory/contracts@0.171.0
  - @cat-factory/kernel@0.165.0
  - @cat-factory/server@0.156.0
  - @cat-factory/node-server@0.121.0
  - @cat-factory/agents@0.72.1
  - @cat-factory/gitlab@0.13.11
  - @cat-factory/integrations@0.101.2
  - @cat-factory/executor-harness@1.60.0

## 0.78.1

### Patch Changes

- Updated dependencies [45fddb6]
  - @cat-factory/orchestration@0.145.1
  - @cat-factory/server@0.155.1
  - @cat-factory/node-server@0.120.1
  - @cat-factory/executor-harness@1.60.0

## 0.78.0

### Minor Changes

- 640cadd: Judges: a registry seam for deployment-authored rubric evaluators that can block or bounce a run.

  Three engine paths already shared one shape — an LLM produces a structured assessment, the engine
  compares it to a per-task threshold, and the run advances, parks or escalates (requirements
  auto-pass, the `merger`, `on-call`). That latent "verdict gate" family is now promoted into a
  **fourth step-taxonomy bucket**: agents / polling gates / one-shot engine steps / **judges**.

  A judge step runs an LLM assessment of the run's work against a **rubric**, and the engine
  compares the verdict's score to the task's merge preset before disposing: advance, park for a
  human, **bounce** the producing step with the findings as its rework brief, or fail the run.
  Adding one is a registry entry, not a copy of the machinery — the same promise `registerGate`
  makes for polling gates.

  - **`JudgeRegistry`** (`@cat-factory/kernel`, app-owned + empty by default) threaded through
    `CoreDependencies.judgeRegistry` beside `gateRegistry`. A registration supplies only its
    differentiators: the rubric, an optional `parseVerdict`, `threshold`/`attemptBudget` read off
    the preset, `onFail` (`park` / `bounce` / `fail`) and `bounceTargets`.
  - **One generic driver** in the engine owns the state machine, threshold comparison, park,
    bounce budget, persistence and emission. All live state rides `step.judge` — no side table, so
    it is runtime-symmetric by construction.
  - **No per-facade wiring**: the verdict producer is an injectable `JudgeAssessor` whose default
    is built from the model-provider dependencies every facade already wires. An
    absent/disabled assessor makes every judge step a **pass-through**, so existing pipelines are
    byte-for-byte unchanged.
  - Two new merge-preset knobs, `judgeMinScore` (default 0.7) and `judgeMaxBounces` (default 1),
    mirrored D1 ⇄ Drizzle. The built-in presets' seed version bumps to 5, so existing workspaces
    are advised to reseed.
  - A rubric's per-workspace override is an ordinary **prompt-library fragment**
    (`JudgeRubric.fragmentId`), so the feature adds no rubric storage.
  - The verdict is a first-class section of the **PR verification report**, rendered through the
    `hostMarkdown` helpers and scrubbed like every other model-authored field.
  - A parked verdict is answerable from the SPA's new judge window **and** from
    `POST /api/v1/runs/:runId/decisions/judge/resolve` — both call the same service method.

  The `merger` is deliberately NOT rewritten onto this: it owns terminal block status and a real,
  credential-bearing merge, and stays a privileged built-in. See
  `docs/initiatives/judge-registry.md`.

### Patch Changes

- Updated dependencies [583fc80]
- Updated dependencies [640cadd]
  - @cat-factory/orchestration@0.145.0
  - @cat-factory/contracts@0.170.0
  - @cat-factory/kernel@0.164.0
  - @cat-factory/agents@0.72.0
  - @cat-factory/integrations@0.101.1
  - @cat-factory/server@0.155.0
  - @cat-factory/node-server@0.120.0
  - @cat-factory/gitlab@0.13.10
  - @cat-factory/executor-harness@1.60.0

## 0.77.3

### Patch Changes

- 968a214: Bugfix reproduction proof — the harness verification phase (Phase B)

  The container now RUNS the reproduction declaration Phase A threaded to it, so a bugfix run
  carries captured evidence that the defect was real instead of the model's own claim that it was.
  Between the agent settling and the pull request opening, the harness runs the declared check
  against two trees of the same clone and computes the verdict from the exit codes:

  - **`reproduced`** — red on the pre-fix tree, green on the tree the PR opens from. The only shape
    that is proof.
  - **`inconclusive`** — every other shape (green at base ⇒ the check does not demonstrate the
    defect; red at both ⇒ the change does not fix it, or the environment is broken), recorded
    honestly with both captured outputs and a one-line note saying which.

  **Symmetry is the safety property.** A non-zero exit at the base proves nothing on its own — a
  missing toolchain, an uninstalled dependency, or an unrelated pre-existing breakage all produce
  one. Both phases therefore run in freshly-created `git worktree` checkouts with the SAME setup
  command and the byte-identical declared test files (applied path-by-path onto the base tree, never
  a whole-tree checkout, which would drag the fix across and green it). An environmental defect
  fails both and is reported as `inconclusive`, never as proof. Red-for-the-wrong-_reason_ is not
  detected — both outputs ride the report precisely so a human can see why the base was red.

  **A failed verification is a REPAIR, not a run failure.** The captured output goes back to the
  agent — with an explicit rule against weakening the reproduction — while budget remains, and
  exhausting it degrades to `inconclusive` with the PR still opening. Deliberately a different
  disposition from pre-PR validation, which opens nothing: a red check means the WORK is broken; an
  unproven reproduction means the EVIDENCE is weak, which is a reviewer's call. A setup failure
  spends no repair rounds at all, since the agent cannot change a setup command it did not declare.

  Also in this slice:

  - The verdict reaches the engine both LIVE (`RunnerJobView.reproductionReport`, republished with a
    fresh timestamp each round so a failed verification is visible while the loop still runs) and
    terminally, on the success path, the failure path, and through a self-hosted runner pool (a new
    `reproductionReportPath` response-manifest mapping, so a pool-backed run is not left with a
    silently missing section).
  - The proof runs BEFORE the pre-PR validation loop, so validation stays the last thing to touch
    the tree and "only a green checkout opens a PR" is preserved unconditionally.
  - Per-job by construction: the worktree root is a fresh `mkdtemp` and every command, cwd and
    environment arrives as an argument, so two concurrent bugfix runs on the ONE local-native host
    process cannot check out over each other's base trees — which would surface as a false verdict
    on a pull request, not a crash. Pinned by a concurrency test.
  - A declared test file that was never `git add`ed is reported as such (the proof runs against
    committed trees, and the push would miss it too) instead of yielding a verdict computed without
    the reproduction in it.

  What the verdict will and will not claim:

  - **A green pre-fix tree no longer blames the test when the tree is not actually fix-free.** A
    resumed run's pre-fix tree is the work branch as it stood when the pass started — which, after a
    mid-run eviction, already carries that same step's committed partial fix. The check then passes
    there for a reason unrelated to the test, so the proof probes (on a green base only, memoised)
    whether the tree carries non-test work, reports that instead of "your test does not demonstrate
    the defect", and spends no repair round. An unavailable answer degrades to the plain diagnosis.
  - **Declared test paths are refused for git pathspec magic** (`:(glob)`, `*`, `?`, `[…]`) as well
    as traversal, in both the engine's sanitizer and the harness's own. `--` stops a path being read
    as a revision but not as a pathspec, so a glob would apply most of the final tree onto the base
    worktree and green it — turning a good reproduction into a false "the test does not capture the
    defect", from model-authored input.
  - **Two identical failures read as an environment problem, not an ineffective fix**, and two
    timeouts read as a watchdog kill. Neither is evidence for "the change does nothing".
  - **A timed-out tree spends no repair round**, joining setup failures and the prior-work base: in
    all three the agent is not what is wrong, so a round can only add cost.
  - **The phase carries a wall-clock ceiling** (`REPRODUCTION_TOTAL_BUDGET_MS`, 45m) on top of the
    attempt budget. Attempts multiply two full tree runs each, and the phase's own heartbeat
    deliberately stops the job inactivity watchdog from firing, so nothing else bounded it.
    Exceeding it settles `inconclusive` with its own note — a cost limit, never a verdict.
  - **The `repro-test` prompt now states that both runs happen in a fresh checkout** and that
    `setupCommand` is required when the tests need an install or build to run there. Omitting it is
    the most common way the proof ends up proving nothing.

  Both pre-PR verification phases now spawn through one shared `runCapturedCommand` seam (watchdog,
  abort handling, exit-code conventions, scrub-then-bound capture) instead of two near-verbatim
  copies, and the capture keeps a small margin so a secret straddling the rolling cut is still whole
  when it is scrubbed.

  Unconfigured means unchanged: no `reproduction` on the job body ⇒ the harness's existing path,
  byte for byte.

  Runner image bumped to `1.59.0`. The PR-report section that renders this is Phase C.

  Design + phase checklist: `docs/initiatives/bugfix-reproduction-proof.md`.

- Updated dependencies [968a214]
  - @cat-factory/executor-harness@1.60.0
  - @cat-factory/integrations@0.101.0
  - @cat-factory/contracts@0.169.0
  - @cat-factory/server@0.154.0
  - @cat-factory/orchestration@0.144.0
  - @cat-factory/agents@0.71.0
  - @cat-factory/node-server@0.119.3
  - @cat-factory/gitlab@0.13.9
  - @cat-factory/kernel@0.163.1

## 0.77.2

### Patch Changes

- 829a905: Refresh dependencies (direct + transitive) and bump the coding-agent CLIs baked into the
  runner image.

  - **Runner image (`@cat-factory/executor-harness`, image tag `1.57.0`)**: Pi
    `0.80.6 → 0.82.1`, Claude Code `2.1.207 → 2.1.220`, Codex `0.144.1 → 0.145.0`, and the
    two Pi extensions `@juicesharp/rpiv-todo` / `@juicesharp/rpiv-web-tools`
    `1.20.0 → 2.1.0`. The todo extension's v2 tool result keeps the `details.tasks[]` shape
    (`subject` + `pending`/`in_progress`/`completed`/`deleted` status) that
    `parseTodoProgress` reads, so live subtask progress is unaffected. The image pins in
    `deploy/backend` (`package.json` + `wrangler.toml`) and
    `RECOMMENDED_HARNESS_IMAGE` are synced to the new tag.
  - **Workspace dependencies**: refreshed the whole lockfile within the declared ranges, so
    transitive dependencies move up too. Direct bumps include `ai` 7.0.37, `@ai-sdk/*`
    (anthropic 4.0.21, openai 4.0.20, amazon-bedrock 5.0.32), `hono` 4.12.32,
    `@hono/node-server` 2.0.12, `pg-boss` 12.26.3, `undici` 8.9.0, `wrangler` 4.114.0,
    `@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers` 0.18.8,
    `@aws-sdk/client-s3` 3.1095.0, `@playwright/test` 1.62.0 and `turbo` 2.10.7. Every
    version picked is the newest that already satisfies the `minimumReleaseAge` supply-chain
    gate, and the AI-SDK family stays inside the majors that pair with `workers-ai-provider`
    (`ai@^7`, `@ai-sdk/*@^4`). No third-party entries were added to
    `minimumReleaseAgeExclude`. The frontend's `typescript@^6` pin is left alone (Nuxt /
    `vue-tsc` toolchain).

- 829a905: Add Claude Opus 5 support: the `claude-opus` catalog entry rolls forward from Opus 4.8 to
  Opus 5, with its own spend pricing and an updated OpenRouter recommended slug.

  - `@cat-factory/kernel`: `MODEL_CATALOG`'s `claude-opus` entry now resolves to Anthropic's
    **Claude Opus 5** — subscription ref `anthropic:claude-opus-5` (Claude Code harness, 1M
    context, previously left implicit) and OpenRouter ref `anthropic/claude-opus-5`. This
    mirrors how the entry already tracked the current Opus across 4.6 → 4.7 → 4.8, so a block
    pinned to `claude-opus` picks up Opus 5 with no migration. **Breaking (pre-1.0,
    acceptable):** Opus 4.8 is no longer a curated catalog entry — a workspace that wants it
    specifically reaches it through the dynamic per-workspace OpenRouter catalog.
  - `@cat-factory/kernel`: the built-in `mdp_claude` model preset is renamed to "Claude
    Opus 5" and its catalog `version` bumped to `2`, so existing workspaces get the usual
    reseed advisory for the built-in they still hold under the old name.
  - `@cat-factory/spend`: adds `anthropic:claude-opus-5` and
    `openrouter:anthropic/claude-opus-5` price entries at Opus-tier list price ($5 in / $25
    out per 1M, ~4.6 / 23 EUR). The Opus 4.8 entries are kept so historical spend rows and
    OpenRouter passthroughs still cost correctly.
  - `@cat-factory/app`: "Enable recommended" in the OpenRouter catalog panel now offers
    `anthropic/claude-opus-5` instead of `anthropic/claude-opus-4.8`, matching the curated
    backend refs.
  - `@cat-factory/cli` / `@cat-factory/local-server` / `@cat-factory/orchestration`: picker
    label and doc comments follow the catalog ("Claude Opus 5").
  - `@cat-factory/conformance`: the model-preset suite asserts the new `mdp_claude` catalog
    version.

- Updated dependencies [143e6bb]
- Updated dependencies [829a905]
- Updated dependencies [829a905]
  - @cat-factory/orchestration@0.143.1
  - @cat-factory/executor-harness@1.58.0
  - @cat-factory/agents@0.70.1
  - @cat-factory/integrations@0.100.2
  - @cat-factory/kernel@0.163.0
  - @cat-factory/server@0.153.1
  - @cat-factory/node-server@0.119.2
  - @cat-factory/gitlab@0.13.8

## 0.77.1

### Patch Changes

- Updated dependencies [c95600b]
  - @cat-factory/orchestration@0.143.0
  - @cat-factory/contracts@0.168.0
  - @cat-factory/agents@0.70.0
  - @cat-factory/kernel@0.162.0
  - @cat-factory/server@0.153.0
  - @cat-factory/node-server@0.119.1
  - @cat-factory/gitlab@0.13.7
  - @cat-factory/integrations@0.100.1
  - @cat-factory/executor-harness@1.56.0

## 0.77.0

### Minor Changes

- df9ca7d: Merge track record: reviewer-effort tags, deterministic change-class classification, and
  per-class auto-merge rules on merge presets.

  The merge decision no longer runs purely on the `merger` agent's self-assessment. Every merge
  decision now persists one row in a new `merge_track_records` table (full D1 ⇄ Drizzle parity)
  carrying the run's **change class**, the merger's scores, the outcome (`pending_review` →
  `auto_merged` / `human_merged` / `external_merged` / `rejected`), and a nullable **reviewer-effort
  tag** (`none` / `minor` / `major`). Per-class rollups are single SQL aggregates behind
  `GET /workspaces/:ws/merge-track-records/rollups`.

  - **Classification** is deterministic backend TypeScript over ONE VCS call (`RepoFiles.listChangedFiles`
    → the pure `classifyChangedFiles`), so it needs no harness change or runner-image bump and works
    identically on a GitLab deployment. Classes are risk-ranked (`docs` < `test` < `dependency` <
    `config` < `source` < `schema`) and a mixed diff takes the highest-ranked class present. An
    unreadable diff yields `unknown`, which never matches a per-class rule.
  - **Per-class rules** on a merge preset: `always` auto-merge, `never` auto-merge, or fall back to the
    score ceilings — resolved with `autoMergeEnabled: false` as the master switch a rule can never
    override.
  - **Effort capture** at the existing decision points: `POST /notifications/:id/act` takes an optional
    `reviewEffort` (one-tap confirm-and-tag, preselected from whether the run's PR review recorded
    findings), `POST /workspaces/:ws/merge-track-records/:id/effort` tags out of band, and a PR merged
    directly on the provider is detected from the webhook ingest and nudged with a dismissible
    `merge_tag_request` card. Tagging is never mandatory: an untagged merge records a null tag.
  - Classification and record writes are **best-effort side channels** — a failure in any part of this
    feature can never fail or block a merge.

  A merge decision's record carries the run's **provider-neutral repo identity** (`repoId` +
  `provider`), captured from the run-repo resolution the classification already performs. That is what
  makes a record attributable: external-merge detection can only look a record up by
  `(repoId, prNumber)`, since a webhook delivery knows nothing else about the run.

  **BREAKING (backend API):** `RepoTarget` (`@cat-factory/server`) and `RunRepoContext`
  (`@cat-factory/kernel`) gain a required `repoId` plus an optional `provider`, in the neutral
  `VcsRepoRef` vocabulary. Both are produced in exactly one place each, so a deployment that builds
  its own `ResolveRepoTarget` / `ResolveRunRepoContext` must supply the id; the compiler points at
  every site.

  A contract route whose request body is ALL-optional now mounts the new `optionalJsonBody`
  middleware (`@cat-factory/server`). A declared `requestBodySchema` otherwise makes the transport
  REQUIRE a body — the validator reads `c.req.json()` before the schema is consulted — so a route that
  merely gained an optional field would start rejecting the body-less calls it had always accepted.
  `POST /blocks/:blockId/merge` and `POST /notifications/:id/act` keep working with no body at all.

  **BREAKING (wire shape):** `RiskPolicy` gains a required `classRules` field (a partial map from
  change class to `thresholds` / `always` / `never`). Per the pre-1.0 policy there is no dual-read
  shim: persisted rows take the `'{}'` column default, which resolves to "use the score ceilings" for
  every class — i.e. byte-for-byte the previous behaviour — but any external consumer of the preset
  wire shape must account for the new field. The built-in preset seeds bump to version 4, so existing
  workspaces are offered a reseed. `notificationTypeSchema` also gains `merge_tag_request`, and
  `MergeDecision.reason` gains `class_auto_merge` / `class_requires_review`; both are closed unions a
  consumer may be switching on exhaustively.

### Patch Changes

- Updated dependencies [df9ca7d]
  - @cat-factory/contracts@0.167.0
  - @cat-factory/kernel@0.161.0
  - @cat-factory/orchestration@0.142.0
  - @cat-factory/integrations@0.100.0
  - @cat-factory/server@0.152.0
  - @cat-factory/node-server@0.119.0
  - @cat-factory/agents@0.69.10
  - @cat-factory/gitlab@0.13.6
  - @cat-factory/executor-harness@1.56.0

## 0.76.2

### Patch Changes

- 600a8ad: Headless clarification loop: questions out to the linked tracker issue (slice 2a). When a run
  started through `/api/v1` parks its requirements review on open findings, its questions can now
  be posted onto the task's linked GitHub/Jira/Linear issue — each rendered with the stable finding
  id that `POST /api/v1/runs/:runId/decisions/requirements/items/:itemId/reply` takes — so the
  clarification reaches whoever requested the work instead of waiting in an inbox nobody headless
  can see.

  Opt-in per workspace via the new `writebackQuestionsOnPark` tracker setting, with the usual
  per-task `trackerQuestionsOnPark` override; both are exposed in the issue-tracker settings panel
  and the task inspector alongside the existing PR-open/PR-merge writeback toggles. Tasks started in
  the app are deliberately unaffected: the echo fires only for runs whose recorded intake origin is
  `public-api`, and their clarification surface remains the in-app review window.

  The post is driven from the durable execution driver, whose steps replay, so it is made idempotent
  by an atomic claim on a new workspace-scoped `review_question_posts` table keyed by
  `(workspace, review, iteration, issue)` — taken before the comment is attempted, so neither a
  replay nor a crash mid-post can double-post onto an issue a human is reading. A failed post is
  recorded with its error and retried on the next replay rather than being swallowed, and a claim
  abandoned by a poster that died mid-post is re-takeable after `REVIEW_QUESTION_POST_CLAIM_TTL_MS`
  so that iteration's questions are not silently lost. The park is committed before the outbound
  call, so a slow or unavailable tracker can never delay the state change that makes the run
  answerable.

  The comment body is model-authored text landing on a host-parsed (often public) surface, so it is
  rendered through the same untrusted-text boundary as the PR verification report — auto-link
  triggers defused so a finding cannot notify a real account or cross-link an unrelated issue, code
  fences balanced, and secrets scrubbed. That boundary moved from `@cat-factory/orchestration` into
  `@cat-factory/kernel` as the `hostMarkdown` namespace to serve both consumers.

  Breaking (pre-1.0, no migration): `TrackerSettings` gains a required `writebackQuestionsOnPark`
  field and `IssueWritebackProvider` gains a required `postReviewQuestions` method, so a deployment
  with its own implementation of either must add them; `ReviewQuestionPostRepository.claim` takes a
  claim window rather than a bare timestamp; and the `commentOnGitHubIssue` writeback seam must now
  THROW when it cannot resolve the target issue instead of returning quietly (returning is the
  seam's promise that the comment landed). New tables/columns are created by the Cloudflare D1
  migration `0062` and the generated Node Drizzle migration.

- Updated dependencies [600a8ad]
  - @cat-factory/kernel@0.160.0
  - @cat-factory/contracts@0.166.0
  - @cat-factory/integrations@0.99.0
  - @cat-factory/orchestration@0.141.0
  - @cat-factory/server@0.151.0
  - @cat-factory/node-server@0.118.0
  - @cat-factory/agents@0.69.9
  - @cat-factory/gitlab@0.13.5
  - @cat-factory/executor-harness@1.56.0

## 0.76.1

### Patch Changes

- Updated dependencies [3949f82]
  - @cat-factory/contracts@0.165.0
  - @cat-factory/integrations@0.98.0
  - @cat-factory/server@0.150.0
  - @cat-factory/agents@0.69.8
  - @cat-factory/gitlab@0.13.4
  - @cat-factory/kernel@0.159.1
  - @cat-factory/orchestration@0.140.1
  - @cat-factory/node-server@0.117.1
  - @cat-factory/executor-harness@1.56.0

## 0.76.0

### Minor Changes

- 1f8ca48: Let a deployment declare environment-handler seeds so infra handlers are registered programmatically instead of via the SPA.

  A deployment can now pass `seedEnvironmentHandlers` (a list of `RegisterHandlerInput`) to `start()` / `startLocal()`. The server idempotently ensures each seed's `environment_connections` handler exists for **every existing workspace at boot** (a best-effort, fire-and-forget backfill over `workspaceService.list(null)`) and for **each newly-created workspace** (`WorkspaceService.create`), so a service's declared provision type resolves a handler with no manual Infrastructure → Test environments step. Seeding is idempotent (a handler already present for a `(provisionType, manifestId)` is skipped) and per-seed fault-tolerant (a bad seed is logged and skipped, never crashing boot or workspace creation).

  New: the `EnvironmentHandlerSeeder` kernel port, the deployment-neutral `createEnvironmentHandlerSeeder` (`@cat-factory/integrations`), a late-bound `getEnvironmentHandlerSeeder` dependency on `WorkspaceService`, an `environmentHandlerSeeder` handle on the container, and the exported `backfillEnvironmentHandlerSeeds` runtime helper.

### Patch Changes

- Updated dependencies [1f8ca48]
  - @cat-factory/kernel@0.159.0
  - @cat-factory/integrations@0.97.0
  - @cat-factory/orchestration@0.140.0
  - @cat-factory/node-server@0.117.0
  - @cat-factory/agents@0.69.7
  - @cat-factory/gitlab@0.13.3
  - @cat-factory/server@0.149.1
  - @cat-factory/executor-harness@1.56.0

## 0.75.0

### Minor Changes

- 5a58b9d: Pre-PR validation: configurable check commands run in the container before a PR is opened.

  A service frame can now declare validation commands (install / lint / test / build). After the
  coder settles, the executor-harness runs them against the checkout **before** opening a pull
  request; a failure is handed back to the agent with the captured output and the loop retries
  under a per-service attempt budget (default 3). Only a passing checkout opens a PR — an
  exhausted budget fails the step with the last captured output and opens nothing, so broken
  lint/tests never become public PR churn.

  - New per-service config store (`validation_configs`, D1 ⇄ Drizzle) resolved up the frame chain,
    managed via `GET|PUT|DELETE /workspaces/:ws/services/:blockId/validation-checks` and a new
    service-inspector panel.
  - The resolved commands ride the job body (no transport-specific wiring), so this works
    identically on the Cloudflare container, a self-hosted runner pool, and local container/native.
  - Command output is truncated and secret-scrubbed, surfaced live on the step while the repair
    loop runs and persisted on `PipelineStep.validation` for observability.
  - Unconfigured services are unaffected: no commands resolved, no loop, no job-body field.

  BREAKING for self-hosted runner pools only: a pool that wants the LIVE repair-loop view should
  map the new `validationReportPath` in its response manifest (the terminal result envelope is
  forwarded without any manifest change).

  Review follow-ups in this PR:

  - The check loop now feeds the run's inactivity watchdog. `JOB_INACTIVITY_MS` (default 10 min) is
    tighter than a single command's own watchdog (default 15 min), so a legitimately slow
    `install`/`test`/`build` previously aborted the whole run as "inactivity" instead of reporting a
    validation failure.
  - Repair prompts now name any NEW files left un-`git add`ed. The checks run against the working
    tree but only tracked edits are pushed, so an unadded file could take the loop green on work the
    pull request would never contain.
  - Checks resolve from the service frame the engine already walked to, instead of re-deriving it —
    removing two block reads from every agent dispatch.

### Patch Changes

- Updated dependencies [5a58b9d]
  - @cat-factory/executor-harness@1.56.0
  - @cat-factory/contracts@0.164.0
  - @cat-factory/kernel@0.158.0
  - @cat-factory/integrations@0.96.0
  - @cat-factory/orchestration@0.139.0
  - @cat-factory/server@0.149.0
  - @cat-factory/node-server@0.116.0
  - @cat-factory/agents@0.69.6
  - @cat-factory/gitlab@0.13.2

## 0.74.2

### Patch Changes

- 55e0a85: Headless clarification loop over the public API (slice 1). A run started through `/api/v1`
  can now include the requirements-review loop instead of being refused at admission: a new
  `/api/v1/runs/:runId/decisions` surface lists a run's parked human decisions (review findings
  with stable item ids, iteration/cap, the incorporated document; the proposed implementation
  forks) and answers them — reply, dismiss, incorporate, re-review, proceed, resolve-exceeded,
  choose a fork. Every route delegates to the SAME service methods the SPA controllers call, so
  the park's optimistic-concurrency arbitration and the task's merge-preset knobs apply
  identically whichever surface answers first.

  **Breaking:** the public-API scope ladder gains a `decide` rung between `write` and `admin`
  (`read ⊂ write ⊂ decide ⊂ admin`). Answering a parked decision — and starting a headless run
  on a pipeline that can park at all — requires it; a `write` key sees exactly the previous
  behaviour, refusal included. Existing keys keep their stored scope, so a `write` key that
  should now answer decisions must be re-minted as `decide`.

  Also in this slice: `POST /api/v1/jobs/:id/cancel` (an abandoned park can always be cleared,
  so the in-flight cap stays recoverable — there is deliberately no run-killing park timeout);
  a `decision` frame on both public SSE streams, which now stay open across a park; a new
  per-workspace outbound **notification webhook** (`GET|PUT|DELETE
/workspaces/:ws/notification-webhook`) delivered HMAC-signed as a `NotificationChannel`
  alongside in-app and Slack, so a headless caller learns of a park by push rather than
  polling; and `ExecutionInstance.intakeOrigin` (`ui` | `public-api`), recorded so slice 2 can
  push clarification questions to a tracker issue for headless-origin runs only. A UI-started
  task's behaviour is unchanged throughout.

  The webhook endpoint is held to the same SSRF guard as the other operator-supplied-URL
  integrations, at both boundaries: registration rejects a private/internal/cloud-metadata host,
  and delivery goes through the shared `safeFetch` so the guard re-runs on every redirect hop
  (a public endpoint cannot 302 the signed body at an internal target). Two new optional env
  vars, `NOTIFICATION_WEBHOOK_ALLOW_URL_HOSTS` / `NOTIFICATION_WEBHOOK_ALLOW_HTTP_URLS`, widen
  it for a receiver on an internal host or a developer's `localhost`; they are scoped to
  webhooks alone, so they never widen the runner-pool or environment guard. One delivery is
  bounded by a total wall-clock budget rather than an attempt count, because the notification
  fan-out is awaited by the engine step that raises it. The webhook counts as an EXTERNAL
  notification channel, so under mothership mode the mothership — which holds the key its
  signing secret is sealed with — is the side that delivers it.

  Also exported: `assertSafePublicUrl`, the provider-neutral URL guard now shared by the
  environment, runner-pool and notification-webhook integrations (previously an
  environment-labelled private function), so an SSRF bypass is fixed in one place for all of
  them.

  See `docs/initiatives/headless-clarification-loop.md`.

- Updated dependencies [ddcdcd8]
- Updated dependencies [55e0a85]
  - @cat-factory/orchestration@0.138.0
  - @cat-factory/kernel@0.157.0
  - @cat-factory/contracts@0.163.0
  - @cat-factory/integrations@0.95.0
  - @cat-factory/server@0.148.0
  - @cat-factory/node-server@0.115.0
  - @cat-factory/agents@0.69.5
  - @cat-factory/gitlab@0.13.1
  - @cat-factory/executor-harness@1.54.0

## 0.74.1

### Patch Changes

- ecd68c5: PR verification report — the ENGINE now maintains a structured verification report on each
  run's pull request, so a reviewer sees captured facts instead of the agent's own "tests pass"
  prose. It carries the `ci` gate's aggregated verdict (per-check-run names/conclusions +
  `ci-fixer` attempt count), the tester step's structured report, the `deployer` step's
  ephemeral-environment lifecycle (per-frame outcomes + teardown state), the `merger`'s scored
  assessment and the engine's resolved merge decision, run metadata (task, linked tracker issues,
  repo/provider, pipeline, per-step agent kind + resolved model), and a deep link into the run's
  observability panel — as human-readable markdown plus a fenced JSON block validated by the new
  `prVerificationReportSchema`.

  It is written as a marker-delimited region of the PR description and updated **idempotently in
  place**, so a retry or re-run rewrites it instead of appending a second copy, and the agent's own
  description is preserved. Composition happens as each step settles (an engine hook, not a new
  pipeline step), so a run that fails or parks part-way still leaves its evidence on the PR, and a
  section whose producing step didn't run says so explicitly rather than silently vanishing.

  Everything the report interpolates is agent- or human-authored, and a pull-request description is
  a PARSED, potentially PUBLIC surface, so the text boundary is explicit: every free-text field is
  scrubbed with the same `redactSecrets` the telemetry store uses, and every interpolation
  neutralises the host's auto-link triggers (`#123` / `@name` / `!123`, and a closing keyword in
  front of an issue URL — which would otherwise CLOSE that issue when the PR merges), folds
  newlines inside table cells, and balances any code fence the agent left open so the fenced JSON
  block stays extractable. Lists are capped, and what was capped is named in the report's own
  `truncations` log rather than silently shortened.

  New per-workspace setting **`publishPrVerificationReport`** (default on, mirrored D1 ⇄ Drizzle
  with a migration on both runtimes): a workspace that would rather keep its CI verdicts, test
  outcomes and environment URLs off the pull request can decline. Turning it off stops future
  writes; a report already on a PR is left as it is.

  Provider-neutral: it publishes through the facade's ENGINE VCS client, so a GitLab deployment
  gets the report on its merge-request description too. **Breaking for port implementors:**
  `GitHubClient` and `VcsClient` gain a required `getPullRequestBody` method (the read half of the
  read-splice-write upsert), and `PrVerificationReportPublisher` gains a required `resolveTarget`
  (the engine states the repo/provider the ADAPTER resolved, never the run's last dispatch — which
  on a multi-repo task is a peer repo, not the repo whose PR is being written to). Wiring is per facade (Worker ⇄ Node/local) alongside the existing
  merge/mergeability providers; with no VCS client wired the engine behaves exactly as before.
  The SPA gains a narrow boot-time deep-link replay (`?ws=…&block=…&run=…&view=observability`) so
  the report's observability link resolves.

- Updated dependencies [ecd68c5]
  - @cat-factory/contracts@0.162.0
  - @cat-factory/kernel@0.156.0
  - @cat-factory/orchestration@0.137.0
  - @cat-factory/server@0.147.0
  - @cat-factory/gitlab@0.13.0
  - @cat-factory/node-server@0.114.0
  - @cat-factory/agents@0.69.4
  - @cat-factory/integrations@0.94.1
  - @cat-factory/executor-harness@1.54.0

## 0.74.0

### Minor Changes

- 16c98f3: Mothership mode: delegate notification DELIVERY to the mothership.

  A mothership-mode local node persists its notification rows on the mothership but holds none of
  the org's external delivery credentials (the Slack bot token is sealed with the mothership's
  encryption key, which never reaches a laptop), so a `merge_review` / `ci_failed` /
  `release_regression` raised by a local run landed in the inbox and never reached the team's Slack.

  Adds the machine-authed `POST /internal/notifications/deliver`, mounted on BOTH facades behind the
  same audience pin + account scoping as the persistence RPC. The wire carries identifiers only
  (`{ workspaceId, notificationId }`) — the mothership re-reads the row from its own workspace-scoped
  store and delivers THAT, so a node can never inject forged notification text into the org's Slack.
  Each facade wires the new `ServerContainer.machineNotificationDelivery` seam with its EXTERNAL
  channels only; the in-app frame for a laptop-raised notification already arrives over the real-time
  upstream relay, so it is never double-pushed. A deployment with no external channel serves a 503.

  On the consumer side, `composeMothership` builds a `RemoteNotificationChannel` (same base URL +
  per-request machine token as the persistence RPC; a token-less node skips the round-trip) and
  `buildLocalContainer` threads it into `buildNodeContainer`'s new `notificationChannels` option, so
  it composes alongside the local in-app push with no engine change. Delivery stays best-effort: an
  unreachable mothership is logged, never propagated into the state transition that raised the row.

### Patch Changes

- Updated dependencies [16c98f3]
  - @cat-factory/server@0.146.0
  - @cat-factory/node-server@0.113.0
  - @cat-factory/executor-harness@1.54.0

## 0.73.8

### Patch Changes

- 1ffa4fe: Split every product function above 300 lines along cohesive, behaviour-neutral seams so the
  `max-lines-per-function` ratchet reaches step 2 (400 → 300) and `max-lines` drops to its new floor
  (2802 → 2648). The engine's `ExecutionService` constructor now composes its gate windows + review
  subjects through sibling factories (`gate-window-controllers.ts`), `createCore` through
  `container/engine-collaborators.ts` + `container/engine-dependent-modules.ts`, the Node composition
  root through `container-core-deps.ts` + `container-foundation.ts`, the Worker's container assembly
  through an in-file `buildWorkerCoreDependencies`, and six Pinia stores through per-group action
  factories under `stores/{execution,auth,github,initiative,board,workspace}/`, and the Node
  `selectNodeGitHubDeps` selector through the `buildNodeIssueWriteback` +
  `buildNodeGitHubModuleDeps` siblings. No behaviour change.
- Updated dependencies [1ffa4fe]
  - @cat-factory/orchestration@0.136.1
  - @cat-factory/node-server@0.112.1
  - @cat-factory/server@0.145.1
  - @cat-factory/executor-harness@1.54.0

## 0.73.7

### Patch Changes

- 7c6bd77: Per-workspace GitLab PAT connect flow (backend, GitLab UI-parity slice 2a). A hosted
  deployment can now connect a workspace to GitLab by pasting a personal access token: the
  token is validated against the account's identity, sealed at rest (a new `access_token`
  column on `github_installations`, mirrored across D1 + Drizzle), and the workspace's repos
  are browsed / linked / synced through the SAME GitHub-shaped projection surface. A new
  `ProviderRoutingGitHubClient` routes each installation-keyed call to the App or GitLab client
  by the connection's stored provider, so a deployment can serve GitHub App and GitLab PAT
  workspaces side by side. New endpoints: `GET|POST|DELETE /workspaces/:ws/gitlab/connection`
  (503 until GitLab connect is wired). The connect UI is a follow-up slice.
- Updated dependencies [7c6bd77]
  - @cat-factory/kernel@0.155.0
  - @cat-factory/contracts@0.161.0
  - @cat-factory/gitlab@0.12.0
  - @cat-factory/integrations@0.94.0
  - @cat-factory/server@0.145.0
  - @cat-factory/orchestration@0.136.0
  - @cat-factory/node-server@0.112.0
  - @cat-factory/agents@0.69.3
  - @cat-factory/executor-harness@1.54.0

## 0.73.6

### Patch Changes

- Updated dependencies [0e2799e]
- Updated dependencies [696da88]
- Updated dependencies [239788a]
  - @cat-factory/kernel@0.154.2
  - @cat-factory/server@0.144.6
  - @cat-factory/gitlab@0.11.22
  - @cat-factory/integrations@0.93.0
  - @cat-factory/node-server@0.111.6
  - @cat-factory/agents@0.69.2
  - @cat-factory/contracts@0.160.1
  - @cat-factory/orchestration@0.135.5
  - @cat-factory/executor-harness@1.54.0

## 0.73.5

### Patch Changes

- Updated dependencies [770f926]
  - @cat-factory/agents@0.69.1
  - @cat-factory/integrations@0.92.1
  - @cat-factory/kernel@0.154.1
  - @cat-factory/orchestration@0.135.4
  - @cat-factory/server@0.144.5
  - @cat-factory/node-server@0.111.5
  - @cat-factory/gitlab@0.11.21
  - @cat-factory/executor-harness@1.54.0

## 0.73.4

### Patch Changes

- ad4c999: Fix per-job state leaking across concurrent native (`LOCAL_NATIVE_AGENTS`) runs, and stop
  native runs writing into the developer's own home directory.

  Native mode already ran jobs in parallel — one long-lived harness host process starts every job
  immediately, each in its own throwaway clone. But three pieces of per-job state were staged in
  process- or HOME-globals, which are only per-job when the process is. That holds for a container
  and not for the shared native host process, whose `HOME` is the developer's own:

  - **`~/.npmrc` was written, and deleted.** Every agent job configures private-registry auth, and
    a job with no registry entries cleared the file — correct for a reused warm-pool container,
    destructive against the developer's real npm config, on essentially every native run. A native
    job now gets its own npmrc under a per-job directory, pointed at by `npm_config_userconfig` and
    seeded from the developer's file so their registries and proxy still apply. Theirs is never
    written and never removed.
  - **A repo-sourced Claude Skill was installed into `~/.claude/skills/<name>/`.** It outlived the
    run in the developer's personal setup, and two concurrent jobs carrying same-named skills from
    different repos overwrote each other. The native install now happens only into an isolated
    `CLAUDE_CONFIG_DIR`; an ambient run reads the skill from the checkout's `.cat-context/skill/`,
    the same fallback codex always used. The prompt follows: `renderSkillForHarness` now keys off
    ambient auth as well as the harness, so such a run gets the skill's instructions folded in
    rather than a pointer to an install that never happened.
  - **The Tester's secrets were set on `process.env` and restored afterwards.** Two overlapping
    Tester runs in one harness process would read each other's values, and whichever finished
    first would delete the other's mid-run. They now ride explicit child env
    (`RunOptions.agentEnv` → `SubscriptionRunOptions.extraEnv`) merged at spawn, so the agent's
    shell tools still read them as `$KEY` with no shared mutable state.

  Container behaviour is unchanged throughout.

  Two consequences of the npmrc move are handled with it: the stand-up/validation commands the
  HARNESS spawns (rather than the agent) are passed the job env explicitly, so they keep the job's
  registry auth on the native path; and the developer's own credentials, now seeded into the job's
  npmrc, are registered for output redaction alongside the job's. Note `npm_config_userconfig` is
  honoured by npm and pnpm but not yarn, so a yarn checkout on the native path sees only the
  developer's own registries.

- Updated dependencies [ad4c999]
  - @cat-factory/executor-harness@1.54.0
  - @cat-factory/server@0.144.4
  - @cat-factory/node-server@0.111.4

## 0.73.3

### Patch Changes

- Updated dependencies [4ceb622]
  - @cat-factory/orchestration@0.135.3
  - @cat-factory/server@0.144.3
  - @cat-factory/node-server@0.111.3
  - @cat-factory/executor-harness@1.52.2

## 0.73.2

### Patch Changes

- 45f21eb: Lint tightening: ratchet oxlint `max-lines-per-function` (product ceiling) from 632 to 400.

  Split every product function above 400 lines along cohesive, behaviour-neutral seams, clearing
  the entire >400 band. The offenders were the DI composition-root builders and other assembly
  god-functions: the Worker `buildContainer`, `buildNodeContainer`, orchestration `createCore`,
  local `buildLocalContainer`, the Worker `scheduled` cron handler, the server public-API
  `registerTaskRoutes`, and the `pipelines` / `environmentWizard` Pinia store setups. Each was
  carved into a cohesive collaborator (a sibling `container-*`/`stores/*` factory or an in-file
  registrar), following the existing extraction precedents; the two tight-budget composition roots
  (Worker + orchestration `container.ts`) used sibling-file moves so their `check-file-size`
  allowances ratchet down rather than up. The test-glob override (2453) is unchanged.

- Updated dependencies [45f21eb]
  - @cat-factory/orchestration@0.135.2
  - @cat-factory/server@0.144.2
  - @cat-factory/node-server@0.111.2
  - @cat-factory/executor-harness@1.52.2

## 0.73.1

### Patch Changes

- ce1ce11: Cut the pr-reviewer's token burn, and fix slice progress reading 0% for a whole review.

  **Slice progress.** The harness derived progress from tool names the Claude Code CLI no longer
  emits: subagent dispatch is `Agent` (the shipped `sdk-tools.d.ts` has no `TaskInput` at all), and
  the plan arrives as `TaskCreate`/`TaskUpdate` rather than `TodoWrite`. Both matchers missed, so a
  437-turn parallel review reported no slices and no progress. The slice tracker now matches `Agent`
  alongside the legacy `Task`, and a new `progress.ts` reads both plan vocabularies — `TaskCreate`
  needs the tool result too, since the CLI mints the task id there.

  **Token burn.** Measured on a ~450-file review: 437 turns, 39.5M cache-read tokens. Cost is
  turns × context, so anything loaded early is re-paid on every later turn.

  - Agent kinds can now declare `standardsDelivery: 'context-files'`: their resolved best-practice
    standards are NOT folded into the system prompt. `pr-reviewer` takes this and writes them as
    one `.cat-context/standard-<id>.md` file each. Folding charged the parent for every standard on
    every turn (~3.7M tokens) while the slice subagents that actually review the code never received
    them and worked from the parent's paraphrase — so `fragmentAdherence` was rated from a summary
    rather than the standard's text. The reviewer's adherence guidance now points at those files
    (not "folded into this prompt above"), and if the standards preOp couldn't run (GitHub unwired)
    the engine falls back to folding so a review never loses its standards through both channels.
    `composeBlockSystemPrompt`'s delivery argument is now required, so no call site (consensus
    included) can silently re-fold a `context-files` kind's standards. Two standard ids that
    sanitize to the same filename no longer collide (a short id hash disambiguates), so the harness
    can't drop one.
  - `pr-diff.md` now leads with a change-shape rollup and a deterministic suggested slicing
    (`planSlices`, size-capped), and inlines patches only when the whole diff fits one pass. A
    partially-inlined large diff was carried on every turn and bypassed anyway — the slice subagents
    ran 141 git calls and referenced it once.
  - Existing review comments are grouped by file under a path index, so a slice greps its own
    threads instead of the parent reading all of them into context.
  - The reviewer prompt now states the context discipline explicitly (ranged reads, never re-read,
    never dump a whole file, don't read a slice you are about to delegate, keep slices small) and
    tells it to dispatch slice subagents on a cheaper model.

- Updated dependencies [ce1ce11]
  - @cat-factory/executor-harness@1.52.2
  - @cat-factory/agents@0.69.0
  - @cat-factory/server@0.144.1
  - @cat-factory/orchestration@0.135.1
  - @cat-factory/node-server@0.111.1

## 0.73.0

### Minor Changes

- 93496b0: Stream per-call LLM telemetry while a run is in flight, and stop losing the cause of death when a local container dies mid-run.

  A `pr-reviewer` run whose container died 18 minutes in surfaced no slices and no calls — not a subagent-handling regression, but three separate gaps that together made the run unfalsifiable: its telemetry was never written, its container logs were deleted before anyone could read them, and the error it did report described a symptom of the cleanup path rather than the failure.

  - **Per-call telemetry now streams.** The harness buffers each model call as its CLI yields it and drains it on the next poll (`RunnerJobView.callMetrics`, drain-on-read like `spans`/`followUps`); `ContainerAgentExecutor.pollJob` records it immediately. It previously arrived only on the terminal `RunnerJobResult.callMetrics`, so a run that died mid-flight reported ZERO calls no matter how many tokens it had spent — precisely the run worth inspecting. Subagent calls stream too, which matters most: that is where a long review spends its tokens and where the parent stream goes quiet. A call whose tokens are not final yet is the one exception: a CLI that reports only a cumulative total is costed at the end (`attributeCumulativeUsage`), and since a streamed call is already recorded, such a call is withheld until it is complete rather than stored as a zero-token row.

  - **Recording a call twice is now a no-op instead of a duplicate row.** Each metric carries a job-scoped `HarnessCallMetric.seq` stamped by the harness and stable across both channels, so the live drain and the terminal list mint the same `<jobId>-hc-<seq>` id, and `LlmCallMetricRepository.record` ignores an id it already holds (`onConflictDoNothing` on Drizzle, `ON CONFLICT(id) DO NOTHING` on D1 — targeted at the id, so neither store silently swallows a genuinely malformed row). First write wins deliberately — an upsert would recompute a row's stored prompt delta against a chain tip that has since moved on. The executor also skips re-offering a call the live drain already stored, so the terminal write costs one round-trip per NEW call instead of re-walking the whole list. A self-hosted runner pool opts into the live channel with the new `callMetricsPath` response mapping.

  - **A promptless call can no longer break the prompt-delta chain.** `latestChainTip` now ignores rows with `messageCount === 0` (a subagent call carries no re-sendable request transcript). Those interleave with the parent's calls in record order now that telemetry streams live, and a tip that can't be chained onto made every following parent call store its whole prompt instead of a delta — losing the compression the chain exists for on exactly the subagent-heavy runs it matters most for.

  - **An exited container no longer blocks its own replacement (local mode).** `DockerRuntimeAdapter.endpoint()` let `docker port`'s non-zero exit ("no public port '8080/tcp' published for …") escape, but `find()` returns exited containers by design and `resolve()` reads an endpoint-less container as absent. The throw therefore skipped the remove-and-recreate recovery in `dispatchPerRun` and surfaced that CLI line as the run's recorded cause of death. A dead container now resolves to `undefined` per the port contract; a fault against a still-RUNNING container still throws, so the spin-up path keeps its fail-fast diagnostic.

  - **A container that dies mid-run leaves a post-mortem.** The poll now captures the container's exit state (new `ContainerRuntimeAdapter.exitState()`, including whether the runtime OOM-killed it) plus a tail of its own logs onto the failed view's `detail`, and the engine carries that through `recoverContainerEviction` onto the recorded failure. `release()` removes the container as the run settles, so this was the only surviving record of why the harness process went away — and it was being thrown away. Container logs were previously captured only on the spin-up path, never for a container that died after a healthy start. Since a re-dispatch also removes the dead container, the FIRST death's post-mortem is retained on the step (`PipelineStep.firstEvictionDetail`) and folded into the failure alongside the last one — with a crash budget of 1, the first death is usually what explains the run. The text is secret-scrubbed before it is persisted.

  Not addressed here: a PR review's `slices` are still written only when the reviewer job completes, so a killed review still shows none. That is a work-product persistence change, not an observability one.

### Patch Changes

- Updated dependencies [93496b0]
  - @cat-factory/executor-harness@1.52.0
  - @cat-factory/kernel@0.154.0
  - @cat-factory/contracts@0.160.0
  - @cat-factory/orchestration@0.135.0
  - @cat-factory/integrations@0.92.0
  - @cat-factory/server@0.144.0
  - @cat-factory/node-server@0.111.0
  - @cat-factory/agents@0.68.4
  - @cat-factory/gitlab@0.11.20

## 0.72.2

### Patch Changes

- 15249df: Opt-in, per-workspace review-debt friction on task creation.

  When a workspace enables it, authoring a new task is frictioned while finished work sits unreviewed:
  past a soft warn threshold (count of tasks parked on human review) creating a task requires an
  explicit acknowledgement, and in `enforce` mode it is refused outright once too many tasks are in
  review (by count) or one has waited too long (by age). Off by default — zero behaviour change for
  workspaces that don't enable it.

  - **Debt is derived from the existing open-notification signal** — no new "in review" state. A new
    closed `REVIEW_WAIT_NOTIFICATION_TYPES` constant + the pure `assessReviewFriction` verdict live in
    `@cat-factory/contracts`, so the SPA pre-warns with the SAME function the backend enforces with.
  - **Enforced server-side** in `BoardService.addTask` behind optional settings/notifications seams
    (pass-through when unwired or off); a `review_debt_warn` / `review_debt_blocked` 409 drives the
    friction dialog, and an acknowledgement can never tunnel through a hard block.
  - **Four new `workspace_settings` fields** (mode + warn count + two nullable hard-block triggers),
    mirrored across D1 and Drizzle with cross-runtime conformance coverage.
  - **Frontend**: a "Review friction" settings group, the friction dialog (with a "go review" deep
    link), a pre-warn debt badge on the add-task affordance, and copy localized in every locale.

  Full design: `backend/docs/review-debt-friction.md`.

- Updated dependencies [15249df]
  - @cat-factory/contracts@0.159.0
  - @cat-factory/kernel@0.153.0
  - @cat-factory/orchestration@0.134.0
  - @cat-factory/node-server@0.110.0
  - @cat-factory/agents@0.68.3
  - @cat-factory/gitlab@0.11.19
  - @cat-factory/integrations@0.91.2
  - @cat-factory/server@0.143.2
  - @cat-factory/executor-harness@1.50.18

## 0.72.1

### Patch Changes

- 8254367: Lint tightening: ratchet oxlint `complexity` from 40 to its step-2 target of 30.

  Refactored every function above complexity 30 along cohesive, behaviour-neutral seams (helper
  extractions / options-object bundles), including the god-file offenders: the Worker
  `buildContainer` registry resolution → a `container-registries.ts` sibling, `RunDispatcher`'s
  settled-poll branch tree → a new `PollCompletionController`, and `ExecutionService.stepInstance`'s
  re-entrancy predicate → a `reentrancy.logic.ts` sibling (both of which also shrink their host
  god-files). The executor-harness image tag is bumped (harness `src/**` changed).

- Updated dependencies [8254367]
  - @cat-factory/executor-harness@1.50.18
  - @cat-factory/orchestration@0.133.2
  - @cat-factory/integrations@0.91.1
  - @cat-factory/server@0.143.1
  - @cat-factory/agents@0.68.2
  - @cat-factory/node-server@0.109.1

## 0.72.0

### Minor Changes

- 2323df1: Enable/disable + pinned default for the two credential pools (subscription tokens and
  direct-provider API keys).

  A pool can hold several credentials "for the same thing" — several subscription tokens per
  (workspace, vendor), or several API keys per (scope, provider). Previously the only lever was
  delete, and selection was pure usage-aware rotation. Now each credential carries two lifecycle
  flags, editable via a new `PATCH` endpoint (`{ enabled?, isDefault? }`):

  - **Enable / disable** — a disabled credential stays in the pool (still listed and
    re-enablable) but is never leased and no longer makes its vendor/provider "configured", so
    the model picker and pipeline-start guard treat an all-disabled provider as unconfigured.
  - **Pinned default** — one credential per group can be pinned as the preferred one; it is
    leased in preference to usage-aware rotation. At most one default per group (setting one
    clears the prior), and a disabled default is ignored (leasing falls back to rotation among
    the remaining enabled credentials).

  New wire fields `enabled` / `isDefault` on `apiKeySchema` + `vendorCredentialSchema`; new
  `PATCH /workspaces/:ws/vendor-credentials/:id`, `PATCH …/api-keys/:id` (workspace + `/me` +
  account scopes). Persisted as `enabled` / `is_default` columns mirrored across all three stores
  (D1, Drizzle/Postgres, and the local `node:sqlite` credential store), with the lease/list
  queries filtering disabled and ordering the default first. The **LLM Vendors** UI gains a
  default toggle + an enable/disable switch per credential. A new cross-runtime conformance suite
  asserts the enable/disable + default behaviour against every store.

  This is an additive, backwards-compatible schema change: existing credentials read as enabled
  and not-default, so behaviour is unchanged until an operator opts in.

### Patch Changes

- Updated dependencies [2323df1]
  - @cat-factory/contracts@0.158.0
  - @cat-factory/kernel@0.152.0
  - @cat-factory/integrations@0.91.0
  - @cat-factory/server@0.143.0
  - @cat-factory/node-server@0.109.0
  - @cat-factory/agents@0.68.1
  - @cat-factory/gitlab@0.11.18
  - @cat-factory/orchestration@0.133.1
  - @cat-factory/executor-harness@1.50.16

## 0.71.4

### Patch Changes

- Updated dependencies [71bd63f]
  - @cat-factory/contracts@0.157.0
  - @cat-factory/kernel@0.151.0
  - @cat-factory/agents@0.68.0
  - @cat-factory/orchestration@0.133.0
  - @cat-factory/server@0.142.0
  - @cat-factory/integrations@0.90.0
  - @cat-factory/executor-harness@1.50.16
  - @cat-factory/gitlab@0.11.17
  - @cat-factory/node-server@0.108.4

## 0.71.3

### Patch Changes

- Updated dependencies [da0b83b]
  - @cat-factory/executor-harness@1.50.14
  - @cat-factory/agents@0.67.9
  - @cat-factory/orchestration@0.132.3
  - @cat-factory/server@0.141.3
  - @cat-factory/node-server@0.108.3

## 0.71.2

### Patch Changes

- 2cfae1e: Internal refactor (lint complexity/size ratchet — `complexity` 60 → 40): extract cohesive helpers
  from the ten functions above cyclomatic complexity 40 so each lands under the new ceiling, all
  behaviour-neutral. No public API, wire shape, or runtime behaviour changes; verified by the
  server / orchestration / agents unit suites and the node config specs (the cross-runtime
  conformance + worker suites run in CI).

  - `@cat-factory/server`: `buildRegisteredAgentBody` split into `buildCodingAgentBody` /
    `buildExploreAgentBody`; `toRunResult` into `coerceCustomResult` / `mapPushOrPrResult`;
    `ContainerAgentExecutor.pollJob`'s subscription/quota usage feedback moved into
    `recordSubscriptionUsageOnce` / `recordSubscriptionQuotaUsageOnce`; the workspace snapshot
    handler's optional-field spread ladder folded into a `definedFields` helper.
  - `@cat-factory/orchestration`: `AgentContextBuilder.buildContext`'s `block` sub-payload extracted
    into `buildBlockPayload`.
  - `@cat-factory/agents`: `coerceInitiativePlan`'s section loops extracted into
    `coerceInitiativePhases` / `coerceInitiativeItems` / `coerceInitiativeDecisions`.
  - `@cat-factory/node-server`: `buildAuthConfig`'s enablement prelude + fail-fast guards extracted
    into `resolveNodeAuthEnablement`.
  - `@cat-factory/worker`: `loadAuthConfig`'s enablement prelude extracted into `resolveAuthEnablement`.
  - `@cat-factory/executor-harness`: `parseAgentJob` split into `parseAgentOutputSpec` /
    `parseAgentPrSpec` / `assembleAgentJob`. Touches the runner image, so its tag is bumped
    (1.50.11) and the three pins re-synced.
  - `@cat-factory/local-server`: carries the re-synced `RECOMMENDED_HARNESS_IMAGE` pin.

- Updated dependencies [2cfae1e]
  - @cat-factory/server@0.141.2
  - @cat-factory/orchestration@0.132.2
  - @cat-factory/agents@0.67.8
  - @cat-factory/node-server@0.108.2
  - @cat-factory/executor-harness@1.50.12

## 0.71.1

### Patch Changes

- Updated dependencies [3c7d62b]
- Updated dependencies [3c7d62b]
- Updated dependencies [3c7d62b]
  - @cat-factory/contracts@0.156.0
  - @cat-factory/integrations@0.89.0
  - @cat-factory/kernel@0.150.0
  - @cat-factory/agents@0.67.7
  - @cat-factory/gitlab@0.11.16
  - @cat-factory/orchestration@0.132.1
  - @cat-factory/server@0.141.1
  - @cat-factory/node-server@0.108.1
  - @cat-factory/executor-harness@1.50.10

## 0.71.0

### Minor Changes

- 916278b: feat(frontend-extension-mechanism slice B): custom task types — a deployment-registered work
  item (an "incident", "pentest", "compliance-audit") is now a first-class create-task choice +
  card badge, symmetric with custom agent kinds, with zero host edits.

  - **Contracts.** `taskTypeSchema` / `createTaskTypeSchema` widen from a closed picklist to
    `picklist ∪ namespaced` (`<ns>:<name>`) — the shape `presentation.resultView` already uses. The
    result-view-only `NAMESPACED_RESULT_VIEW_ID_PATTERN` is generalized into a shared `primitives.ts`
    atom (`NAMESPACED_ID_PATTERN` / `isNamespacedId` / `namespacedIdSchema`) reused across every
    extension surface. New `customTaskTypeSchema` (+ `taskTypeFieldDescriptorSchema`), a sparse
    `taskTypeFields.custom` bag for descriptor values, and `workspaceSnapshot.customTaskTypes`.
  - **Kernel.** App-owned `TaskTypeRegistry` (`defaultTaskTypeRegistry()`, empty), mirroring
    `AgentKindRegistry`/`PipelineRegistry`; `defaultPipelineIdForTaskType` consults it after the
    built-in map.
  - **Orchestration.** `CoreDependencies.taskTypeRegistry` threaded into `BoardService` + re-exposed
    on `Core`; `validateRegistrations` gains task-type checks (namespaced id, `formPanel`,
    `defaultPipelineId` resolves).
  - **Server + all three facades.** Snapshot projects `customTaskTypes` (shared `WorkspaceController`);
    the Worker / Node / local facades build, install, validate, and re-export the registry (a
    `taskTypeRegistry` option on `createApp`/`start`/`startLocal`).
  - **Frontend (`@cat-factory/app`).** A `taskTypes` slot + a `useTaskTypesStore` (cloning the
    agents-store merge → `taskTypeMeta` read-model); `buildAgentCapabilitiesManifest` generalized to
    one `buildWorkspaceCapabilitiesManifest(kinds, taskTypes)` carrying both slots (agents store's
    `hydrateCustomKinds` → `hydrateCapabilities`). `AddTaskModal` merges custom types into its picker
    and renders their descriptor fields (or a `taskTypeFormPanels`-paired section) into
    `taskTypeFields.custom`; `TaskCard` shows a type badge via `taskTypeMeta` (unregistered
    namespaced types degrade to the `feature` presentation).

  Cross-runtime conformance asserts the backend round-trip on both runtimes; the `deploy/frontend`
  `acme:security` module dogfoods a CODE-shipped `acme:incident` task type end to end (e2e).

### Patch Changes

- Updated dependencies [916278b]
  - @cat-factory/contracts@0.155.0
  - @cat-factory/kernel@0.149.0
  - @cat-factory/orchestration@0.132.0
  - @cat-factory/server@0.141.0
  - @cat-factory/node-server@0.108.0
  - @cat-factory/agents@0.67.6
  - @cat-factory/gitlab@0.11.15
  - @cat-factory/integrations@0.88.18
  - @cat-factory/executor-harness@1.50.10

## 0.70.27

### Patch Changes

- 1bcb223: Internal refactor (lint complexity/size ratchet — `max-lines-per-function` step 1.5, 1000 → 632):
  split the product functions above the new ceiling along cohesive seams, all behaviour-neutral. No
  public API, wire shape, or runtime behaviour changes.

  - `@cat-factory/kernel`: `seedPipelines` split into three module-level catalog builders it composes.
  - `@cat-factory/server`: `publicApiController` / `authController` split into per-route-group registrars
    (mirroring `registerCoreControllers`'s mount groups).
  - `@cat-factory/app`: the `board` Pinia store's write operations extracted into `stores/board/`
    factories (`createBoardMutations` / `createBoardRemoval`) over a shared `BoardWriteContext`.
  - `@cat-factory/node-server`: `buildNodeContainer` split into `assembleNodeCoreDependencies` +
    `projectNodeServerContainer` (the `CoreDependencies` object and the `ServerContainer` projection).
  - `@cat-factory/local-server`: `buildLocalContainer`'s `buildNodeContainer` options extracted into
    `buildLocalNodeOptions`.

- Updated dependencies [1bcb223]
  - @cat-factory/kernel@0.148.5
  - @cat-factory/server@0.140.7
  - @cat-factory/node-server@0.107.26
  - @cat-factory/agents@0.67.5
  - @cat-factory/gitlab@0.11.14
  - @cat-factory/integrations@0.88.17
  - @cat-factory/orchestration@0.131.7
  - @cat-factory/executor-harness@1.50.10

## 0.70.26

### Patch Changes

- Updated dependencies [e86e95b]
  - @cat-factory/orchestration@0.131.6
  - @cat-factory/server@0.140.6
  - @cat-factory/node-server@0.107.25
  - @cat-factory/executor-harness@1.50.10

## 0.70.25

### Patch Changes

- Updated dependencies [91ea6b7]
  - @cat-factory/contracts@0.154.2
  - @cat-factory/kernel@0.148.4
  - @cat-factory/server@0.140.5
  - @cat-factory/orchestration@0.131.5
  - @cat-factory/integrations@0.88.16
  - @cat-factory/agents@0.67.4
  - @cat-factory/gitlab@0.11.13
  - @cat-factory/node-server@0.107.24
  - @cat-factory/executor-harness@1.50.10

## 0.70.24

### Patch Changes

- Updated dependencies [3999941]
  - @cat-factory/executor-harness@1.50.10
  - @cat-factory/kernel@0.148.3
  - @cat-factory/agents@0.67.3
  - @cat-factory/server@0.140.4
  - @cat-factory/gitlab@0.11.12
  - @cat-factory/integrations@0.88.15
  - @cat-factory/orchestration@0.131.4
  - @cat-factory/node-server@0.107.23

## 0.70.23

### Patch Changes

- Updated dependencies [b1d1e2c]
  - @cat-factory/orchestration@0.131.3
  - @cat-factory/agents@0.67.2
  - @cat-factory/server@0.140.3
  - @cat-factory/node-server@0.107.22
  - @cat-factory/executor-harness@1.50.8

## 0.70.22

### Patch Changes

- 021f2a0: Make a parallel-subagent review observable and correctly metered (ADR 0026 D2.1/D3/D4).

  - D2.1: the Claude Code runner now derives slice progress from the parent stream's `Task`
    dispatches + their tool_results (which DO appear there), so a subagent-driven review no
    longer sits at 0% — per-slice progress surfaces without a parent TodoWrite plan.
  - D3: a best-effort watcher tails the CLI's `subagents/*.jsonl` transcripts while the run is
    live, feeding the inactivity heartbeat (so a quiet-but-alive review stops looking wedged)
    and summing each subagent turn's token usage into the run's `usage` + per-call telemetry —
    the subagent cost that was previously invisible.
  - D4: a short cold-start watchdog (`JOB_COLD_START_MS`, default 120s, 0 to disable) records a
    structured diagnostic when a job produces no output early — without killing it — plus a
    one-line assertion that the pre-seeded onboarding keys landed, logged with the CLI version.

- Updated dependencies [021f2a0]
- Updated dependencies [021f2a0]
- Updated dependencies [021f2a0]
  - @cat-factory/executor-harness@1.50.8
  - @cat-factory/contracts@0.154.1
  - @cat-factory/kernel@0.148.2
  - @cat-factory/server@0.140.2
  - @cat-factory/integrations@0.88.14
  - @cat-factory/node-server@0.107.21
  - @cat-factory/agents@0.67.1
  - @cat-factory/gitlab@0.11.11
  - @cat-factory/orchestration@0.131.2

## 0.70.21

### Patch Changes

- 90a0c1b: Namespace local-mode containers per installation (ADR 0026 D5). Every managed job + warm-pool container is now tagged with a stable, secret-derived install id (a Docker `cat-factory.install` label; the Apple `container` name prefix), and the reaper/adopter/enumerations filter strictly on it. A machine running two local installs against one container daemon can no longer adopt, reap, or re-lease a neighbour's container — closing the warm-pool cross-install `HARNESS_SHARED_SECRET` poisoning vector.
- Updated dependencies [90a0c1b]
  - @cat-factory/orchestration@0.131.1
  - @cat-factory/server@0.140.1
  - @cat-factory/node-server@0.107.20
  - @cat-factory/executor-harness@1.50.6

## 0.70.20

### Patch Changes

- Updated dependencies [7e1f841]
  - @cat-factory/executor-harness@1.50.6

## 0.70.19

### Patch Changes

- Updated dependencies [a14fe03]
  - @cat-factory/contracts@0.154.0
  - @cat-factory/agents@0.67.0
  - @cat-factory/orchestration@0.131.0
  - @cat-factory/server@0.140.0
  - @cat-factory/gitlab@0.11.10
  - @cat-factory/integrations@0.88.13
  - @cat-factory/kernel@0.148.1
  - @cat-factory/node-server@0.107.19
  - @cat-factory/executor-harness@1.50.4

## 0.70.18

### Patch Changes

- Updated dependencies [8053837]
  - @cat-factory/orchestration@0.130.0
  - @cat-factory/contracts@0.153.0
  - @cat-factory/kernel@0.148.0
  - @cat-factory/server@0.139.0
  - @cat-factory/gitlab@0.11.9
  - @cat-factory/agents@0.66.7
  - @cat-factory/node-server@0.107.18
  - @cat-factory/integrations@0.88.12
  - @cat-factory/executor-harness@1.50.4

## 0.70.17

### Patch Changes

- Updated dependencies [511076d]
  - @cat-factory/kernel@0.147.3
  - @cat-factory/server@0.138.16
  - @cat-factory/agents@0.66.6
  - @cat-factory/gitlab@0.11.8
  - @cat-factory/integrations@0.88.11
  - @cat-factory/orchestration@0.129.11
  - @cat-factory/node-server@0.107.17
  - @cat-factory/executor-harness@1.50.4

## 0.70.16

### Patch Changes

- Updated dependencies [1614e62]
  - @cat-factory/agents@0.66.5
  - @cat-factory/orchestration@0.129.10
  - @cat-factory/server@0.138.15
  - @cat-factory/node-server@0.107.16
  - @cat-factory/executor-harness@1.50.4

## 0.70.15

### Patch Changes

- Updated dependencies [7f54858]
  - @cat-factory/contracts@0.152.2
  - @cat-factory/kernel@0.147.2
  - @cat-factory/server@0.138.14
  - @cat-factory/orchestration@0.129.9
  - @cat-factory/agents@0.66.4
  - @cat-factory/gitlab@0.11.7
  - @cat-factory/integrations@0.88.10
  - @cat-factory/node-server@0.107.15
  - @cat-factory/executor-harness@1.50.4

## 0.70.14

### Patch Changes

- 26f7c18: Lint ratchet: `max-statements` from its pinned baseline (157) down below 60 (no behavioural
  change).

  Every function above 50 statements is split along a cohesive seam so the `.oxlintrc.json`
  `max-statements` ceiling can drop from 157 to 50. All extractions are behaviour-neutral (moved
  code verbatim into well-named helpers, destructured at the top so the remaining bodies are
  unchanged; verified by the package unit suites and the cross-runtime conformance suites on real
  Postgres/workerd in CI):

  - **`createUiModals`** (`app/stores/ui/modals.ts`, 157): the flat bag of modal refs + open/close
    handlers is grouped into cohesive sub-factories (`createHealthAdvisoryModals`,
    `createDocumentTaskModals`, `createIntegrationPanelModals`, `createSettingsModals`,
    `createInfraModals`, `createAiOnboardingModals`, `createMiscModals`) composed behind the shared
    hub came-from markers; the returned public surface is unchanged.
  - **the LLM proxy handler** (`server/modules/llmProxy/LlmProxyController.ts`, 108): the workers-ai
    ceiling, the in-process dispatch, upstream resolution (local runner vs the DB-backed key pool),
    and the response relay are extracted into `applyWorkersAiCeiling` / `dispatchInProcess` /
    `resolveUpstreamTarget` / `relayUpstream` behind a per-call `ProxyCallContext`.
  - **`registerCoreControllers`** (`server/app.ts`, 77): the controller mounts split into
    `registerRootControllers` / `registerWorkspaceControllers` / `registerWebhookControllers`
    (exact mount order preserved).
  - **`resolveAuxiliaryRepos`** (`server/agents/ContainerAgentExecutor.ts`, 75),
    **`checkEntityCallScope`** (`server/persistence/rpc.ts`, 63), and the screenshot handler
    (`server/modules/artifacts/HarnessArtifactController.ts`, 51) are split along their existing
    seams.
  - **`provisionRecipe`** (`integrations/modules/compose/ComposeEnvironmentProvider.ts`, 94):
    decomposed into `preflightRecipe` / `readRecipeComposeFiles` / `materializeRecipeEnvFiles` /
    `runComposeBuildAndUp` / `runRecipeStepsAndGate` / `resolvePreviewUrl`. `bringUp`
    (`SharedStackService.ts`, 60), `buildKubernetesRecommendation` /
    `detectFrontendConfig` (`environments/*-detect.logic.ts`, 58/52) split similarly.
  - **`buildNodeContainer`** (`node/container.ts`, 63), the stale-run sweeper `tick`
    (`node/execution/pgBossRunner.ts`, 54), `bootServer` (`node/server.ts`, 53), and
    `buildLocalContainer` (`local/container.ts`, 51) extract cohesive sub-builders / sweeper
    closures.
  - **the coder container callbacks** (`executor-harness/src/coding-agent.ts`, 67/63) extract
    `prepareCodingCheckout` / `finalizeCodingRun` / `prepareMultiRepoCheckouts` /
    `pushMultiRepoLegs`. The harness image tag is bumped accordingly.
  - **orchestration**: `createCore` (`container.ts`, 71), the `RunDispatcher` step handlers
    (66/60), `SandboxRunService` (59), and `CompanionController` (56) split along cohesive seams.

- Updated dependencies [26f7c18]
  - @cat-factory/server@0.138.13
  - @cat-factory/orchestration@0.129.8
  - @cat-factory/integrations@0.88.9
  - @cat-factory/node-server@0.107.14
  - @cat-factory/executor-harness@1.50.4

## 0.70.13

### Patch Changes

- e4efb5f: Lint ratchet: `complexity` step 1 (141 → 60; no behavioural change).

  Every function above cyclomatic-complexity 60 is split along a cohesive seam so the
  `.oxlintrc.json` `complexity` ceiling can drop from its pinned baseline (141) to the first
  real step (60). All extractions are behaviour-neutral (verified by the server + orchestration
  unit suites and the node/local config tests; the cross-runtime conformance suites cover the
  `FakeAgentExecutor` + config paths on real Postgres/workerd in CI):

  - **`loadNodeConfig`** (`node/config.ts`, 141): the giant `AppConfig`-assembly function is
    decomposed into cohesive per-section builders (`resolveProviderCaps`, `buildAgentRouting`,
    `buildGithubConfig`, `buildAuthConfig`, `buildEmailConfig`, `buildEnvironmentsConfig`,
    `buildRunnersConfig`, `buildRetentionConfig`, `buildLangfuseConfig`, `buildOtelConfig`,
    `buildExecutionConfig`).
  - **`dispatchPersistenceCall`** (`server/persistence/rpc.ts`, 101): the scope-rule enforcement
    switch is lifted into `checkCallScope`, then split again into `checkEntityCallScope` (the
    block/service/user/owner resolver kinds) + a shared `checkOwnerPairScope`, keeping the two
    switches jointly exhaustive over `ScopeRule`.
  - **`buildJobBody`** (`server/agents/ContainerAgentExecutor.ts`, 75): the multi-repo fan-out /
    conflict-resolver / merger-combined-diff / reference-repo+branch resolution is extracted into
    `resolveAuxiliaryRepos`.
  - **`FakeAgentExecutor.run`** (conformance, 68): the decision/blueprints/spec-writer/companion
    cluster moves into `runProducerKinds`.
  - **`buildNodeContainer`** (`node/container.ts`, 64): the app-owned registry resolution + EKS
    registration moves into `resolveNodeAppRegistries`.
  - **`buildLocalContainer`** (`local/container.ts`, 66): the provider-agnostic PAT/VCS-client/
    repo-origin resolution moves into `resolveLocalVcs`.
  - **`pollAgentJobInner`** (`orchestration/RunDispatcher.ts`, 61): the running-poll fold becomes
    `applyRunningFold` and the gate-helper re-probe becomes `reprobeGateAfterHelper`.

- Updated dependencies [e4efb5f]
  - @cat-factory/server@0.138.12
  - @cat-factory/orchestration@0.129.7
  - @cat-factory/node-server@0.107.13
  - @cat-factory/executor-harness@1.50.2

## 0.70.12

### Patch Changes

- Updated dependencies [6a6c6df]
  - @cat-factory/node-server@0.107.12

## 0.70.11

### Patch Changes

- 972a1bd: Lint ratchet: complete `max-params` (20 → 6, its final target; no behavioural change).

  Refactored every function above the target from a long positional list to a bundled
  argument, walking the `.oxlintrc.json` ceiling down 20 → 10 → 8 → 6:

  - **DI builders → dependency objects:** the Node `buildNodeContainerExecutor`
    (`NodeContainerExecutorDeps`), the Worker `selectAgentExecutor` / `buildContainerExecutor`
    (a shared `WorkerExecutorDeps`), `buildResolveTransport`, and `selectEnvConfigRepairer`.
  - **Loop-invariant step context → one object:** the deployer fan-out (`DeployerFanOut`
    threaded through `advanceDeployerFrames` / `settleDeployerFrame` / `settleDeployerFailure` /
    `completeDeployerStep`), the companion `applyAssessment` grading bundle, the Tester
    `failTester` failure bundle, and the gate `dispatchGateHelper` helper bundle.
  - **`ExecutionService.start(...)` trailing options → `RunStartOptions`** (new
    `runStartOptions.ts`, keeping `ExecutionService.ts` under the `max-lines` ceiling), updated
    at every call site.
  - **Callback / identity bundles:** `GitHubSyncService.syncResource` handlers,
    `RequirementReviewService.runWriterForChunk` (resolved model + grounding),
    `EnvironmentConnectionService.runProviderValidate` repo target, `SkillSourceService.syncSkillDir`
    dir descriptor, and the executor-harness `streamCli` CLI descriptor.

  The executor-harness bump republishes the runner image (its `streamCli` refactor touches
  `src/**`); the three image-tag pins + `RECOMMENDED_HARNESS_IMAGE` are synced to `1.50.1`.

- Updated dependencies [972a1bd]
  - @cat-factory/orchestration@0.129.6
  - @cat-factory/integrations@0.88.8
  - @cat-factory/agents@0.66.3
  - @cat-factory/server@0.138.11
  - @cat-factory/node-server@0.107.11
  - @cat-factory/executor-harness@1.50.2

## 0.70.10

### Patch Changes

- Updated dependencies [492d0a2]
  - @cat-factory/kernel@0.147.1
  - @cat-factory/node-server@0.107.10
  - @cat-factory/integrations@0.88.7
  - @cat-factory/agents@0.66.2
  - @cat-factory/gitlab@0.11.6
  - @cat-factory/orchestration@0.129.5
  - @cat-factory/server@0.138.10
  - @cat-factory/executor-harness@1.50.0

## 0.70.9

### Patch Changes

- Updated dependencies [2d97b16]
  - @cat-factory/orchestration@0.129.4
  - @cat-factory/agents@0.66.1
  - @cat-factory/server@0.138.9
  - @cat-factory/node-server@0.107.9
  - @cat-factory/executor-harness@1.50.0

## 0.70.8

### Patch Changes

- Updated dependencies [8b6fa53]
  - @cat-factory/orchestration@0.129.3
  - @cat-factory/node-server@0.107.8
  - @cat-factory/server@0.138.8
  - @cat-factory/executor-harness@1.50.0

## 0.70.7

### Patch Changes

- Updated dependencies [a10bfdf]
- Updated dependencies [a10bfdf]
  - @cat-factory/server@0.138.7
  - @cat-factory/executor-harness@1.50.0
  - @cat-factory/kernel@0.147.0
  - @cat-factory/agents@0.66.0
  - @cat-factory/orchestration@0.129.2
  - @cat-factory/node-server@0.107.7
  - @cat-factory/gitlab@0.11.5
  - @cat-factory/integrations@0.88.6

## 0.70.6

### Patch Changes

- Updated dependencies [7aab031]
  - @cat-factory/orchestration@0.129.1
  - @cat-factory/agents@0.65.5
  - @cat-factory/server@0.138.6
  - @cat-factory/node-server@0.107.6
  - @cat-factory/executor-harness@1.48.1

## 0.70.5

### Patch Changes

- Updated dependencies [f2b25ba]
  - @cat-factory/orchestration@0.129.0
  - @cat-factory/kernel@0.146.0
  - @cat-factory/contracts@0.152.1
  - @cat-factory/server@0.138.5
  - @cat-factory/node-server@0.107.5
  - @cat-factory/agents@0.65.4
  - @cat-factory/gitlab@0.11.4
  - @cat-factory/integrations@0.88.5
  - @cat-factory/executor-harness@1.48.1

## 0.70.4

### Patch Changes

- Updated dependencies [e679977]
  - @cat-factory/contracts@0.152.0
  - @cat-factory/orchestration@0.128.0
  - @cat-factory/agents@0.65.3
  - @cat-factory/gitlab@0.11.3
  - @cat-factory/integrations@0.88.4
  - @cat-factory/kernel@0.145.1
  - @cat-factory/server@0.138.4
  - @cat-factory/node-server@0.107.4
  - @cat-factory/executor-harness@1.48.1

## 0.70.3

### Patch Changes

- Updated dependencies [9450415]
  - @cat-factory/contracts@0.151.0
  - @cat-factory/kernel@0.145.0
  - @cat-factory/orchestration@0.127.0
  - @cat-factory/agents@0.65.2
  - @cat-factory/gitlab@0.11.2
  - @cat-factory/integrations@0.88.3
  - @cat-factory/server@0.138.3
  - @cat-factory/node-server@0.107.3
  - @cat-factory/executor-harness@1.48.1

## 0.70.2

### Patch Changes

- Updated dependencies [2138e45]
  - @cat-factory/integrations@0.88.2
  - @cat-factory/orchestration@0.126.1
  - @cat-factory/server@0.138.2
  - @cat-factory/node-server@0.107.2
  - @cat-factory/executor-harness@1.48.1

## 0.70.1

### Patch Changes

- Updated dependencies [54c44bb]
  - @cat-factory/contracts@0.150.0
  - @cat-factory/kernel@0.144.0
  - @cat-factory/orchestration@0.126.0
  - @cat-factory/server@0.138.1
  - @cat-factory/node-server@0.107.1
  - @cat-factory/agents@0.65.1
  - @cat-factory/gitlab@0.11.1
  - @cat-factory/integrations@0.88.1
  - @cat-factory/executor-harness@1.48.1

## 0.70.0

### Minor Changes

- 6709dc4: Migrate the last module-global plugin registries to app-owned DI (the registry-DI initiative):
  pipelines, VCS providers, provider tokens, and agent traits now ride the composition root's
  injected instances instead of a process-wide `Map`, removing the `clear*()` test cruft and the
  phantom-`Map` hazard for separately-published adapter packages (e.g. `@cat-factory/gitlab`).

  **Breaking (pre-1.0, no back-compat):** the following free functions are removed in favour of the
  app-owned registry instances a facade injects:

  - **Pipelines** (`@cat-factory/kernel`): `registerPipeline` / `registerPipelines` /
    `registeredPipelines` / `clearRegisteredPipelines` / `mergeRegisteredPipelines` →
    `PipelineRegistry` (`register` / `registerMany` / `registered` / `merge`) + `defaultPipelineRegistry()`.
    `seedPipelines(registry?)` now takes the registry (the no-arg form returns the built-in catalog).
  - **VCS providers** (`@cat-factory/kernel`): `registerVcsProvider` / `getVcsProvider` /
    `resolveVcsProvider` / `requireVcsProvider` / `isVcsProviderRegistered` / `registeredVcsProviders` /
    `clearVcsProviders` → `VcsProviderRegistry` + `defaultVcsRegistry()` (a required `ServerContainer`
    field, so facade parity is type-enforced). `@cat-factory/gitlab`'s `registerGitLab` now takes the
    registry as its first argument.
  - **Provider tokens** (`@cat-factory/kernel`): `wireProvider` / `getProvider` / `isProviderWired` /
    `requireProvider` / `clearProviders` → `ProviderRegistry` + `defaultProviderRegistry()`, read by the
    gate machine's `GateContext` (which gains `isProviderWired`). The `@cat-factory/gates` `wireX` /
    `applyGateProviders` / `warnUnwiredGates` handles take the registry as their first argument;
    `clearGateProviders` is no longer needed by a facade (a fresh registry per build starts empty).
  - **Agent traits** (`@cat-factory/agents`): `registerAgentTrait` / `registerAgentTraits` /
    `registeredAgentTrait` / `clearRegisteredAgentTraits` / `assignAgentTraits` /
    `clearAssignedAgentTraits` are folded onto the app-owned `AgentKindRegistry`
    (`registerTrait` / `registerTraits` / `traitDefinition` / `assignTraits` / `assignedTraitsFor`);
    `traitsFor` / `hasTrait` / `traitGuidanceFor` keep their signatures. `@cat-factory/consensus`'s
    `registerConsensusTraits` now takes the registry as its first argument.

### Patch Changes

- Updated dependencies [009bc97]
- Updated dependencies [0abcf31]
- Updated dependencies [6709dc4]
- Updated dependencies [a53bbf7]
  - @cat-factory/integrations@0.88.0
  - @cat-factory/server@0.138.0
  - @cat-factory/node-server@0.107.0
  - @cat-factory/contracts@0.149.0
  - @cat-factory/kernel@0.143.0
  - @cat-factory/orchestration@0.125.0
  - @cat-factory/agents@0.65.0
  - @cat-factory/gitlab@0.11.0
  - @cat-factory/executor-harness@1.48.1

## 0.69.20

### Patch Changes

- Updated dependencies [4dbf0fc]
  - @cat-factory/orchestration@0.124.2
  - @cat-factory/server@0.137.10
  - @cat-factory/node-server@0.106.11
  - @cat-factory/executor-harness@1.48.1

## 0.69.19

### Patch Changes

- Updated dependencies [5771e05]
  - @cat-factory/kernel@0.142.0
  - @cat-factory/integrations@0.87.0
  - @cat-factory/agents@0.64.2
  - @cat-factory/gitlab@0.10.22
  - @cat-factory/orchestration@0.124.1
  - @cat-factory/server@0.137.9
  - @cat-factory/node-server@0.106.10
  - @cat-factory/executor-harness@1.48.1

## 0.69.18

### Patch Changes

- f34ddf1: Move the **gate** and **step-resolver** registries onto the app-owned DI seam
  (`docs/initiatives/registry-di-migration.md`), the same pattern as the agent-kind /
  backend registries. The two engine-extension registries the `RunDispatcher` reads are no
  longer module-global `Map`s populated by import side effect.

  - **kernel** now exposes `GateRegistry` / `defaultGateRegistry()` and `StepResolverRegistry`
    / `defaultStepResolverRegistry()` classes. The free functions `registerGate` /
    `registeredGateFactories` / `clearRegisteredGates` and `registerStepResolver` /
    `registeredStepResolverFactories` / `clearRegisteredStepResolvers` are **removed**
    (breaking — pre-1.0, no shim). Registration is now `registry.register(kind, factory)` on
    the app-owned instance the composition root injects.
  - **`@cat-factory/gates`** — `registerBuiltinGates(registry)` now takes the app-owned
    `GateRegistry` and the **module-load side-effect registration is gone** (the
    `registerBuiltinGates()` band-aid the registry-DI initiative called out). A new
    `gateRegistryWithBuiltins()` factory returns a fresh registry pre-loaded with the suite in one
    call — the seam a facade uses (`overrides.gateRegistry ?? gateRegistryWithBuiltins()`) so the
    empty-default hazard is unrepresentable; `registerBuiltinGates` stays for installing into an
    already-held instance.
  - **orchestration** threads `gateRegistry` + `stepResolverRegistry` through
    `CoreDependencies` → `ExecutionService` → `RunDispatcher` (defaulted so existing
    construction sites don't break), re-exposes `gateRegistry` on `Core`, and
    `validateRegistrations` now takes the gate registry to cross-check.
  - The three **facades** build the registries, install the built-in gates, and inject the
    same instance into `createCore` + the boot-time validation — kept symmetric and covered by
    the cross-runtime conformance suite (the custom-gate + step-resolver assertions now inject
    the registries via `makeApp`).

  Provider tokens and the pipeline registry remain module-global (the next slices of the
  initiative). Deployment packages that registered gates/resolvers via the free functions must
  switch to registering by reference on the injected instances (see
  `@cat-factory/example-custom-agent`'s `registerExampleCustomAgents`).

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0
  - @cat-factory/orchestration@0.124.0
  - @cat-factory/node-server@0.106.9
  - @cat-factory/agents@0.64.1
  - @cat-factory/gitlab@0.10.21
  - @cat-factory/integrations@0.86.6
  - @cat-factory/server@0.137.8
  - @cat-factory/executor-harness@1.48.1

## 0.69.17

### Patch Changes

- Updated dependencies [37c642f]
  - @cat-factory/agents@0.64.0
  - @cat-factory/server@0.137.7
  - @cat-factory/orchestration@0.123.8
  - @cat-factory/node-server@0.106.8
  - @cat-factory/executor-harness@1.48.1

## 0.69.16

### Patch Changes

- Updated dependencies [ea64461]
  - @cat-factory/agents@0.63.0
  - @cat-factory/server@0.137.6
  - @cat-factory/orchestration@0.123.7
  - @cat-factory/node-server@0.106.7
  - @cat-factory/executor-harness@1.48.1

## 0.69.15

### Patch Changes

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1
  - @cat-factory/integrations@0.86.5
  - @cat-factory/orchestration@0.123.6
  - @cat-factory/server@0.137.5
  - @cat-factory/node-server@0.106.6
  - @cat-factory/agents@0.62.13
  - @cat-factory/gitlab@0.10.20
  - @cat-factory/executor-harness@1.48.1

## 0.69.14

### Patch Changes

- Updated dependencies [edfd2f8]
- Updated dependencies [d675cc5]
  - @cat-factory/orchestration@0.123.5
  - @cat-factory/server@0.137.4
  - @cat-factory/node-server@0.106.5
  - @cat-factory/executor-harness@1.48.1

## 0.69.13

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0
  - @cat-factory/orchestration@0.123.4
  - @cat-factory/contracts@0.148.1
  - @cat-factory/agents@0.62.12
  - @cat-factory/gitlab@0.10.19
  - @cat-factory/integrations@0.86.4
  - @cat-factory/server@0.137.3
  - @cat-factory/node-server@0.106.4
  - @cat-factory/executor-harness@1.48.1

## 0.69.12

### Patch Changes

- efa3345: chore(deps): in-range dependency sweep + transitive upgrade and dedupe

  Update all dependencies within their existing semver ranges across the
  workspace (including the harness packages), run a transitive upgrade and
  `pnpm dedupe`, and re-adopt `@modular-vue/journeys@1.2.0` now that its neutral
  engine (`@modular-frontend/journeys-engine@1.8.0`) is published.

  - The Vercel AI SDK stays on `ai@6` / `@ai-sdk/*@3`: the newest
    `workers-ai-provider` (3.3.1) still peer-requires `ai@^6`, so a v7 bump
    remains blocked (moves within the pinned majors only).
  - `@modular-frontend/core` is pinned to a single `0.3.0` via a pnpm override:
    the 1.8.0 journeys engine hard-depends on `0.3.0` while the sibling
    `@modular-vue/*` bindings still range `^0.2.0`, which otherwise bundles two
    copies and splits the `JourneyRuntime` type. 0.3.0 is a strict superset
    (adds `discard`). Drop the override once the bindings widen their peer range.
  - `@cat-factory/executor-harness` runtime deps (`hono`, `@hono/node-server`)
    moved within range, so the runner-image tag is bumped and the three pins are
    re-synced (image publish/deploy is a maintainer follow-up).

- Updated dependencies [efa3345]
  - @cat-factory/agents@0.62.11
  - @cat-factory/executor-harness@1.48.1
  - @cat-factory/integrations@0.86.3
  - @cat-factory/kernel@0.139.3
  - @cat-factory/node-server@0.106.3
  - @cat-factory/orchestration@0.123.3
  - @cat-factory/server@0.137.2
  - @cat-factory/gitlab@0.10.18

## 0.69.11

### Patch Changes

- Updated dependencies [1f5f5bc]
  - @cat-factory/contracts@0.148.0
  - @cat-factory/orchestration@0.123.2
  - @cat-factory/agents@0.62.10
  - @cat-factory/gitlab@0.10.17
  - @cat-factory/integrations@0.86.2
  - @cat-factory/kernel@0.139.2
  - @cat-factory/server@0.137.1
  - @cat-factory/node-server@0.106.2
  - @cat-factory/executor-harness@1.47.0

## 0.69.10

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/server@0.137.0
  - @cat-factory/contracts@0.147.1
  - @cat-factory/kernel@0.139.1
  - @cat-factory/integrations@0.86.1
  - @cat-factory/node-server@0.106.1
  - @cat-factory/executor-harness@1.47.0
  - @cat-factory/agents@0.62.9
  - @cat-factory/gitlab@0.10.16
  - @cat-factory/orchestration@0.123.1

## 0.69.9

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/contracts@0.147.0
  - @cat-factory/kernel@0.139.0
  - @cat-factory/orchestration@0.123.0
  - @cat-factory/integrations@0.86.0
  - @cat-factory/server@0.136.0
  - @cat-factory/node-server@0.106.0
  - @cat-factory/agents@0.62.8
  - @cat-factory/gitlab@0.10.15
  - @cat-factory/executor-harness@1.47.0

## 0.69.8

### Patch Changes

- Updated dependencies [60c0a1e]
- Updated dependencies [f444062]
  - @cat-factory/contracts@0.146.0
  - @cat-factory/orchestration@0.122.0
  - @cat-factory/integrations@0.85.4
  - @cat-factory/server@0.135.0
  - @cat-factory/agents@0.62.7
  - @cat-factory/gitlab@0.10.14
  - @cat-factory/kernel@0.138.1
  - @cat-factory/node-server@0.105.1
  - @cat-factory/executor-harness@1.47.0

## 0.69.7

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/contracts@0.145.0
  - @cat-factory/orchestration@0.121.0
  - @cat-factory/server@0.134.0
  - @cat-factory/kernel@0.138.0
  - @cat-factory/node-server@0.105.0
  - @cat-factory/agents@0.62.6
  - @cat-factory/gitlab@0.10.13
  - @cat-factory/integrations@0.85.3
  - @cat-factory/executor-harness@1.47.0

## 0.69.6

### Patch Changes

- Updated dependencies [5924903]
  - @cat-factory/contracts@0.144.0
  - @cat-factory/server@0.133.0
  - @cat-factory/node-server@0.104.0
  - @cat-factory/agents@0.62.5
  - @cat-factory/gitlab@0.10.12
  - @cat-factory/integrations@0.85.2
  - @cat-factory/kernel@0.137.1
  - @cat-factory/orchestration@0.120.2
  - @cat-factory/executor-harness@1.47.0

## 0.69.5

### Patch Changes

- 74c21ab: feat: repo-sourced Claude Skills — freshness automation (slice 4)

  Keep a running pipeline from ever executing a stale skill, without the management
  surface having to resync by hand (docs/initiatives/repo-skills.md, final slice):

  - **Push-webhook fan-out.** A verified `push` webhook to a repo that skill sources are
    linked to now enqueues a targeted `skill-source-resync` job per affected source, so its
    skills are refreshed shortly after the upstream change. One indexed
    `SkillSourceRepository.listByRepo(owner, name)` lookup (new port method, D1 ⇄ Drizzle
    with a conformance assertion; the `skill_sources(repo_owner, repo_name)` index was
    already in place) drives the fan-out; the enqueue rides the existing GitHub-sync queue
    through a new `GitHubWebhookIngest.queueSkillResync` seam (Cloudflare Queue ⇄ Node
    pg-boss), and the async consumer runs `SkillSourceService.sync` for the one source
    (a source unlinked between enqueue and processing is swallowed, not retried forever).
  - **Dispatch-time self-verifying probe.** At skill-step dispatch, `SkillRunResolver` now
    probes the source dir's head commit; if it advanced since the last sync it re-syncs so
    the run uses current instructions. It never fails the run — any probe/re-sync error
    degrades to the last-synced record (a run may be at most one push behind, never broken),
    and it's a no-op on the common unchanged path (one `latestCommitSha` read).

  Together with the push fan-out this is the layered freshness story: the webhook keeps the
  account catalog warm, and the dispatch probe is the correctness backstop for deployments
  with no sync queue (local/dev) or a missed delivery. Backend-only; no harness/image change.

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0
  - @cat-factory/server@0.132.0
  - @cat-factory/agents@0.62.4
  - @cat-factory/integrations@0.85.1
  - @cat-factory/orchestration@0.120.1
  - @cat-factory/node-server@0.103.1
  - @cat-factory/gitlab@0.10.11
  - @cat-factory/executor-harness@1.47.0

## 0.69.4

### Patch Changes

- Updated dependencies [27f0ea2]
  - @cat-factory/orchestration@0.120.0
  - @cat-factory/server@0.131.0
  - @cat-factory/node-server@0.103.0
  - @cat-factory/executor-harness@1.47.0

## 0.69.3

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/contracts@0.143.0
  - @cat-factory/kernel@0.136.0
  - @cat-factory/integrations@0.85.0
  - @cat-factory/server@0.130.0
  - @cat-factory/node-server@0.102.0
  - @cat-factory/orchestration@0.119.0
  - @cat-factory/agents@0.62.3
  - @cat-factory/gitlab@0.10.10
  - @cat-factory/executor-harness@1.47.0

## 0.69.2

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0
  - @cat-factory/contracts@0.142.0
  - @cat-factory/orchestration@0.118.0
  - @cat-factory/node-server@0.101.0
  - @cat-factory/agents@0.62.2
  - @cat-factory/gitlab@0.10.9
  - @cat-factory/integrations@0.84.12
  - @cat-factory/server@0.129.2
  - @cat-factory/executor-harness@1.47.0

## 0.69.1

### Patch Changes

- Updated dependencies [e618bf5]
  - @cat-factory/contracts@0.141.0
  - @cat-factory/server@0.129.1
  - @cat-factory/agents@0.62.1
  - @cat-factory/gitlab@0.10.8
  - @cat-factory/integrations@0.84.11
  - @cat-factory/kernel@0.134.1
  - @cat-factory/orchestration@0.117.1
  - @cat-factory/node-server@0.100.1
  - @cat-factory/executor-harness@1.47.0

## 0.69.0

### Minor Changes

- be6e109: Workspace RBAC (slice 3): resolve effective workspace access in the shared auth gate.

  `mountAuthGate` now resolves a signed-in caller's effective workspace role once (via the
  new `loadWorkspaceAccess` helper over the kernel `resolveWorkspaceAccess` decision) and
  publishes it on the request context as `workspaceAccess`. A denied board returns the
  existing 404 shape (existence is never leaked); a resolved-but-insufficient write hits the
  **viewer write floor** — any non-GET method requires at least `member`, with the read-only
  `POST /workspaces/:ws/events/ticket` mint allowlisted — returning `403 forbidden`. The
  account-admin escape hatch and the legacy owner-only board are preserved byte-for-byte.

  `WorkspaceVisibility` is extended (unrestricted account boards, an admin-account escape
  hatch, an explicit-membership branch, and legacy-owned boards) and enforced SQL-side in
  both the D1 and Drizzle `listVisible`; `AccountService.accessibleAccountScopes` derives the
  member/admin account sets from the single existing membership read. `GET /workspaces`
  annotates each board with the caller's effective `viewerRole` via one batched member-row
  read, and the board snapshot (GET + create) carries the resolved `access` (role +
  permissions). `WorkspaceService.create` auto-enrolls the creator as a workspace admin. The
  `workspace_members` repository is now wired into both runtime facades' containers. Cross-
  runtime conformance asserts the 404 invisibility, the viewer floor + ticket allowlist, the
  escape hatch, and list filtering over the real HTTP gate on both D1 and Postgres.

### Patch Changes

- 32a0720: feat: repo-sourced Claude Skills — executable pipeline step (slice 2)

  Make a synced repo-sourced Claude Skill runnable as a pipeline step
  (docs/initiatives/repo-skills.md):

  - **One generic `skill` agent kind** (`container-coding`, `noChangesTolerated`,
    `pr-or-work` clone), parametrized per step by a new `stepOptions.skillId` — not a
    dynamic kind per skill. Pipeline save (and run-start re-validation) rejects a `skill`
    step that names no skill.
  - **`SkillRunResolver`** resolves the picked skill at dispatch: the persisted
    instructions from the account catalog plus the sibling resource bodies fetched at the
    skill's immutable pinned commit (per-file + total caps; oversized/binary files are
    referenced by repo path instead). The run never depends on a live GitHub fetch — a
    fetch failure degrades a resource to a path reference rather than failing the run.
    Wired into the engine as `skillResolver` in `AgentContextBuilder` (a skill step
    dispatched with the library unconfigured fails loudly rather than running blank), and
    the run step is pinned with `skillVersion: { skillId, commit, sha }`.
  - **Harness-aware rendering** in `ContainerAgentExecutor`: the resolved skill travels as
    a dedicated top-level `skill` job-body field (never a context file). The
    executor-harness materialises it natively into `CLAUDE_CONFIG_DIR/skills/<name>/` for
    the claude-code subscription harness (so the CLI loads it), and under
    `.cat-context/skill/` for the Pi/codex harnesses (whose prompt carries the folded-in
    instructions).
  - Bumps `@cat-factory/executor-harness` (native claude-code skills write) and the pinned
    runner image tag in the Node/local facades.

- 54e117e: GitLab UI parity (pre-slice): carry a `provider` VCS discriminator on the repo/connection
  projection.

  The GitLab-parity SPA work (provider-aware labels, icons, host/URL shapes) needs a
  `provider: VcsProvider` (`'github' | 'gitlab'`) it can read off the data. This adds that
  field to the `GitHubRepo` / `GitHubConnection` / `GitHubAvailableRepo` wire types and the
  kernel `GitHubInstallation`, and persists it symmetrically on both runtimes' projection
  tables (D1 migration `0051_vcs_provider.sql` + a Drizzle migration + both sets of mappers).
  The tables keep their GitHub names — the entity-rename fold is separate, acknowledged Phase-1
  work.

  `provider` is a per-connection fact: a connection records it (`GitHubInstallationService.connect`
  → `'github'`; local mode's `AutoProvisioningInstallationRepository` → the deployment's provider,
  `'gitlab'` for a GitLab-PAT deployment), and the repos reached through it inherit it (the sync
  service stamps `installation.provider`, the bootstrapper and CLI `linkRepo` stamp their own).
  Rows written before the column default to `'github'`. A cross-runtime conformance suite
  (`defineVcsProviderSuite`) asserts the round-trip on both stores. No SPA behaviour changes yet;
  this unblocks the presentation-switch slices.

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/contracts@0.140.0
  - @cat-factory/kernel@0.134.0
  - @cat-factory/agents@0.62.0
  - @cat-factory/orchestration@0.117.0
  - @cat-factory/server@0.129.0
  - @cat-factory/executor-harness@1.47.0
  - @cat-factory/integrations@0.84.10
  - @cat-factory/node-server@0.100.0
  - @cat-factory/gitlab@0.10.7

## 0.68.7

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0
  - @cat-factory/contracts@0.139.0
  - @cat-factory/orchestration@0.116.0
  - @cat-factory/server@0.128.0
  - @cat-factory/node-server@0.99.0
  - @cat-factory/agents@0.61.2
  - @cat-factory/gitlab@0.10.6
  - @cat-factory/integrations@0.84.9
  - @cat-factory/executor-harness@1.45.0

## 0.68.6

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/contracts@0.138.0
  - @cat-factory/kernel@0.132.0
  - @cat-factory/server@0.127.1
  - @cat-factory/node-server@0.98.1
  - @cat-factory/agents@0.61.1
  - @cat-factory/gitlab@0.10.5
  - @cat-factory/integrations@0.84.8
  - @cat-factory/orchestration@0.115.1
  - @cat-factory/executor-harness@1.45.0

## 0.68.5

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/kernel@0.131.0
  - @cat-factory/contracts@0.137.0
  - @cat-factory/agents@0.61.0
  - @cat-factory/orchestration@0.115.0
  - @cat-factory/server@0.127.0
  - @cat-factory/node-server@0.98.0
  - @cat-factory/gitlab@0.10.4
  - @cat-factory/integrations@0.84.7
  - @cat-factory/executor-harness@1.45.0

## 0.68.4

### Patch Changes

- 1869ad3: Add a "Ralph loop" task type: a persistent retry-until-done coding loop whose exit condition is
  a programmatic validation command the harness runs against the checkout (exit 0 = done), bounded
  by a per-task iteration budget and surviving restarts.

  Each iteration is a fresh-context container-coding run that works the task spec; the harness then
  runs the task's configured `ralph.validationCommand` (bounded timeout, redacted output tail) and
  reports the verdict on the run result — never a model self-report. The engine (`RalphController` +
  a `ralph-verdict` step-completion interceptor, modelled on the Tester→Fixer loop) re-dispatches a
  fresh iteration on a failing verdict until it passes or the `ralph.maxIterations` budget (default 10) is spent, then hands off to a human. Loop state rides the persisted `step.ralph` (no
  migration), so a mid-loop run is re-driven from where it was by both durable drivers + sweepers.

  - New `ralph` agent kind (the reusable loop-body primitive) + the `pl_ralph` pipeline
    (`ralph → conflicts → ci → merger`) + a `ralph` task type (a one-click creation entry point).
  - The validation command + iteration budget are per-task agent config; `AgentConfigDescriptor`
    gained `text`/`number` control types for them.
  - Cross-runtime conformance coverage (loop completes / exhausts / refuses to start unconfigured)
    and pure-logic unit tests.

  Breaking: none (pre-1.0; `taskType` / `step.ralph` / the descriptor types are additive). The
  executor-harness image is bumped for the new in-container validation capability.

- Updated dependencies [1869ad3]
  - @cat-factory/contracts@0.136.0
  - @cat-factory/kernel@0.130.0
  - @cat-factory/agents@0.60.0
  - @cat-factory/server@0.126.0
  - @cat-factory/orchestration@0.114.0
  - @cat-factory/executor-harness@1.45.0
  - @cat-factory/gitlab@0.10.3
  - @cat-factory/integrations@0.84.6
  - @cat-factory/node-server@0.97.4

## 0.68.3

### Patch Changes

- Updated dependencies [06a094a]
  - @cat-factory/contracts@0.135.0
  - @cat-factory/server@0.125.0
  - @cat-factory/agents@0.59.2
  - @cat-factory/gitlab@0.10.2
  - @cat-factory/integrations@0.84.5
  - @cat-factory/kernel@0.129.2
  - @cat-factory/orchestration@0.113.2
  - @cat-factory/node-server@0.97.3
  - @cat-factory/executor-harness@1.43.8

## 0.68.2

### Patch Changes

- Updated dependencies [6dc444e]
  - @cat-factory/server@0.124.0
  - @cat-factory/node-server@0.97.2
  - @cat-factory/executor-harness@1.43.8

## 0.68.1

### Patch Changes

- Updated dependencies [bd0a42a]
  - @cat-factory/server@0.123.1
  - @cat-factory/executor-harness@1.43.8
  - @cat-factory/node-server@0.97.1

## 0.68.0

### Minor Changes

- 745de02: feat(mothership): real-time upstream publish (the outbound half of PR 2's real-time both directions)

  A mothership-mode local node runs the engine on the laptop but delegates org/durable state to the
  mothership. Until now its engine events (a run advancing, a board change, a notification) never
  reached the mothership's real-time fan-out, so a hosted teammate watching the same shared board
  couldn't see the local node's activity live. This adds the upstream channel.

  - `@cat-factory/server`: a new machine-authed `POST /internal/events/publish` endpoint
    (`eventsRelayController`) + the `MachineEventRelay` seam on `ServerContainer` + the
    `HttpMachineEventClient`. Mounted on both facades; account-scoped and default-deny exactly like
    the persistence RPC (a workspace outside the token's scope is a uniform 404). The verbatim-forwarded
    payload is size-capped (413 above the ceiling) so a compromised node can't inject an unbounded frame.
  - `@cat-factory/node-server`: `LocalMachineEventRelay` delivers a relayed event into the facade's
    own real-time sink (the hub / layered propagator); attached whenever a realtime sink is wired.
  - `@cat-factory/worker`: `DurableObjectMachineEventRelay` delivers a relayed event into the
    per-workspace `WorkspaceEventsHub` Durable Object — the symmetric Cloudflare side.
  - `@cat-factory/local-server`: `MothershipWebSocketPropagator` (a `WebSocketPropagator` adapter,
    reusing the existing cross-node seam) forwards the local node's engine events upstream; it is
    layered over the hub in mothership mode so every event fans to the laptop's own SPA AND the
    mothership.

  Scope: this is the OUTBOUND direction only. The INBOUND subscribe leg (the local node receiving org
  events raised on the mothership / by peer laptops) is a distinct, runtime-shaped follow-up — see
  `docs/initiatives/mothership-mode.md`.

### Patch Changes

- Updated dependencies [745de02]
- Updated dependencies [6108525]
- Updated dependencies [6108525]
  - @cat-factory/server@0.123.0
  - @cat-factory/node-server@0.97.0
  - @cat-factory/orchestration@0.113.1
  - @cat-factory/kernel@0.129.1
  - @cat-factory/executor-harness@1.43.8
  - @cat-factory/agents@0.59.1
  - @cat-factory/gitlab@0.10.1
  - @cat-factory/integrations@0.84.4

## 0.67.7

### Patch Changes

- Updated dependencies [6227908]
  - @cat-factory/node-server@0.96.1

## 0.67.6

### Patch Changes

- bc77cac: Bump the container-harness build toolchains to TypeScript 7.

  The executor-harness and deploy-harness were the last packages still building on
  TypeScript 6 (`^6.0.3`), and their Docker build stages compiled `dist/` with an even
  older standalone `typescript@^5.6.0` / `@types/node@^22.0.0`. Both are now aligned with
  the rest of the monorepo: the package `devDependency` moves to `7.0.2` and each
  Dockerfile build stage to `typescript@^7.0.0` / `@types/node@^26.0.0` (matching the
  runtime `node:26` base), so the published images are actually compiled on TS 7 rather
  than only local dev. The other harness deps (`hono`, `@hono/node-server`, `@types/node`,
  `vitest`) were already on the repo-consistent latest ranges.

  Editing the harness `package.json` + `Dockerfile` re-tags the runner images, so
  `@cat-factory/executor-harness` bumps 1.43.6 -> 1.43.7, `@cat-factory/deploy-harness`
  0.2.6 -> 0.2.7, and all six image-tag pins are synced to match: the
  `deploy/backend/{package.json,wrangler.toml}` refs plus `RECOMMENDED_HARNESS_IMAGE` and
  `RECOMMENDED_DEPLOY_IMAGE` in `@cat-factory/local-server`. The lockfile was also deduped
  to drop redundant duplicate entries.

- Updated dependencies [bc77cac]
- Updated dependencies [1b90387]
  - @cat-factory/executor-harness@1.43.8
  - @cat-factory/server@0.122.0
  - @cat-factory/node-server@0.96.0

## 0.67.5

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/agents@0.59.0
  - @cat-factory/kernel@0.129.0
  - @cat-factory/contracts@0.134.0
  - @cat-factory/orchestration@0.113.0
  - @cat-factory/server@0.121.0
  - @cat-factory/gitlab@0.10.0
  - @cat-factory/node-server@0.95.2
  - @cat-factory/integrations@0.84.3
  - @cat-factory/executor-harness@1.43.6

## 0.67.4

### Patch Changes

- Updated dependencies [9e9127f]
  - @cat-factory/contracts@0.133.0
  - @cat-factory/orchestration@0.112.0
  - @cat-factory/server@0.120.0
  - @cat-factory/agents@0.58.1
  - @cat-factory/gitlab@0.9.1
  - @cat-factory/integrations@0.84.2
  - @cat-factory/kernel@0.128.1
  - @cat-factory/node-server@0.95.1
  - @cat-factory/executor-harness@1.43.6

## 0.67.3

### Patch Changes

- d68e3a8: Add opt-in OpenTelemetry (OTLP) observability. A new `@cat-factory/observability-otel`
  package implements the kernel `LlmTraceSink` port and exports LLM generations (+ container
  tool spans) and metrics to any OTLP/HTTP backend — a workerd-safe fetch exporter on the
  Cloudflare Worker facade and the official `@opentelemetry/*` SDK exporter on Node, kept
  conformant by a shared mapping layer + a conformity test.

  - **kernel:** new `CompositeTraceSink` + `composeTraceSinks` so multiple external trace
    destinations (Langfuse and/or OTLP) fan out through the single sink slot.
  - **server:** new `OtelConfig` on `AppConfig`.
  - **worker / node-server:** wire the OTLP exporter (fetch on the Worker, SDK on Node)
    everywhere the Langfuse sink is wired, composed alongside Langfuse. Enabled with
    `OTEL_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT` (`OTEL_EXPORTER_OTLP_HEADERS` /
    `OTEL_SERVICE_NAME` optional).
  - **cli:** advertise the `OTEL_*` vars in the generated `.env`.

  Refinements: the Node facade shares ONE trace-sink instance across the core, the container
  executor and the inline model-provider (so the SDK exporter's batch processors/timers aren't
  duplicated) and flushes + shuts it down on graceful shutdown (via `LlmTraceSink.shutdown` /
  `CompositeTraceSink` fan-out) so the final batch isn't dropped. Metric data points carry only
  the low-cardinality `gen_ai.*` dimensions — the unbounded workspace id stays on spans, off
  metrics — to keep metric-backend cardinality bounded.

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0
  - @cat-factory/server@0.119.0
  - @cat-factory/node-server@0.95.0
  - @cat-factory/contracts@0.132.0
  - @cat-factory/agents@0.58.0
  - @cat-factory/orchestration@0.111.0
  - @cat-factory/gitlab@0.9.0
  - @cat-factory/integrations@0.84.1
  - @cat-factory/executor-harness@1.43.6

## 0.67.2

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/contracts@0.131.0
  - @cat-factory/kernel@0.127.0
  - @cat-factory/agents@0.57.0
  - @cat-factory/orchestration@0.110.0
  - @cat-factory/integrations@0.84.0
  - @cat-factory/server@0.118.0
  - @cat-factory/gitlab@0.8.1
  - @cat-factory/node-server@0.94.8
  - @cat-factory/executor-harness@1.43.6

## 0.67.1

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/contracts@0.130.0
  - @cat-factory/kernel@0.126.0
  - @cat-factory/agents@0.56.0
  - @cat-factory/orchestration@0.109.0
  - @cat-factory/server@0.117.0
  - @cat-factory/gitlab@0.8.0
  - @cat-factory/integrations@0.83.3
  - @cat-factory/node-server@0.94.7
  - @cat-factory/executor-harness@1.43.6

## 0.67.0

### Minor Changes

- 86bbd18: Resolve the local `container` deploy runner's image automatically — `LOCAL_DEPLOY_IMAGE` is now an
  escape hatch, not a mandatory companion.

  - **local-server:** `LOCAL_DEPLOY_RUNTIME=container` now works out of the box with no other
    variable. The deploy-harness image defaults to `RECOMMENDED_DEPLOY_IMAGE` — the version this
    backend release supports, kept in lockstep with the Worker's `wrangler.toml` pin and the
    deploy-harness `version` by the runner-image-tag sync (`scripts/sync-runner-image-tags.mjs`), so
    every facade resolves the SAME supported deploy image. This mirrors how `LOCAL_HARNESS_IMAGE`
    defaults to `RECOMMENDED_HARNESS_IMAGE`. `LOCAL_DEPLOY_IMAGE` is retained ONLY as an override to
    pin a custom/older build or a private-registry mirror (container mode no longer breaks boot when
    it is unset — only `native` still requires its `LOCAL_DEPLOY_HARNESS_ENTRY` companion).
  - **cli:** `cat-factory init`/`env` now steer to the one-line `container` mode in the generated
    `.env` (and the scaffolded `.env.example`), documenting `LOCAL_DEPLOY_IMAGE` as an escape hatch
    with an auto-resolved default. `cat-factory k3s`, after provisioning a local cluster connection,
    now also points the user at enabling the deploy runner (`LOCAL_DEPLOY_RUNTIME=container`) so a
    guided Kubernetes-test-environment setup no longer stops one step short and fails mid-run with
    "no deploy runner wired".

## 0.66.0

### Minor Changes

- d38d6c2: Make the local Kubernetes deploy runner explicit and its misconfiguration loud.

  - **local-server (BREAKING for `LOCAL_DEPLOY_RUNTIME`):** `LOCAL_DEPLOY_RUNTIME` no longer
    defaults to `native`. It is unset ⇒ deploy stays unwired (the normal "no Kubernetes test
    environments" state); set explicitly to `native` or `container` to wire it. A mode set WITHOUT
    its mandatory companion variable (`LOCAL_DEPLOY_HARNESS_ENTRY` for `native`,
    `LOCAL_DEPLOY_IMAGE` for `container`) — or an unrecognised value — now BREAKS boot with an
    actionable config error instead of warning and silently degrading to an unwired deploy that
    only failed mid-run. `native` was the more brittle, higher-privilege mode, so it must be chosen
    deliberately rather than fallen into.
  - **integrations:** the `deploy_runner_unwired` provisioning failure message now spells out each
    facade's exact setting and, for local mode, both modes' companion variables and how they differ.
  - **cli:** `cat-factory init` and `cat-factory env` now document the three `LOCAL_DEPLOY_*`
    variables in the generated `.env` (and the scaffolded `.env.example`), commented out — deploy is
    unused by default, and no companion var is written active since a lone mode breaks boot.

### Patch Changes

- Updated dependencies [d38d6c2]
  - @cat-factory/integrations@0.83.2
  - @cat-factory/orchestration@0.108.1
  - @cat-factory/server@0.116.1
  - @cat-factory/node-server@0.94.6
  - @cat-factory/executor-harness@1.43.6

## 0.65.15

### Patch Changes

- 5fa0a8e: perf(github): fix the slow add-service repo picker search on the local (workspace-PAT) path

  The "add service from repo" typeahead stalled for seconds per keystroke when local mode's
  `GITHUB_PAT` backed the picker: `PatGitHubClient.searchInstallationRepos` re-walked the
  PAT's entire `GET /user/repos` set — up to 20 SEQUENTIAL pages — on every search request,
  with nothing cached (the counterpart viewer-PAT branch was already fixed, but the
  workspace-credential branch kept its own older serial walk).

  - `PatGitHubClient.listInstallationRepos` now delegates to the shared
    `FetchGitHubClient.listReposForToken` walk (page 1 reveals the page count via
    `Link: rel="last"`, the remaining pages fetch concurrently — ~2 round-trips instead of
    up to 20 serial ones) and re-stamps the rows as workspace-wide (`linkedVia: 'app'`).
    Note the enumeration cap is now the shared walk's 10 pages (1000 repos, flagged
    `truncated`) instead of the old silent 20.
  - New `AppCaches.patInstallationRepos` slice (grouped/keyed by installation id, 60s TTL;
    pass-through on the Worker's isolate-safe profile): the picker typeahead filters a
    cached complete enumeration in memory instead of re-walking `/user/repos` per
    keystroke. The blank browse-all stays live/uncached. The local PAT is env-fixed per
    boot, so there is no swap-write to invalidate on — the short TTL is the coherence
    story, mirroring `viewerRepos`.
  - `GitHubSyncService.listAvailableRepos` now runs its three independent reads (the
    tracked-projection list, the App-side lookup, the viewer-PAT expansion) as one
    concurrent wave instead of serially, so a cold PAT enumeration no longer stacks on top
    of the App lookup's latency.

- Updated dependencies [f7e7139]
- Updated dependencies [5fa0a8e]
  - @cat-factory/contracts@0.129.0
  - @cat-factory/kernel@0.125.0
  - @cat-factory/agents@0.55.0
  - @cat-factory/orchestration@0.108.0
  - @cat-factory/server@0.116.0
  - @cat-factory/integrations@0.83.1
  - @cat-factory/gitlab@0.7.71
  - @cat-factory/node-server@0.94.5
  - @cat-factory/executor-harness@1.43.6

## 0.65.14

### Patch Changes

- 806811c: Node/local boot de-serialization (app-startup initiative, items 2/5/6). The Node facade brings up its five pg-boss consumers (execution / bootstrap / env-config-repair / env-test / github-sync) as one `Promise.all` wave instead of awaiting them serially — each is an independent queue with no ordering dependency, so this collapses ~10 back-to-back DB round trips on the boot path to ~2 (kept after `boss.start()` and before listen, invariant unchanged). The best-effort Redis reachability probe (`warnIfRedisUnreachable`) and local mode's GitHub PAT probe are now fire-and-forget (`warnIfRedisUnreachableInBackground` / `warnOnGitHubPatProblemInBackground`) rather than awaited, so a set-but-down Redis bus no longer stalls boot for ~3.5s and a slow github.com round-trip no longer precedes `start()`. Both probes still log their single warning if/when they resolve; the local runtime `--version` preflight stays awaited (it gates limited mode).
- Updated dependencies [806811c]
  - @cat-factory/node-server@0.94.4

## 0.65.13

### Patch Changes

- Updated dependencies [3f3031a]
  - @cat-factory/orchestration@0.107.10
  - @cat-factory/server@0.115.1
  - @cat-factory/node-server@0.94.3
  - @cat-factory/executor-harness@1.43.6

## 0.65.12

### Patch Changes

- Updated dependencies [ca9ea20]
  - @cat-factory/integrations@0.83.0
  - @cat-factory/server@0.115.0
  - @cat-factory/orchestration@0.107.9
  - @cat-factory/node-server@0.94.2
  - @cat-factory/executor-harness@1.43.6

## 0.65.11

### Patch Changes

- Updated dependencies [e5cd022]
  - @cat-factory/kernel@0.124.0
  - @cat-factory/integrations@0.82.0
  - @cat-factory/server@0.114.0
  - @cat-factory/orchestration@0.107.8
  - @cat-factory/node-server@0.94.1
  - @cat-factory/agents@0.54.12
  - @cat-factory/gitlab@0.7.70
  - @cat-factory/executor-harness@1.43.6

## 0.65.10

### Patch Changes

- c28f89e: Add boot-phase timers to the backend startup path (app-startup initiative, item 1). `bootServer`
  now brackets each phase (config, migrate, pg-boss start, container build, bus, worker registration,
  listen) with `performance.now()` and logs one structured `cat-factory node server ready in N ms`
  line with the per-phase breakdown; local mode times its own preflights (container-runtime probe,
  GitHub PAT probe) the same way. New `startBootClock` helper is exported from `@cat-factory/node-server`.
  Pure instrumentation — no behavioural change.
- Updated dependencies [c28f89e]
  - @cat-factory/node-server@0.94.0

## 0.65.9

### Patch Changes

- 6c4bcef: fix(infra-setup): stop the false "test environment not configured" nag in local mode, and make the remaining nag actionable

  Local mode on a Docker-family runtime stands the Tester's dependencies up with the
  zero-config in-container `local-compose` backend, so a missing ephemeral-environment
  _provider_ connection is not actually a setup gap there. The infra-setup projection
  now gates the `ephemeralEnvironments` area on a new
  `ephemeralEnvironmentsRequireProvider` container flag (derived from the deployment's
  test-env capability via `testEnvHasZeroConfigDefault`) — exactly like
  `agentExecutorRequiresRunnerPool` gates the executor area — so the banner stays quiet
  where docker-compose already works and only fires where a provider is genuinely
  mandatory (the Worker, stock Node, and local Apple `container`).

  Where the nag still applies, its copy now tells the user what to do: open Test
  environments and connect a Kubernetes cluster or a custom HTTP environment provider.

- Updated dependencies [6c4bcef]
- Updated dependencies [6c4bcef]
  - @cat-factory/contracts@0.128.2
  - @cat-factory/kernel@0.123.3
  - @cat-factory/integrations@0.81.20
  - @cat-factory/server@0.113.9
  - @cat-factory/node-server@0.93.9
  - @cat-factory/agents@0.54.11
  - @cat-factory/gitlab@0.7.69
  - @cat-factory/orchestration@0.107.7
  - @cat-factory/executor-harness@1.43.6

## 0.65.8

### Patch Changes

- Updated dependencies [b34ab46]
- Updated dependencies [b34ab46]
  - @cat-factory/executor-harness@1.43.6
  - @cat-factory/server@0.113.8
  - @cat-factory/orchestration@0.107.6
  - @cat-factory/node-server@0.93.8

## 0.65.7

### Patch Changes

- Updated dependencies [90a7fb3]
  - @cat-factory/integrations@0.81.19
  - @cat-factory/server@0.113.7
  - @cat-factory/orchestration@0.107.5
  - @cat-factory/node-server@0.93.7
  - @cat-factory/executor-harness@1.43.4

## 0.65.6

### Patch Changes

- Updated dependencies [c1028cc]
  - @cat-factory/orchestration@0.107.4
  - @cat-factory/server@0.113.6
  - @cat-factory/node-server@0.93.6
  - @cat-factory/executor-harness@1.43.4

## 0.65.5

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/executor-harness@1.43.4
  - @cat-factory/kernel@0.123.2
  - @cat-factory/contracts@0.128.1
  - @cat-factory/agents@0.54.10
  - @cat-factory/gitlab@0.7.68
  - @cat-factory/integrations@0.81.18
  - @cat-factory/orchestration@0.107.3
  - @cat-factory/server@0.113.5
  - @cat-factory/node-server@0.93.5

## 0.65.4

### Patch Changes

- Updated dependencies [2c7ca2e]
  - @cat-factory/orchestration@0.107.2
  - @cat-factory/kernel@0.123.1
  - @cat-factory/server@0.113.4
  - @cat-factory/node-server@0.93.4
  - @cat-factory/agents@0.54.9
  - @cat-factory/gitlab@0.7.67
  - @cat-factory/integrations@0.81.17
  - @cat-factory/executor-harness@1.43.2

## 0.65.3

### Patch Changes

- Updated dependencies [85bf0ef]
  - @cat-factory/server@0.113.3
  - @cat-factory/node-server@0.93.3
  - @cat-factory/executor-harness@1.43.2

## 0.65.2

### Patch Changes

- Updated dependencies [17c6808]
  - @cat-factory/server@0.113.2
  - @cat-factory/executor-harness@1.43.2
  - @cat-factory/node-server@0.93.2

## 0.65.1

### Patch Changes

- Updated dependencies [e4c5abe]
- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0
  - @cat-factory/orchestration@0.107.1
  - @cat-factory/server@0.113.1
  - @cat-factory/integrations@0.81.16
  - @cat-factory/agents@0.54.8
  - @cat-factory/gitlab@0.7.66
  - @cat-factory/node-server@0.93.1
  - @cat-factory/executor-harness@1.43.2

## 0.65.0

### Minor Changes

- 1e684b7: Add a "Test environment creation" diagnostic to the service inspector. A developer can now
  run the whole ephemeral-environment lifecycle against a throwaway branch — create branch →
  provision → tear down → delete branch — and see the live stage plus the final success/failure
  (and the stage it failed at), with guaranteed cleanup even on error.

  Modelled as a durable, observable run (its own `environment_test_runs` table on both facades)
  driven by a Cloudflare Workflow on the Worker and pg-boss on Node, with live `envTest` events
  pushed to the SPA. Adds the `RepoFiles.deleteBranch` port method (implemented once in the shared
  server layer) so the throwaway branch is reclaimed through the existing checkout-free seam.

  The always-cleans-up contract is enforced on every path: the branch is persisted before
  dispatch (a dispatch failure can't orphan it), a failed deploy view releases the runner and
  finalizes so cleanup tears down partial infra, a stop mid-provision aborts the in-flight
  deploy job, and the run's synthetic environment-registry row is always reclaimed. The
  provisioning config is pinned on the run record at dispatch, terminal writes are guarded
  (`updateIfRunning`, first-writer-wins vs the stop button), and both runtimes gain an env-test
  stale-run sweep plus self-finalization on poll-budget exhaustion so a run whose driver dies
  can never show `running` forever. The SPA store reconciles snapshots and live events by
  `updatedAt` so a stale refresh can't regress or drop a run's state.

  Schema change (no backwards-compatible migration, per project policy): a new
  `environment_test_runs` table is added to both the D1 (`0050_environment_test_runs.sql`) and
  Postgres/Drizzle schemas.

- 1e684b7: Mothership-mode GitHub support + remote persistence for environment self-test runs.

  **GitHub token delegation.** The mothership now serves a machine-authed
  `POST /internal/github/installation-token` (mounted on both facades, like the persistence
  RPC): a mothership-mode local node presents its machine token and an installation id, the
  call is rate-limited per node (fixed window on the token's signed `nodeId`) and
  account-scoped off the installation's own account binding (live row + `accountId` in the
  token scope, uniform 404 otherwise), and the mothership's GitHub App mints a short-lived
  installation token **repo-scoped via `repository_ids`** to the live App-linked
  `github_repos` projection for that installation (`user_pat`-linked rows excluded; no
  linked repos ⇒ 404) — never an installation-wide token, and never served from or written
  into the engine's unscoped token cache. Every mint/denial/failure is audit-logged with
  the node + user ids (the new kernel port method backing the scoping read is
  `RepoProjectionRepository.listByInstallation`, mirrored D1 ⇄ Drizzle). A mothership-mode
  local node with no `GITHUB_PAT` now consumes these tokens through the new
  `DelegatedAppTokenSource` — wiring the push/clone token mint AND a full `FetchGitHubClient`
  (gates, merge, repo-link, `resolveRunRepoContext`/RepoFiles) off the org's GitHub App, with
  the App private key never leaving the mothership. An explicitly configured PAT still wins;
  `GITHUB_PAT` is now optional in mothership mode.

  **Environment self-test remote persistence.** The `environment_test_runs` store is now on
  the mothership persistence allow-list (`get`/`update`/`listRunningByWorkspace` workspace-
  scoped, record-based `insert` bound on the run's `workspaceId` field), so a mothership-mode
  node persists and lists its self-test runs remotely instead of failing with
  `unknown_method`. Its former blocker — the self-test's GitHub branch create/delete — is
  served by the delegation endpoint above. A FULL mothership-mode self-test still waits on
  the provisioning writes (`environmentRegistryRepository.insert`/`update`, the
  secrets-delegation slice); until then the run fails cleanly at the provisioning stage with
  cleanup.

### Patch Changes

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/contracts@0.128.0
  - @cat-factory/kernel@0.122.0
  - @cat-factory/orchestration@0.107.0
  - @cat-factory/integrations@0.81.15
  - @cat-factory/server@0.113.0
  - @cat-factory/node-server@0.93.0
  - @cat-factory/agents@0.54.7
  - @cat-factory/gitlab@0.7.65
  - @cat-factory/executor-harness@1.43.2

## 0.64.38

### Patch Changes

- Updated dependencies [5a3fe5d]
- Updated dependencies [2a13ece]
  - @cat-factory/server@0.112.10
  - @cat-factory/node-server@0.92.21
  - @cat-factory/kernel@0.121.8
  - @cat-factory/integrations@0.81.14
  - @cat-factory/executor-harness@1.43.2
  - @cat-factory/agents@0.54.6
  - @cat-factory/gitlab@0.7.64
  - @cat-factory/orchestration@0.106.8

## 0.64.37

### Patch Changes

- 3ce997d: Structured container-eviction signal (error-message initiative I1). A container eviction is now
  carried on a typed `RunnerJobView.evicted` field (`'crash'` | `'transient'`, the new
  `ContainerEvictionKind`) minted by every runner transport (Cloudflare, the shared local
  `harnessHttp`, the local container/pool/process/native-routing transports, and Kubernetes/EKS),
  forwarded through `AgentJobUpdate`, and read by the execution / bootstrap / env-config-repair
  consumers via the new `evictionKindOf` extractor. The `(container evicted or crashed)` sentinel +
  the transient marker are PRESERVED as the fallback for an older producer, so nothing that still
  matches the string breaks — the structured field is simply the load-bearing signal now, replacing
  the regex as the primary classification channel.
- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7
  - @cat-factory/orchestration@0.106.7
  - @cat-factory/server@0.112.9
  - @cat-factory/integrations@0.81.13
  - @cat-factory/agents@0.54.5
  - @cat-factory/gitlab@0.7.63
  - @cat-factory/node-server@0.92.20
  - @cat-factory/executor-harness@1.43.2

## 0.64.36

### Patch Changes

- Updated dependencies [67dccb6]
  - @cat-factory/kernel@0.121.6
  - @cat-factory/orchestration@0.106.6
  - @cat-factory/server@0.112.8
  - @cat-factory/agents@0.54.4
  - @cat-factory/gitlab@0.7.62
  - @cat-factory/integrations@0.81.12
  - @cat-factory/node-server@0.92.19
  - @cat-factory/executor-harness@1.43.2

## 0.64.35

### Patch Changes

- f8f1aa8: Update workspace dependencies (direct + transitive) to the newest versions published before the
  `minimumReleaseAge` supply-chain cutoff. No source changes — dependency ranges + the lockfile only.

  - Refreshed direct deps to their newest cooldown-compliant releases: `wrangler` 4.110.0, `hono`
    4.12.29, `vitest` / `@vitest/coverage-v8` 4.1.10, `oxlint` 1.73.0, `knip` 6.26.0, `msw` 2.15.0,
    `pg-boss` 12.26.0, `sherif` 1.13.0, `turbo` 2.10.4, `vue-tsc` 3.3.7, `@types/node` 26.1.1,
    `@nuxtjs/i18n` 10.4.1, `@aws-sdk/client-s3` 3.1085.0.
  - `typescript` moved off the `7.0.1-rc` prerelease to the stable `7.0.2` release across every
    package that used the RC (the TS-6 world — the frontend layer and the two runner harnesses —
    stays on `^6.0.3`).
  - Vercel AI SDK family held to the `ai@6`-compatible majors that `workers-ai-provider@3.3.1` peers
    require (`ai` 6.0.224, `@ai-sdk/anthropic|openai|provider` on 3.x, `@ai-sdk/openai-compatible` on
    2.x, `@ai-sdk/amazon-bedrock` 4.x) — no v7/v5 major bumps.
  - Coding (`executor-harness`) and deploy runner harnesses updated too, including the pinned
    in-container coding-agent CLIs (Pi 0.80.6, Claude Code 2.1.207, Codex 0.144.1; the Pi todo /
    web-tools extensions stay at their lockstep 1.20.0). Their image tags and the three
    hand-maintained pins were bumped in lockstep, so the runner images must be re-published +
    deployed for the new tags to roll out.

- Updated dependencies [f8f1aa8]
  - @cat-factory/executor-harness@1.43.2
  - @cat-factory/agents@0.54.3
  - @cat-factory/contracts@0.127.1
  - @cat-factory/gitlab@0.7.61
  - @cat-factory/integrations@0.81.11
  - @cat-factory/kernel@0.121.5
  - @cat-factory/node-server@0.92.18
  - @cat-factory/orchestration@0.106.5
  - @cat-factory/server@0.112.7

## 0.64.34

### Patch Changes

- 5dd16d3: Elaborate two boot-time connectivity failures with actionable remedies (error-message coverage
  A11/A12):

  - **A11 (Node):** a loopback Postgres connection that's refused or reset at boot now reports the
    fix on the misconfigured screen — including the Windows/Docker-Desktop `localhost`→IPv6 `::1`
    footgun and the `127.0.0.1` workaround — instead of dying with a raw `ECONNRESET`. A non-loopback
    (remote) database being briefly unreachable is deliberately left to crash-and-retry.
  - **A12 (Local):** a set-but-invalid `GITHUB_PAT` is validated once at boot (a best-effort
    `GET /user`) and, when it's expired/revoked/under-scoped, warned about with the same pre-scoped
    token-creation link the missing-PAT warning already uses — instead of failing opaquely on the
    first clone/push/PR later.

- Updated dependencies [5dd16d3]
  - @cat-factory/node-server@0.92.17

## 0.64.33

### Patch Changes

- Updated dependencies [e68c958]
- Updated dependencies [90553c8]
  - @cat-factory/integrations@0.81.10
  - @cat-factory/node-server@0.92.16
  - @cat-factory/server@0.112.6
  - @cat-factory/orchestration@0.106.4
  - @cat-factory/executor-harness@1.43.0

## 0.64.32

### Patch Changes

- Updated dependencies [e61c980]
  - @cat-factory/server@0.112.5
  - @cat-factory/executor-harness@1.43.0
  - @cat-factory/node-server@0.92.15

## 0.64.31

### Patch Changes

- 4810353: Structured, elaborated container/runner dispatch failures (error-message coverage initiative,
  items D1/I2). A `dispatch()` rejection used to throw a bare `Container dispatch failed (HTTP n)`
  string that named the symptom but not the cause, and downstream consumers decided "was this a
  dispatch failure?" by regex-matching `/dispatch failed/i` — so error IDENTITY rode a string, and a
  self-hosted-pool fault (`Runner pool … → <status>`, a different wording) fell through and was
  mislabelled a `preflight` error.

  - **I2** — new kernel `DispatchError` (`domain/dispatch-errors.ts`) carries the HTTP `status` as a
    structured field, thrown by every transport `dispatch()`: `CloudflareContainerTransport`,
    `KubernetesRunnerTransport`, the local `postHarnessJob` (both local transports), and
    `RunnerPoolTransport` (which re-wraps the pool provider's `RunnerPoolApiError`, carrying its
    status). `BootstrapService`, `EnvConfigRepairService`, and the execution engine
    (`classifyDispatchFailure`) now classify via `instanceof` / the `isDispatchFailure` extractor,
    with the legacy `/dispatch failed/i` message shape kept only as a fallback. This fixes the pool
    dispatch fault being mislabelled `preflight`.
  - **D1** — a 404 from the harness `/jobs` route (the deployed executor-harness image predates the
    route because its tag was never bumped, so new containers run stale code) now elaborates with the
    stale-image cause + the republish-under-a-fresh-tag remedy and a link to the release rules. The
    raw `<label> dispatch failed (HTTP n): <body>` first line is preserved verbatim (still greppable,
    still matched by the fallback regex); the cause + remedy is only appended.

  No behaviour changes beyond error message text and failure classification. No executor-harness
  image change (the dispatch signal is minted by in-repo transports).

- Updated dependencies [4810353]
- Updated dependencies [327a1ef]
  - @cat-factory/kernel@0.121.4
  - @cat-factory/orchestration@0.106.3
  - @cat-factory/integrations@0.81.9
  - @cat-factory/node-server@0.92.14
  - @cat-factory/agents@0.54.2
  - @cat-factory/gitlab@0.7.60
  - @cat-factory/server@0.112.4
  - @cat-factory/executor-harness@1.43.0

## 0.64.30

### Patch Changes

- Updated dependencies [6fc42ed]
- Updated dependencies [b7ca24a]
  - @cat-factory/server@0.112.3
  - @cat-factory/node-server@0.92.13
  - @cat-factory/executor-harness@1.43.0

## 0.64.29

### Patch Changes

- Updated dependencies [edad6e6]
  - @cat-factory/kernel@0.121.3
  - @cat-factory/orchestration@0.106.2
  - @cat-factory/server@0.112.2
  - @cat-factory/node-server@0.92.12
  - @cat-factory/agents@0.54.1
  - @cat-factory/gitlab@0.7.59
  - @cat-factory/integrations@0.81.8
  - @cat-factory/executor-harness@1.43.0

## 0.64.28

### Patch Changes

- Updated dependencies [3b3bdc8]
  - @cat-factory/server@0.112.1
  - @cat-factory/integrations@0.81.7
  - @cat-factory/executor-harness@1.43.0
  - @cat-factory/node-server@0.92.11
  - @cat-factory/orchestration@0.106.1

## 0.64.27

### Patch Changes

- Updated dependencies [6a4feb9]
  - @cat-factory/node-server@0.92.10

## 0.64.26

### Patch Changes

- Updated dependencies [d1a4129]
  - @cat-factory/contracts@0.127.0
  - @cat-factory/agents@0.54.0
  - @cat-factory/orchestration@0.106.0
  - @cat-factory/server@0.112.0
  - @cat-factory/gitlab@0.7.58
  - @cat-factory/integrations@0.81.6
  - @cat-factory/kernel@0.121.2
  - @cat-factory/node-server@0.92.9
  - @cat-factory/executor-harness@1.43.0

## 0.64.25

### Patch Changes

- df7a489: De-duplicate the GitHub reconcile pass across the two facades, and make every Node
  periodic sweep non-overlapping through a single seam.

  **Reconcile hoist (audit item 4).** `reconcileStaleRepos` and its two gone-installation
  classifiers were duplicated verbatim between the Worker's `sync-consumer.ts` and the Node
  `githubReconcile.ts` (the Node copy's own comment said "Mirrors the Worker's classification"),
  with no shared test — so a change to one would silently diverge (one runtime stops tombstoning
  dead installations while the other keeps working). The pass now lives once in
  `@cat-factory/server` (`reconcileStaleRepos` + `GitHubReconcileDeps`), and each facade supplies
  only its per-repo driver: the Worker enqueues on `GITHUB_SYNC_QUEUE` (or direct-syncs when
  unbound), Node direct-syncs inline. The classifiers moved verbatim (their regex→structured-code
  conversion is tracked separately as error-message-coverage I7). The 30-minute staleness window
  is now the shared exported `GITHUB_RECONCILE_STALE_MS` (previously defined independently per
  facade), and all reconcile logs — the per-repo lines AND the Worker's cron summary — now use a
  single `sweep: 'github-reconcile'` field on both facades. The Worker's queue-less direct-sync
  fallback also builds its DI container once per pass instead of once per stale repo.

  **Non-overlapping Node sweepers (audit item 6).** The DB-heavy `initiativeLoop`, `recurring`,
  and notification-escalation sweeps ran unguarded `setInterval` timers, so a pass that outlasted
  its interval could be stacked — and two concurrent `runDue` passes could both observe "no active
  run" and double-spawn. All eight Node sweeps (kaizen, github-reconcile, initiative loop,
  recurring, notification escalation, environment TTL, and both retention sweeps) now go through
  one `startSweeper` helper built on `toad-scheduler`: `preventOverrun` is the non-overlap guard,
  `runImmediately` the run-once-first behaviour, and the `AsyncTask` error handler the best-effort
  logging (each sweep names its task, so scheduler-surfaced errors identify their sweep), and
  `unref` keeps the sweep timers from holding the process alive — the same contract as the
  hand-rolled `setInterval(...).unref()` timers this replaced. A new sweeper physically cannot
  forget the guard. Adds a `toad-scheduler` (^4.1.0) dependency to `@cat-factory/node-server`.

- Updated dependencies [df7a489]
  - @cat-factory/server@0.111.0
  - @cat-factory/node-server@0.92.8
  - @cat-factory/executor-harness@1.43.0

## 0.64.24

### Patch Changes

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1
  - @cat-factory/server@0.110.5
  - @cat-factory/gitlab@0.7.57
  - @cat-factory/orchestration@0.105.6
  - @cat-factory/agents@0.53.6
  - @cat-factory/integrations@0.81.5
  - @cat-factory/node-server@0.92.7
  - @cat-factory/executor-harness@1.43.0

## 0.64.23

### Patch Changes

- f4482c7: Reclaim a deleted board's binary artifacts (screenshots + reference images) — BOTH the
  metadata rows AND the heavy blob bytes — so they no longer leak forever.

  The artifact retention sweeps only ever iterate LIVE workspaces (`listVisible`), and
  `binary_artifacts` is deliberately excluded from the SQL workspace-delete cascade (dropping
  the metadata row without the bytes would strand the blob in object storage forever — the row
  is the only handle on its key). So before this change, deleting a board orphaned both the
  metadata rows and their backing R2 / S3 / filesystem bytes with nothing to reclaim them —
  unbounded object-storage cost with no surfacing.

  `BinaryArtifactStore` gains `deleteByWorkspace(workspaceId)` (backed by new
  `listByWorkspace` / `deleteByWorkspace` metadata-store methods, mirrored D1 ⇄ Drizzle),
  reusing the same fail-safe blobs-first-then-rows ordering as `pruneOlderThan`: a blob whose
  delete throws keeps its metadata row so a later retry can still reach the bytes rather than
  orphaning them. `WorkspaceService.delete` now purges through this port (best-effort — a
  storage outage can't wedge the board delete) before the row cascade runs. The cross-runtime
  binary-artifact conformance suite asserts the reclaim removes every artifact's rows + bytes,
  scoped to the workspace, on both D1 and Postgres. (system-audit-improvements initiative,
  item 3.)

- Updated dependencies [f4482c7]
  - @cat-factory/kernel@0.121.0
  - @cat-factory/server@0.110.4
  - @cat-factory/node-server@0.92.6
  - @cat-factory/agents@0.53.5
  - @cat-factory/gitlab@0.7.56
  - @cat-factory/integrations@0.81.4
  - @cat-factory/orchestration@0.105.5
  - @cat-factory/executor-harness@1.43.0

## 0.64.22

### Patch Changes

- Updated dependencies [cc6d554]
  - @cat-factory/agents@0.53.4
  - @cat-factory/server@0.110.3
  - @cat-factory/orchestration@0.105.4
  - @cat-factory/node-server@0.92.5
  - @cat-factory/executor-harness@1.43.0

## 0.64.21

### Patch Changes

- 22a4d9e: Complete the workspace-delete cascade so a board delete no longer orphans rows forever.
  Both facades' `WorkspaceRepository.delete` previously cleared only ~7 tables
  (blocks/pipelines/agent_runs/environments/services/mounts), leaving every other
  workspace-scoped table (`notifications`, `requirement_reviews`, the review / session /
  settings / connection / preset tables, the GitHub projection, …) permanently orphaned on
  a normal board delete — invisible today, unbounded cost tomorrow.

  The cascade is now driven by a single shared kernel list, `WORKSPACE_SCOPED_TABLES`, that
  both the D1 (Cloudflare) and Drizzle (Node/local) facades iterate, so the two runtimes
  cannot drift and a newly-added workspace-scoped table can't silently miss the cascade.
  Per-facade static completeness guards make a new table impossible to forget: the Node guard
  introspects the Drizzle/Postgres schema and the Worker guard introspects the real migrated
  D1, each failing if any `workspace_id` table is neither listed nor explicitly acknowledged
  as a special case (the D1 guard also covers the Cloudflare-only `live_containers` table the
  Drizzle schema can't see). A cross-runtime conformance assertion proves a deleted board
  leaves no rows behind on both D1 and Postgres.

  Deliberately out of scope (unchanged): `binary_artifacts` (its blob bytes must be reclaimed
  through the `BinaryBlobBackend` port at the service layer — a follow-up slice), the
  bespoke `services` / mount re-home handling, and the isolated `telemetry` / `sandbox` /
  `provisioning` schemas (separate stores reclaimed by their own retention sweeps; telemetry
  is a physically separate D1 database on the Worker). (system-audit-improvements initiative,
  item 2.)

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0
  - @cat-factory/node-server@0.92.4
  - @cat-factory/agents@0.53.3
  - @cat-factory/gitlab@0.7.55
  - @cat-factory/integrations@0.81.3
  - @cat-factory/orchestration@0.105.3
  - @cat-factory/server@0.110.2
  - @cat-factory/executor-harness@1.43.0

## 0.64.20

### Patch Changes

- dbfe2e8: Boot-time structured warnings for three previously-silent misconfigurations (error-message
  coverage initiative, items A5/A9/A10). Each is a single greppable WARN naming the offending
  var, its consequence, and a doc link — behaviour is unchanged (the conditions were, and stay,
  non-fatal); they were just invisible until the first dispatch failed.

  - **A5** — the Node facade's container agent executor is disabled when a prerequisite is
    missing (`PUBLIC_URL`, `AUTH_SESSION_SECRET`, a runner backend, or a GitHub token source),
    but the service still boots "healthy" and repo-operating steps (coder/mocker/tester/merger/…)
    failed only at dispatch, deep in a request. It now logs at boot exactly which prerequisite is
    missing, so the gap is visible up front (the Worker already throws a `configProblem` here).
  - **A9** — an unrecognised `LOCAL_CONTAINER_RUNTIME` value silently fell back to `docker`; the
    local preflight now names the rejected value, the accepted set
    (`docker`/`podman`/`orbstack`/`colima`/`apple`), and the fallback taken.
  - **A10** — a half-set `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` pair silently disabled
    Cloudflare Workers AI (over REST) on the Node facade; config load now names which half is set
    and which is missing.

  Adds a `localMode` section anchor to `@cat-factory/server`'s `ENV_VARS_ANCHORS` so the A9
  warning deep-links the local-mode env-var docs.

- Updated dependencies [dbfe2e8]
  - @cat-factory/server@0.110.1
  - @cat-factory/node-server@0.92.3
  - @cat-factory/executor-harness@1.43.0

## 0.64.19

### Patch Changes

- 8d65179: Boot-time configuration validation for three previously-opaque failures (error-message
  coverage initiative, items A2/A4/A6):

  - **A2** — the system `ENCRYPTION_KEY` is now validated at config load on every facade
    (present, valid base64, decoding to a full AES-256 key) via a shared
    `requireEncryptionKey` helper in `@cat-factory/server`, wired into the Node and Worker
    config loaders and reused by local mode. A malformed key fails with an actionable,
    doc-linked message on the misconfigured screen instead of lazily deep inside the first
    cipher build (a bare "must decode to at least 32 bytes" or an opaque `atob` error).
  - **A4** — the Cloudflare Worker's primary `DB` binding is guarded by `requireDb` at
    container build, mirroring `requireTelemetryDb`, so an unbound/misnamed binding fails
    fast with a `[[d1_databases]]` remedy rather than NPE-ing deep in the first repository
    call.
  - **A6** — an invalid `DB_SCHEMA` / `DB_MIGRATIONS_SCHEMA` on the Node facade now throws a
    `ConfigValidationError`, so it reaches the "backend misconfigured" fallback screen
    instead of hard-crashing the process with an opaque message.

- a5dcf7d: Prune resolved notifications on the retention sweep. The `notifications` table was
  never pruned on either facade (upsert/escalate only, no delete), so resolved
  (acted/dismissed) cards accumulated without bound on a table read on the snapshot hot
  path. A new `NotificationRepository.deleteResolvedOlderThan(cutoff)` port method
  (mirrored D1 ⇄ Drizzle) is wired into both facades' retention sweeps under a new
  `RetentionConfig.notificationsMs` window (`NOTIFICATION_RETENTION_DAYS`, default 90
  days). Only terminal rows past the window are deleted — `open` cards (the actionable
  inbox) are never touched. Covered by a new cross-runtime notification conformance
  suite. (system-audit-improvements initiative, item 1.)
- Updated dependencies [8d65179]
- Updated dependencies [a5dcf7d]
  - @cat-factory/server@0.110.0
  - @cat-factory/node-server@0.92.2
  - @cat-factory/kernel@0.119.0
  - @cat-factory/executor-harness@1.43.0
  - @cat-factory/agents@0.53.2
  - @cat-factory/gitlab@0.7.54
  - @cat-factory/integrations@0.81.2
  - @cat-factory/orchestration@0.105.2

## 0.64.18

### Patch Changes

- 5072999: Boot-time configuration problems now carry a documentation link. Each `ENV_HELP`
  entry embeds a stable in-repo doc URL (built through a new centralized `DOCS`
  helper in `@cat-factory/server`), the operator log appends a `Docs:` line, and the
  "backend misconfigured" screen renders a "View documentation" link per problem.
  This establishes the doc-URL convention for the error-message coverage initiative
  (item A1).
- Updated dependencies [5072999]
  - @cat-factory/contracts@0.126.0
  - @cat-factory/server@0.109.0
  - @cat-factory/node-server@0.92.1
  - @cat-factory/agents@0.53.1
  - @cat-factory/gitlab@0.7.53
  - @cat-factory/integrations@0.81.1
  - @cat-factory/kernel@0.118.1
  - @cat-factory/orchestration@0.105.1
  - @cat-factory/executor-harness@1.43.0

## 0.64.17

### Patch Changes

- Updated dependencies [25ac984]
  - @cat-factory/node-server@0.92.0

## 0.64.16

### Patch Changes

- 2eb0cfd: Make database migrations fail safe and recover cleanly.

  Motivated by a `0.63 → 0.64` upgrade that bricked boot: a database whose drizzle-kit 1.0
  migration ledger (in its own `drizzle` schema) had outlived its `public` tables — the classic
  ledger↔schema split left by a hand `DROP SCHEMA public CASCADE` — hit a bare
  `42P01 relation "accounts" does not exist` deep inside the new FK migration, with no
  remediation path.

  - **Boot drift-guard + wrapped errors (Node).** `migrate()` now probes for the ledger↔schema
    split up front (ledger non-empty but anchor tables `public.accounts`/`public.workspaces`
    missing) and throws a clear `DbSchemaInconsistentError`, and wraps any apply failure in a
    `MigrationFailedError` mapping the pg code (`42P01`/`23503`/`42P07`) to a human cause + the
    recovery command. Boot runs `migrate()` before `boss.start()` (no longer racing them in a
    `Promise.all`) so the migration error is the clean top-level rejection.
  - **`db:reset` recovery command (Node).** `pnpm --filter @cat-factory/node-server db:reset`
    drops all app-owned schemas together — the app schema, `telemetry`, `sandbox`,
    `provisioning`, the migration ledger, and pg-boss's queue schema — so the ledger can never
    outlive the data. This is the sanctioned recovery; never hand-drop `public` alone (that is
    what causes the split). **DESTRUCTIVE** — it deletes all data in `DATABASE_URL`.
  - **Configurable schemas for a shared database (Node).** New optional env vars, all defaulting
    to the prior behaviour: `DB_SCHEMA` relocates the default (`public`) app tables via the
    connection `search_path` (for databases with no usable `public`); `DB_MIGRATIONS_SCHEMA` moves
    the drizzle migration ledger off the top-level `drizzle` schema so it can't collide with
    another drizzle-using service's `drizzle.__drizzle_migrations`; `DB_PGBOSS_SCHEMA` moves
    pg-boss's queue schema. `db:reset` honours the same vars. The named app schemas
    (`telemetry`/`sandbox`/`provisioning`) remain fixed.
  - **Self-healing FK migrations (both runtimes).** The `ON DELETE RESTRICT` FK migrations now
    delete/NULL pre-existing orphans before `ADD CONSTRAINT`, so a database old enough to predate
    the FKs migrates instead of hard-failing on `23503`. Applied symmetrically to the Postgres
    `20260709061125_old_santa_claus` migration and the D1
    `0046_user_identity_foreign_keys.sql` rebuild. **Breaking:** editing these already-shipped
    migrations changes their content; a database that already applied the originals should recover
    via `db:reset` (only experimental installs exist pre-1.0). Orphaned rows are deleted — losing
    that stale data is acceptable (backwards compatibility is a non-goal).
  - **Test-pollution hardening.** The Node/local/mothership test harnesses now require a
    per-vitest-worker database (they refuse to run against the base `DATABASE_URL`) and use the
    `postgres` maintenance database for the admin `CREATE DATABASE` connection, so running the
    suite can never pollute or desync a developer's dev database.

- Updated dependencies [2eb0cfd]
  - @cat-factory/node-server@0.91.1

## 0.64.15

### Patch Changes

- Updated dependencies [4f936de]
  - @cat-factory/contracts@0.125.0
  - @cat-factory/kernel@0.118.0
  - @cat-factory/agents@0.53.0
  - @cat-factory/orchestration@0.105.0
  - @cat-factory/integrations@0.81.0
  - @cat-factory/server@0.108.0
  - @cat-factory/node-server@0.91.0
  - @cat-factory/gitlab@0.7.52
  - @cat-factory/executor-harness@1.43.0

## 0.64.14

### Patch Changes

- Updated dependencies [4b8fc5f]
  - @cat-factory/executor-harness@1.43.0
  - @cat-factory/server@0.107.10
  - @cat-factory/node-server@0.90.11

## 0.64.13

### Patch Changes

- Updated dependencies [e254ef5]
  - @cat-factory/orchestration@0.104.1
  - @cat-factory/server@0.107.9
  - @cat-factory/node-server@0.90.10
  - @cat-factory/executor-harness@1.41.0

## 0.64.12

### Patch Changes

- Updated dependencies [127fe3e]
  - @cat-factory/orchestration@0.104.0
  - @cat-factory/contracts@0.124.1
  - @cat-factory/kernel@0.117.6
  - @cat-factory/server@0.107.8
  - @cat-factory/node-server@0.90.9
  - @cat-factory/agents@0.52.9
  - @cat-factory/gitlab@0.7.51
  - @cat-factory/integrations@0.80.6
  - @cat-factory/executor-harness@1.41.0

## 0.64.11

### Patch Changes

- Updated dependencies [774908c]
  - @cat-factory/kernel@0.117.5
  - @cat-factory/server@0.107.7
  - @cat-factory/orchestration@0.103.1
  - @cat-factory/node-server@0.90.8
  - @cat-factory/agents@0.52.8
  - @cat-factory/gitlab@0.7.50
  - @cat-factory/integrations@0.80.5
  - @cat-factory/executor-harness@1.41.0

## 0.64.10

### Patch Changes

- Updated dependencies [08a7da2]
  - @cat-factory/contracts@0.124.0
  - @cat-factory/orchestration@0.103.0
  - @cat-factory/kernel@0.117.4
  - @cat-factory/server@0.107.6
  - @cat-factory/node-server@0.90.7
  - @cat-factory/agents@0.52.7
  - @cat-factory/gitlab@0.7.49
  - @cat-factory/integrations@0.80.4
  - @cat-factory/executor-harness@1.41.0

## 0.64.9

### Patch Changes

- Updated dependencies [87f835a]
  - @cat-factory/server@0.107.5
  - @cat-factory/node-server@0.90.6
  - @cat-factory/executor-harness@1.41.0

## 0.64.8

### Patch Changes

- Updated dependencies [6b968bb]
  - @cat-factory/kernel@0.117.3
  - @cat-factory/orchestration@0.102.8
  - @cat-factory/server@0.107.4
  - @cat-factory/node-server@0.90.5
  - @cat-factory/agents@0.52.6
  - @cat-factory/gitlab@0.7.48
  - @cat-factory/integrations@0.80.3
  - @cat-factory/executor-harness@1.41.0

## 0.64.7

### Patch Changes

- Updated dependencies [a650396]
  - @cat-factory/orchestration@0.102.7
  - @cat-factory/server@0.107.3
  - @cat-factory/node-server@0.90.4
  - @cat-factory/executor-harness@1.41.0

## 0.64.6

### Patch Changes

- Updated dependencies [eeadc97]
  - @cat-factory/kernel@0.117.2
  - @cat-factory/contracts@0.123.1
  - @cat-factory/orchestration@0.102.6
  - @cat-factory/server@0.107.2
  - @cat-factory/node-server@0.90.3
  - @cat-factory/agents@0.52.5
  - @cat-factory/gitlab@0.7.47
  - @cat-factory/integrations@0.80.2
  - @cat-factory/executor-harness@1.41.0

## 0.64.5

### Patch Changes

- cb7fd14: Validate the personal-subscription password cache against an 8h expiry buffer on every
  gated action (start / confirm / retry), so the user is prompted to re-enter early — while
  they are present at the action — instead of the key lapsing mid-pipeline and surfacing as a
  broken run that asks for a retry.

  - Frontend (`@cat-factory/app`): a cached key with under 8h of runway left is withheld on
    the first attempt of a gated action, so the server's existing `428 credential_required`
    gate re-challenges and the modal refreshes the full window. The mid-run confirm actions
    (resolve decision / approve step / request changes / resolve-exceeded) now flow through
    the same `withCredential` prompt path as start/retry.
  - Backend (`@cat-factory/server`): **behavior change** — the run-interaction endpoints
    (resolve decision / approve / request changes / resolve-exceeded) now hard-gate for
    individual-usage runs (mint a fresh activation via `personalGateForRun`, 428 when the
    password is needed but absent/withheld) instead of a silent best-effort re-mint, so an
    early re-entry can be surfaced mid-run. The `remintActivations` helper is removed.
  - `@cat-factory/integrations`: removed the now-unused `PersonalSubscriptionService.refreshActivations`.
  - `@cat-factory/kernel` + the runtime facades (`@cat-factory/worker`, `@cat-factory/node-server`,
    `@cat-factory/local-server`): dropped the now-dead `SubscriptionActivationRepository.refresh`
    port method and its D1 / Drizzle / SQLite implementations — its only caller
    (`refreshActivations`) is gone, so activations are now only ever minted at full TTL via
    `activateForRun`, never TTL-extended in place.

- Updated dependencies [cb7fd14]
  - @cat-factory/server@0.107.1
  - @cat-factory/integrations@0.80.1
  - @cat-factory/kernel@0.117.1
  - @cat-factory/node-server@0.90.2
  - @cat-factory/executor-harness@1.41.0
  - @cat-factory/orchestration@0.102.5
  - @cat-factory/agents@0.52.4
  - @cat-factory/gitlab@0.7.46

## 0.64.4

### Patch Changes

- Updated dependencies [c5d8fa1]
  - @cat-factory/node-server@0.90.1

## 0.64.3

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0
  - @cat-factory/integrations@0.80.0
  - @cat-factory/server@0.107.0
  - @cat-factory/node-server@0.90.0
  - @cat-factory/agents@0.52.3
  - @cat-factory/gitlab@0.7.45
  - @cat-factory/orchestration@0.102.4
  - @cat-factory/executor-harness@1.41.0

## 0.64.2

### Patch Changes

- Updated dependencies [51869b8]
- Updated dependencies [2924e32]
  - @cat-factory/kernel@0.116.0
  - @cat-factory/orchestration@0.102.3
  - @cat-factory/agents@0.52.2
  - @cat-factory/gitlab@0.7.44
  - @cat-factory/integrations@0.79.3
  - @cat-factory/server@0.106.3
  - @cat-factory/node-server@0.89.3
  - @cat-factory/executor-harness@1.41.0

## 0.64.1

### Patch Changes

- Updated dependencies [ddb0b68]
  - @cat-factory/node-server@0.89.2
  - @cat-factory/orchestration@0.102.2
  - @cat-factory/server@0.106.2
  - @cat-factory/executor-harness@1.41.0

## 0.64.0

### Minor Changes

- 57979b0: feat(local): fail loudly when the executor harness version doesn't match the backend

  Add a version handshake so a stale or mismatched executor is surfaced clearly and early
  instead of as a cryptic downstream error (the class of bug where a since-removed git flag
  reappears in an old image and breaks every authenticated clone/push with `fatal: unable to
get password from user`).

  - The harness now self-reports its version on `/health` (baked into the image as a file next
    to `dist/`, since the image ships no `package.json`; read from `package.json` in native/npm
    installs).
  - Both local runner transports (per-run/pooled container and native host process) verify the
    running harness against the version this backend build is matched to
    (`RECOMMENDED_HARNESS_IMAGE`) as soon as it becomes healthy. A mismatch — or a harness too
    old to report a version at all — fails the dispatch with an actionable message (re-pull the
    image / update the package). A custom override (`LOCAL_HARNESS_IMAGE` / `LOCAL_HARNESS_ENTRY`)
    downgrades the mismatch to a warning, mirroring the boot-time custom-image notice.

  Bumps the executor-harness image tag (harness `src/**` + `Dockerfile` changed) and the local
  mode pin to `cat-factory-executor:1.40.0`.

### Patch Changes

- Updated dependencies [a51a498]
- Updated dependencies [57979b0]
  - @cat-factory/orchestration@0.102.1
  - @cat-factory/kernel@0.115.1
  - @cat-factory/node-server@0.89.1
  - @cat-factory/executor-harness@1.41.0
  - @cat-factory/server@0.106.1
  - @cat-factory/agents@0.52.1
  - @cat-factory/gitlab@0.7.43
  - @cat-factory/integrations@0.79.2

## 0.63.0

### Minor Changes

- b83bcc8: Requirements review UX + per-task risk policy rename + document default pipeline.

  **Requirements review — per-finding recommendation guidance & inline recommendations.** Each
  finding now has an explicit 3-way selector (Answer / Dismiss / Recommend) in place of the old
  button row. Typing an answer marks the finding "You answered"; choosing **Recommend** carries
  whatever you typed over as **per-finding guidance** that steers the Requirement Writer's
  suggestion (shown on-screen as guidance, not saved as the answer). Recommendations now render
  **inline inside their source finding card** — generating spinner, the ready suggestion with
  accept/reject/re-request — instead of a separate section below. The request-recommendations wire
  contract changes from `{ itemIds, note }` to `{ items: [{ itemId, note? }] }` so each finding in a
  batch can steer the Writer differently.

  **Auto-recommendation on every round.** Auto-recommendation now also runs after an off-path
  re-review (not only the pipeline-driven incorporation cycle), so every iteration round that
  introduces new questions gets its auto-answerable findings pre-answered.

  **"Merge threshold preset" renamed to "Risk policy".** The per-task/per-workspace preset governs
  merge ceilings, CI-fixer attempts, requirement/tester iteration caps and release-health watch — a
  broader risk-management surface than "merge". It is renamed to **Risk policy** across the wire
  contracts, kernel/domain types, services, HTTP routes (`/workspaces/:ws/merge-presets` →
  `/risk-policies`), repositories, and the SPA (store/util/panel/i18n). `Block.mergePresetId` →
  `Block.riskPolicyId`. Iteration caps stay on the policy (per your risk-management model) — no
  functional change. The physical DB table/column names are retained internally (mapped to the new
  domain names), so there is no data migration.

  **Document tasks default to the document pipeline.** A `taskType: 'document'` task now defaults to
  the document-authoring pipeline (`pl_document`) instead of the full-build pipeline, which produces
  no code and needs no spec/tests. Overridable per task as before.

### Patch Changes

- a0c6934: Token-usage tracking for BOTH metered API traffic and flat-rate subscription harnesses
  (usage-and-quota-tracking initiative, Part A). The `token_usage` spend ledger gains a
  `billing` discriminator (`metered` | `subscription`) + `vendor` column, and subscription
  harness usage (Claude Code / Codex / GLM / pooled Kimi & DeepSeek) — previously kept out of
  the ledger entirely — is now recorded durably for reporting. The budget gate is unchanged:
  every spend rollup (`status` / `isOverBudget` / the account & user tiers) filters
  `billing = 'metered'`, so a flat-rate quota call is counted for the usage report but never
  inflates spend or trips a budget.

  New `GET /workspaces/:ws/usage` returns the current period's usage broken down by
  `(billing, vendor, provider, model)`, surfaced in a new "Usage" tab in Workspace Settings
  (both metered and subscription usage, with per-model progress bars). Subscription cost is
  illustrative (the equivalent metered-API cost), never billed.

  D1 migration `0044_usage_billing.sql` ⇄ the Drizzle schema + generated migration; the
  cross-runtime conformance suite pins the metered-vs-subscription split on both stores. No
  data migration — existing rows default to `metered`.

  (The `@cat-factory/executor-harness` bump is a test-only type fix — its fake
  `TokenUsageRepository` gains the new `usageBreakdownForWorkspace` method; nothing in the
  runner image changed.)

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/contracts@0.123.0
  - @cat-factory/kernel@0.115.0
  - @cat-factory/agents@0.52.0
  - @cat-factory/orchestration@0.102.0
  - @cat-factory/server@0.106.0
  - @cat-factory/node-server@0.89.0
  - @cat-factory/executor-harness@1.39.3
  - @cat-factory/gitlab@0.7.42
  - @cat-factory/integrations@0.79.1

## 0.62.0

### Minor Changes

- 0f3c88b: feat(testing): sealed sensitive test credentials, delivered to the Tester out of band

  Add a SEALED per-service store for sensitive testing credentials (e.g. a third-party API
  token a Tester needs), the sibling of the non-sensitive test-credential pools. Values are
  encrypted at rest by the facade `SecretCipher` (info tag `cat-factory:test-secrets`, mirroring
  `observability_connections`) and delivered to the Tester container **out of band**: decrypted at
  dispatch, carried on a dedicated job-body field the agent-context snapshot allow-list omits, and
  injected by the harness as container environment variables the agent reads (`$KEY`). The tester
  prompt advertises only each secret's key + description (never the value). Per service frame,
  resolved up the frame chain like release-health config; mirrored across both runtimes (D1 +
  Drizzle) with a cross-runtime conformance assertion.

  New API: `GET|PUT|DELETE /workspaces/:ws/services/:blockId/test-secrets` (values write-only).

  This is Slice C of the tester-environment-access initiative; the Test Data Seeder agent
  (Slice D) is a tracked follow-up. See docs/initiatives/tester-environment-access.md.

### Patch Changes

- Updated dependencies [0f3c88b]
  - @cat-factory/contracts@0.122.0
  - @cat-factory/kernel@0.114.0
  - @cat-factory/agents@0.51.0
  - @cat-factory/integrations@0.79.0
  - @cat-factory/orchestration@0.101.0
  - @cat-factory/server@0.105.0
  - @cat-factory/node-server@0.88.0
  - @cat-factory/executor-harness@1.39.2
  - @cat-factory/gitlab@0.7.41

## 0.61.10

### Patch Changes

- ed77be6: Initiative-preset registry → app-owned DI (slice 5 of the custom-initiative-definitions
  initiative; registry-DI-migration "Initiative presets" row). The module-global initiative-preset
  registry is replaced by an app-owned `InitiativePresetRegistry` instance the composition root news,
  threads through `CoreDependencies`, and re-exposes on `Core` — mirroring the agent-kind registry.
  This removes the shared process state and the external-adapter module-identity gotcha: a deployment
  registers its own presets by reference on the instance the facade injects.

  BREAKING: the free `@cat-factory/kernel` exports `registerInitiativePreset`,
  `registerInitiativePresets`, `getInitiativePreset`, `allInitiativePresets`,
  `initiativePresetDescriptors`, and `clearRegisteredInitiativePresets` are removed. Use the new
  `InitiativePresetRegistry` class (kernel) + `defaultInitiativePresetRegistry()` factory
  (`@cat-factory/agents`, preloads the built-in generic / docs-refresh / tech-migration presets)
  instead, and inject it via the facade's composition seam — `createApp({ overrides: {
initiativePresetRegistry } })` on the Worker, or the `initiativePresetRegistry` option on `start()`
  / `startLocal()`. `registerDocsRefreshPreset` / `registerTechMigrationPreset` now take the registry
  as a parameter (no bottom-of-module self-registration). No data migration — pre-1.0, no back-compat.

- Updated dependencies [ed77be6]
  - @cat-factory/kernel@0.113.0
  - @cat-factory/agents@0.50.0
  - @cat-factory/orchestration@0.100.2
  - @cat-factory/server@0.104.2
  - @cat-factory/node-server@0.87.10
  - @cat-factory/contracts@0.121.2
  - @cat-factory/gitlab@0.7.40
  - @cat-factory/integrations@0.78.8
  - @cat-factory/executor-harness@1.39.0

## 0.61.9

### Patch Changes

- 7ee2530: Internal cleanup: prune dead/needless exports flagged by knip (no runtime behaviour
  change). ~110 findings resolved — genuinely-dead symbols deleted (e.g. the unused
  `ENVIRONMENT_ANALYSIS_PIPELINE_ID` / `INITIATIVE_BREAKDOWN_PIPELINE_ID` pipeline-id
  constants, `isCiStatusProviderWired`, `parseApiKeyProvider`, unused re-export members of
  the runtime facade barrels), and the `export` keyword dropped from symbols only used
  inside their own module (repository classes, config constants, helper types). Also tidied
  stale `knip.jsonc` baseline entries (removed no-longer-needed `ignore` / `ignoreDependencies`
  and dead entry-glob patterns).

  The residual knip warnings are now all DELIBERATE: the neutral `VcsClient` port type
  re-export barrel, the Worker config-type barrel, the `providerEndpoints` base-URL group,
  and a couple of types that must stay exported for declaration emit. Since backwards
  compatibility is a non-goal pre-1.0, the removed exports (which nothing imported) are
  dropped outright rather than deprecated.

- Updated dependencies [7ee2530]
  - @cat-factory/agents@0.49.3
  - @cat-factory/integrations@0.78.7
  - @cat-factory/kernel@0.112.1
  - @cat-factory/orchestration@0.100.1
  - @cat-factory/server@0.104.1
  - @cat-factory/node-server@0.87.9
  - @cat-factory/gitlab@0.7.39
  - @cat-factory/executor-harness@1.39.0

## 0.61.8

### Patch Changes

- f25d5e2: Complete the two deferred service-connections Phase 4 multi-repo follow-ups.

  **Conflict-resolver peer targeting.** The `conflicts` gate now ESCALATES a conflict on a
  connected involved service's PEER repo (previously it declined escalation and fast-failed the run
  to a manual give-up). The gate still tags which repo conflicted (`conflictTarget`); the engine
  threads that onto the dispatched `conflict-resolver`'s context, and the container executor points
  the (single-repo) resolver at THAT peer repo — resolving its target, cloning its PR (work) branch,
  and merging the peer's base in — instead of always the task's own service. An own-repo conflict is
  unchanged (no `frameId` ⇒ the own service is the implicit target). Handles the peer-only case (own
  service unchanged, so no own PR) by pinning the resolve branch to the shared work branch.

  **Merger combined-diff.** The `merger` now scores the COMBINED cross-repo change on a multi-repo
  task instead of only the own-repo diff. Driven by the PRs that actually exist
  (`block.peerPullRequests`), it clones each peer PR's repo as a read-only sibling checkout at its PR
  branch (full history) alongside the own service, and a "Multi-repo pull request" prompt section
  plus the reworked merger prompts instruct it to diff each repo against its base and return ONE
  blended complexity/risk/impact assessment covering the whole change. The read-only multi-repo
  explore harness path gained per-peer `cloneBranch` selection and honours the job's `full` flag (a
  new container capability — the executor-harness image is bumped), so the bug-investigator's
  base-branch fan-out is unchanged while the merger checks each peer out at its PR head.

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0
  - @cat-factory/orchestration@0.100.0
  - @cat-factory/server@0.104.0
  - @cat-factory/executor-harness@1.39.0
  - @cat-factory/agents@0.49.2
  - @cat-factory/gitlab@0.7.38
  - @cat-factory/integrations@0.78.6
  - @cat-factory/node-server@0.87.8

## 0.61.7

### Patch Changes

- Updated dependencies [9aa9e19]
  - @cat-factory/contracts@0.121.1
  - @cat-factory/orchestration@0.99.1
  - @cat-factory/agents@0.49.1
  - @cat-factory/gitlab@0.7.37
  - @cat-factory/integrations@0.78.5
  - @cat-factory/kernel@0.111.1
  - @cat-factory/server@0.103.1
  - @cat-factory/node-server@0.87.7
  - @cat-factory/executor-harness@1.37.2

## 0.61.6

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/kernel@0.111.0
  - @cat-factory/agents@0.49.0
  - @cat-factory/server@0.103.0
  - @cat-factory/orchestration@0.99.0
  - @cat-factory/contracts@0.121.0
  - @cat-factory/gitlab@0.7.36
  - @cat-factory/integrations@0.78.4
  - @cat-factory/node-server@0.87.6
  - @cat-factory/executor-harness@1.37.2

## 0.61.5

### Patch Changes

- Updated dependencies [bcc843d]
  - @cat-factory/orchestration@0.98.1
  - @cat-factory/agents@0.48.5
  - @cat-factory/server@0.102.1
  - @cat-factory/kernel@0.110.1
  - @cat-factory/node-server@0.87.5
  - @cat-factory/executor-harness@1.37.2
  - @cat-factory/gitlab@0.7.35
  - @cat-factory/integrations@0.78.3

## 0.61.4

### Patch Changes

- 090ca89: Local mode now advertises the `cat-factory env` CLI when it fails to boot for a missing or invalid
  mandatory config value. The misconfiguration fallback (both the terminal log and the SPA's "backend
  misconfigured" screen) prepends a one-step remedy — `npx @cat-factory/cli env` generates a
  ready-to-run local-mode `.env` with every required value at once — above the per-variable remedies,
  so a developer can fix the whole file in one command instead of satisfying each secret/URL by hand.

  It covers every mandatory value: the three crypto secrets validated by `applyLocalDefaults`
  (`AUTH_SESSION_SECRET`, `ENCRYPTION_KEY`, `HARNESS_SHARED_SECRET`) and `DATABASE_URL`, which is
  validated inside the reused Node boot. The Node facade's `start()` gains an optional
  `augmentConfigProblems` seam that layers the facade-specific advice onto the problems it catches
  itself; the hosted Node/Worker facades pass nothing, so their remedies are unchanged.

- Updated dependencies [090ca89]
  - @cat-factory/node-server@0.87.4

## 0.61.3

### Patch Changes

- Updated dependencies [a2db337]
- Updated dependencies [a2db337]
  - @cat-factory/orchestration@0.98.0
  - @cat-factory/agents@0.48.4
  - @cat-factory/contracts@0.120.0
  - @cat-factory/kernel@0.110.0
  - @cat-factory/server@0.102.0
  - @cat-factory/node-server@0.87.3
  - @cat-factory/gitlab@0.7.34
  - @cat-factory/integrations@0.78.2
  - @cat-factory/executor-harness@1.37.2

## 0.61.2

### Patch Changes

- Updated dependencies [35636d5]
- Updated dependencies [35636d5]
  - @cat-factory/node-server@0.87.2
  - @cat-factory/agents@0.48.3
  - @cat-factory/orchestration@0.97.2
  - @cat-factory/server@0.101.2
  - @cat-factory/executor-harness@1.37.2

## 0.61.1

### Patch Changes

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1
  - @cat-factory/node-server@0.87.1
  - @cat-factory/agents@0.48.2
  - @cat-factory/gitlab@0.7.33
  - @cat-factory/integrations@0.78.1
  - @cat-factory/orchestration@0.97.1
  - @cat-factory/server@0.101.1
  - @cat-factory/executor-harness@1.37.2

## 0.61.0

### Minor Changes

- 8728bf7: Capture per-run diagnostics on `agent_runs` for after-the-fact investigation. Each run now
  records a `diagnostics` object (riding in the run's `detail` JSON, like `notes`/`frontendBindings`)
  with the most recent container-step dispatch context — `agentKind`, resolved `model`, the `repo`
  (owner/name/baseBranch/provider), the **execution backend** (`local-native` vs `local-container`
  vs `runner-pool` vs `cloudflare-container` — the datum that distinguishes a native host-process run
  from a sandboxed container), and the control-plane host `platform`. The backend is reported by the
  runner transport (a new optional `RunnerTransport.backend` / `RunnerJobView.backend`, stamped by
  the shared job client; the native/container router stamps its per-job leg).

  Also preserves the harness's fine-grained failure `cause` (`git` / `api` / `no-usable-output` /
  `no-changes`) on the failure's machine-readable `reason` instead of collapsing it to the coarse
  `agent` kind — so a push/clone failure reads as `git`, not a generic agent error, without grepping
  the transcript. No schema migration (the diagnostics ride in the existing `detail` column; the
  cause rides on the existing `failure.reason`); mirrored across both runtimes with a cross-runtime
  conformance round-trip assertion.

- 7157908: Expose the seeded default model preset as a programmatic override on the deploy-app boot
  seams, so a deployment can change its out-of-the-box default without editing library code.

  - `start({ defaultModelPresetId })` (Node) and `startLocal({ defaultModelPresetId })` (local)
    now accept the catalog id of the built-in preset a fresh workspace is seeded with as its
    default; it is forwarded to `buildNodeContainer` / `buildLocalContainer` (both the Postgres
    and mothership local paths). The Worker already honours `defaultModelPresetId` via
    `createApp`'s / `buildContainer`'s `overrides`; that read is now explicit rather than
    relying on the trailing spread.
  - `MODEL_PRESET_SEED_IDS` and `DEFAULT_MODEL_PRESET_ID` are re-exported from all three facade
    packages, so a wrapper can name a preset (`.kimi` / `.glm` / `.claude`) without a direct
    `@cat-factory/kernel` import.

  Applied only at the first seed of a workspace, so a user's later manual default choice is
  always preserved. Facade defaults are unchanged (Node/Cloudflare → Kimi K2.7, local → Claude
  Opus 4.8). Documented in the `deploy/{node,local,backend}` READMEs.

- 7157908: Model presets now support reseeding, mirroring pipelines and merge presets, plus a new
  built-in "Claude Opus 4.8" preset (everything `claude-opus`).

  - Built-in model presets carry stable catalog ids (`mdp_kimi` / `mdp_glm` / `mdp_claude`)
    and a monotonic `version`. The workspace snapshot ships `modelPresetCatalogVersions`, and
    `POST /workspaces/:ws/model-presets/:id/reseed` restores a built-in to the current catalog
    (adopt an update, repair drift, or materialise a new built-in that appeared). The SPA gains
    a once-per-session "model preset updates" advisory (reseed / add) like the pipeline and
    merge-preset ones.
  - The seeded workspace DEFAULT preset is now a deployment fact: Cloudflare and Node default to
    Kimi K2.7 (Cloudflare-runnable on the bare baseline), local mode defaults to Claude Opus 4.8
    (local runs subscription models via the ambient CLI / a leased personal credential). The
    deployment default is applied only at first seed, so a user's later manual default choice is
    always preserved.

  Breaking (pre-1.0, no migration): model presets gain a nullable `version` column
  (D1 `0043_model_preset_versioning`; Drizzle migration). Workspaces seeded before this change
  hold the old index-based preset ids (`mdp-seed-0/1`); they are treated as custom presets, and
  the three stable built-ins are offered via the reseed advisory rather than migrated in place.

### Patch Changes

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
- Updated dependencies [7157908]
  - @cat-factory/contracts@0.119.0
  - @cat-factory/kernel@0.109.0
  - @cat-factory/server@0.101.0
  - @cat-factory/orchestration@0.97.0
  - @cat-factory/integrations@0.78.0
  - @cat-factory/node-server@0.87.0
  - @cat-factory/agents@0.48.1
  - @cat-factory/gitlab@0.7.32
  - @cat-factory/executor-harness@1.37.2

## 0.60.4

### Patch Changes

- 42b5e76: Fix authenticated git clone/push failing with `fatal: unable to get password from user`. The
  non-interactive-auth hardening added `-c credential.interactive=false` to every git invocation,
  but modern git (≥ 2.47 — the executor image and host git) honors `credential.interactive` and
  treats invoking `GIT_ASKPASS` as interactive, so it skipped the harness askpass entirely and
  never sent the PAT — breaking every authenticated push on both the native and container paths (a
  public base repo still clones anonymously, so it only surfaced at push, looking intermittent).
  The flag is removed; the emptied credential-helper list plus `GIT_TERMINAL_PROMPT=0` /
  `GCM_INTERACTIVE=never` already defeat the Git Credential Manager popup it was meant to guard
  against. Bumps the runner image (and the local-mode pin) to `cat-factory-executor:1.37.1`.
- Updated dependencies [42b5e76]
  - @cat-factory/executor-harness@1.37.2

## 0.60.3

### Patch Changes

- Updated dependencies [629cf90]
  - @cat-factory/node-server@0.86.8

## 0.60.2

### Patch Changes

- Updated dependencies [4775c40]
  - @cat-factory/agents@0.48.0
  - @cat-factory/orchestration@0.96.3
  - @cat-factory/server@0.100.2
  - @cat-factory/node-server@0.86.7
  - @cat-factory/executor-harness@1.37.0

## 0.60.1

### Patch Changes

- Updated dependencies [f97d5d3]
  - @cat-factory/agents@0.47.0
  - @cat-factory/orchestration@0.96.2
  - @cat-factory/server@0.100.1
  - @cat-factory/node-server@0.86.6
  - @cat-factory/executor-harness@1.37.0

## 0.60.0

### Minor Changes

- b3bd653: Make `HARNESS_SHARED_SECRET` a mandatory, stable local-mode secret and a required runner-transport parameter.

  Local mode previously let the runner transports mint a RANDOM `HARNESS_SHARED_SECRET` per process when the env var was unset. That value is the inbound-auth secret between the orchestrator and its agent containers, so after a restart, polls against a container still running from before the restart failed auth (not mapped to eviction) and the run flapped instead of re-attaching.

  Now:

  - `applyLocalDefaults` REQUIRES `HARNESS_SHARED_SECRET` (min 16 chars) and fails loudly at boot with a clear, actionable error when it is missing/blank/too-short, exactly like `AUTH_SESSION_SECRET` / `ENCRYPTION_KEY`.
  - `sharedSecret` is now a REQUIRED constructor argument on `LocalContainerRunnerTransport`, `LocalProcessRunnerTransport`, and `LocalPreviewTransport` — the random per-process fallback is gone. The `*FromEnv` factories read it via the new `requireHarnessSharedSecret(env)`.
  - `pnpm secrets` (deploy/local) now emits `HARNESS_SHARED_SECRET` alongside the other two, and `deploy/local/.env.example` documents it.

  BREAKING (local mode): a local deployment with no `HARNESS_SHARED_SECRET` set now fails at boot instead of running with an unstable per-process secret. Set a stable value (via `pnpm secrets`) before upgrading.

### Patch Changes

- cb088c7: Cap concurrent inline (non-container) LLM calls to a subscription/shared-pool vendor so a burst
  can't overwhelm it. A new `VendorConcurrencyLimiter` + `LimitedModelProvider` decorator
  (`@cat-factory/agents`) gates each resolved subscription-vendor model behind an in-process
  per-vendor semaphore, keyed by `subscriptionVendorForRef(ref)`. It is applied as the outermost
  resolver wrap in every facade via `wrapResolverWithLimiter` (`@cat-factory/server`), mirroring the
  existing `InstrumentedModelProvider` shape, so no inline call site changes. Both the buffered
  (`wrapGenerate`) and streaming (`wrapStream`) inline paths are gated — a stream holds its permit
  until it ends — and a queued call whose request is aborted releases its slot instead of
  head-of-line blocking. Only the five subscription vendors (`claude`/`codex`/`glm`/`kimi`/`deepseek`)
  are capped; API-key vendors and Cloudflare pass through untouched.

  Configured by `LLM_SUBSCRIPTION_MAX_CONCURRENCY` (default 3 per vendor; a
  `LLM_SUBSCRIPTION_MAX_CONCURRENCY_<VENDOR>` overrides that one vendor and always wins). Any value
  `<= 0` is uncapped, so setting the default to `0` uncaps every vendor that has no explicit
  per-vendor override (to turn the feature off entirely, leave the per-vendor overrides unset too).
  The limiter is
  in-process only — one per Node process (per container/tenant) or per Worker isolate, which is the
  scope of a single inline fan-out (a consensus panel, the requirements recommendation writer, a
  sandbox sweep). It bounds in-flight concurrency, not requests-per-minute, and does not coordinate
  across replicas/isolates; global rate-limiting stays out of scope. Because inline subscription
  refs are degraded to a pool/API-key provider before resolve on Node/Worker, the cap primarily
  bites in local mode (the prewarmed-container inline subscription backend keeps the ref) and is a
  wired pass-through elsewhere.

- Updated dependencies [cb088c7]
- Updated dependencies [b3bd653]
  - @cat-factory/agents@0.46.0
  - @cat-factory/server@0.100.0
  - @cat-factory/node-server@0.86.5
  - @cat-factory/orchestration@0.96.1
  - @cat-factory/executor-harness@1.37.0

## 0.59.4

### Patch Changes

- Updated dependencies [09a1c85]
  - @cat-factory/agents@0.45.0
  - @cat-factory/orchestration@0.96.0
  - @cat-factory/server@0.99.8
  - @cat-factory/node-server@0.86.4
  - @cat-factory/executor-harness@1.37.0

## 0.59.3

### Patch Changes

- Updated dependencies [785576b]
  - @cat-factory/agents@0.44.1
  - @cat-factory/orchestration@0.95.3
  - @cat-factory/server@0.99.7
  - @cat-factory/node-server@0.86.3
  - @cat-factory/executor-harness@1.37.0

## 0.59.2

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/agents@0.44.0
  - @cat-factory/kernel@0.108.0
  - @cat-factory/orchestration@0.95.2
  - @cat-factory/server@0.99.6
  - @cat-factory/node-server@0.86.2
  - @cat-factory/gitlab@0.7.31
  - @cat-factory/integrations@0.77.8
  - @cat-factory/executor-harness@1.37.0

## 0.59.1

### Patch Changes

- @cat-factory/agents@0.43.1
- @cat-factory/orchestration@0.95.1
- @cat-factory/server@0.99.5
- @cat-factory/node-server@0.86.1
- @cat-factory/executor-harness@1.37.0

## 0.59.0

### Minor Changes

- 44fafa4: Inline subscription LLM steps can now run inside a prewarmed local container on a leased
  subscription credential (initiative phase C2). The executor-harness gains a one-shot `inline`
  job kind that runs `claude -p` / `codex exec` with no checkout and returns the completion text +
  usage; the local `LocalContainerRunnerTransport` leases a warm pool member to serve it. The
  local inline resolver now selects the developer's host CLI when its binary is present (ambient,
  unmetered) and otherwise the container backend on a leased credential — personal per-run
  activation for an individual vendor (Claude/Codex/GLM), a pooled token otherwise (Kimi/DeepSeek).
  This lets a subscription-only preset run its inline reviewers/brainstorm/estimator even when the
  host has no `claude`/`codex` binary and in mothership mode, and extends inline coverage to the
  non-native claude-code vendors.

  Mechanics: `ModelScope` gains an `executionId` run dimension and `resolveScopedModelProvider`
  takes the full scope; the inline callers (the iterative reviewers, the doc/initiative
  interviewers, the tester quality companion, Kaizen, and the AI/consensus agent executors) thread
  the run's execution + initiator so the container backend can lease the right credential.
  `buildNodeContainer`'s `wrapModelProviderResolver` seam now receives the subscription lease
  closures. Bumps the executor-harness image tag (the harness `inline` kind is new image code).

### Patch Changes

- Updated dependencies [44fafa4]
  - @cat-factory/executor-harness@1.37.0
  - @cat-factory/node-server@0.86.0
  - @cat-factory/orchestration@0.95.0
  - @cat-factory/kernel@0.107.0
  - @cat-factory/agents@0.43.0
  - @cat-factory/server@0.99.4
  - @cat-factory/gitlab@0.7.30
  - @cat-factory/integrations@0.77.7

## 0.58.3

### Patch Changes

- Updated dependencies [cd60892]
  - @cat-factory/orchestration@0.94.0
  - @cat-factory/server@0.99.3
  - @cat-factory/node-server@0.85.10
  - @cat-factory/executor-harness@1.35.0

## 0.58.2

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/agents@0.42.0
  - @cat-factory/kernel@0.106.0
  - @cat-factory/orchestration@0.93.1
  - @cat-factory/server@0.99.2
  - @cat-factory/node-server@0.85.9
  - @cat-factory/gitlab@0.7.29
  - @cat-factory/integrations@0.77.6
  - @cat-factory/executor-harness@1.35.0

## 0.58.1

### Patch Changes

- Updated dependencies [f7f9a9e]
  - @cat-factory/orchestration@0.93.0
  - @cat-factory/server@0.99.1
  - @cat-factory/node-server@0.85.8
  - @cat-factory/executor-harness@1.35.0

## 0.58.0

### Minor Changes

- e3cfd61: Run inline LLM steps on a subscription-only model by default in local and mothership mode.

  A preset that pins everything to a subscription-only model (e.g. `claude-opus`) used to be
  refused at pipeline start with `preset_unsatisfiable` unless you also enabled
  `LOCAL_NATIVE_AGENTS`, which runs whole container agents unsandboxed. The inline steps
  (requirements reviewer, brainstorm, task-estimator, inline document kinds) are one-shot text
  calls with no repo checkout or tools, so they now run on the developer's ambient `claude` /
  `codex` CLI by default, via a dedicated `LOCAL_NATIVE_INLINE` flag (default on) that is
  decoupled from the container-native opt-in. Set `LOCAL_NATIVE_INLINE=off` to disable, or list a
  subset (e.g. `claude-code`) to restrict which vendors are inline-eligible. Only the native
  vendors (`claude` / `codex`) are eligible; a non-native vendor reusing the `claude-code` harness
  (GLM / Kimi / DeepSeek) still degrades to a provider model for inline steps.

## 0.57.7

### Patch Changes

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/agents@0.41.0
  - @cat-factory/kernel@0.105.0
  - @cat-factory/integrations@0.77.5
  - @cat-factory/contracts@0.118.0
  - @cat-factory/orchestration@0.92.0
  - @cat-factory/server@0.99.0
  - @cat-factory/node-server@0.85.7
  - @cat-factory/gitlab@0.7.28
  - @cat-factory/executor-harness@1.35.0

## 0.57.6

### Patch Changes

- 8f7af8e: Make ephemeral-environment provisioning DETECTION more universal — so it adapts to repos that
  follow different conventions than the stack-recipes pilot (different names, paths, tech stack). The
  changes are additive in the sense that detection can only ever surface MORE — it never removes or
  changes an existing detection, and a repo with no monorepo service-container dirs resolves exactly
  as before. Note the one behavioural change below: the env-template scan now also looks one level into
  `services/*`/`apps/*`/`packages/*`, so a monorepo that keeps per-service templates there will now
  surface them as low-confidence, user-confirmed `recipe.envFiles` where it previously surfaced none.

  - **Injectable detection conventions (deployment config).** A deployment can extend the built-in
    compose file names/dirs, seed dirs, and env-template dirs via the `ENVIRONMENTS_DETECTION_CONVENTIONS`
    JSON env var, threaded additively (built-ins always win; canonical compose names stay
    highest-priority) through `CoreDependencies.detectionConventions` into BOTH the service-provisioning
    detector (`EnvironmentConnectionService`) and the shared-stack detector (`SharedStackService`). New
    `parseDetectionConventions` + `EnvironmentsConfig.detectionConventions` (`@cat-factory/server`,
    parsed by both facades) and the exported `DetectionConventions` type (`@cat-factory/integrations`).
  - **Env-template detection now scans one level into monorepo service-container dirs** (`services/*`,
    `apps/*`, `packages/*`), so a per-service `*-dist`/`.example` template outside the compose dir (the
    pilot's documented `services/app/` gap) is surfaced — still bounded by the existing read budget.
    This is on by default (not gated behind conventions), so any monorepo with a compose file AND
    per-service templates newly gets those as `recipe.envFiles`; they are low-confidence and confirmed
    in the wizard before anything is materialized.
  - **The environment setup wizard elevates the "run deep analysis" nudge** when a repo ships its own
    imperative bring-up CLI/Makefile the deterministic scan can't read (`@cat-factory/app`), pointing the
    user at the LLM analyst — the intended universality mechanism for stack-specific imperative steps.

- Updated dependencies [8f7af8e]
- Updated dependencies [8f7af8e]
  - @cat-factory/integrations@0.77.4
  - @cat-factory/server@0.98.3
  - @cat-factory/orchestration@0.91.1
  - @cat-factory/node-server@0.85.6
  - @cat-factory/executor-harness@1.35.0

## 0.57.5

### Patch Changes

- Updated dependencies [4a3e536]
  - @cat-factory/orchestration@0.91.0
  - @cat-factory/contracts@0.117.0
  - @cat-factory/server@0.98.2
  - @cat-factory/node-server@0.85.5
  - @cat-factory/agents@0.40.13
  - @cat-factory/gitlab@0.7.27
  - @cat-factory/integrations@0.77.3
  - @cat-factory/kernel@0.104.4
  - @cat-factory/executor-harness@1.35.0

## 0.57.4

### Patch Changes

- Updated dependencies [18a9cb5]
  - @cat-factory/contracts@0.116.1
  - @cat-factory/agents@0.40.12
  - @cat-factory/gitlab@0.7.26
  - @cat-factory/integrations@0.77.2
  - @cat-factory/kernel@0.104.3
  - @cat-factory/orchestration@0.90.1
  - @cat-factory/server@0.98.1
  - @cat-factory/node-server@0.85.4
  - @cat-factory/executor-harness@1.35.0

## 0.57.3

### Patch Changes

- Updated dependencies [bc77f89]
  - @cat-factory/contracts@0.116.0
  - @cat-factory/orchestration@0.90.0
  - @cat-factory/server@0.98.0
  - @cat-factory/kernel@0.104.2
  - @cat-factory/agents@0.40.11
  - @cat-factory/gitlab@0.7.25
  - @cat-factory/integrations@0.77.1
  - @cat-factory/node-server@0.85.3
  - @cat-factory/executor-harness@1.35.0

## 0.57.2

### Patch Changes

- Updated dependencies [802fc05]
  - @cat-factory/orchestration@0.89.0
  - @cat-factory/integrations@0.77.0
  - @cat-factory/contracts@0.115.0
  - @cat-factory/server@0.97.2
  - @cat-factory/node-server@0.85.2
  - @cat-factory/agents@0.40.10
  - @cat-factory/gitlab@0.7.24
  - @cat-factory/kernel@0.104.1
  - @cat-factory/executor-harness@1.35.0

## 0.57.1

### Patch Changes

- a869ae9: Initiative presets — slice 2: the per-run gate-override engine seam.

  - **orchestration** (`ExecutionService.start`): a new optional `gatesOverride` argument — one
    boolean per pipeline step, indexed by the pipeline's ORIGINAL step index exactly like
    `pipeline.gates` — that REPLACES the pipeline's declared approval gates for a single run. It is
    copied onto the run's steps (`requiresApproval`, `gatesOverride?.[i] ?? pipeline.gates?.[i]`), so
    a retry/restart — which re-drive the STORED steps — preserve it with no extra persistence. A
    length that doesn't match the pipeline's step count is rejected up front (a `ValidationError`)
    before any side effects. Absent ⇒ today's behaviour byte-for-byte.
  - **orchestration** (`InitiativeLoopService`): a spawned item's preset-authored `spawn.gates` is
    threaded straight into `ExecutionService.start` as that run's gate override, so a spawned task
    gates (or doesn't) per the preset's human-review mapping instead of the pipeline default.

  Conformance: a new `startExecution` harness probe (start a run through the real `ExecutionService`
  with an optional gate override — a path no HTTP route exposes) plus shared assertions that an
  override flips a step's approval gate on/off, round-trips `requiresApproval` through each store, and
  rejects a mismatched-length override — run identically on the Cloudflare (D1) and Node/local
  (Postgres) facades.

- Updated dependencies [a869ae9]
  - @cat-factory/orchestration@0.88.0
  - @cat-factory/node-server@0.85.1
  - @cat-factory/server@0.97.1
  - @cat-factory/executor-harness@1.35.0

## 0.57.0

### Minor Changes

- 6198b08: Missing mandatory env vars / bindings now produce human-readable, actionable startup errors AND a
  graceful degraded backend instead of an opaque crash.

  - **Shared structured config errors.** A new `ConfigValidationError` (carrying a list of
    `ConfigProblem { key, summary, remedy }`) plus a canonical `ENV_HELP` description table and a
    `requireEnv` helper live in `@cat-factory/server`. Every facade's startup throw for a mandatory
    variable (`DATABASE_URL`, `ENCRYPTION_KEY`, `AUTH_SESSION_SECRET`, a configured auth provider,
    `TELEMETRY_DB`, `AGENT_MODELS`, the container-executor prerequisites) now routes through it, so the
    message reads the same across Node, local, and the Worker and always says what the variable is for
    and how to fill it. A `ConfigProblem` never carries a secret value.

  - **Graceful misconfiguration fallback backend.** Instead of exiting (which left the SPA on a generic
    "can't reach the backend" panel with no clue what was wrong), a facade that hits a
    `ConfigValidationError` at boot now serves a minimal fallback app (`createMisconfiguredApp`) on the
    normal port: `GET /auth/config` returns an auth-disabled config carrying the problem list, `/health`
    stays 200 (`status: misconfigured`, so an orchestrator doesn't crash-loop it), and every other route
    503s with the structured problems. Wired symmetrically in all three runtimes — Node/local
    `serveMisconfigured`, the Worker's per-request build (which recovers automatically once bindings are
    fixed).

  - **Dedicated frontend error screen.** The SPA's boot handshake now recognises the `misconfigured`
    field and renders `BackendMisconfiguredScreen` — a per-variable list of name + meaning + remedy with
    a reload button — instead of the login/board. Fully translated across all locales.

### Patch Changes

- Updated dependencies [6198b08]
- Updated dependencies [37d1517]
  - @cat-factory/contracts@0.114.0
  - @cat-factory/server@0.97.0
  - @cat-factory/node-server@0.85.0
  - @cat-factory/kernel@0.104.0
  - @cat-factory/integrations@0.76.0
  - @cat-factory/orchestration@0.87.0
  - @cat-factory/agents@0.40.9
  - @cat-factory/gitlab@0.7.23
  - @cat-factory/executor-harness@1.35.0

## 0.56.0

### Minor Changes

- 14eac27: Add an account-wide model-family allow/block policy. An account admin can constrain which
  LLM families their teams run (block/allow lists over families like DeepSeek, Qwen, Claude,
  OpenAI), gated to the Cloudflare / remote-Node / mothership runtimes (never plain local
  mode). The policy is evaluated against `(family, effective-route provider)`, so a
  residency-guaranteed route (`trustedProviders`, e.g. Bedrock) can exempt an otherwise-blocked
  family — data-residency risk is a property of the serving route, not the model weights.
  Region-grouped built-in presets (USA / Europe / China / Other) ship as apply-in templates.

  Stored on the existing per-account settings config blob (no migration). Enforced through a
  single choke point (`ProviderCapabilities`): the `/models` catalog flags blocked models
  (`available: false` + `policyBlocked: true`) and the pipeline start guard refuses them
  (`model_policy_blocked`). The per-account policy read is cached via a new `accountModelPolicy`
  slice of the app cache seam (`AppCaches`), invalidated on the account-settings write.

### Patch Changes

- Updated dependencies [14eac27]
  - @cat-factory/contracts@0.113.0
  - @cat-factory/kernel@0.103.0
  - @cat-factory/server@0.96.0
  - @cat-factory/orchestration@0.86.0
  - @cat-factory/node-server@0.84.0
  - @cat-factory/agents@0.40.8
  - @cat-factory/gitlab@0.7.22
  - @cat-factory/integrations@0.75.1
  - @cat-factory/executor-harness@1.35.0

## 0.55.4

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/contracts@0.112.0
  - @cat-factory/kernel@0.102.0
  - @cat-factory/integrations@0.75.0
  - @cat-factory/orchestration@0.85.0
  - @cat-factory/server@0.95.0
  - @cat-factory/agents@0.40.7
  - @cat-factory/gitlab@0.7.21
  - @cat-factory/node-server@0.83.1
  - @cat-factory/executor-harness@1.35.0

## 0.55.3

### Patch Changes

- 23f7342: Mothership mode: give the four remaining `local-sqlite` bucket repositories a `node:sqlite` home on
  the laptop, so the subscription features and the local-mode settings panel work in mothership mode
  (previously their services were OFF for lack of a database).

  - The local credential store (`credentialStore.ts`) gains three sealed-credential repositories —
    `SqliteProviderSubscriptionTokenRepository` (the per-workspace pooled Claude Code / Codex / GLM
    subscription tokens), `SqlitePersonalSubscriptionRepository` (per-user individual-usage
    credentials, the outer double-encryption blob), and `SqliteSubscriptionActivationRepository`
    (their short-lived per-run, system-key-only copies). A new `localSettingsStore.ts` holds the
    local-mode operational settings singleton (`SqliteLocalSettingsRepository`), kept out of the
    credential store so its "only credentials" invariant holds.
  - All mirror their `D1*` SQL (D1 is SQLite) and stay LOCAL for the same reason the API-key pool
    does: the tokens are leased + decrypted by the LOCAL container executor with the LOCAL key, so
    they must never traverse the machine API to the mothership.
  - New `NodeContainerOptions` credential-override seams (`providerSubscriptionTokenRepository` /
    `personalSubscriptionRepository` / `subscriptionActivationRepository`, mirroring the existing
    `providerApiKeyRepository` seam) let `buildNodeSubscriptionService` /
    `buildNodePersonalSubscriptionService` build without a `db`; the activation repo is threaded once
    and shared by both its consumers (the personal-subscription service's mint + the engine core's
    clear-on-completion). `localSettingsService` is built in the local facade from the local-sqlite
    repo when there is no `db`.

- Updated dependencies [23f7342]
- Updated dependencies [fdba1ea]
  - @cat-factory/node-server@0.83.0
  - @cat-factory/contracts@0.111.0
  - @cat-factory/integrations@0.74.0
  - @cat-factory/orchestration@0.84.0
  - @cat-factory/agents@0.40.6
  - @cat-factory/gitlab@0.7.20
  - @cat-factory/kernel@0.101.2
  - @cat-factory/server@0.94.3
  - @cat-factory/executor-harness@1.35.0

## 0.55.2

### Patch Changes

- Updated dependencies [6a701ef]
  - @cat-factory/integrations@0.73.6
  - @cat-factory/orchestration@0.83.2
  - @cat-factory/server@0.94.2
  - @cat-factory/node-server@0.82.2
  - @cat-factory/executor-harness@1.35.0

## 0.55.1

### Patch Changes

- Updated dependencies [10787c4]
  - @cat-factory/contracts@0.110.1
  - @cat-factory/kernel@0.101.1
  - @cat-factory/orchestration@0.83.1
  - @cat-factory/integrations@0.73.5
  - @cat-factory/agents@0.40.5
  - @cat-factory/gitlab@0.7.19
  - @cat-factory/server@0.94.1
  - @cat-factory/node-server@0.82.1
  - @cat-factory/executor-harness@1.35.0

## 0.55.0

### Minor Changes

- c66362f: Remove the `ENVIRONMENTS_ENABLED` deployment flag; the ephemeral-environment
  integration now assembles wherever the shared `ENCRYPTION_KEY` is set, the same
  "always on where the key is present" model as the document/task sources.

  The flag was a footgun: it defaulted off and its only effect was to make the whole
  integration silently inert (auto-detect 503ing with `unavailable`) even when the real
  prerequisites — an encryption key plus a registered per-workspace connection — were
  present. Whether a workspace provisions anything is already governed by whether it
  connects a provider and whether its pipeline includes a `deployer`/`tester` step, so to
  keep environments out of a pipeline you simply omit those steps. `EnvironmentsConfig`
  drops its `enabled` field and the module gates on `encryptionKey` presence in all three
  runtimes.

  Breaking: `ENVIRONMENTS_ENABLED` is no longer read; remove it from deployment config
  (setting it has no effect). The inspector's dedicated "ephemeral environments aren't
  enabled" auto-detect panel is removed with it, since that off state no longer exists.

### Patch Changes

- Updated dependencies [c66362f]
  - @cat-factory/server@0.94.0
  - @cat-factory/node-server@0.82.0
  - @cat-factory/executor-harness@1.35.0

## 0.54.0

### Minor Changes

- cc74273: Add an optional `backendRegistries` seam to `startLocal()`, threaded into `buildLocalContainer`
  on both the Postgres and mothership boot paths (mirroring the existing `agentKindRegistry` seam).

  This lets a deployment that registers a custom environment/runner backend by reference (e.g. an
  in-house ephemeral-environment provider) call `startLocal()` — and inherit its boot preflights
  (harness-image refresh, container-runtime probe, PAT/auth warnings) — instead of re-implementing
  the boot path with `start()` + `buildLocalContainer` by hand, which silently forgoes those
  preflights (notably the recommended-executor-image pull at boot). Absent → unchanged (the
  built-in-only default `manifest` + `kubernetes`).

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/contracts@0.110.0
  - @cat-factory/kernel@0.101.0
  - @cat-factory/orchestration@0.83.0
  - @cat-factory/server@0.93.0
  - @cat-factory/agents@0.40.4
  - @cat-factory/gitlab@0.7.18
  - @cat-factory/integrations@0.73.4
  - @cat-factory/node-server@0.81.1
  - @cat-factory/executor-harness@1.35.0

## 0.53.0

### Minor Changes

- 9ea1e77: Tiered spend budgets (account / workspace / user) with operator hard caps.

  Budgets are now tracked and enforced across three tiers: the existing per-workspace
  monthly limit, a per-account limit, and a per-user limit. A run pauses when any applicable
  tier is exhausted. All three tiers are configurable and visible in the Budget settings
  screen.

  Two new environment variables (`BUDGET_MAX_MONTHLY_PER_ACCOUNT`,
  `BUDGET_MAX_MONTHLY_PER_USER`), read by the Node and Cloudflare config loaders, set
  operator hard ceilings on the account/user tiers; the UI cannot exceed a configured cap and
  shows it on the budget screen. See `docs/environment-variables.md` and
  `docs/initiatives/tiered-budgets.md`.

  Breaking (pre-1.0, no data migration): the `token_usage` ledger gains nullable
  `account_id`/`user_id` columns (existing rows are unattributed and excluded from the new
  account/user rollups until re-metered); `TokenUsageRecord`, `RecordUsageInput`, and
  `SpendPricing` gained fields; `SpendService.isOverBudget` now takes an optional tier scope.
  A new `user_settings` table and `GET/PUT /user-settings` endpoint carry the user-tier
  budget.

### Patch Changes

- Updated dependencies [9ea1e77]
  - @cat-factory/contracts@0.109.0
  - @cat-factory/kernel@0.100.0
  - @cat-factory/orchestration@0.82.0
  - @cat-factory/server@0.92.0
  - @cat-factory/node-server@0.81.0
  - @cat-factory/agents@0.40.3
  - @cat-factory/gitlab@0.7.17
  - @cat-factory/integrations@0.73.3
  - @cat-factory/executor-harness@1.35.0

## 0.52.4

### Patch Changes

- e66accb: Stack recipes & shared stacks (slice 7): make the Deployer the sole docker-compose provisioner + the environment setup wizard scaffolding.

  **Deployer becomes the single docker-compose provisioner (the compose-centralization follow-up owed by this slice).** Now that the setup wizard can save a `docker-compose` handler, docker-compose is provisioned by the single Deployer step through a workspace handler, exactly like `kubernetes`/`custom` — the in-container (DinD) bring-up is retired from the run-mode decision:

  - `decideTesterInfra` (`tester-infra.logic.ts`): `docker-compose` is handler-based (drops the `localTestInfraSupported`/`hasComposePath` inputs and the `limited-local`/`compose-unconfigured` reasons).
  - `needsDeployerBeforeConsumer` + `ExecutionService.assertTesterInfraConfigured`'s `needsHandler` now cover `docker-compose`, so a compose chain that reaches a tester with no resolvable handler is refused at run start (fail-fast, same as k8s/custom) instead of dead-ending.
  - `testerInfraSpec` (`@cat-factory/server`): `docker-compose` targets the Deployer-provisioned env (`environment: 'ephemeral'`); the `local`/`composePath` branch is gone.
  - (The harness's in-container `docker compose up` is now unreachable and retired in a later image-bumping slice.)

  **Environment setup wizard.** The guided detect → review → preflight → save flow the compose-centralization depends on: `EnvironmentSetupWizard.vue` (stepper shell over the `environmentWizard` store — detection, opt-in deep analysis via `pl_environment_analysis` with live provenance-merged review, compose-file/profile/seed candidate pickers, a raw-recipe editor, the preflight checklist, save the workspace compose handler + the frame recipe, and an optional trial provision with live provisioning logs), a docker-compose service-inspector nudge, a SideBar entry, the mount in `pages/index.vue`, and the `environmentWizard` i18n namespace across all 8 locales. Backed by the `preflights` API + store (`POST /workspaces/:ws/preflights/run`) and the `provisionEnvironment` API. (The `data-testid`-only e2e spec is deferred — it needs a fake `ProvisioningRepoReader` e2e seam so detection returns a canned recommendation with GitHub off; tracked in the slice-7 checklist.)

  Breaking (pre-1.0, acceptable): a `docker-compose` service reaching a tester/human-test with no configured compose handler is now refused at run start rather than falling back to an in-container compose bring-up.

  Review follow-ups in the same slice: the `environmentWizard` store now fully resets per-frame state when re-targeted (`selectFrame` no longer leaves a prior frame's `saved`/service/port behind), resolves the analyst run by preferring a live/succeeded instance over a bare `.at(-1)` (so a retry's dead predecessor can't mask the successful run), validates the exposed port before registering the handler, and surfaces a real (non-503) preflight failure instead of swallowing it. The now-dead `localTestInfraSupported` dependency (its only reads were removed with the DinD path) is dropped from `CoreDependencies`/`ExecutionService` and the local facade's wiring, and the stale DinD doc comments on `assertTesterInfraConfigured` / `testerInfraSpec` are corrected.

- Updated dependencies [e66accb]
  - @cat-factory/orchestration@0.81.0
  - @cat-factory/server@0.91.0
  - @cat-factory/contracts@0.108.1
  - @cat-factory/node-server@0.80.5
  - @cat-factory/executor-harness@1.35.0
  - @cat-factory/agents@0.40.2
  - @cat-factory/gitlab@0.7.16
  - @cat-factory/integrations@0.73.2
  - @cat-factory/kernel@0.99.1

## 0.52.3

### Patch Changes

- Updated dependencies [9cc02a0]
  - @cat-factory/integrations@0.73.1
  - @cat-factory/orchestration@0.80.1
  - @cat-factory/server@0.90.3
  - @cat-factory/node-server@0.80.4
  - @cat-factory/executor-harness@1.35.0

## 0.52.2

### Patch Changes

- Updated dependencies [1afa003]
- Updated dependencies [f91b99d]
  - @cat-factory/kernel@0.99.0
  - @cat-factory/orchestration@0.80.0
  - @cat-factory/integrations@0.73.0
  - @cat-factory/contracts@0.108.0
  - @cat-factory/agents@0.40.1
  - @cat-factory/gitlab@0.7.15
  - @cat-factory/server@0.90.2
  - @cat-factory/node-server@0.80.3
  - @cat-factory/executor-harness@1.35.0

## 0.52.1

### Patch Changes

- Updated dependencies [eef8612]
- Updated dependencies [bf31df7]
  - @cat-factory/integrations@0.72.1
  - @cat-factory/contracts@0.107.0
  - @cat-factory/agents@0.40.0
  - @cat-factory/kernel@0.98.0
  - @cat-factory/orchestration@0.79.1
  - @cat-factory/server@0.90.1
  - @cat-factory/node-server@0.80.2
  - @cat-factory/gitlab@0.7.14
  - @cat-factory/executor-harness@1.35.0

## 0.52.0

### Minor Changes

- 6f9d935: Stack recipes & shared stacks (slice 6): preflight prerequisite checks with guided remediation.

  A stack recipe can now declare machine `prerequisites: PreflightRef[]` — automated PROBE + human REMEDIATION checks for the inherently-manual one-time machine setup a complex compose repo needs (docker daemon reachable, free disk / RAM, container-registry login state, VPN reachability, mkcert CA, hosts-file entries, an env-file secrets marker). They are re-run at provision start: a failing REQUIRED check fails the provision fast with its copy-paste remediation in the provisioning log, instead of a mystery deep inside a 40-image pull (a non-required check is advisory — a warning). A `POST /workspaces/:ws/preflights/run` endpoint runs an arbitrary set of checks for the setup wizard's live re-check.

  - Contracts: `PreflightCheckId` / `PreflightParams` / `PreflightRef` / `PreflightResult` (`preflights.ts`) + `prerequisites` on `stackRecipeSchema`; the `runPreflightsContract` route.
  - Kernel: the runtime-bound `PreflightHostProbes` seam + `PreflightProbeOutcome`, and a `runPreflights` seam on `ProvisionEnvironmentRequest`.
  - Integrations: `PreflightService` (runtime-neutral orchestration over the probe seam) + provision-start enforcement in `ComposeEnvironmentProvider`.
  - Server: `PreflightController`.
  - Local facade: `createDockerPreflightProbes` (the host probes over the docker CLI + `node:*`), wired only where the compose runtime is (a Docker-family host daemon). The probes are runtime-bound (local facade only, the documented compose exception); the declaration + API are runtime-neutral and the recipe rides the existing `provisioning` blob, so there is no migration. On the Worker / plain Node the preflight API 503s and a recipe that declares prerequisites fails loudly at provision.

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/contracts@0.106.0
  - @cat-factory/kernel@0.97.0
  - @cat-factory/integrations@0.72.0
  - @cat-factory/orchestration@0.79.0
  - @cat-factory/server@0.90.0
  - @cat-factory/agents@0.39.4
  - @cat-factory/gitlab@0.7.13
  - @cat-factory/node-server@0.80.1
  - @cat-factory/executor-harness@1.35.0

## 0.51.2

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [e5b9462]
- Updated dependencies [dd6df12]
  - @cat-factory/contracts@0.105.0
  - @cat-factory/kernel@0.96.0
  - @cat-factory/server@0.89.0
  - @cat-factory/orchestration@0.78.0
  - @cat-factory/node-server@0.80.0
  - @cat-factory/integrations@0.71.0
  - @cat-factory/agents@0.39.3
  - @cat-factory/gitlab@0.7.12
  - @cat-factory/executor-harness@1.35.0

## 0.51.1

### Patch Changes

- 35f499c: Fix local-mode CORS + two SPA regressions

  - **local-server:** default `ENVIRONMENT=local` in `applyLocalDefaults`, and pass the
    localized env (not the raw one) into `start()`. The shared app's CORS middleware reads
    `ENVIRONMENT` / `CORS_ALLOWED_ORIGINS` directly off the env, and the raw env was being
    passed through, so the server default-DENIED CORS and the SPA on `:3000` failed with
    "can't reach backend" until an operator hand-set `CORS_ALLOWED_ORIGINS`. Local mode now
    reflects the SPA origin out of the box (auth is a bearer header, credentials mode off).
  - **app:** import the `CreateInitiativeModal` component in `index.vue` — it was referenced
    in the template but never imported, so Vue logged "Failed to resolve component".
  - **app:** stop sending an empty `?kind=` query when describing an infra provider without a
    concrete backend kind. The empty string was read as a real (unknown) backend kind and
    rejected with 422; the request now omits the param so the server falls back to the
    workspace's stored/default kind.

## 0.51.0

### Minor Changes

- accb8ec: feat(docs): attach read-only reference repositories to a document-authoring task

  Let a document-type task carry a list of **reference repositories** the `doc-writer` agent clones
  READ-ONLY while it drafts, so it can reuse existing solutions in those repos as a reference. The
  writer is already containerized (`container-coding`), so no interim step is needed — the reference
  repos become extra sibling checkouts it may read but can never write to.

  - **Read-only by construction.** Reference repos flow through a NEW `referenceRepos` block field,
    separate from the writable `involvedServiceIds`/`fanOutMultiRepo` path. The harness job spec
    carries no branch/PR fields for a reference, the multi-repo coder clones it at its base branch
    with no work branch, and the push phase skips it — three independent layers, so a reference repo
    is structurally impossible to push to. Its clone URL is host-allowlisted like every other repo.
  - **Any accessible repo, by name fragment.** A reference need not be a board service or in the
    workspace's synced projection: the inspector picker reuses the SAME server-side, debounced repo
    search as the add-service modal (extracted into a shared `useRepoSearch` composable), so any repo
    the workspace's VCS connection or the signed-in user's PAT can reach can be attached.
  - **Provider-neutral by construction.** The `ReferenceRepo` identity mirrors the kernel's VCS
    vocabulary (`repoId` / `owner` / `name` / `defaultBranch` / `connectionId`, per `VcsRepoRef` /
    `VcsConnectionRef`) rather than GitHub-specific names, and the clone URL + provider come from the
    deployment-level `ResolveRepoOrigin` seam the primary already rides — so a GitLab deployment
    clones references from GitLab with no extra wiring.
  - **Deduped against the primary.** A reference pointing at the doc task's own repo (or a duplicate
    attachment) is dropped by the shared sibling-checkout key, so it can't collide with an existing
    clone directory and fail the run.
  - **Symmetric persistence.** New `reference_repos` JSON column on `blocks`, mirrored across the D1
    and Drizzle stores with a cross-runtime conformance round-trip assertion.

  Bumps `@cat-factory/executor-harness` (new read-only reference-leg support in the coding harness) —
  the runner image tag pins and `RECOMMENDED_HARNESS_IMAGE` are bumped in lockstep.

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/contracts@0.104.0
  - @cat-factory/kernel@0.95.0
  - @cat-factory/server@0.88.0
  - @cat-factory/orchestration@0.77.0
  - @cat-factory/executor-harness@1.35.0
  - @cat-factory/node-server@0.79.0
  - @cat-factory/agents@0.39.2
  - @cat-factory/gitlab@0.7.11
  - @cat-factory/integrations@0.70.1

## 0.50.0

### Minor Changes

- cd435d1: Shared stacks (stack-recipes-and-shared-stacks initiative, slice 4): a workspace-scoped,
  long-lived compose stack a per-PR consumer environment attaches to over an external network
  (the acme-shared-services shape). Adds the `SharedStack` contract + `SharedStackRepository`
  port, the D1 ⇄ Drizzle `shared_stacks` table with a cross-runtime conformance round-trip, a
  `SharedStackService` lifecycle (CRUD everywhere + host-Docker `ensureUp`/`teardown` on the local
  facade, reusing the compose recipe-runner), the `GET|POST|PATCH|DELETE /workspaces/:ws/shared-stacks`
  (+ `ensure-up`/`teardown`) controller, and a "Shared stacks" panel in the Infrastructure window.
  Bringing a stack up is local-facade-bound (host daemon), the documented compose exception to
  runtime symmetry; persistence stays fully symmetric.

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/contracts@0.103.0
  - @cat-factory/kernel@0.94.0
  - @cat-factory/integrations@0.70.0
  - @cat-factory/orchestration@0.76.0
  - @cat-factory/server@0.87.0
  - @cat-factory/node-server@0.78.0
  - @cat-factory/agents@0.39.1
  - @cat-factory/gitlab@0.7.10
  - @cat-factory/executor-harness@1.34.12

## 0.49.0

### Minor Changes

- c435c09: Local mode ships an on-by-default self-hosted SearXNG web-search upstream.

  Web search for container agents is a backend proxy (`/v1/web-search/search`) that resolves its
  upstream from the run's per-account settings — so local mode previously had no web search until a
  developer hand-entered keys. This adds a **deployment-level trusted default upstream** the proxy
  falls back to when the account has none, and wires a self-hosted SearXNG as that default in local
  mode (on by default, disable with `LOCAL_WEB_SEARCH=off`).

  - **server**: `SearxngWebSearchUpstream` gains a `trusted` flag that trusts only the deployment's
    own configured origin (its base URL — which may be loopback/LAN — and same-origin redirects)
    while a CROSS-origin redirect stays SSRF-guarded, so a trusted-but-compromised upstream can't
    pivot to an internal/metadata host; redirect/credential-stripping/byte-cap protection is
    unchanged. New `createDefaultWebSearchUpstream(...)` (trusted counterpart to
    `createWebSearchUpstream`). `ServerContainer` gains optional `defaultWebSearchUpstream`, which
    `WebSearchProxyController` uses as the fallback when the account resolves no upstream (the
    account path still wins and stays SSRF-guarded; neither ⇒ the unchanged empty-result degrade).
  - **node-server & worker**: both facades build the default from `WEB_SEARCH_BRAVE_API_KEY` /
    `WEB_SEARCH_SEARXNG_URL` / `WEB_SEARCH_SEARXNG_API_KEY`, surface it on the container, and
    advertise Pi's `web_search` tool whenever a default exists (or the account has keys). A stock
    Node **or Cloudflare** deployment can now set a deployment-wide default (Brave or a public
    self-hosted SearXNG); each facade carries a proxy-fallback parity test.
  - **local-server**: `applyLocalDefaults` points `WEB_SEARCH_SEARXNG_URL` at the local SearXNG
    (`http://localhost:8080`) unless `LOCAL_WEB_SEARCH=off`; the `deploy/local` docker-compose gains a
    pinned `searxng` service (behind a `web-search` profile) + a `settings.yml` enabling the JSON API.

  The only Cloudflare-specific gap is the loopback-SearXNG story (no localhost container on workerd),
  which is inherently local-only; the runtime-neutral Brave/public-SearXNG default is now symmetric.

### Patch Changes

- Updated dependencies [c435c09]
  - @cat-factory/server@0.86.0
  - @cat-factory/node-server@0.77.0
  - @cat-factory/executor-harness@1.34.12

## 0.48.0

### Minor Changes

- 076d02f: feat(documents): interactive document-review sessions (doc-task WS5)

  Between the outline and the draft, a document-authoring run now converses with the requester
  instead of a single binary approve/revise gate. A new inline `doc-interviewer` step (inserted
  after `doc-outliner` in `pl_document`, replacing the outline's human gate) asks a small batch of
  clarifying questions about scope, audience and structure, parks the run on the standard durable
  decision-wait while the human answers through a dedicated window, and iterates (up to a round
  cap) until it synthesizes a refined **authoring brief** the `doc-writer`/`doc-finalizer` start
  from (folded into their context via the agent-context builder).

  The park/answer/resume/advance spine is now a shared `InterviewGateController<TEntity>`
  parameterized by an `InterviewGateKind` strategy; both the document interviewer and the
  interactive-planning (initiative) interviewer ride it, so the two gates can't drift. A document
  task has no owning entity row, so its transcript is persisted in its own `doc_interview_sessions`
  table — mirrored across D1 ⇄ Drizzle with a cross-runtime conformance assertion. The interview
  window is wired through the universal result-view seam (`doc-interview`) and updates live over a
  new `docInterview` workspace event. Pass-through when no interviewer model is wired, so document
  pipelines run unchanged.

  Hardening: a re-run of a document task now clears the block's prior session before interviewing
  (so it starts clean instead of reusing a stale, already-converged one), the converged brief is
  folded only into the two kinds that consume it (`doc-writer`/`doc-finalizer`), and a non-final
  interviewer pass that returns neither questions nor a brief fails the run loudly instead of
  silently skipping the interview with an empty brief.

  Breaking: `pl_document` bumps to version 3 (the reseed offer), and its step indices shift (the
  interviewer is inserted at index 2), so in-flight runs on the old shape should be restarted.

### Patch Changes

- 77bc73c: Update dependencies to the latest versions within the supply-chain release-age
  window. The Vercel AI SDK family stays within the `ai@6` / `@ai-sdk/*` majors
  that `workers-ai-provider@^3` peers require (`ai@6.0.219`,
  `@ai-sdk/anthropic@3.0.92`, `@ai-sdk/openai@3.0.80`,
  `@ai-sdk/openai-compatible@2.0.56`, `@ai-sdk/provider@3.0.13`,
  `@ai-sdk/amazon-bedrock@4.0.128`). Other bumps include `@hono/node-server`,
  `pg-boss`, `undici`, `markdown-it`, `@aws-sdk/client-s3`, `@clack/prompts`,
  `@types/node`, and eligible transitive dependencies. `@cloudflare/workers-types`
  is held at `4.x` because `wrangler@4` peers on `^4`.
- Updated dependencies [77bc73c]
- Updated dependencies [076d02f]
- Updated dependencies [77bc73c]
  - @cat-factory/agents@0.39.0
  - @cat-factory/integrations@0.69.1
  - @cat-factory/kernel@0.93.0
  - @cat-factory/orchestration@0.75.0
  - @cat-factory/server@0.85.0
  - @cat-factory/node-server@0.76.0
  - @cat-factory/contracts@0.102.0
  - @cat-factory/executor-harness@1.34.12
  - @cat-factory/gitlab@0.7.9

## 0.47.0

### Minor Changes

- 029a689: feat(environments): stack-recipe execution engine (shared-stacks initiative, slice 3)

  Teach the Docker Compose environment provider to run a declarative STACK RECIPE — the imperative
  bring-up of a complex multi-repo/multi-service stack (the acme-main pilot) expressed as data.
  The recipe is service-owned (`ServiceProvisioning.recipe`, landed slice 1) and now reaches the
  provider: `resolveProviderForType` folds it into the compose handler's `providerConfig.recipe` at
  provision time (the compose analogue of merging a kube `manifestSource`), so the provider keys
  purely on the persisted, merged config. Runtime-bound to the local facade (needs a host daemon) —
  the documented compose exception to runtime symmetry; the contracts + persistence stay symmetric.

  - **Multi-`-f` layering + profiles + env files** — `recipe.composeFiles` are read, `{{var}}`-
    rendered, host-escape-checked and port-neutralized per layer (concurrent per-PR stacks never
    collide), then written beside their originals in the checkout and passed as ordered `-f`s;
    `recipe.composeProfiles` drives `COMPOSE_PROFILES`; `recipe.envFiles` materialize committed
    templates into their gitignored targets before `up` (`.env.dev.local-dist` → `.env.dev.local`).
  - **Setup-step runner** — ordered `setupSteps` after `up -d` (no `--wait` — readiness is the
    recipe gate, since these stacks rarely declare healthchecks): `compose-exec` (composer install,
    migrations, cache warmup; seed import pipes a `.sql` dump via stdin), `copy-file`, `wait-http`,
    `wait-file` (container `test -f` or checkout), and the opt-in `host-command` (refused unless the
    workspace handler sets `allowHostCommands`). Each step has its own timeout budget.
  - **Terminal health gate** — `compose-healthy` (default, poll `ps`), `http`, or `compose-exec`
    (e.g. `bin/console monitor:health`), polled until it passes or its budget elapses.
  - **Per-step provisioning log** — the provider streams a `recordStep` entry per step (env file,
    `up`, each setup step, health gate) into the environment provisioning log, so the "View logs"
    drawer shows which step is running / died. Any step's failure tears the half-up stack down for a
    clean retry and surfaces the step's own error as the deployer step's `lastError`.

  New optional `ComposeRuntime` seams (implemented by the local docker-CLI runtime): `compose`
  stdin-streaming, `copyCheckoutFile`, `checkoutFileExists`, `hostCommand`. All compose safety lines
  carry over (host-escape guard on every recipe path, `include:`/cross-file `extends`/`privileged`
  refused). Fixture-driven unit tests cover the new pure helpers and the provider recipe flow
  (layering, env files, steps, stdin seed, HTTP gate, host-command opt-in, failure teardown).
  Recipe `teardownSteps` execution is deferred (the recipe schema carries them; `down -v` remains
  the teardown for now).

### Patch Changes

- Updated dependencies [029a689]
- Updated dependencies [029a689]
  - @cat-factory/contracts@0.101.1
  - @cat-factory/integrations@0.69.0
  - @cat-factory/kernel@0.92.0
  - @cat-factory/agents@0.38.2
  - @cat-factory/gitlab@0.7.8
  - @cat-factory/orchestration@0.74.3
  - @cat-factory/server@0.84.3
  - @cat-factory/node-server@0.75.3
  - @cat-factory/executor-harness@1.34.10

## 0.46.2

### Patch Changes

- Updated dependencies [f6399cf]
  - @cat-factory/integrations@0.68.0
  - @cat-factory/orchestration@0.74.2
  - @cat-factory/server@0.84.2
  - @cat-factory/node-server@0.75.2
  - @cat-factory/executor-harness@1.34.10

## 0.46.1

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/contracts@0.101.0
  - @cat-factory/kernel@0.91.0
  - @cat-factory/agents@0.38.1
  - @cat-factory/gitlab@0.7.7
  - @cat-factory/integrations@0.67.1
  - @cat-factory/orchestration@0.74.1
  - @cat-factory/server@0.84.1
  - @cat-factory/node-server@0.75.1
  - @cat-factory/executor-harness@1.34.10

## 0.46.0

### Minor Changes

- 773695b: feat(documents): workspace-linked template + exemplar documents per DocKind (doc-task WS1 items 2–4)

  A workspace can now point a document kind at its OWN template and example documents, reusing
  the existing documents integration end-to-end (no new fetch machinery). A single `role`
  (`template` | `exemplar`) + `docKind` tag on the projected `documents` row — sitting alongside
  the block-scoped `linkedBlockId` anchor — models both:

  - **Template** (singular per kind): its parsed section headings REPLACE the built-in skeleton
    for that kind. Resolved through one shared seam (`resolveDocTemplate`) that BOTH the
    doc-authoring prompts (via the engine-resolved `block.docTemplateBody`) and the `doc-quality`
    gate provider go through, so the writer and the gate never check against different sections.
  - **Exemplars** (multi-valued per kind): "good examples to emulate" surfaced to the author
    agents alongside a new set of built-in curated exemplars.

  The `documents` table gains nullable `role`/`doc_kind` columns (D1 migration ⇄ Drizzle schema +
  generated migration), with new `DocumentRepository` role methods mirrored across both stores and
  asserted by the cross-runtime conformance suite. The Node facade's Drizzle migration is the
  merge node that collapses the two pre-existing divergent snapshot leaves. New workspace-scoped
  routes (`GET`/`POST /document-role-links`, `POST /document-role-links/remove`) back a
  per-DocKind template/exemplar management panel in the Integrations hub (i18n in all 8 locales).

  Breaking (pre-1.0, acceptable): the `documents` projection wire shape gains `role`/`docKind`
  fields; stale rows simply carry nulls.

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/contracts@0.100.0
  - @cat-factory/kernel@0.90.0
  - @cat-factory/agents@0.38.0
  - @cat-factory/integrations@0.67.0
  - @cat-factory/orchestration@0.74.0
  - @cat-factory/server@0.84.0
  - @cat-factory/node-server@0.75.0
  - @cat-factory/gitlab@0.7.6
  - @cat-factory/executor-harness@1.34.10

## 0.45.5

### Patch Changes

- Updated dependencies [3981bbb]
  - @cat-factory/contracts@0.99.0
  - @cat-factory/agents@0.37.2
  - @cat-factory/gitlab@0.7.5
  - @cat-factory/integrations@0.66.1
  - @cat-factory/kernel@0.89.1
  - @cat-factory/orchestration@0.73.1
  - @cat-factory/server@0.83.2
  - @cat-factory/node-server@0.74.1
  - @cat-factory/executor-harness@1.34.10

## 0.45.4

### Patch Changes

- Updated dependencies [cfcb6c7]
- Updated dependencies [48f9d97]
  - @cat-factory/kernel@0.89.0
  - @cat-factory/contracts@0.98.0
  - @cat-factory/orchestration@0.73.0
  - @cat-factory/integrations@0.66.0
  - @cat-factory/node-server@0.74.0
  - @cat-factory/agents@0.37.1
  - @cat-factory/gitlab@0.7.4
  - @cat-factory/server@0.83.1
  - @cat-factory/executor-harness@1.34.10

## 0.45.3

### Patch Changes

- Updated dependencies [f4c321e]
  - @cat-factory/kernel@0.88.0
  - @cat-factory/agents@0.37.0
  - @cat-factory/server@0.83.0
  - @cat-factory/node-server@0.73.0
  - @cat-factory/gitlab@0.7.3
  - @cat-factory/integrations@0.65.3
  - @cat-factory/orchestration@0.72.1
  - @cat-factory/executor-harness@1.34.10

## 0.45.2

### Patch Changes

- 13a284f: Bug-triage pipeline (phase G): the `repro-test` Reproduction Test Automation agent. A new
  structured `container-coding` agent kind writes one or more tests that fail for the reported
  reason and commits them onto the run's shared work branch (seeding it for the coder, which opens
  the one PR containing both the reproduction test and the fix) — or concedes `not_reproducible`
  without failing the run. Conceding and reproduced outcomes both advance to the coder; a
  post-completion resolver folds the `{ outcome, testPaths, notes }` assessment into the step
  output so the coder reads it, and a `BUG_FIX_GUIDANCE` prompt fragment reframes the coder's
  objective around the pre-existing failing test (fix the issue, don't merely make the test pass).

  Enabling changes: `AgentStepSpec` gains `opensPr` / `noChangesTolerated` (container-coding) so a
  kind can seed the work branch without opening a PR and tolerate a no-op; the executor-harness
  coding path now parses a structured JSON outcome (`custom`) alongside the pushed commit; the
  harness image is bumped to `1.34.9`. The runtime-neutral `@cat-factory/server` package keeps its
  Web-standard `src` surface (no `@types/node`) while typing the one cross-runtime Node built-in it
  uses (`AsyncLocalStorage`) via a local ambient shim, with node-using tests typechecked under a
  separate project.

- Updated dependencies [13a284f]
  - @cat-factory/kernel@0.87.0
  - @cat-factory/agents@0.36.0
  - @cat-factory/orchestration@0.72.0
  - @cat-factory/server@0.82.0
  - @cat-factory/executor-harness@1.34.10
  - @cat-factory/gitlab@0.7.2
  - @cat-factory/integrations@0.65.2
  - @cat-factory/node-server@0.72.2

## 0.45.1

### Patch Changes

- Updated dependencies [102c049]
  - @cat-factory/contracts@0.97.0
  - @cat-factory/agents@0.35.0
  - @cat-factory/gitlab@0.7.1
  - @cat-factory/integrations@0.65.1
  - @cat-factory/kernel@0.86.1
  - @cat-factory/orchestration@0.71.1
  - @cat-factory/server@0.81.1
  - @cat-factory/node-server@0.72.1
  - @cat-factory/executor-harness@1.34.8

## 0.45.0

### Minor Changes

- 49b498a: Registry DI migration — the agent-kind registry becomes app-owned (no module global).

  Continues the [registry-DI initiative](docs/initiatives/registry-di-migration.md): the
  plugin-style agent-kind registry (`registerAgentKind` into a module-level `Map`) is replaced by
  an app-owned **`AgentKindRegistry`** instance the composition root news once
  (`defaultAgentKindRegistry()`, pre-loaded with the built-in `bug-investigator` / document /
  initiative kinds), threads through the single `CoreDependencies` object, and re-exposes on the
  `Core` + `ServerContainer` for the HTTP snapshot projection. Module identity stops mattering, the
  external-adapter "phantom Map" gotcha is gone, and tests get a fresh instance instead of
  `clearRegisteredAgentKinds()`. This also fixes the phase-F worker-shard conformance flake at its
  root: the shared suite's `clearRegisteredAgentKinds()` used to wipe the built-in kinds for the
  rest of a single-module run.

  **BREAKING** — the free module-global seams are removed from `@cat-factory/agents` (and the
  facade re-exports): `registerAgentKind`/`registerAgentKinds`, `registered*` (`registeredAgentKind`,
  `registeredAgentStep`, `registeredKindRequiresContainer`, `registeredSystemPrompt`,
  `registeredUserPrompt`, `registeredConfigContributions`, `registeredPreOps`, `registeredPostOps`,
  `registeredAgentPresentation`, `registeredStructuredOutput`, `registeredWebResearchHint`,
  `registeredAgentTuning`, `registeredAgentKinds`), and `clearRegisteredAgentKinds`. Instead export
  the `AgentKindRegistry` class + `defaultAgentKindRegistry()` factory; the pure prompt/catalog fns
  (`systemPromptFor`/`userPromptFor`/`traitsFor`/`hasTrait`/`agentTuningFor`/`configContributionsFor`/
  `configContributionCatalog`/`webResearchGuidanceFor`/`isInlineModelStep`) now take a `registry`
  argument, and a deployment registers custom kinds **by reference** on the instance it injects into
  `buildContainer` / `start()` / `startLocal()` (the `agentKindRegistry` seam), exactly like the
  backend-registries pilot. The runtimes stay symmetric and the cross-runtime conformance suite
  injects a pre-loaded registry to assert a custom kind resolves identically on every facade.

  Also fixes a warm-pool bug in the executor-harness: the read-only multi-repo explore fan-out
  (`runExploreMode`) was gated on `!job.persistentCheckout`, so a `bug-investigator` dispatched to a
  warm local pool (which injects `persistentCheckout: true` on every job) silently dropped its peer
  repos and only saw the primary. The guard is dropped — `runMultiRepoExplore` uses its own
  ephemeral workspace, so the flag is harmlessly ignored.

- 49b498a: Service connections Phase 3 — multi-repo coding. The implementer now fans a cross-service
  change out across every connected involved-service repo, not just the task's own. A new
  `resolveRepoTargets` resolves the task's own repo PLUS each involved service's repo, deduped
  by repo (two services in one monorepo collapse into a single checkout with both
  subdirectories noted; a service co-located in the primary's own repo rides the own-service
  PR). `ContainerAgentExecutor` builds a `peerRepos` job body + a "Multi-repo workspace" prompt
  section for the `coder` kind and works at the repo root so it can reach every involved
  subtree. The executor-harness clones each peer repo as a SIBLING checkout under one workspace
  root, runs the agent once across all of them, and opens one PR per repo it actually changed.
  The own-service PR stays on `block.pullRequest`; the peer PRs are recorded on the new
  `block.peerPullRequests` (`AgentRunResult.peerPullRequests` → engine → JSON column, mirrored
  on D1 + Drizzle), with an `allPullRequests(block)` helper for the multi-repo-aware readers.
  Peer clone URLs are host-allowlisted exactly like the primary. Bumps the runner image
  (`peerRepos` job field + sibling-checkout flow).

### Patch Changes

- 49b498a: Bug-triage pipeline, Phase F — structured, multi-repo investigation + clarification.

  The `bug-investigator` is upgraded from a thin prose role into a STRUCTURED, read-only,
  multi-repo `container-explore` kind whose triage drives the downstream `clarity-review` gate,
  and the gate learns to seed itself from that triage instead of running its own first LLM pass.
  Same kind id, so the existing `pl_bugfix` preset inherits the upgrade.

  - **Structured `bug-investigator`** (`@cat-factory/agents`): registered via the public
    `registerAgentKind` seam (the `security-auditor` shape) with a lenient valibot
    `bugInvestigation` schema — `clarity` (`clear` | `needs_clarification`), `summary`, ranked
    `rootCauseHypotheses`, `affectedRepos`, `suggestedReproductions`, and `questions`
    (non-empty only when clarification is needed). Its structured object lands on `step.custom`
    (rendered by the stock `generic-structured` view); a built-in post-completion resolver renders
    a prose digest onto `step.output` so downstream steps read the investigation via `priorOutputs`.
    The old prose ROLE entry is removed.
  - **Read-only multi-repo checkouts** (`@cat-factory/server` + `@cat-factory/executor-harness`,
    image bump): the multi-repo fan-out gate now also fires for `bug-investigator`, and the
    container-explore job body threads `peerRepos` + the multi-repo prompt section. The harness
    gains a read-only `runMultiRepoExplore` path — it clones the primary repo PLUS every connected
    involved-service repo as SIBLING checkouts, runs the agent once at the workspace root, and
    makes NO edits / commits / PR (a read-only peer carries no `newBranch`/`pr`) — so a
    cross-service bug is traced across every repo it touches. `PeerRepoSpec.newBranch` is now
    optional (present for the coding fan-out, absent for the read-only one).
  - **Clarity gate seeding + auto-pass** (`@cat-factory/orchestration`): when a structured
    investigator ran upstream, the `clarity-review` gate seeds DETERMINISTICALLY from its triage —
    no reviewer LLM — auto-passing on `clarity === 'clear'` (advance, no human park, no
    notification) and seeding one blocking finding per `question` on `needs_clarification` (park
    for a human, exactly as an LLM reviewer pass would). Because the seed needs no model, the gate
    now activates whenever the clarity store is wired, and the review/incorporate/re-review LLM
    paths degrade gracefully when unwired. Mirrors the requirements-review auto-pass pattern.
  - **Tracker echo on park** (`@cat-factory/kernel` port + `@cat-factory/integrations`): a new
    best-effort `IssueWritebackProvider.postQuestions` echoes the open questions as a comment on
    the block's linked tracker issue when the gate parks — answers still arrive in-app (the tracker
    comment is an echo, not a channel). Not gated on the workspace writeback settings, and a
    tracker outage never fails the run.
  - **Conformance**: a two-facade suite drives the investigator → clarity gate flow — `clear`
    auto-passes straight through to the next step with the digest recorded, and
    `needs_clarification` parks one finding per question then resumes on dismiss-all + proceed.

  The runner image is bumped for the read-only multi-repo explore path; the three hand-maintained
  image-tag pins are synced.

- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/contracts@0.96.0
  - @cat-factory/kernel@0.86.0
  - @cat-factory/integrations@0.65.0
  - @cat-factory/orchestration@0.71.0
  - @cat-factory/server@0.81.0
  - @cat-factory/gitlab@0.7.0
  - @cat-factory/node-server@0.72.0
  - @cat-factory/agents@0.34.0
  - @cat-factory/executor-harness@1.34.8

## 0.44.4

### Patch Changes

- 1f6d9fc: Cache the workspace GitHub repo projection through the app caching seam
  (caching-layer initiative, slice 3). A new `AppCaches.repoProjection` group cache
  (grouped and keyed by workspace id) serves the whole-projection re-list that the
  block→repo resolver (`buildResolveRepoTarget`) runs on every agent dispatch and
  every durable poll tick, replacing a live `repoProjectionRepository.list` per
  resolution with a per-workspace cached read.

  Coherence is invalidation-driven: every projection write drops the workspace
  group after it commits — `GitHubSyncService` (repo link / monorepo-flag / the
  exact-set write + tombstone / the link-time full re-stamp, fanned out per
  workspace), `BoardService.addServiceFromRepo` (the monorepo-flag write on the
  import-existing-repo path), `WebhookService` (the `installation_repositories`
  removed tombstone), and `ContainerRepoBootstrapper` (projecting a freshly
  bootstrapped repo). `GitHubSyncService.syncRepo` only invalidates on a `full`
  (link-time) pass — an incremental resync re-stamps `syncedAt` alone, which the
  resolver never reads, so invalidating there would only churn the cache. The
  installation lookup and the tree-depth-bounded block ancestry walk stay live, so
  a block reparent or a service repo-link change needs no cache invalidation.

  The cache is pass-through on the Cloudflare Worker's isolate-safe profile (our own
  mutable D1 state, no cross-isolate invalidation bus), so the Worker reads the
  projection live. Local mode is likewise pass-through: it seeds the projection via
  the out-of-process `link-repo` CLI and runs single-node with no invalidation bus,
  so an in-memory TTL'd entry could serve a pre-link projection. So the cache is
  active on the multi-node-capable Node facade only. Absent a cache (tests /
  harnesses) every resolve lists live, unchanged.

- Updated dependencies [1f6d9fc]
  - @cat-factory/kernel@0.85.0
  - @cat-factory/server@0.80.0
  - @cat-factory/integrations@0.64.0
  - @cat-factory/orchestration@0.70.1
  - @cat-factory/node-server@0.71.3
  - @cat-factory/agents@0.33.1
  - @cat-factory/gitlab@0.6.12
  - @cat-factory/executor-harness@1.34.4

## 0.44.3

### Patch Changes

- Updated dependencies [8eaa3f2]
  - @cat-factory/agents@0.33.0
  - @cat-factory/orchestration@0.70.0
  - @cat-factory/server@0.79.4
  - @cat-factory/node-server@0.71.2
  - @cat-factory/executor-harness@1.34.4

## 0.44.2

### Patch Changes

- Updated dependencies [e5ddaa4]
- Updated dependencies [6213771]
  - @cat-factory/kernel@0.84.0
  - @cat-factory/integrations@0.63.0
  - @cat-factory/agents@0.32.0
  - @cat-factory/orchestration@0.69.1
  - @cat-factory/node-server@0.71.1
  - @cat-factory/gitlab@0.6.11
  - @cat-factory/server@0.79.3
  - @cat-factory/executor-harness@1.34.4

## 0.44.1

### Patch Changes

- 9bac054: Caching initiative pilot (docs/initiatives/caching-layer.md, rows 0-1): introduce the
  app-level caching seam and adopt it for the per-dispatch fragment-catalog resolve.

  - New published package `@cat-factory/caching`: `createAppCaches(options)` builds the
    named, typed in-memory read-through caches (layered-loader `GroupLoader`, LRU + TTL)
    behind the new kernel `AppCaches`/`GroupCacheHandle` port. Redis is only ever an
    invalidation bus, never a data tier; with no notification factory injected the
    loaders are bare in-memory. The package deep-imports only layered-loader's in-memory
    machinery so ioredis never enters the module graph outside the Node facade's
    REDIS_URL-gated wiring.
  - `FragmentLibraryService.resolveCatalog` now reads through the fragment-catalog cache
    (group = workspace id), and every fragment write path — create / update / remove /
    createFromDocument / refresh / the run-time document-body re-resolve / fragment-source
    sync + unlink — invalidates it after commit (`invalidateCatalogTier`). The
    `ResolvedCatalogEntry` type moved to `@cat-factory/kernel` so the port can name it.
  - Node facade: `start()` builds the process-wide cache bag; when `REDIS_URL` is set,
    each cache gets its own `cat-factory:cache:<name>` notification channel (prefix
    overridable via the new `REDIS_CACHE_CHANNEL_PREFIX` env var) over dedicated
    ioredis publisher/subscriber clients, so peers drop their in-memory entries on every
    write — the same gating and resilience pattern as the realtime propagator. Local
    mode stays bare in-memory (single-node by construction).
  - Cloudflare Worker: wired with the ISOLATE-SAFE profile — the fragment catalog (mutable
    cross-instance state) is pass-through, since an isolate has no cross-isolate
    invalidation bus. Documented in the caching package README.
  - Conformance: new `defineCacheSuite` asserts write-then-read coherence of the resolved
    catalog on all three runtimes (Worker/Node/local).
  - Staleness probes for the upcoming git-backed slices, on layered-loader 14.5.3's new
    in-memory `isEntryStillCurrentFn` support: a cache profile may set
    `ttlLeftBeforeRefreshInMsecs`, and `GroupCacheHandle.get` accepts an optional per-read
    `isStillCurrent` probe — entries entering the refresh window get their TTL bumped when
    the probe reports the source unmoved, and fall back to a full background reload
    otherwise. `layered-loader` (maintainer-owned) is now excluded unversioned from the
    `minimumReleaseAge` supply-chain gate, like the `@cat-factory/*` namespace.

- Updated dependencies [9bac054]
  - @cat-factory/kernel@0.83.0
  - @cat-factory/agents@0.31.0
  - @cat-factory/orchestration@0.69.0
  - @cat-factory/node-server@0.71.0
  - @cat-factory/gitlab@0.6.10
  - @cat-factory/integrations@0.62.1
  - @cat-factory/server@0.79.2
  - @cat-factory/executor-harness@1.34.4

## 0.44.0

### Minor Changes

- 6c1efd1: Docker Compose ephemeral envs: opt-in build-from-source mode.

  The Docker Compose environment backend was checkout-free / image-pull only and hard-rejected
  `build:`, host bind mounts, relative `env_file`, and `privileged`, so an app repo that builds
  its own images (e.g. a .NET + Angular + SQL Server stack) could not become a per-PR preview env.

  A new opt-in `build` mode (workspace handler `providerConfig.build`, mirrored advisory
  `ServiceProvisioning.composeBuild`) clones the PR head into a per-project working tree, writes
  the isolation-safe rewritten compose beside the original inside the checkout, and runs
  `docker compose build` + `up --wait`. In build mode `build:`, in-checkout relative bind mounts,
  and relative `env_file`s are honored. Image mode is unchanged and remains the default.

  Host-escape refusal is uniform across EVERY path-bearing reference, not just bind mounts: bind
  sources, `env_file`s, the `build:` context, and top-level `secrets:`/`configs:` `file:` sources are
  all run through `escapesCheckout`, which now also catches UNC/backslash-absolute paths, a
  separator-buried `../` source (`sub/../../../etc`, previously mis-read as a named volume), and an
  unresolved `${VAR}` interpolation (expands to an arbitrary host path at runtime). `include:` and
  cross-file `extends: { file }` are refused outright in both modes — the daemon merges those files
  from disk, so their services would otherwise slip a privileged container / host bind / pinned port
  past the parse-based guard. `privileged: true` stays refused.

  The `ComposeRuntime` seam gains optional `checkout`/`writeCheckoutFile` (implemented in the local
  facade via a shallow, token-authenticated git clone); `ProvisionEnvironmentRequest` gains a LAZY
  `clone` resolver (a thunk) invoked only by the build-mode provider that actually needs a working
  tree — so image-mode compose / custom / k8s-sync provisions no longer mint a short-lived VCS token
  they never use (reusing the deploy clone-target seam, memoized so one provision never mints twice).
  Build mode registers only on the docker-family local runtime — the documented runtime-bound
  exception. Build timeout is separate from the health-wait bound (`buildTimeoutMinutes`).

  Auto-detection is now content-aware: a compose stack that declares `build:` is detected and
  recommended in build-from-source mode (previously it was recommended blindly and then failed at
  provision time).

  The compose environment connect form gains an "Image source" selector (pull pre-built vs build
  from source) and a build-timeout field; the misleading "image-based stacks only" copy is removed.

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/contracts@0.95.0
  - @cat-factory/kernel@0.82.0
  - @cat-factory/integrations@0.62.0
  - @cat-factory/agents@0.30.5
  - @cat-factory/gitlab@0.6.9
  - @cat-factory/orchestration@0.68.1
  - @cat-factory/server@0.79.1
  - @cat-factory/node-server@0.70.1
  - @cat-factory/executor-harness@1.34.4

## 0.43.0

### Minor Changes

- 6edcce0: Personal-PAT repo access + fail-closed board redaction, and removal of the legacy repo→block link.

  - **Expand the repo picker with your own PAT (all facades).** A user's stored GitHub PAT
    (`user_secrets` kind `github_pat`) now surfaces repos it can reach beyond the workspace's GitHub
    App grant — even on the hosted Cloudflare/Node facades. Linking one creates a **personal service**
    (`GitHubRepo.linkedVia === 'user_pat'`); runs against it already use the initiator's PAT.
  - **Fail-closed frame redaction.** A service frame backed by a repo linked via another member's PAT
    is hidden from members who can't reach it: the board snapshot scrubs the frame to just its
    internal id + a "Permission denied" placeholder and drops its subtree. Access is a fail-closed
    per-user projection (`github_user_repo_access`), refreshed when a user enumerates their PAT repos
    and cleared when they remove their PAT — no live GitHub call on the snapshot path.
  - **New:** `github_repos.linked_via` column + `github_user_repo_access` table (mirrored D1 ⇄
    Drizzle, with a cross-runtime conformance suite); kernel `UserRepoAccessRepository` port and
    optional `GitHubClient.listReposForToken`/`getRepoForToken`; `Block.accessDenied` +
    `GitHubAvailableRepo.personal` wire fields.

  **Breaking (pre-1.0, no migration):** the legacy `github_repos.block_id` repo↔frame link is removed
  — the account-owned `Service` (`getByFrameBlock` → `repoGithubId`) is now the SOLE repo↔frame
  linkage. `RepoProjectionRepository.linkBlock` and `GitHubRepo.blockId` are gone; `resolveRepoTarget`
  now requires a `serviceRepository`; the `RepoBootstrapper` port's `linkRepoToBlock` is replaced by
  `projectBootstrappedRepo` (the caller binds the frame's `Service`). Existing rows' `block_id` is
  dropped; repos remain reachable through their `Service`.

### Patch Changes

- Updated dependencies [6edcce0]
  - @cat-factory/contracts@0.94.0
  - @cat-factory/kernel@0.81.0
  - @cat-factory/integrations@0.61.0
  - @cat-factory/server@0.79.0
  - @cat-factory/orchestration@0.68.0
  - @cat-factory/node-server@0.70.0
  - @cat-factory/gitlab@0.6.8
  - @cat-factory/agents@0.30.4
  - @cat-factory/executor-harness@1.34.4

## 0.42.1

### Patch Changes

- @cat-factory/node-server@0.69.1

## 0.42.0

### Minor Changes

- dbde3b8: Cross-node WebSocket propagation for the Node facade (optional Redis adapter).

  The Node facade's real-time transport (`NodeRealtimeHub`) is an in-process, single-node socket
  registry: an event published on the node that processed a run only reaches browsers connected to
  THAT node. A horizontally-scaled Node deployment spreads browsers and background work across
  several nodes, so an event produced on one node has to reach a browser attached to another.

  This adds that reach as a **layered propagator** with pluggable cross-node adapters. Publishing an
  event fans it to the local hub AND to each configured adapter; an adapter carries it to peer nodes,
  which apply it to their own local hubs. **Redis pub/sub is the first adapter** — a Postgres
  LISTEN/NOTIFY or NATS adapter would implement the same `WebSocketPropagator` port with no other
  changes.

  - `ioredis` is an **optional dependency**, imported dynamically only when `REDIS_URL` is set. With
    no bus configured (single-replica Node, and **local mode**, which is always single-node) the
    layer is exactly the bare hub with zero overhead and no extra dependency — the default.
  - Config: `REDIS_URL` enables it; `REDIS_REALTIME_CHANNEL` (default `cat-factory:realtime`) and
    `REALTIME_NODE_ID` (default a random uuid, used to drop a node's own echoes) tune it.
  - The engine's event publisher now writes through a narrow `LocalEventSink` seam that both the bare
    hub and the layered propagator implement, so no other code differs between single- and multi-node.

  The Worker facade needs none of this: its real-time transport is a globally-addressed
  `WorkspaceEventsHub` Durable Object (one per workspace across the whole deployment), so cross-node
  propagation is inherent to the platform — this is a genuine Node-only concern, not a facade gap.

### Patch Changes

- Updated dependencies [dbde3b8]
  - @cat-factory/node-server@0.69.0

## 0.41.5

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/contracts@0.93.0
  - @cat-factory/kernel@0.80.0
  - @cat-factory/orchestration@0.67.0
  - @cat-factory/server@0.78.0
  - @cat-factory/node-server@0.68.0
  - @cat-factory/agents@0.30.3
  - @cat-factory/gitlab@0.6.7
  - @cat-factory/integrations@0.60.2
  - @cat-factory/executor-harness@1.34.4

## 0.41.4

### Patch Changes

- Updated dependencies [1d738f7]
  - @cat-factory/contracts@0.92.0
  - @cat-factory/orchestration@0.66.0
  - @cat-factory/server@0.77.0
  - @cat-factory/node-server@0.67.0
  - @cat-factory/agents@0.30.2
  - @cat-factory/gitlab@0.6.6
  - @cat-factory/integrations@0.60.1
  - @cat-factory/kernel@0.79.1
  - @cat-factory/executor-harness@1.34.4

## 0.41.3

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/contracts@0.91.0
  - @cat-factory/kernel@0.79.0
  - @cat-factory/integrations@0.60.0
  - @cat-factory/orchestration@0.65.0
  - @cat-factory/server@0.76.0
  - @cat-factory/node-server@0.66.0
  - @cat-factory/agents@0.30.1
  - @cat-factory/gitlab@0.6.5
  - @cat-factory/executor-harness@1.34.4

## 0.41.2

### Patch Changes

- Updated dependencies [0477068]
  - @cat-factory/server@0.75.2
  - @cat-factory/node-server@0.65.2
  - @cat-factory/executor-harness@1.34.4

## 0.41.1

### Patch Changes

- Updated dependencies [4a59f45]
  - @cat-factory/server@0.75.1
  - @cat-factory/node-server@0.65.1
  - @cat-factory/executor-harness@1.34.4

## 0.41.0

### Minor Changes

- b928904: Service connections Phase 2 — multi-env provisioning. A `deployer` step now fans out over
  the task's own service frame PLUS each connected involved-service frame, provisioning one
  ephemeral environment per frame (dispatched provider-before-consumer, parked between), each
  keyed per `(blockId, frameId)` so the fan-out no longer clobbers itself. Already-ready peers
  are injected into a later provision as `{{input.peerEnvUrls}}`, the agent context gains
  `involvedServices` (title + connection description + the peer's live env URL, read-time
  stale-filtered), and the Tester infra spec gains a `peerEnvironments` map so a cross-service
  integration test can reach a peer's real environment.

### Patch Changes

- Updated dependencies [b928904]
  - @cat-factory/orchestration@0.64.0
  - @cat-factory/contracts@0.90.0
  - @cat-factory/kernel@0.78.0
  - @cat-factory/integrations@0.59.0
  - @cat-factory/agents@0.30.0
  - @cat-factory/server@0.75.0
  - @cat-factory/node-server@0.65.0
  - @cat-factory/executor-harness@1.34.4
  - @cat-factory/gitlab@0.6.4

## 0.40.8

### Patch Changes

- Updated dependencies [7fa7578]
- Updated dependencies [f372f4e]
  - @cat-factory/contracts@0.89.0
  - @cat-factory/kernel@0.77.0
  - @cat-factory/orchestration@0.63.0
  - @cat-factory/server@0.74.0
  - @cat-factory/node-server@0.64.2
  - @cat-factory/agents@0.29.1
  - @cat-factory/gitlab@0.6.3
  - @cat-factory/integrations@0.58.1
  - @cat-factory/executor-harness@1.34.2

## 0.40.7

### Patch Changes

- Updated dependencies [6917962]
  - @cat-factory/server@0.73.1
  - @cat-factory/executor-harness@1.34.2
  - @cat-factory/node-server@0.64.1

## 0.40.6

### Patch Changes

- Updated dependencies [55661f4]
  - @cat-factory/contracts@0.88.0
  - @cat-factory/kernel@0.76.0
  - @cat-factory/agents@0.29.0
  - @cat-factory/integrations@0.58.0
  - @cat-factory/server@0.73.0
  - @cat-factory/orchestration@0.62.0
  - @cat-factory/node-server@0.64.0
  - @cat-factory/gitlab@0.6.2
  - @cat-factory/executor-harness@1.34.2

## 0.40.5

### Patch Changes

- Updated dependencies [ca5c3e8]
  - @cat-factory/contracts@0.87.0
  - @cat-factory/kernel@0.75.0
  - @cat-factory/agents@0.28.0
  - @cat-factory/orchestration@0.61.0
  - @cat-factory/server@0.72.0
  - @cat-factory/node-server@0.63.0
  - @cat-factory/gitlab@0.6.1
  - @cat-factory/integrations@0.57.2
  - @cat-factory/executor-harness@1.34.2

## 0.40.4

### Patch Changes

- Updated dependencies [cc924a9]
  - @cat-factory/agents@0.27.1
  - @cat-factory/orchestration@0.60.4
  - @cat-factory/server@0.71.2
  - @cat-factory/node-server@0.62.2
  - @cat-factory/executor-harness@1.34.2

## 0.40.3

### Patch Changes

- Updated dependencies [803fa76]
  - @cat-factory/server@0.71.1
  - @cat-factory/executor-harness@1.34.2
  - @cat-factory/node-server@0.62.1

## 0.40.2

### Patch Changes

- 7b8b04f: Pin the local browsable-preview host port to the app's serve port so the preview origin is a deterministic `http://localhost:<servePort>` — the same origin `frontendOriginsForService` injects into a bound backend's CORS allow-list. Previously the preview published to an ephemeral host port and formed its URL via `docker port` (`http://127.0.0.1:<random>`), a different origin, so a developer browsing the preview was CORS-blocked when the app called the live backend. `RunContainerSpec.publishPorts` gains an optional pinned `host`, and a new `ContainerRuntimeAdapter.publishesToLocalhost` flag distinguishes the Docker family (pinnable localhost origin) from Apple `container` (reached at the container's own IP).

## 0.40.1

### Patch Changes

- Updated dependencies [b216fdc]
  - @cat-factory/kernel@0.74.0
  - @cat-factory/contracts@0.86.0
  - @cat-factory/agents@0.27.0
  - @cat-factory/server@0.71.0
  - @cat-factory/gitlab@0.6.0
  - @cat-factory/node-server@0.62.0
  - @cat-factory/integrations@0.57.1
  - @cat-factory/orchestration@0.60.3
  - @cat-factory/executor-harness@1.34.2

## 0.40.0

### Minor Changes

- 7fd6a19: Import-from-repo picker: find and link accessible repos in realtime instead of enumerating the whole installation and filtering in memory. The old path listed every installation repo (capped at a bounded page count) then substring-filtered client-of-the-cap — so on a wide App install a repo beyond that window returned "no matches" for a repo you actually had access to, and every keystroke re-fetched all pages. Two new `GitHubClient` primitives fix it end to end: `searchInstallationRepos` issues one bounded, account-scoped GitHub search per query, and `getRepoById` point-reads the picked repo by id when linking it (so a repo surfaced by search from beyond the enumeration cap links instead of spuriously 409-ing). Blank-query browse-all is unchanged; PAT (local) and GitLab connections filter their bounded token listing. When an installation has no resolvable account to scope the GitHub search to, the App adapter filters its own bounded listing rather than running an unscoped global search (which would surface arbitrary, unlinkable public repos).

### Patch Changes

- Updated dependencies [7fd6a19]
  - @cat-factory/kernel@0.73.0
  - @cat-factory/server@0.70.0
  - @cat-factory/integrations@0.57.0
  - @cat-factory/gitlab@0.5.0
  - @cat-factory/agents@0.26.18
  - @cat-factory/orchestration@0.60.2
  - @cat-factory/node-server@0.61.2
  - @cat-factory/executor-harness@1.34.2

## 0.39.2

### Patch Changes

- Updated dependencies [96cff56]
  - @cat-factory/executor-harness@1.34.2

## 0.39.1

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/contracts@0.85.0
  - @cat-factory/kernel@0.72.0
  - @cat-factory/orchestration@0.60.1
  - @cat-factory/agents@0.26.17
  - @cat-factory/gitlab@0.4.45
  - @cat-factory/integrations@0.56.5
  - @cat-factory/server@0.69.1
  - @cat-factory/node-server@0.61.1
  - @cat-factory/executor-harness@1.34.0

## 0.39.0

### Minor Changes

- b78adf5: Private package registries: workspace-scoped npm registry credentials (npm private
  orgs + GitHub Packages) that agent containers use to resolve private dependencies on
  checkout.

  - **Storage**: one `package_registry_connections` row per workspace (D1 migration 0034
    ⇄ Drizzle mirror) holding a single sealed JSON array of entries
    (`{ id, ecosystem: 'npm', vendor: 'npmjs' | 'github-packages', scopes, token }`,
    cipher tag `cat-factory:package-registries`) plus a non-secret summary (vendor +
    scopes + token tail). Ecosystem-discriminated so pip/maven/cargo are later additive.
  - **API**: `GET|POST /workspaces/:ws/package-registries`, `DELETE …/:entryId`
    (`PackageRegistriesController`, 503 when the module is unwired). Tokens are
    write-only — the list view never returns them; edit = delete + re-add. Only one
    entry per vendor is allowed (a 409 otherwise): the harness renders a single
    host-keyed `_authToken` per registry, so a duplicate token would be silently
    dropped — put every scope for a vendor on its one entry. Tokens are validated as a
    single opaque printable-ASCII string (no spaces/control characters) so a token can't
    inject extra `~/.npmrc` lines.
  - **Dispatch**: `ContainerAgentExecutor` + `ContainerRepoBootstrapper` accept a
    `resolvePackageRegistries` seam (wired in both facades from the same store) and
    forward the decrypted entries as a `packageRegistries` field on every container job
    body, like `ghToken`. The registry host is derived backend-side from the fixed
    vendor set. A resolution failure fails the dispatch rather than silently running
    without auth. The agent-context snapshot's allow-list projection excludes the field.
  - **UI**: a "Private package registries" panel in the Integrations hub
    (`PackageRegistriesPanel.vue`) — vendor preset + scopes + write-only token, entries
    listed from the redacted summary.
  - **Conformance**: a new suite section asserts add → redacted list → decrypted
    dispatch resolution → remove identically on D1 and Postgres.

### Patch Changes

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
- Updated dependencies [b78adf5]
  - @cat-factory/contracts@0.84.0
  - @cat-factory/orchestration@0.60.0
  - @cat-factory/kernel@0.71.0
  - @cat-factory/server@0.69.0
  - @cat-factory/executor-harness@1.34.0
  - @cat-factory/node-server@0.61.0
  - @cat-factory/agents@0.26.16
  - @cat-factory/gitlab@0.4.44
  - @cat-factory/integrations@0.56.4

## 0.38.12

### Patch Changes

- Updated dependencies [e0aab3f]
  - @cat-factory/contracts@0.83.0
  - @cat-factory/kernel@0.70.2
  - @cat-factory/orchestration@0.59.2
  - @cat-factory/server@0.68.2
  - @cat-factory/node-server@0.60.2
  - @cat-factory/agents@0.26.15
  - @cat-factory/gitlab@0.4.43
  - @cat-factory/integrations@0.56.3
  - @cat-factory/executor-harness@1.32.0

## 0.38.11

### Patch Changes

- 0d51638: Boundary hardening:

  - **Local mode** now enforces a minimum strength on the required crypto secrets at config
    load: `AUTH_SESSION_SECRET` must be ≥32 characters (local mode defaults the auth gate open,
    so a weak secret would leave session/proxy/machine tokens forgeable) and `ENCRYPTION_KEY`
    must decode to a full 32-byte key (surfaced early instead of deep in the first cipher build).
  - **GitHub webhook verifier** fails closed when the webhook secret is unset (previously it would
    import an empty HMAC key and compare), matching the GitLab verifier.
  - **CORS** no longer reflects an arbitrary Origin by default outside development: an unset
    `CORS_ALLOWED_ORIGINS` reflects any origin only when `ENVIRONMENT` is an explicitly
    recognised development value (`development`/`dev`/`test`/`testing`/`local`/`e2e`). An
    unset, unknown, or production `ENVIRONMENT` default-denies (fails safe), so a deployment
    that forgets BOTH `ENVIRONMENT` and `CORS_ALLOWED_ORIGINS` no longer silently reflects.
    An explicit `*` still opts into reflect-all.

- Updated dependencies [0d51638]
- Updated dependencies [0d51638]
- Updated dependencies [0d51638]
  - @cat-factory/integrations@0.56.2
  - @cat-factory/server@0.68.1
  - @cat-factory/node-server@0.60.1
  - @cat-factory/kernel@0.70.1
  - @cat-factory/orchestration@0.59.1
  - @cat-factory/executor-harness@1.32.0
  - @cat-factory/agents@0.26.14
  - @cat-factory/gitlab@0.4.42

## 0.38.10

### Patch Changes

- Updated dependencies [eb67d40]
  - @cat-factory/executor-harness@1.32.0
  - @cat-factory/kernel@0.70.0
  - @cat-factory/orchestration@0.59.0
  - @cat-factory/server@0.68.0
  - @cat-factory/node-server@0.60.0
  - @cat-factory/agents@0.26.13
  - @cat-factory/gitlab@0.4.41
  - @cat-factory/integrations@0.56.1

## 0.38.9

### Patch Changes

- Updated dependencies [5ce03c6]
- Updated dependencies [5ce03c6]
  - @cat-factory/contracts@0.82.0
  - @cat-factory/integrations@0.56.0
  - @cat-factory/server@0.67.0
  - @cat-factory/executor-harness@1.31.12
  - @cat-factory/agents@0.26.12
  - @cat-factory/gitlab@0.4.40
  - @cat-factory/kernel@0.69.8
  - @cat-factory/orchestration@0.58.1
  - @cat-factory/node-server@0.59.4

## 0.38.8

### Patch Changes

- Updated dependencies [7f9d215]
- Updated dependencies [05d1b08]
  - @cat-factory/kernel@0.69.7
  - @cat-factory/orchestration@0.58.0
  - @cat-factory/server@0.66.7
  - @cat-factory/node-server@0.59.3
  - @cat-factory/integrations@0.55.0
  - @cat-factory/agents@0.26.11
  - @cat-factory/gitlab@0.4.39
  - @cat-factory/executor-harness@1.31.10

## 0.38.7

### Patch Changes

- 9577c4a: Fix a batch of native-mode (`LOCAL_NATIVE_AGENTS`) agent-harness bugs:

  - The harnesses (executor + deploy) now shut down gracefully on SIGTERM/SIGINT:
    every running job is aborted (`JobRegistry.abortAll`) so in-flight `claude`/
    `codex`/git/kubectl children are killed instead of being orphaned. Previously a
    dev-server restart left the agent CLI running unsupervised on the developer's
    login. The abort now targets the child's whole process group (POSIX), so the
    CLI's own grandchildren (a shell tool, a build, its git) die with it rather than
    reparenting to init. Shutdown exits as soon as the aborted jobs settle (capped at
    6s) instead of always waiting the fixed window. Both harness servers also honor a
    new `HARNESS_BIND_HOST` env, which the native transport sets to `127.0.0.1` so the
    unsandboxed agent-spawning API is no longer reachable from the LAN (containers keep
    binding all interfaces).
  - The native host-process transport sanitizes the harness child's environment to an
    allow-list (`LOCAL_HARNESS_ENV_ALLOW` extends it), so the orchestrator's secrets
    (DATABASE_URL, ENCRYPTION_KEY, GITHUB_PAT, provider keys) no longer leak into the
    ambient agent's env; the inline ambient CLI runner is sanitized the same way. The
    allow-list keeps the TLS trust-anchor vars (NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, ...)
    alongside the proxy vars, so a corporate TLS-terminating proxy still works. The
    deploy transport keeps full inheritance (kubectl/helm need ambient cluster env).
  - Process-lifecycle fixes in `LocalProcessRunnerTransport`: a harness that never
    becomes healthy is killed instead of leaking one process per retry, and
    `shutdown()` racing an in-flight lazy start now kills the child instead of
    resurrecting it. The local/Node graceful-shutdown path now invokes the
    container's `onShutdown`, which stops the native harnesses; that call is isolated
    in its own try so a failing pg-boss/pool teardown can't skip it.
  - `NativeRoutingRunnerTransport` no longer reports a blanket eviction for refs it
    doesn't know: after an orchestrator restart both `poll` and `release` fall back to
    the container leg (which re-finds a per-run container by label), so a still-running
    container job is re-attached / torn down instead of spuriously re-driven or leaked.
  - Config typos are no longer silent: unrecognized `LOCAL_NATIVE_AGENTS` tokens and
    an unrecognized/under-configured `LOCAL_DEPLOY_RUNTIME` now log a boot warning
    (behavior still fails safe).

- Updated dependencies [9577c4a]
- Updated dependencies [4955639]
  - @cat-factory/executor-harness@1.31.10
  - @cat-factory/node-server@0.59.2
  - @cat-factory/agents@0.26.10
  - @cat-factory/orchestration@0.57.7
  - @cat-factory/server@0.66.6

## 0.38.6

### Patch Changes

- Updated dependencies [4a7a3f1]
  - @cat-factory/contracts@0.81.3
  - @cat-factory/server@0.66.5
  - @cat-factory/orchestration@0.57.6
  - @cat-factory/agents@0.26.9
  - @cat-factory/gitlab@0.4.38
  - @cat-factory/integrations@0.54.3
  - @cat-factory/kernel@0.69.6
  - @cat-factory/node-server@0.59.1
  - @cat-factory/executor-harness@1.31.8

## 0.38.5

### Patch Changes

- 6347d0e: Fix opaque "Failed to open PR (HTTP 422): No commits between ..." run failure when a
  coding run resumes a work branch that has nothing ahead of its base (e.g. its earlier PR
  was merged with a merge commit, leaving the branch reachable from base and its best-effort
  delete skipped).

  - `runCodingAgent` no longer treats a resumed branch as work unconditionally: when the
    branch has no new commits this pass, it confirms the branch is actually ahead of the PR
    base (new `branchAheadOfBase`, tri-state so an undeterminable result keeps the prior
    resume-is-work behaviour) and records a clean no-op otherwise.
  - `openPullRequest` now maps GitHub's `422 "No commits between ..."` to a no-op (returns
    `null`) instead of a hard `HarnessFailure`, as a backstop.

  Image-bumping: `@cat-factory/executor-harness` → 1.31.7 with the three runner-image pins
  synced.

- Updated dependencies [4e82496]
- Updated dependencies [6347d0e]
- Updated dependencies [6439181]
- Updated dependencies [6347d0e]
  - @cat-factory/node-server@0.59.0
  - @cat-factory/server@0.66.4
  - @cat-factory/executor-harness@1.31.8

## 0.38.4

### Patch Changes

- Updated dependencies [6243bea]
  - @cat-factory/contracts@0.81.2
  - @cat-factory/integrations@0.54.2
  - @cat-factory/server@0.66.3
  - @cat-factory/agents@0.26.8
  - @cat-factory/gitlab@0.4.37
  - @cat-factory/kernel@0.69.5
  - @cat-factory/orchestration@0.57.5
  - @cat-factory/node-server@0.58.6
  - @cat-factory/executor-harness@1.31.6

## 0.38.3

### Patch Changes

- Updated dependencies [fc8df61]
- Updated dependencies [fc8df61]
  - @cat-factory/agents@0.26.7
  - @cat-factory/server@0.66.2
  - @cat-factory/node-server@0.58.5
  - @cat-factory/orchestration@0.57.4
  - @cat-factory/executor-harness@1.31.6

## 0.38.2

### Patch Changes

- 9468b90: Force fully non-interactive git auth in the harness so native local mode never triggers a Git
  Credential Manager popup. Every git invocation now empties the host credential-helper list
  (`-c credential.helper=`) and disables interactive credential backends, so git falls back to the
  harness's own askpass PAT instead of the host's GCM — which on Windows either stole focus with a
  stray auth window or, when modal, hung the git command (clone/fetch/push) until it timed out. A
  per-command git timeout is now surfaced as an explicit stall (naming the likely causes) rather
  than a contentless "Command failed", and a genuine git failure now folds in git's stderr.

  Bumps the executor-harness image tag (and the matched `RECOMMENDED_HARNESS_IMAGE` pin) to 1.31.5.

- Updated dependencies [9468b90]
  - @cat-factory/executor-harness@1.31.6

## 0.38.1

### Patch Changes

- Updated dependencies [986ed0e]
  - @cat-factory/executor-harness@1.31.4

## 0.38.0

### Minor Changes

- 063ef2b: Local native mode: default `LOCAL_HARNESS_ENTRY` to a bundled harness (no more manual path)

  Native execution (`LOCAL_NATIVE_AGENTS`) previously required `LOCAL_HARNESS_ENTRY` to be set
  to a filesystem path to the executor-harness server entry, which only existed inside a full
  monorepo checkout — so consumers installing `@cat-factory/*` from npm had no stable target.

  - `@cat-factory/executor-harness` is now **published** (was `private`). Its `.` export is the
    zero-dependency `dist/server.js` HTTP server that native mode spawns via `node <entry>`.
  - `@cat-factory/local-server` now depends on it and **auto-resolves** the entry via
    `require.resolve('@cat-factory/executor-harness')` when `LOCAL_HARNESS_ENTRY` is unset — so a
    fresh install runs native mode out of the box, mirroring how an unset `LOCAL_HARNESS_IMAGE`
    falls back to the pinned recommended image. Setting `LOCAL_HARNESS_ENTRY` still overrides it
    (for a custom or source-checkout build).
  - `cat-factory init` (`@cat-factory/cli`) no longer treats the entry as required: it is written
    commented (optional override) and the "set it before starting" warnings are gone.

### Patch Changes

- Updated dependencies [2a91615]
- Updated dependencies [063ef2b]
- Updated dependencies [063ef2b]
  - @cat-factory/contracts@0.81.1
  - @cat-factory/orchestration@0.57.3
  - @cat-factory/integrations@0.54.1
  - @cat-factory/server@0.66.1
  - @cat-factory/executor-harness@1.31.2
  - @cat-factory/agents@0.26.6
  - @cat-factory/gitlab@0.4.36
  - @cat-factory/kernel@0.69.4
  - @cat-factory/node-server@0.58.4

## 0.37.3

### Patch Changes

- Updated dependencies [67d3876]
  - @cat-factory/contracts@0.81.0
  - @cat-factory/integrations@0.54.0
  - @cat-factory/server@0.66.0
  - @cat-factory/agents@0.26.5
  - @cat-factory/gitlab@0.4.35
  - @cat-factory/kernel@0.69.3
  - @cat-factory/orchestration@0.57.2
  - @cat-factory/node-server@0.58.3

## 0.37.2

### Patch Changes

- 63cf6de: Performance: batch reads, parallelize independent awaits, and push work into SQL on hot paths.

  - `GET /workspaces/:id` (the board-load endpoint) now fetches its ~15 independent snapshot
    ingredients concurrently instead of serially, so its latency is the slowest read rather
    than the sum of every round-trip; the create-workspace route parallelizes its spend +
    infra-setup reads the same way.
  - Agent-context reference lookups (Jira keys / GitHub refs / URLs) run concurrently on the
    per-step dispatch path; run-start model-default resolutions run concurrently per agent kind.
  - New batched port methods, mirrored on both runtimes with conformance coverage:
    `BlockRepository.findByIds` (cross-workspace dependency resolution — one chunked query
    instead of a point-read per id, also allow-listed for mothership mode),
    `NotificationRepository.escalateStaleOpen` (the escalation sweep is now one
    `UPDATE … RETURNING` statement instead of a load-filter-upsert loop), and
    `GitHubInstallationRepository.listByInstallationIds` (connect-UI annotation).
  - GitHub webhook fan-out resolves linked workspaces via the existing batched
    `linkedWorkspaces` read instead of a per-workspace point-read on every delivery.
  - The Node Drizzle GitHub projections write chunked multi-row upserts (matching the D1
    twins' `db.batch`) instead of one round-trip per row, and their list reads run
    `ORDER BY`/`LIMIT` in SQL (NULLS LAST for D1 parity) instead of sorting full result
    sets in JS.
  - `autoStartDependents` hoists the invariant workspace-pipeline read out of its loop and
    stops re-fetching blocks it already holds.
  - Session/WS-ticket/machine-token verification reuses a memoized `HmacSigner` per secret,
    so `crypto.subtle.importKey` no longer runs on every request (`signerFor` export).
  - The Cloudflare Workflows drivers (execution / bootstrap / env-config-repair) build the
    DI container once per wake instead of once per `step.do` poll tick.

- Updated dependencies [d7f6e1c]
- Updated dependencies [63cf6de]
  - @cat-factory/kernel@0.69.2
  - @cat-factory/orchestration@0.57.1
  - @cat-factory/contracts@0.80.1
  - @cat-factory/node-server@0.58.2
  - @cat-factory/integrations@0.53.2
  - @cat-factory/server@0.65.2
  - @cat-factory/agents@0.26.4
  - @cat-factory/gitlab@0.4.34

## 0.37.1

### Patch Changes

- 120de05: feat(testing): pipeline-builder toggle + Test Report surfacing for the test quality companion (PR 2)

  Completes the test quality-control (QC) companion (see
  `docs/initiatives/tester-quality-companion.md`) with its authoring + observability surfaces:

  - **Pipeline builder**: a per-Tester-step toggle (enabled by default) turns the QC companion
    off, and an optional estimate-gating panel runs the coverage audit only on tasks whose
    estimate clears a threshold (mirroring the companion-gating panel). The estimator-required
    hint now covers QC gating too.
  - **Test Report window**: a "Coverage review" section renders each QC verdict (adequate /
    gaps-found, the reviewer's feedback + concrete gaps, model, timestamp) plus the loop budget
    and a "budget spent" badge — so a report that greenlit only after a QC-driven re-run shows
    why it looped.
  - **Persistence fix**: the pipeline create/update/clone API + `PipelineService` now thread
    `testerQuality` (and the sibling `followUps`, which had the same latent gap) end-to-end, so a
    custom pipeline's builder toggle actually persists instead of being silently stripped by the
    request-body validator. This includes the persistence layer itself: new `follow_ups` +
    `tester_quality` JSON columns on the `pipelines` table, mirrored D1 (migration
    `0032_pipeline_companion_toggles`) ⇄ Drizzle (schema + generated migration), written by both
    repos and read by the shared `rowToPipeline` mapper. A QC estimate gate is validated like
    companion gating (a threshold must be set and a `task-estimator` must run earlier).
  - **Conformance**: the full QC loop (audit → loop the Tester on gaps → conclude on an adequate
    report) is now driven through an injected deterministic reviewer on every runtime, asserting
    the verdicts + counters persist identically across D1 and Drizzle. A separate round-trip
    assertion saves a custom pipeline with a `followUps` opt-out + a gated `testerQuality` config
    and re-reads it from the store, so the new columns can't silently drop the toggles on either
    runtime.

  All new user-facing copy is translated across every shipped locale.

- Updated dependencies [120de05]
  - @cat-factory/contracts@0.80.0
  - @cat-factory/orchestration@0.57.0
  - @cat-factory/kernel@0.69.1
  - @cat-factory/node-server@0.58.1
  - @cat-factory/agents@0.26.3
  - @cat-factory/gitlab@0.4.33
  - @cat-factory/integrations@0.53.1
  - @cat-factory/server@0.65.1

## 0.37.0

### Minor Changes

- dcc8b32: Browsable frontend preview — transport dispatch + `PreviewService` + controller + stop (slice 5c of
  the frontend-preview + in-context UI-testing initiative,
  docs/initiatives/frontend-preview-ui-testing.md).

  Wire the harness `preview` mode (slice 5b) end to end: a `frontend` frame can now be built and
  served on a HOST-reachable URL for a browsable preview, and stopped again. New pieces:

  - A new optional `PreviewTransport` kernel port — the per-runtime half that publishes a served
    app's port to an ephemeral host port and keeps the container alive past the build job. The local
    facade wires the real one over its Docker/Podman/OrbStack/Colima/Apple adapter (a second
    published port read back with `docker port` / the container IP); the Worker never wires it.
  - A runtime-neutral `PreviewService` (start / get / stop) that persists the running preview like an
    ephemeral `environments` row keyed by the `frontend` frame (reusing the existing table + soft-delete
    stop path — no new migration), plus a `PreviewController` mounting
    `GET|POST|DELETE /workspaces/:ws/frames/:frameId/preview`, gated server-side on the
    `frontendPreview.supported` capability (503 on the Worker).
  - The cross-runtime conformance suite drives the full start → serve → stop lifecycle on both Postgres
    runtimes with a fake transport, pinning the ephemeral-env-row persistence parity.

  Notes:

  - `frontendPreview.supported` now tracks whether a preview transport is actually wired: a stock Node
    build (runner pool, no host-port-publish primitive) advertises `false`, so the SPA never offers a
    Start button that would 503; local mode (and any facade injecting a `previewTransport`) advertises
    `true`.
  - Preview rows share the `environments` table but carry a dedicated `preview` discriminator (outside
    `provisionTypeSchema`), so the environment subsystem filters them out of its generic listing +
    block-resolution paths — a preview never leaks into the deployer-env UI or tester env resolution.
  - `PreviewService.get` re-polls a `ready` preview so a vanished/evicted container stops reporting a
    stale, unreachable URL (it flips to `failed`); a healthy preview whose URL merely can't be
    re-derived keeps its authoritative persisted URL.

  Local/node differentiator; the SPA surface (the clickable URL + a stop button on the frame inspector)
  lands in slice 5d. The harness is unchanged (no runner-image bump).

### Patch Changes

- Updated dependencies [dcc8b32]
  - @cat-factory/orchestration@0.56.0
  - @cat-factory/node-server@0.58.0
  - @cat-factory/integrations@0.53.0
  - @cat-factory/contracts@0.79.0
  - @cat-factory/kernel@0.69.0
  - @cat-factory/server@0.65.0
  - @cat-factory/agents@0.26.2
  - @cat-factory/gitlab@0.4.32

## 0.36.4

### Patch Changes

- Updated dependencies [16ee6cc]
- Updated dependencies [16ee6cc]
  - @cat-factory/orchestration@0.55.1
  - @cat-factory/contracts@0.78.1
  - @cat-factory/kernel@0.68.1
  - @cat-factory/server@0.64.4
  - @cat-factory/node-server@0.57.2
  - @cat-factory/agents@0.26.1
  - @cat-factory/gitlab@0.4.31
  - @cat-factory/integrations@0.52.2

## 0.36.3

### Patch Changes

- Updated dependencies [6da6637]
  - @cat-factory/server@0.64.3
  - @cat-factory/node-server@0.57.1

## 0.36.2

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/contracts@0.78.0
  - @cat-factory/kernel@0.68.0
  - @cat-factory/agents@0.26.0
  - @cat-factory/orchestration@0.55.0
  - @cat-factory/node-server@0.57.0
  - @cat-factory/gitlab@0.4.30
  - @cat-factory/integrations@0.52.1
  - @cat-factory/server@0.64.2

## 0.36.1

### Patch Changes

- Updated dependencies [08be94c]
  - @cat-factory/orchestration@0.54.1
  - @cat-factory/server@0.64.1
  - @cat-factory/node-server@0.56.1

## 0.36.0

### Minor Changes

- 6c51e31: Run inline LLM steps through the ambient Claude Code / Codex CLI in local mode, and refuse to
  start a pipeline whose model preset can't satisfy every step.

  - **Local inline harness execution**: with native agents enabled (`LOCAL_NATIVE_AGENTS`), the
    inline steps (requirements reviewer, brainstorm, task-estimator, inline document kinds) now run
    on the developer's ambient `claude`/`codex` subscription CLI as a host subprocess — the inline
    analogue of the existing container ambient-auth path. Previously a subscription-only preset
    (e.g. Claude Opus) degraded these inline steps to the routing default and failed against an
    unconfigured provider (the confusing "requirements reviewer (qwen:qwen3-max) failed" error).
    Implemented via a new AI-SDK `CliInlineLanguageModel` (`@cat-factory/agents`) wired into the
    local model provider; `inlineModelRef` now keeps an ambient-eligible harness ref instead of
    degrading it. The consensus executor (an inline path) threads the same predicate, so a
    subscription-only consensus participant model is kept inline in local mode too.
  - **Preset satisfiability guard**: the pipeline-start guard now checks INLINE steps against
    inline-usability, not just container-usability. A subscription-only model that satisfies the
    container agents but can't run the inline reviewers (and this deployment has no inline harness)
    is refused up front with a new `preset_unsatisfiable` conflict reason and an actionable message,
    instead of failing mid-run. The SPA maps the new reason to a translated toast.

  Breaking: `inlineModelRef` gains an optional third `opts` argument; the `ConflictReason` wire
  union gains `preset_unsatisfiable`.

### Patch Changes

- 9e93fe8: feat(frontend): `frontendPreview` infrastructure capability + preview-toggle gate (slice 5a of the
  frontend-preview + in-context UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

  A browsable frontend preview keeps a built app served on a host-reachable URL, which needs a
  long-lived host serve — so it is a genuine local/node differentiator. The Worker only runs the
  self-contained UI-test container (built, tested, and torn down with the run), so it cannot host one.
  Until now the `frontendConfig.previewEnabled` toggle (shipped as scaffolding in slice 2) was offered
  on every runtime and read by nothing.

  This lands the capability that makes the toggle honest, and gates it in the SPA where a preview can't
  run. The long-lived build+serve-kept-alive mechanic itself is the remaining slice 5b.

  - **New capability axis** on the `/auth/config` `infrastructureCapabilities` descriptor:
    `frontendPreview: { supported: boolean }`, built by the shared `buildInfrastructureCapabilities`
    so all three facades emit the same shape. Value is a per-facade differentiator — Worker `false`,
    Node + local `true`.
  - **SPA gate**: `FrontendConfig.vue` reads `infrastructure.frontendPreview.supported` (defaulting
    true until the auth handshake resolves) and disables the `previewEnabled` checkbox with an
    explanatory hint (`inspector.frontendConfig.previewUnsupported`, translated across every locale)
    when unsupported. The stored config is left untouched, so a `previewEnabled` flag authored on
    local/node is simply inert when served from the Worker (no migration; pre-1.0 breakage rules).
  - **Conformance** pins that the axis is present + boolean on every facade (its value is a
    differentiator); the Worker `auth.spec` pins `false`, the Node `auth-gate.spec` pins `true`.

- 9b26ff1: feat(frontend): key a deployer's ephemeral env by its service FRAME so a live `service` binding
  resolves (slice 4b of the frontend-preview + in-context UI-testing initiative,
  docs/initiatives/frontend-preview-ui-testing.md).

  A `frontend` frame's `service` binding names a service FRAME id, but a `deployer` keyed its
  ephemeral env only under the task `block_id` it ran on — so `resolveFrontendConfig`'s
  `handle === serviceBlockId` match never hit and a live-service binding fell back to WireMock even
  when the backend's env was up (the deferred keying gap slices 3/4 flagged).

  The env now also records the resolved service `frame_id` (the deployer's block walked up to its
  enclosing frame), and the frontend binding resolution matches handles on THAT. The task-keyed
  `block_id` — and the same-block deployer→tester env projection that reads it — is unchanged; this
  is an additive column, not a re-key.

  - **New `frame_id` column** on `environments`, mirrored D1 (`0030_environment_frame_id.sql`) ⇄
    Drizzle (`environments.frame_id` + generated migration), threaded through `EnvironmentRecord`,
    the `EnvironmentHandle` wire shape, and both registry repos.
  - **Keying**: `RunDispatcher.deployerProvisionArgs` resolves the service frame id via the shared
    frame walk and passes it on `ProvisionArgs.frameId`; the provisioning service persists it on both
    the provisioned and the failed-record paths.
  - **Resolution**: `AgentContextBuilder.resolveFrontendConfig` indexes the single `listHandles` read
    by `handle.frameId` (still one batch read, no per-binding point read), so a `service` binding
    resolves to its live ephemeral URL — and the frontend UI-test infra gate is satisfied instead of
    refusing the run.
  - **Conformance**: a new cross-runtime assertion provisions a service frame's env via a `deployer`,
    then a UI-tester run against a frontend bound to that frame STARTS (the mirror of the existing
    no-live-service refusal), pinning both the `frame_id` D1 ⇄ Drizzle round-trip and the
    frame-keyed resolution.

- e0aa45e: Self-contained frontend UI-test infra (slice 3 of the frontend-preview + in-context
  UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

  A `tester-ui` running on a task under a `type: 'frontend'` frame now builds and serves the
  frontend, stands WireMock up for its OTHER backend upstreams, and drives the UI tests against
  the two together — all as localhost processes in the one container (no Docker-in-Docker), so
  it works on Cloudflare and Apple `container` too.

  - **Harness**: a new `frontend` variant of the tester infra spec (`kind: 'frontend'`) that
    installs, builds (injecting the resolved backend URLs at build time, or a `window.env` shim
    for runtime injection), starts WireMock seeded from the frontend repo's mappings dir, serves
    the built app, health-checks it, and points the agent at it. The `ui` image gains pnpm/yarn
    (corepack), a static file server (`serve`), and a headless JRE + WireMock standalone
    (executor-harness image bumped to 1.28.0).
  - **Backend**: `AgentRunContext` carries a resolved `frontend` slice (the frame's
    `frontendConfig` plus its backend bindings resolved to concrete upstreams — a bound service's
    live ephemeral env URL for the service under test, else a WireMock mock). The engine's
    `testerInfraSpec` turns it into the harness spec, and the tester-infra start gate refuses a
    frontend UI test only when it binds a live-backend `service` with none actually live (a
    mock-only / no-backend frontend passes — WireMock + the static server fully stand it up).
    Empty-envVar bindings are filtered.
  - **Hardening** (review follow-ups): the harness's WireMock / serve child processes get an
    `'error'` listener (a spawn failure is captured, not an uncaught crash of the job server),
    WireMock is now health-checked alongside the served app (a dead mock becomes a prompt note,
    not a test-time ECONNREFUSED), reserved env-var names (`PATH`, `NODE_OPTIONS`, …) are dropped
    from the injected build env, and a configured `servePort` that collides with a reserved
    in-container port (8080 harness job server, 8089 WireMock) falls back to the default. The
    inspector's servePort placeholder now shows 4173. Shared `pathExists` / log-capture helpers
    are de-duplicated in the harness. The frontend UI-test gate's batch env read
    (`environmentRegistryRepository.listByWorkspace`) is added to the mothership remote-persistence
    allow-list so the gate resolves in mothership mode.
  - **Hardening (second review round)**: the frontend stand-up now feeds the run's inactivity
    watchdog with a heartbeat while it installs/builds/serves — a real frontend's `install` +
    `build` can exceed the 10-min inactivity window, and the (activity-silent) stand-up would
    otherwise be killed mid-build with a misleading "likely hung". `serveMode: 'command'` now also
    forwards the resolved backend URLs (`env`) to the serve process, so a runtime-reading
    dev/preview server sees them (previously only `PORT` was passed). Reserved env-var names are
    now also dropped in the backend infra-spec builder (defence in depth, not just the harness).
    The `mockMappingsPath` docs + inspector hint clarify WireMock's `--root-dir` layout (stubs go
    in a `mappings/` subfolder), and the env-injection hint notes the build-tool prefix caveat
    (e.g. Vite only exposes `VITE_*`). The UI-tester prompt flags a live-backend CORS failure as an
    infra gap rather than an app defect.
  - **Hardening (third review round)**: the frontend stand-up now runs in the run's SERVICE
    SUBTREE (`workDir`), not the clone root — a monorepo frontend's `package.json` / `outputDir` /
    `mocks/` live under its own subdirectory, so installing, building, serving and seeding WireMock
    from the repo root would have targeted the wrong directory (the docker-compose stand-up still
    runs at the root, where its repo-relative `composePath` resolves). The harness now bounds
    frontend `servePort` / `wiremockPort` to 1..65535 at its untrusted-body boundary (an
    out-of-range port can never bind, so it falls back to the default). The reserved-env filter —
    in BOTH the harness parse and the backend infra-spec builder — grows the `NODE_EXTRA_CA_CERTS`
    / `BASH_ENV` / `ENV` / `SHELL` / `IFS` names plus the `npm_config_*` and `GIT_*` FAMILIES, so a
    binding that reconfigures the package manager, git, or the TLS trust store during the build is
    dropped rather than injected. Runtime env injection under `serveMode: 'command'` now warns
    (the `window.env` shim is only served in static mode; the forwarded `env` covers the command
    server), and a failed shim write is logged instead of silently swallowed. `AgentContextBuilder`
    gains `resolveServiceFrame` so the frontend-config resolution reuses the frame row the walk
    already loaded instead of re-fetching it. Fixes the `Lint & format` failure (an unnecessary
    `?? {}` empty-fallback spread in the serve env).
  - **Hardening (fourth review round)**: the reserved-env family filter (`npm_config_*` / `GIT_*`)
    now matches **case-insensitively** in BOTH the harness parse and the backend infra-spec builder —
    npm reads its config env with a case-insensitive `/^npm_config_/i`, so `NPM_CONFIG_REGISTRY`
    (upper/mixed case) is honoured just like `npm_config_registry`; a case-sensitive prefix match
    would have let the upper-cased form slip through and reconfigure the package manager during the
    build. The frontend serve/WireMock health-check now also aborts an in-flight probe on the run's
    own abort signal (not just the per-attempt timeout). The stale `envInjectionHint` translation is
    synced across all locales, and the missed-translation class is now guarded in CI (see the app
    note). The agent prompt-note assembly and the frontend `installCommand` are extracted as pure
    helpers with unit coverage.

  `@cat-factory/app`: sync the `envInjectionHint` hint across all locales (the `en` update noting
  the build-tool prefix caveat, e.g. Vite only exposes `VITE_*`, had been left untranslated). A new
  CI **locale-parity guard** now fails a PR that changes an `en.json` message key without changing
  the same key in every other locale, so translations can't silently go stale.

  BREAKING (pre-1.0): the harness `AgentInfraSpec` is now a discriminated union
  (`service` | `frontend`); the default backend-service tester shape is unchanged.

- Updated dependencies [9e93fe8]
- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [edf4e69]
- Updated dependencies [f21279e]
- Updated dependencies [ab7d589]
- Updated dependencies [6c51e31]
- Updated dependencies [456a992]
- Updated dependencies [1d2684f]
- Updated dependencies [33687cf]
  - @cat-factory/contracts@0.77.0
  - @cat-factory/server@0.64.0
  - @cat-factory/node-server@0.56.0
  - @cat-factory/kernel@0.67.0
  - @cat-factory/integrations@0.52.0
  - @cat-factory/orchestration@0.54.0
  - @cat-factory/agents@0.25.0
  - @cat-factory/gitlab@0.4.29

## 0.35.6

### Patch Changes

- Updated dependencies [3135ae8]
  - @cat-factory/gitlab@0.4.28
  - @cat-factory/node-server@0.55.3
  - @cat-factory/server@0.63.3

## 0.35.5

### Patch Changes

- Updated dependencies [39534d6]
  - @cat-factory/server@0.63.2
  - @cat-factory/node-server@0.55.2

## 0.35.4

### Patch Changes

- Updated dependencies [eab2b60]
  - @cat-factory/server@0.63.1
  - @cat-factory/node-server@0.55.1

## 0.35.3

### Patch Changes

- Updated dependencies [762fe66]
  - @cat-factory/contracts@0.76.0
  - @cat-factory/server@0.63.0
  - @cat-factory/node-server@0.55.0
  - @cat-factory/agents@0.24.16
  - @cat-factory/gitlab@0.4.27
  - @cat-factory/integrations@0.51.4
  - @cat-factory/kernel@0.66.1
  - @cat-factory/orchestration@0.53.2

## 0.35.2

### Patch Changes

- fb53662: Recover and surface stalled runs instead of letting them spin `running` forever.

  A run whose durable driver was lost (a crashed/restarted orchestrator that left its
  pg-boss advance job orphaned-`active`) previously stayed `running` indefinitely with no
  error: the Node stale-run sweeper's re-`send` is a silent no-op while the `exclusive`
  singleton is still held, so the run was never recovered or flagged.

  - **Sweeper now reclaims orphaned advance jobs.** It classifies each stale run's advance
    job by pg-boss's own heartbeat (`live` / `orphaned` / `missing`); an orphaned job (dead
    worker, frozen heartbeat) is deleted to free its singletonKey before re-driving, so a
    bare re-send no longer no-ops onto a dead job. Runs on boot too (immediate reconcile),
    not just on the interval.
  - **Hard-stall backstop.** A run orphaned past a deadline (`STALE_RUN_HARD_FAIL_MINUTES`,
    default 60) that recovery can't resume is failed with the new `stalled`
    `AgentFailureKind` — surfaced by the existing failure banner + retry (a new "Run stalled"
    title) instead of spinning silently. Symmetric on the Cloudflare cron sweeper.
  - **Orphaned local containers are reaped at boot** — a still-running per-run container
    whose run has since gone terminal/away (its `release()` never ran) is removed, via a new
    `AgentRunRepository.liveRunIds` batch query + a `ContainerRuntimeAdapter.listRunContainers`.
  - **Harness structured-repair retries transient failures.** The last-ditch structured-output
    repair call now retries HTTP 429 / 5xx / network errors with exponential backoff honoring
    `Retry-After`, so a transient rate-limit no longer turns a recoverable parse into a hard
    `no structured result` run failure. (executor-harness image bumped to 1.27.5.)

  Breaking (internal): `AgentRunRepository.listStale` now returns `StaleAgentRun` (adds
  `updatedAt`) and gains `liveRunIds`; both D1 and Drizzle repos implement them.

- Updated dependencies [fb53662]
  - @cat-factory/kernel@0.66.0
  - @cat-factory/contracts@0.75.0
  - @cat-factory/orchestration@0.53.1
  - @cat-factory/node-server@0.54.3
  - @cat-factory/agents@0.24.15
  - @cat-factory/gitlab@0.4.26
  - @cat-factory/integrations@0.51.3
  - @cat-factory/server@0.62.3

## 0.35.1

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/contracts@0.74.0
  - @cat-factory/kernel@0.65.0
  - @cat-factory/orchestration@0.53.0
  - @cat-factory/agents@0.24.14
  - @cat-factory/gitlab@0.4.25
  - @cat-factory/integrations@0.51.2
  - @cat-factory/server@0.62.2
  - @cat-factory/node-server@0.54.2

## 0.35.0

### Minor Changes

- 0ef76af: Local mode now pins the executor-harness image to the version it was released against and
  refreshes it at boot, so a rerun can't launch a stale — or, via a mutable `:latest`, a
  too-new — harness image (versions aren't guaranteed compatible across the image/backend
  boundary).

  - `LOCAL_HARNESS_IMAGE` is now **optional**: unset resolves to the backend-matched
    `RECOMMENDED_HARNESS_IMAGE` (`resolveHarnessImage`), so a stock deployment runs the
    matched image out of the box.
  - `startLocal()` refreshes the resolved image during its runtime preflight (best-effort;
    falls back to the local copy if the registry is unreachable). Disable with
    `LOCAL_HARNESS_IMAGE_REFRESH=off`. Auto-refresh is skipped on the Apple `container`
    runtime (its CLI verbs differ).
  - An explicit image that differs from the matched pin — or is a mutable tag — is warned
    about at boot.

  Release note: bump `RECOMMENDED_HARNESS_IMAGE` in lockstep with the harness image.

## 0.34.2

### Patch Changes

- Updated dependencies [d4d4cbc]
  - @cat-factory/server@0.62.1
  - @cat-factory/integrations@0.51.1
  - @cat-factory/node-server@0.54.1
  - @cat-factory/orchestration@0.52.1

## 0.34.1

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/contracts@0.73.0
  - @cat-factory/kernel@0.64.0
  - @cat-factory/integrations@0.51.0
  - @cat-factory/server@0.62.0
  - @cat-factory/orchestration@0.52.0
  - @cat-factory/node-server@0.54.0
  - @cat-factory/agents@0.24.13
  - @cat-factory/gitlab@0.4.24

## 0.34.0

### Minor Changes

- 70e321b: Mothership mode: mint the machine token from a whitelisted login and cache it locally, so
  `LOCAL_MOTHERSHIP_TOKEN` is now a headless/CI override instead of a hard requirement.

  A mothership (either facade) serves `POST /auth/machine-token`, which exchanges the caller's
  mothership SESSION for a `machine`-audience token scoped to the user's accounts (derived from
  `accountService.listForUser`; a `requestedAccountIds` hint may only NARROW that set, never widen
  it). The single production mint helper `mintMachineToken` (`@cat-factory/server`) replaces the
  hand-rolled test copy.

  The local facade adds a `node:sqlite` machine-token cache and a local-only
  `POST /local/mothership/connect` proxy: the SPA signs the user into the mothership (OAuth),
  captures the returned session from the redirect fragment, and hands it to its own node, which
  exchanges it for the opaque machine token (cached locally), mints a LOCAL session for the same
  user, and returns it so the SPA is signed in. `composeMothership` now resolves the token per
  request (env override → unexpired cached token → none), so a token-less node boots inert and the
  SPA can drive the login rather than the boot throwing. The login screen gains a "Sign in via
  mothership" affordance behind `localMode.mothership` (i18n across all locales).

  A mothership now honours a post-login `redirect` back to a loopback host (`localhost`,
  `127.0.0.0/8`, `::1`) in `pickPostLoginRedirect`, so the "Sign in via mothership" round-trip lands
  back on the local node without an operator allowlisting every dev port (a redirect to the caller's
  own machine is not a token-exfiltration vector). A failed connect exchange now surfaces an error on
  the login screen instead of silently returning to the sign-in button, and each connect lets the
  mothership assign the node id (a reconnect as a different user never inherits the previous user's
  id).

  Config: `AUTH_MACHINE_TOKEN_TTL_MS` (default 30 days) sets the machine-token lifetime on both
  facades.

### Patch Changes

- Updated dependencies [70e321b]
  - @cat-factory/contracts@0.72.0
  - @cat-factory/server@0.61.0
  - @cat-factory/agents@0.24.12
  - @cat-factory/gitlab@0.4.23
  - @cat-factory/integrations@0.50.2
  - @cat-factory/kernel@0.63.4
  - @cat-factory/orchestration@0.51.7
  - @cat-factory/node-server@0.53.8

## 0.33.4

### Patch Changes

- 37c488f: Internal refactor of mothership-mode code (no behaviour change): share one `node:sqlite` open
  helper between the local credential store and work queue, make `statusForPersistenceError` a
  lookup table, inline the trivial mothership db-path wrappers, bind `pickRepoSource` through a
  local `sourced` helper (collapsing the repeated `remoteRepos`/`db` wiring, including the five
  GitHub projection repos) in the Node container, and centralize the mothership-vs-Postgres
  persistence decision in the local container behind a single `resolveLocalPersistence` helper.
- Updated dependencies [37c488f]
  - @cat-factory/node-server@0.53.7
  - @cat-factory/server@0.60.3

## 0.33.3

### Patch Changes

- Updated dependencies [b744822]
- Updated dependencies [c40736e]
  - @cat-factory/integrations@0.50.1
  - @cat-factory/orchestration@0.51.6
  - @cat-factory/server@0.60.2
  - @cat-factory/node-server@0.53.6

## 0.33.2

### Patch Changes

- Updated dependencies [77c6842]
  - @cat-factory/contracts@0.71.0
  - @cat-factory/integrations@0.50.0
  - @cat-factory/agents@0.24.11
  - @cat-factory/gitlab@0.4.22
  - @cat-factory/kernel@0.63.3
  - @cat-factory/orchestration@0.51.5
  - @cat-factory/server@0.60.1
  - @cat-factory/node-server@0.53.5

## 0.33.1

### Patch Changes

- 79a0f48: Wire the programmatic custom provision-type catalog (`CustomManifestTypeRegistry`)
  into every facade so a code-registered `custom` manifest type is actually visible.
  Previously a deployment/provider package could register a custom manifest type, but
  no runtime constructed or injected the registry, so `listCustomTypes` always saw an
  empty registered set — the type never appeared in the infrastructure custom-type
  editor or the per-service provisioning picker.

  `customManifestTypeRegistry` now belongs to `BackendRegistries` (built by
  `createBackendRegistries()`), and the Cloudflare + Node facades thread it into
  `createCore` (local inherits via `buildNodeContainer`). A deployment registers a
  type by reference — `registries.customManifestTypeRegistry.register({ manifestId,
label, … })` — exactly like a custom environment/runner backend. The cross-runtime
  conformance suite now asserts a registered type surfaces in the handlers bundle
  (`source: 'registered'`) on both runtimes.

- 91f876b: Mothership-mode tech-debt cleanup (functionality-preserving): rename the persistence
  allow-list export `PILOT_PERSISTENCE_METHODS` → `REMOTE_PERSISTENCE_METHODS` (it is the
  functional surface, no longer a pilot) and drop the unused `accountField` `ScopeRule` kind
  that was defined but never allow-listed or exercised. Also refresh stale comments/docs that
  predated the Phase-3 merge gate (which is now MET): the `MothershipComposition.repos` JSDoc,
  the `buildNodeContainer` `db: undefined` service-matrix note, and the mothership-mode tracker
  banner. No runtime behavior change.
- Updated dependencies [79a0f48]
- Updated dependencies [91f876b]
  - @cat-factory/integrations@0.49.0
  - @cat-factory/node-server@0.53.4
  - @cat-factory/server@0.60.0
  - @cat-factory/orchestration@0.51.4

## 0.33.0

### Minor Changes

- cc01f1e: Mothership mode: durable SQLite execution work queue (initiative PR 2).

  The best-effort in-memory `InProcessWorkRunner` is replaced by the durable `SqliteWorkRunner`,
  backed by a file-based `node:sqlite` work queue (default `~/.cat-factory/work-queue.sqlite`,
  override with `LOCAL_MOTHERSHIP_WORK_DB`). A mothership-mode local node has no Postgres/pg-boss,
  so it drives runs in-process — but the queue now persists the "this run needs driving" intent, so
  a crash or restart re-drives what was in flight (boot-time orphan reset + a periodic recovery
  poll). It mirrors pg-boss's `exclusive` advance queue (one row per run, mid-drive signal
  coalescing, deferred gate re-polls, a poison-attempt cap), reusing the same `executionRuntime()`
  timing derivation.

## 0.32.3

### Patch Changes

- Updated dependencies [2e1354f]
  - @cat-factory/contracts@0.70.1
  - @cat-factory/kernel@0.63.2
  - @cat-factory/integrations@0.48.2
  - @cat-factory/server@0.59.2
  - @cat-factory/agents@0.24.10
  - @cat-factory/gitlab@0.4.21
  - @cat-factory/orchestration@0.51.3
  - @cat-factory/node-server@0.53.3

## 0.32.2

### Patch Changes

- Updated dependencies [66a8c71]
  - @cat-factory/integrations@0.48.1
  - @cat-factory/orchestration@0.51.2
  - @cat-factory/server@0.59.1
  - @cat-factory/node-server@0.53.2

## 0.32.1

### Patch Changes

- Updated dependencies [b4c7e60]
  - @cat-factory/contracts@0.70.0
  - @cat-factory/integrations@0.48.0
  - @cat-factory/server@0.59.0
  - @cat-factory/agents@0.24.9
  - @cat-factory/gitlab@0.4.20
  - @cat-factory/kernel@0.63.1
  - @cat-factory/orchestration@0.51.1
  - @cat-factory/node-server@0.53.1

## 0.32.0

### Minor Changes

- f568a8c: Add a built-in "Manual review only" merge-threshold preset and reseeding for the
  merge-preset catalog (mirroring pipelines).

  - "Manual review only" sets a new `autoMergeEnabled: false` flag, so the `merger` step
    never auto-merges a task using it — every PR is routed to a human `merge_review`
    notification regardless of the assessment scores. The flag is editable on any preset via
    a toggle in the Merge thresholds settings.
  - Built-in merge presets now carry a stable id (`mp_balanced`, `mp_manual_review`) and a
    monotonic `version`. The workspace snapshot ships `mergePresetCatalogVersions`, and the
    SPA surfaces a once-per-session startup advisory when a built-in preset is outdated or a
    new built-in appeared upstream, offering a one-click reseed
    (`POST /workspaces/:ws/merge-presets/:id/reseed`).

  Breaking (pre-1.0, no migration): `merge_threshold_presets` gains `auto_merge_enabled`
  (default on) and `version` columns (D1 + Drizzle). First read of a workspace's presets now
  seeds the whole built-in catalog (Balanced + Manual review only), not just the default.

### Patch Changes

- Updated dependencies [f568a8c]
  - @cat-factory/kernel@0.63.0
  - @cat-factory/contracts@0.69.0
  - @cat-factory/orchestration@0.51.0
  - @cat-factory/server@0.58.0
  - @cat-factory/node-server@0.53.0
  - @cat-factory/agents@0.24.8
  - @cat-factory/gitlab@0.4.19
  - @cat-factory/integrations@0.47.1

## 0.31.2

### Patch Changes

- Updated dependencies [41203db]
  - @cat-factory/contracts@0.68.0
  - @cat-factory/integrations@0.47.0
  - @cat-factory/server@0.57.0
  - @cat-factory/agents@0.24.7
  - @cat-factory/gitlab@0.4.18
  - @cat-factory/kernel@0.62.4
  - @cat-factory/orchestration@0.50.1
  - @cat-factory/node-server@0.52.2

## 0.31.1

### Patch Changes

- Updated dependencies [3ec9c90]
  - @cat-factory/server@0.56.1
  - @cat-factory/node-server@0.52.1

## 0.31.0

### Minor Changes

- cb9e2e3: Per-service provision types (Phase 2, slice 10): facade wiring for the async, container-backed
  Kubernetes deploy lifecycle + the local-mode native-CLI deploy transport. A `deployer` step whose
  manifests need rendering (kustomize/helm/Gateway-API) now stands its environment up in a real
  deploy container (or, locally, the host CLIs) on every runtime — slice 9's `deployJobClient` /
  `resolveDeployCloneTarget` seams are no longer unwired. The synchronous raw-manifest REST path is
  unchanged.

  - **Cloudflare Worker**: a new `DeployContainer` Durable Object (per-run, the separate
    deploy-harness image — `kubectl`/`kustomize`/`helm`) bound as `DEPLOY_CONTAINER`, with its
    `[[containers]]` block + binding + a `v4` migration in both wranglers and the class exported from
    the worker entry. The `image: 'deploy'` dispatch routes here while agent jobs stay on
    `ExecutionContainer`. `selectDeployDeps` wires a deploy-dedicated `RunnerJobClient` (over the
    deploy namespace) + `resolveDeployCloneTarget` when the binding + GitHub App are present.
  - **Node**: wires the default pool-backed `deployJobClient` (`new RunnerJobClient(resolveTransport)`)
    - a `resolveDeployCloneTarget` built from the App token mint, both overridable by a sibling facade.
      The self-hosted runner pool now forwards the `image` dispatch option (the generic
      `RunnerPoolTransport` + `HttpRunnerPoolProvider` expose it as a first-class `{{input.image}}`
      variable, and the native Kubernetes runner config gains an `imageDeploy` variant) so a pool pulls
      the deploy-harness image for `image: 'deploy'`.
  - **Local**: a new `NativeCliDeployTransport` (`LOCAL_DEPLOY_RUNTIME=native|container`). `native`
    (default) runs the deploy harness as a host process driving the developer's own
    `kubectl`/`kustomize`/`helm`; `container` runs the deploy image per job, keyed by its own job id so
    it never collides with the run's agent container. The clone target is inherited from Node's default
    (PAT mint + GitLab-aware origin).
  - **Shared**: `@cat-factory/server` exports `makeResolveDeployCloneTarget` (compose a deploy clone
    resolver from a repo-target walk + token mint, with a per-facade clone-URL override).
  - **Conformance**: the cross-runtime suite drives the engine's async render path on every facade —
    it forwards the provider's `deploy` kind + `image: 'deploy'` option through the wired client, polls
    a stubbed view, and finalizes — asserting the finalized record round-trips through each facade's
    real registry repo to an identical `ProvisionedEnvironment` on D1 and Postgres. (The per-facade
    transport selection is out of this runtime-neutral suite's scope; only local's selection has a
    dedicated unit test today.)

### Patch Changes

- Updated dependencies [cb9e2e3]
  - @cat-factory/contracts@0.67.0
  - @cat-factory/integrations@0.46.0
  - @cat-factory/orchestration@0.50.0
  - @cat-factory/server@0.56.0
  - @cat-factory/node-server@0.52.0
  - @cat-factory/agents@0.24.6
  - @cat-factory/gitlab@0.4.17
  - @cat-factory/kernel@0.62.3

## 0.30.2

### Patch Changes

- Updated dependencies [1e55e77]
  - @cat-factory/contracts@0.66.1
  - @cat-factory/integrations@0.45.0
  - @cat-factory/orchestration@0.49.0
  - @cat-factory/agents@0.24.5
  - @cat-factory/gitlab@0.4.16
  - @cat-factory/kernel@0.62.2
  - @cat-factory/server@0.55.2
  - @cat-factory/node-server@0.51.2

## 0.30.1

### Patch Changes

- Updated dependencies [ecf4cc1]
  - @cat-factory/contracts@0.66.0
  - @cat-factory/orchestration@0.48.2
  - @cat-factory/agents@0.24.4
  - @cat-factory/gitlab@0.4.15
  - @cat-factory/integrations@0.44.1
  - @cat-factory/kernel@0.62.1
  - @cat-factory/server@0.55.1
  - @cat-factory/node-server@0.51.1

## 0.30.0

### Minor Changes

- f9678df: Mothership mode: the no-Postgres local boot SPINE (initiative slice 1b). A local node can now
  boot with `LOCAL_MOTHERSHIP_URL` set and NO local database: it composes the remote (RPC-backed)
  org repositories + a local `node:sqlite` credential store (sealed with the LOCAL key; the
  mothership's `ENCRYPTION_KEY` never reaches the machine) and drives runs with an in-process work
  runner instead of pg-boss.

  NOT yet functional end-to-end — keep the mothership PR a DRAFT. The pilot allow-list exposes only
  the six core domain repositories remotely, but a board load and a run reach many more org repos
  (mounts, settings, presets, notifications, projections, …) plus stores still built from the
  now-absent local `db`, so those paths currently throw. Routing the full repository surface through
  the remote registry + widening the server allow-list (with the per-method account/role scope rules
  that boundary needs) is the gating phase in `docs/initiatives/mothership-mode.md`; this work must
  not merge until that phase lands. See the tracker for the per-repo task list.

  - `@cat-factory/server`: `createRemoteRepositoryRegistry(client)` — a drift-proof, full-surface
    remote repository set (a `Proxy` that lazily forwards any accessed repository to one RPC), so a
    mothership-mode node backs its entire `CoreRepositories` surface remotely with no per-repo
    wiring. The server-side allow-list still gates which repo+method actually executes.
  - `@cat-factory/node-server`: `buildNodeContainer` now tolerates `db: undefined` — the per-user
    Postgres services (subscriptions, user secrets, OpenRouter catalog) turn themselves off, the
    API-key pool + local-model endpoints accept injected repositories, and the composite `repos`
    is required in that mode. Re-exports the execution driver + realtime pieces the local
    mothership boot reuses.
  - `@cat-factory/local-server`: `composeMothership` wires the remote repos + the local credential
    store; `buildLocalContainer` composes them with `db: undefined`, injects the credential repos,
    and drives runs with the new in-process `WorkRunner` (the no-pg-boss analogue, serialized per
    execution); `startLocal()` takes the dedicated no-Postgres boot path automatically when
    `LOCAL_MOTHERSHIP_URL` is set.
  - `@cat-factory/contracts`: `localModeConfig.mothership` is surfaced to the SPA so the UI can
    label what is stored locally vs delegated to the mothership.

  Login-based machine-token minting also lands later (a static `LOCAL_MOTHERSHIP_TOKEN` is used for
  now). Pre-1.0, no back-compat: the standard siloed-Postgres local mode is unchanged when
  `LOCAL_MOTHERSHIP_URL` is unset.

### Patch Changes

- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [858799e]
  - @cat-factory/server@0.55.0
  - @cat-factory/node-server@0.51.0
  - @cat-factory/contracts@0.65.0
  - @cat-factory/orchestration@0.48.1
  - @cat-factory/kernel@0.62.0
  - @cat-factory/integrations@0.44.0
  - @cat-factory/agents@0.24.3
  - @cat-factory/gitlab@0.4.14

## 0.29.0

### Minor Changes

- 9bb75b0: Per-service provision types (slices 3 + 4): the deployer engine step + run-details recording,
  and the per-type handler controllers + container wiring.

  Slice 3 — engine step:

  - The `deployer` step now resolves the SERVICE frame's declared `provisioning` and routes to the
    workspace handler for its type (merging the service's manifest source). A service declaring
    `infraless` records a no-op step output (nothing provisioned); an undeclared service falls
    through to the legacy single-connection path. The resolved provision type + engine are recorded
    on the `EnvironmentRecord` (success and failed paths) and surfaced on the step output
    (`Provision type:` / `Engine:` lines + `model: environment:<engine>:<providerId>`).
  - `EnvironmentProvisioningService.provision` gains an `initiatedBy` arg and a
    `resolveUserHandlerOverrides` seam: in local mode the run initiator's per-user handler
    overrides layer over the workspace handlers.

  Slice 4 — controllers + wiring:

  - New per-type infra handler HTTP surface on `EnvironmentController` (workspace-scoped): a batched
    `GET …/environments/handlers` bundle (handlers + custom-type catalog), `POST …/handlers`,
    `PATCH …/handlers/:provisionType/secrets`, `DELETE …/handlers/:provisionType`, plus custom-type
    CRUD (`PUT|DELETE …/environments/custom-types/:manifestId`).
  - New **local-mode-only** `EnvironmentUserHandlerController` mounted at the root
    (`GET /me/environment-handlers/:workspaceId`, `PUT|DELETE …/:provisionType`), backed by the new
    `EnvironmentUserHandlerService`. The service + per-user overrides are wired ONLY by the local
    facade (Worker/Node 503 the controller and ignore user overrides), enforced purely by container
    wiring.
  - `customManifestTypeRepository` is wired on all three facades (workspace catalog CRUD);
    `environmentUserHandlerRepository` only on the local facade.
  - The handler validation/lowering is extracted to a shared `buildInfraHandlerFields` helper used by
    both the workspace and per-user stores. Cross-runtime conformance asserts the per-type handler
    CRUD + custom-type CRUD + the `infraless` deployer no-op on every facade.

### Patch Changes

- Updated dependencies [9bb75b0]
  - @cat-factory/contracts@0.64.0
  - @cat-factory/integrations@0.43.0
  - @cat-factory/orchestration@0.48.0
  - @cat-factory/server@0.54.0
  - @cat-factory/node-server@0.50.0
  - @cat-factory/agents@0.24.2
  - @cat-factory/gitlab@0.4.13
  - @cat-factory/kernel@0.61.1

## 0.28.1

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/server@0.53.0
  - @cat-factory/contracts@0.63.0
  - @cat-factory/kernel@0.61.0
  - @cat-factory/node-server@0.49.0
  - @cat-factory/agents@0.24.1
  - @cat-factory/gitlab@0.4.12
  - @cat-factory/integrations@0.42.1
  - @cat-factory/orchestration@0.47.1

## 0.28.0

### Minor Changes

- f383515: Per-service provision types (slice 2c — tester collapse). **Breaking:** the per-task/per-service
  `local` vs `ephemeral` Tester toggle is gone. A service's declared `provisioning` config now
  drives the Tester's infra entirely, so these are removed (BC is a non-goal — stale rows/columns
  are simply dropped):

  - the `Block` fields `defaultTestEnvironment`, `testComposePath`, `noInfraDependencies` (folded
    into `provisioning.type` / `provisioning.composePath`) — dropped from the contract, the shared
    block mapper, and the D1 (`0026_drop_tester_env_columns.sql`) + Drizzle block columns;
  - the `tester.environment` agent-config descriptor (`@cat-factory/agents`) and its prompt/job-body
    consumers — the Tester's run mode is now derived from the service's provision type;
  - the `delegateTestEnvToProvider` workspace setting (+ its D1/Drizzle column) and the local-facade
    `resolveTesterFallbackDefault` / `resolveRequireEnvironmentProvider` wiring.

  The start-time Tester gate is rewritten: it passes for an `infraless` (or undeclared) service,
  refuses a `docker-compose` service on a runtime that can't nest containers OR with no compose
  path declared (`tester_infra_unsupported` — "limited mode" / "nothing to stand up"), and requires
  a resolvable workspace handler for a `kubernetes`/`custom` service (`provision_type_unhandled`, via
  the new `EnvironmentConnectionService.resolveHandlerForType` /
  `EnvironmentProvisioningService.canProvision` seam). The Tester's run mode (the `infra` job spec +
  the prompt run-mode line, kept in lock-step) is derived from the provision type AND the run's
  provisioned environment: a service that actually provisioned an env URL (e.g. via a `deployer`
  step) tests against it regardless of declared type, and an undeclared service runs with no infra.
  The agent-executor `service` context carries `provisioning` instead of the three legacy fields. The
  service inspector replaces the local/ephemeral toggle with a provision-type selector.

### Patch Changes

- Updated dependencies [f383515]
  - @cat-factory/kernel@0.60.0
  - @cat-factory/contracts@0.62.0
  - @cat-factory/agents@0.24.0
  - @cat-factory/orchestration@0.47.0
  - @cat-factory/integrations@0.42.0
  - @cat-factory/server@0.52.0
  - @cat-factory/node-server@0.48.0
  - @cat-factory/gitlab@0.4.11

## 0.27.4

### Patch Changes

- Updated dependencies [d21588d]
  - @cat-factory/node-server@0.47.0

## 0.27.3

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/kernel@0.59.0
  - @cat-factory/contracts@0.61.0
  - @cat-factory/agents@0.23.4
  - @cat-factory/gitlab@0.4.10
  - @cat-factory/integrations@0.41.1
  - @cat-factory/orchestration@0.46.1
  - @cat-factory/server@0.51.3
  - @cat-factory/node-server@0.46.1

## 0.27.2

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/kernel@0.58.0
  - @cat-factory/contracts@0.60.0
  - @cat-factory/integrations@0.41.0
  - @cat-factory/orchestration@0.46.0
  - @cat-factory/node-server@0.46.0
  - @cat-factory/agents@0.23.3
  - @cat-factory/gitlab@0.4.9
  - @cat-factory/server@0.51.2

## 0.27.1

### Patch Changes

- 6009266: Refresh dependencies to their latest release-age-compliant versions: the Vercel AI
  SDK family within its `workers-ai-provider`-compatible majors (`ai` 6.0.214,
  `@ai-sdk/anthropic` 3.0.89, `@ai-sdk/openai` 3.0.77, `@ai-sdk/openai-compatible`
  2.0.54, `@ai-sdk/amazon-bedrock` 4.0.124), `drizzle-orm`/`drizzle-kit` 1.0.0-rc.4,
  and `yaml` 2.9.0, plus refreshed transitive resolutions.
- Updated dependencies [6009266]
  - @cat-factory/agents@0.23.2
  - @cat-factory/integrations@0.40.1
  - @cat-factory/kernel@0.57.1
  - @cat-factory/orchestration@0.45.3
  - @cat-factory/node-server@0.45.1
  - @cat-factory/server@0.51.1
  - @cat-factory/gitlab@0.4.8

## 0.27.0

### Minor Changes

- 1c326f9: Add the mothership-mode local `node:sqlite` credential store (the consumer-side foundation
  of the mothership-mode initiative). In mothership mode a local node keeps NO main database
  (org/durable state is forwarded to the hosted mothership over the persistence RPC), but the
  agent/model credentials stay on the developer's machine, sealed with the LOCAL key so the
  mothership's `ENCRYPTION_KEY` never reaches the laptop. This ships their persistence: a
  file-based `node:sqlite` store implementing the two `local-sqlite` bucket ports,
  `SqliteProviderApiKeyRepository` (the direct-vendor API-key pool, with usage-window rotation
  and atomic lease-least-used) and `SqliteLocalModelEndpointRepository` (per-user local model
  endpoints), behind a `createLocalCredentialStore(path)` factory. The schema and behaviour
  mirror the Drizzle/D1 repositories column-for-column so a mothership-mode node pools and
  rotates keys identically to a Postgres one. Not yet wired into `buildLocalContainer`: the
  `LOCAL_MOTHERSHIP_URL` composition switch + no-Postgres boot land in the next slice.

## 0.26.1

### Patch Changes

- Updated dependencies [bd23c46]
- Updated dependencies [bd23c46]
- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/node-server@0.45.0
  - @cat-factory/server@0.51.0
  - @cat-factory/contracts@0.59.0
  - @cat-factory/kernel@0.57.0
  - @cat-factory/integrations@0.40.0
  - @cat-factory/agents@0.23.1
  - @cat-factory/gitlab@0.4.7
  - @cat-factory/orchestration@0.45.2

## 0.26.0

### Minor Changes

- 2ac148d: Add a Docker Compose ephemeral-environment backend (the Checkbox-style preview-env mechanic).

  `composeEnvironmentBackend(runtime)` (new in `@cat-factory/integrations`) is an
  `EnvironmentProvider` that stands the PR repo's own `docker-compose.yml` up on a local Docker
  daemon under a per-PR `COMPOSE_PROJECT_NAME`, publishes the configured web service's port to an
  ephemeral host port, returns `http://localhost:<port>` for the Tester/`deployer` flow, and tears
  the project down on TTL. It rides the contract's generic environment-backend manifest member (no
  new config variant, no migration): the flat config lives in the stored manifest's `providerConfig`,
  written by the descriptor-driven connect form.

  To make the per-PR isolation real, the repo compose file is read checkout-free and **rewritten
  into one project file** before `up`: every service's published host port is forced ephemeral (so
  two concurrent per-PR stacks can't collide on a pinned host port — an additive `-f` overlay can't
  strip the base's mapping), the probed service is guaranteed to publish its port, and references
  this checkout-free backend can't honor — `build:` contexts, host bind mounts, relative `env_file`s,
  and `privileged` services — are **refused up front** with a clear reason instead of silently
  mis-mounting. An **auto-teardown TTL** is collected on the connect form (`ttlMinutes`, default
  2h; `0` = never) so a forgotten preview env is swept off the host instead of leaking containers +
  volumes. `testConnection` now probes the daemon (`compose ls`), not just the CLI, and every daemon
  call is time-bounded so a wedged daemon can't hang a provision/status/teardown. Default project
  names are disambiguated by block id so two workspaces sharing a repo name + PR number can't
  collide, and `status` reads `ps -a` so a brief container recreate doesn't flip a healthy env to
  `failed`.

  The local facade (`@cat-factory/local-server`) registers it by reference, closing over the host
  docker CLI, on the Docker-family runtimes only (Apple `container`, the plain Node service, and the
  Cloudflare Worker have no host docker daemon, so they don't register it — the documented
  runtime-bound asymmetry). The infrastructure picker (`@cat-factory/app`) surfaces it on the "Where
  test environments run" axis with actionable "when to use this" guidance and a local-only caveat.

  v1 supports self-contained image-based compose stacks (a service that builds from source, or that
  needs host bind mounts / relative env files, needs a full checkout — a follow-up). No
  backwards-compat concerns: this is a net-new opt-in backend.

### Patch Changes

- Updated dependencies [2ac148d]
  - @cat-factory/integrations@0.39.0
  - @cat-factory/orchestration@0.45.1
  - @cat-factory/server@0.50.3
  - @cat-factory/node-server@0.44.3

## 0.25.15

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/orchestration@0.45.0
  - @cat-factory/contracts@0.58.0
  - @cat-factory/agents@0.23.0
  - @cat-factory/server@0.50.2
  - @cat-factory/node-server@0.44.2
  - @cat-factory/gitlab@0.4.6
  - @cat-factory/integrations@0.38.1
  - @cat-factory/kernel@0.56.1

## 0.25.14

### Patch Changes

- Updated dependencies [1ff013f]
  - @cat-factory/server@0.50.1
  - @cat-factory/orchestration@0.44.1
  - @cat-factory/node-server@0.44.1

## 0.25.13

### Patch Changes

- f9a173f: Fix three concurrency hazards in the backend with database-native primitives.

  - **Optimistic concurrency on execution runs.** `agent_runs` gains a monotonic `rev`
    column; the execution repo's `upsert` bumps it on every write and a new
    `compareAndSwap` performs a guarded conditional write. The in-place human-action handlers
    (resolve decision / request changes / reject / request-human-review-fix / resume-paused)
    now go through a `mutateInstance` retry helper, so a double-submit or a write that raced
    the durable driver is re-applied on fresh state instead of silently clobbering the other
    writer (lost update). (`retry` / `restart-from-step` mint a fresh run id, so the same-row
    hazard is structurally absent there.)
  - **Atomic API-key pool lease.** The non-transactional `listForPool → chooseToken →
markLeased` is replaced by a single atomic select-and-mark (`leaseLeastUsed`: Postgres
    `FOR UPDATE SKIP LOCKED`; D1 a single serialised write), so two concurrent dispatches
    can no longer grab the same key before usage is recorded.
  - **Notification open-card dedup.** A partial unique index on
    `(workspace_id, block_id, type) WHERE status='open'` plus an atomic
    `upsertOpenForBlock` replaces the racy `findOpenByBlock` read-before-write, so two
    concurrent raises can't stack duplicate open cards. `upsertOpenForBlock` returns the
    CANONICAL persisted row, so when a concurrent raise wins the insert the loser delivers
    and returns that row's id rather than a phantom id (which would show a duplicate inbox
    card and 404 when acted on).

  BREAKING (pre-1.0, no data migration): `agent_runs` adds a non-null `rev` column and the
  `notifications` table adds a partial unique index, mirrored across the D1 and Drizzle
  migrations. The `ExecutionRepository`, `ProviderApiKeyRepository` and
  `NotificationRepository` ports each gain a method.

- Updated dependencies [f9a173f]
  - @cat-factory/contracts@0.57.0
  - @cat-factory/kernel@0.56.0
  - @cat-factory/server@0.50.0
  - @cat-factory/orchestration@0.44.0
  - @cat-factory/integrations@0.38.0
  - @cat-factory/node-server@0.44.0
  - @cat-factory/agents@0.22.6
  - @cat-factory/gitlab@0.4.5

## 0.25.12

### Patch Changes

- Updated dependencies [fdeb466]
  - @cat-factory/kernel@0.55.4
  - @cat-factory/orchestration@0.43.4
  - @cat-factory/integrations@0.37.1
  - @cat-factory/node-server@0.43.12
  - @cat-factory/agents@0.22.5
  - @cat-factory/gitlab@0.4.4
  - @cat-factory/server@0.49.6

## 0.25.11

### Patch Changes

- Updated dependencies [0dd9532]
  - @cat-factory/server@0.49.5
  - @cat-factory/node-server@0.43.11

## 0.25.10

### Patch Changes

- 21b2096: Make the environment-backend and runner-backend registries app-owned (DI) instead of
  module-global Maps. This is the pilot for the registry-DI migration
  (`docs/initiatives/registry-di-migration.md`): the composition root now constructs each
  registry instance via `createBackendRegistries()` and injects it through
  `CoreDependencies`; a deployment registers a custom backend by reference
  (`registry.register(provider)`), so registration no longer depends on the adapter and
  server sharing the same `@cat-factory/integrations` module instance.

  BREAKING (`@cat-factory/integrations`): the module-global free functions
  `registerEnvironmentBackend` / `environmentBackend` / `registeredEnvironmentBackendKinds`
  / `environmentBackendKinds` / `findRepairCapableProvider` and their runner-backend
  equivalents (`registerRunnerBackend` / `runnerBackend` / `registeredRunnerBackendKinds`
  / `runnerBackendKinds`) are removed. Use the new `EnvironmentBackendRegistry` /
  `RunnerBackendRegistry` classes (methods `register` / `get` / `kinds` / `labelled`, plus
  `findRepairCapable` on the env registry), the `defaultEnvironmentBackendRegistry()` /
  `defaultRunnerBackendRegistry()` factories, or the unified `createBackendRegistries()`.

- Updated dependencies [21b2096]
  - @cat-factory/integrations@0.37.0
  - @cat-factory/orchestration@0.43.3
  - @cat-factory/server@0.49.4
  - @cat-factory/node-server@0.43.10
  - @cat-factory/contracts@0.56.1
  - @cat-factory/agents@0.22.4
  - @cat-factory/gitlab@0.4.3
  - @cat-factory/kernel@0.55.3

## 0.25.9

### Patch Changes

- Updated dependencies [123336c]
  - @cat-factory/server@0.49.3
  - @cat-factory/node-server@0.43.9

## 0.25.8

### Patch Changes

- Updated dependencies [7536092]
  - @cat-factory/node-server@0.43.8

## 0.25.7

### Patch Changes

- Updated dependencies [4ec514a]
  - @cat-factory/server@0.49.2
  - @cat-factory/node-server@0.43.7

## 0.25.6

### Patch Changes

- ad5d3e0: Collapse the Infrastructure settings into one flat backend list per tab. The "Agent
  containers" and "Test environments" tabs each now show a single radio list of concrete
  destinations (built-in · Kubernetes cluster · custom HTTP pool/provider) with a one-line
  description, instead of stacking a "where it runs" radio above a separate "runner/environment
  backend" dropdown. Selecting a cluster/pool reveals its connect form inline.

  Adds a low-config **Local Kubernetes (k3s)** preset (local mode, agent containers) that
  prefills the Kubernetes runner form for a local k3s cluster — the operator only pastes a
  ServiceAccount token. To support it, the Kubernetes runner form gains the
  `insecureSkipTlsVerify` toggle, and the infrastructure capability descriptor surfaces the
  local deployment's executor image (`suggestedExecutorImage`, from `LOCAL_HARNESS_IMAGE`) so
  the preset's image is prefilled. No backend behavior change was needed — the Kubernetes
  apiserver validator already permits loopback hosts and self-signed TLS.

  Also moves the manifest editor's "currently stored secrets" indication next to the secret
  inputs so it's clear whether a value is already saved.

  BREAKING (pre-1.0, internal): removes the `settings.providerConnection.backend.*` and
  `settings.providerConnection.advancedManifest.*` i18n keys (the old in-form backend
  dropdown + collapsed-manifest disclosure are gone).

- Updated dependencies [ad5d3e0]
  - @cat-factory/contracts@0.56.0
  - @cat-factory/server@0.49.1
  - @cat-factory/agents@0.22.3
  - @cat-factory/gitlab@0.4.2
  - @cat-factory/integrations@0.36.1
  - @cat-factory/kernel@0.55.2
  - @cat-factory/orchestration@0.43.2
  - @cat-factory/node-server@0.43.6

## 0.25.5

### Patch Changes

- Updated dependencies [4897078]
  - @cat-factory/contracts@0.55.0
  - @cat-factory/integrations@0.36.0
  - @cat-factory/server@0.49.0
  - @cat-factory/node-server@0.43.5
  - @cat-factory/agents@0.22.2
  - @cat-factory/gitlab@0.4.1
  - @cat-factory/kernel@0.55.1
  - @cat-factory/orchestration@0.43.1

## 0.25.4

### Patch Changes

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/gitlab@0.4.0
  - @cat-factory/kernel@0.55.0
  - @cat-factory/server@0.48.4
  - @cat-factory/node-server@0.43.4
  - @cat-factory/contracts@0.54.0
  - @cat-factory/orchestration@0.43.0
  - @cat-factory/agents@0.22.1
  - @cat-factory/integrations@0.35.4

## 0.25.3

### Patch Changes

- Updated dependencies [b76f303]
  - @cat-factory/orchestration@0.42.1
  - @cat-factory/server@0.48.3
  - @cat-factory/node-server@0.43.3

## 0.25.2

### Patch Changes

- 48a3df6: Surface the per-run container's live lifecycle in a container agent's details, and bring
  the API Tester window to parity with the Coder.

  Previously a container-backed step showed a "Spinning up container…" badge that simply
  **vanished** once the container was up, leaving a blank "working" state — you couldn't tell
  whether the agent was still preparing the checkout or already making model calls, and there
  was no way to see which container the run was on or whether it was up / errored / gone.

  - **Live phase.** The executor-harness now exposes its current lifecycle phase
    (`starting` → `clone` → `agent` → `push`) on the running job view — the same marker that
    already drove the stuck-run breadcrumb. The engine threads it through
    (`RunnerJobView` / `AgentJobUpdate`) onto the step so the details show WHAT the container
    is doing: "Preparing workspace" vs "Agent running" vs "Pushing changes".
  - **Container identity + address.** The transport now attaches the container's id (the
    Cloudflare Durable Object id; the local Docker container id) and, where one exists, its
    reachable URL (the local host URL) — so a run's details name WHERE it runs.
  - **Explicit lifecycle status.** Steps carry a `container` projection
    (`starting` / `up` / `errored`, with `destroyed` derived once the run's container is
    reclaimed), so the details say whether the container is spinning up, running, errored, or
    gone — instead of inferring it from a run-level failure.
  - **API Tester parity.** The Tester result window now reuses the same observability the
    Coder's step detail shows — the container lifecycle (status / phase / id / url), the
    ephemeral environment status, and the run's infrastructure attempts + logs — alongside its
    test report, instead of the report alone. The Tester (and the human-test / visual-confirm
    gate helpers) now surface the cold-boot `starting` window before the agent comes up, like
    the Coder, rather than jumping straight to "running".
  - **The legacy `startingContainer` boolean is removed** in favour of the richer `container`
    projection everywhere (no dual-signal path): every container-backed step — including the
    gate helpers — now reports its lifecycle through `container`. (Stale persisted steps simply
    drop the field; backwards compatibility is a non-goal.)

  Bumps the `@cat-factory/executor-harness` image to `1.24.0` (and the matching tag in
  `deploy/backend`).

- 48a3df6: Fix the Tester→Fixer loop, make fixer runs inspectable, and let the Tester abort a run.

  Three related issues in the API/UI Tester flow:

  - **The Tester never actually re-ran after a Fixer round, so the step was marked "done"
    regardless of the outcome.** The harness keys each job by `run + agentKind` and re-attaches
    to an existing entry rather than re-running (replay idempotency). A container-reusing
    transport (a warm local pool / a self-hosted runner pool) keeps that registry alive across
    rounds — reclaiming a pooled member does NOT destroy it — so a re-dispatched Tester
    re-attached to its FIRST round's completed job and silently replayed the stale report. Each
    re-dispatch within a run now carries a per-round **dispatch epoch** folded into the harness
    job id (`AgentRunContext.dispatchEpoch`), so the re-test always runs anew. Also covers the
    CI/conflicts gate fixer loops, which share the same re-dispatch shape. Defensively, a report
    with any failed outcome can no longer be greenlit (a failed check is treated as a blocker).
    The conformance suite now models a pooled container so the loop is exercised faithfully.

  - **Fixer companion runs were opaque.** A Tester step now keeps an append-only `attemptLog`
    of its fixer rounds (what each round was handed + how it ended), rendered as an inspectable
    timeline in the test report window instead of only a bare "N/M fix" count.

  - **The Tester can now ABORT a run instead of looping the fixer.** When the change cannot be
    meaningfully tested — its ephemeral environment never came up, a required dependency is
    missing — the Tester sets `abort: { reason }` on its report (or the engine auto-aborts when
    the step's ephemeral environment is in a `failed` state). The run stops, the block is left
    blocked (retryable), and a human-actionable notification is raised — the fixer is NOT
    dispatched, since it cannot provision infrastructure.

  This is a breaking change to the persisted Tester step state and the test-report wire shape
  (new `attemptLog` / `abort` fields); per the project's pre-1.0 policy, stale in-flight runs
  may simply break rather than migrate.

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/kernel@0.54.0
  - @cat-factory/contracts@0.53.0
  - @cat-factory/orchestration@0.42.0
  - @cat-factory/server@0.48.2
  - @cat-factory/agents@0.22.0
  - @cat-factory/node-server@0.43.2
  - @cat-factory/gitlab@0.3.9
  - @cat-factory/integrations@0.35.3

## 0.25.1

### Patch Changes

- Updated dependencies [614e985]
  - @cat-factory/integrations@0.35.2
  - @cat-factory/orchestration@0.41.4
  - @cat-factory/server@0.48.1
  - @cat-factory/node-server@0.43.1

## 0.25.0

### Minor Changes

- 0577404: feat: move infrastructure configuration into its own top-level navbar menu. Agent-container execution + Tester environments + (local mode) the warm-container pool / checkout reuse now live in a dedicated tabbed "Infrastructure" window reached from the navbar, instead of being buried in the Integrations hub and a separate "Local mode" entry. The old bare "delegate to runner pool" toggle is replaced by a clear execution-backend selector that reflects the backends available for THIS deployment (local Docker host / Cloudflare Containers / self-hosted runner pool) and which is active — driven by a new symmetric `infrastructure` capability descriptor on `GET /auth/config` (set by every facade; asserted by the cross-runtime conformance suite). The raw-JSON runner manifest editor is kept but collapsed behind an "Advanced: custom API-based scheduler" disclosure, since the common backends don't need it.

### Patch Changes

- Updated dependencies [0577404]
  - @cat-factory/contracts@0.52.0
  - @cat-factory/server@0.48.0
  - @cat-factory/node-server@0.43.0
  - @cat-factory/agents@0.21.17
  - @cat-factory/gitlab@0.3.8
  - @cat-factory/integrations@0.35.1
  - @cat-factory/kernel@0.53.1
  - @cat-factory/orchestration@0.41.3

## 0.24.0

### Minor Changes

- 69558f9: Add a Kubernetes-based ephemeral-environment provider, selected per workspace through an
  env-backend registry that mirrors the runner-pool backends.

  The ephemeral-environment connection is now discriminated by a `kind` field (`manifest` =
  the generic BYO HTTP management API, `kubernetes` = native per-PR namespaces), resolved
  through a `registerEnvironmentBackend` provider-registry seam — so a native backend is a
  single registry entry + a config variant + a UI form, with no new table/service/controller.

  The Kubernetes backend applies an operator-authored set of k3s/Kubernetes manifests into a
  per-PR namespace over the kube-apiserver (server-side apply), reusing the Kubernetes runner
  backend's shared apiserver client (Bearer ServiceAccount token + custom-CA TLS). Manifests
  are read checkout-free from either the PR repo (co-located) or a separate repo; the URL is
  derived from an ingress host template or read back from an applied Service/Ingress
  LoadBalancer (k3s Traefik / ServiceLB). It is wired symmetrically into the Cloudflare and
  Node facades (the Worker rejects a custom-CA config it can't honor), and local mode can
  point at a developer-run local k3s (its env URL-safety policy is widened to loopback/LAN).
  See `backend/docs/local-k3s-environments.md`.

  BREAKING (pre-1.0):

  - The `environments/connection` register/test wire shape now takes a discriminated `config`
    instead of a bare `manifest`, and the `environment_connections` table gains a `kind`
    column (existing rows backfill to `manifest`).
  - The `EnvironmentProvider` provision request gains optional `runRepo` / `resolveRepoFiles`
    seams (additive).
  - The deployment-wide environment-provider injection option
    (`buildNodeContainer({ environmentProvider })` / `startLocal({ environmentProvider })`) is
    removed — native adapters register via `registerEnvironmentBackend` instead.

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/contracts@0.51.0
  - @cat-factory/kernel@0.53.0
  - @cat-factory/integrations@0.35.0
  - @cat-factory/server@0.47.0
  - @cat-factory/node-server@0.42.0
  - @cat-factory/orchestration@0.41.2
  - @cat-factory/agents@0.21.16
  - @cat-factory/gitlab@0.3.7

## 0.23.1

### Patch Changes

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0
  - @cat-factory/contracts@0.50.1
  - @cat-factory/server@0.46.3
  - @cat-factory/orchestration@0.41.1
  - @cat-factory/integrations@0.34.1
  - @cat-factory/agents@0.21.15
  - @cat-factory/gitlab@0.3.6
  - @cat-factory/node-server@0.41.2

## 0.23.0

### Minor Changes

- 40f687d: Surface container/environment spin-up breakages on the agent step instead of hanging or hiding them.

  - **Local Docker mode fails fast.** `LocalContainerRunnerTransport` now aborts the
    container start the moment the container has exited (or a CLI call fails) instead of
    spinning for the full ready timeout, and the thrown error carries the real Docker
    stderr plus a tail of the container's own logs — so a broken daemon / failed image
    pull / crashing entrypoint shows the root cause in the step's failure card and the
    provisioning-logs drawer within one poll rather than ~60s of "spinning up container".
    Adds a `logs()` method to the `ContainerRuntimeAdapter` seam (Docker + Apple adapters).

  - **Kubernetes runner fails fast on doomed pods.** `KubernetesRunnerTransport` now
    detects terminal container start-up reasons (`ImagePullBackOff`/`ErrImagePull`/
    `InvalidImageName`/`CreateContainerConfigError`/`CrashLoopBackOff`/…) and aborts the
    readiness wait immediately with the pod's real `reason: message` as a hard `dispatch`
    failure — instead of polling the full 120s and then mis-tagging a deterministic failure
    (e.g. a bad image) as a recoverable "evicted" that the engine re-drives into the same
    120s hang. The recoverable timeout/terminated paths are also enriched with the latest
    pod-status detail so a stuck pod is no longer a bare "not ready within 120000ms".

  - **Custom EnvironmentProvider failures are stored and displayed.** A failed `deployer`
    provision (the provider threw, or returned `status:'failed'`) is now a real, displayed
    step failure: the errored environment (with the provider's verbatim `lastError`) is
    persisted and stamped onto the step, and the run records a new `environment`
    `AgentFailureKind` — instead of a green step with the error buried in its prose output.
    A provider that reports `status:'failed'` WITHOUT throwing can now carry its verbatim
    reason on the new optional `ProvisionedEnvironment.error` field (`@cat-factory/kernel`),
    which surfaces as the step's `lastError` instead of a generic "Provisioning failed". The
    failure is terminal + surfaced for one-click retry (NOT auto-retried), deliberately
    symmetric with the `dispatch` (container-failed-to-start) failure.

  **Breaking shape change:** `agentFailureKindSchema` gains the `environment` member.
  Pre-1.0, no migration — stale failure rows simply don't use the new kind.

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/contracts@0.50.0
  - @cat-factory/kernel@0.51.0
  - @cat-factory/integrations@0.34.0
  - @cat-factory/orchestration@0.41.0
  - @cat-factory/agents@0.21.14
  - @cat-factory/gitlab@0.3.5
  - @cat-factory/server@0.46.2
  - @cat-factory/node-server@0.41.1

## 0.22.2

### Patch Changes

- Updated dependencies [e0f1149]
  - @cat-factory/contracts@0.49.0
  - @cat-factory/kernel@0.50.0
  - @cat-factory/integrations@0.33.0
  - @cat-factory/node-server@0.41.0
  - @cat-factory/server@0.46.1
  - @cat-factory/orchestration@0.40.2
  - @cat-factory/agents@0.21.13
  - @cat-factory/gitlab@0.3.4

## 0.22.1

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/contracts@0.48.0
  - @cat-factory/kernel@0.49.0
  - @cat-factory/integrations@0.32.0
  - @cat-factory/server@0.46.0
  - @cat-factory/node-server@0.40.0
  - @cat-factory/orchestration@0.40.1
  - @cat-factory/agents@0.21.12
  - @cat-factory/gitlab@0.3.3

## 0.22.0

### Minor Changes

- e3b3540: feat(environments): durable, asynchronous environment-provider config-repair agent

  When mechanical config bootstrap can't produce a valid provider config (`needsAgent`, or the
  re-validation still fails) and the caller passed `allowAgentFallback`, the engine dispatches a
  coding agent that fixes the provider's config file in an existing repo and pushes the fix back.
  That repair is now a **durable, asynchronous, observable run** — modelled exactly on the
  "bootstrap repo" flow — instead of being awaited synchronously inside the `bootstrapRepo` HTTP
  request (a ~20-minute in-request poll loop that could not survive on the Cloudflare Worker).

  - The repair is its own `kind='env-config-repair'` run in the unified `agent_runs` table (no DB
    migration — the table is kind-scoped), driven durably by **Cloudflare Workflows**
    (`EnvConfigRepairWorkflow`) ⇄ **Node pg-boss** (`env-config-repair.advance` queue), and
    re-driven by the existing cron / stale-run sweeper on either runtime. Local mode inherits the
    pg-boss driver via `buildNodeContainer`.
  - `ContainerEnvConfigRepairer` (`@cat-factory/server`) is reworked into the kernel
    `EnvConfigRepairer` port (`startRepair`/`pollRepair`/`stopRepair`) — dispatch returns
    immediately; the durable runner polls. It still dispatches a plain `coding` job (no `bootstrap`
    block, no PR, no force-push), distinct from the repo-bootstrap flow.
  - `bootstrapRepo` now **starts** the repair run and returns immediately with `usedAgent:true`,
    `repairJobId`, and `ok:false` (pending); the new `EnvConfigRepairService` re-validates the repo
    on completion (via a callback into `EnvironmentConnectionService`, where the decrypted secrets +
    manifest config live) and records the terminal `ok`/`issues`. In PR mode the fix is targeted at
    the config PR branch, not the target branch.
  - The run is observable: progress/outcome is pushed as an `env-config-repair` workspace event and
    carried on the workspace snapshot (`envConfigRepairJobs`); the SPA holds it in the agentRuns
    store and rides the unified `agent-runs` retry/stop endpoints (the new kind supports both —
    retry re-starts a fresh run from the failed job's coords). There is no board block — a repair is
    surfaced only on the infrastructure-providers surface that triggered it.
  - Wired symmetrically across the Cloudflare, Node and local facades, with a cross-runtime
    conformance assertion (`driveEnvConfigRepair` + a fake `EnvConfigRepairer`) that drives a repair
    to `succeeded` with the post-repair validation recorded on both D1 and Postgres. Gated on the
    container prerequisites plus a provider that supports `describeRepairAgent`, so a stock
    deployment running the generic manifest provider is unchanged.
  - The original bootstrap `inputs` (which shape the repair agent's prompt) are persisted on the
    run record (internal, never on the wire), so a retry re-dispatches a fresh run with the SAME
    prompt context via `EnvConfigRepairService.retry` instead of dropping them.

  Breaking (pre-1.0, no migration): the `dispatchConfigRepair` /
  `CoreDependencies.dispatchEnvConfigRepair` seam is replaced by the `EnvConfigRepairer` /
  `EnvConfigRepairRunner` / `EnvConfigRepairJobRepository` ports + `Core.envConfigRepair`; any
  in-flight synchronous repair shape is obsolete.

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/contracts@0.47.0
  - @cat-factory/kernel@0.48.0
  - @cat-factory/server@0.45.0
  - @cat-factory/integrations@0.31.0
  - @cat-factory/orchestration@0.40.0
  - @cat-factory/node-server@0.39.0
  - @cat-factory/agents@0.21.11
  - @cat-factory/gitlab@0.3.2

## 0.21.1

### Patch Changes

- Updated dependencies [704c99e]
  - @cat-factory/integrations@0.30.0
  - @cat-factory/contracts@0.46.0
  - @cat-factory/server@0.44.0
  - @cat-factory/node-server@0.38.0
  - @cat-factory/orchestration@0.39.2
  - @cat-factory/agents@0.21.10
  - @cat-factory/gitlab@0.3.1
  - @cat-factory/kernel@0.47.2

## 0.21.0

### Minor Changes

- 2961b05: Meaningfully widen GitLab support in local mode — a `GITLAB_PAT` deployment now drives the
  real agent workflow, not just sign-in:

  - **`@cat-factory/gitlab`** adds `asGitHubClient(...)`, a `VcsClient`→`GitHubClient` adapter so
    any provider-neutral VCS client (e.g. `FetchGitLabClient`) satisfies the legacy `GitHubClient`
    port the engine's CI gate, merger and repo-read paths still consume.
  - **`@cat-factory/server`** resolves a run's repo origin (clone URL + provider) through an
    injectable `resolveRepoOrigin` seam and stamps the provider onto the dispatched job, instead
    of hardcoding a `github.com` clone URL. The default stays GitHub, so the Worker/Node facades
    are unchanged; a GitLab deployment supplies a GitLab origin so containers clone the right host
    and open merge requests. Without this the clone URL was always github.com, so a GitLab repo
    could never be cloned by an agent container.
  - **`@cat-factory/node-server`** threads `resolveRepoOrigin` through `NodeContainerOptions` to
    the container executor (default GitHub), so a sibling facade can supply a GitLab origin.
  - **`@cat-factory/local-server`** wires a GitLab PAT symmetrically to the GitHub PAT: the agent
    containers' git clone/push token falls back to `GITLAB_PAT`; the CI gate, mergeability, real
    merge and repo-link flows read through a PAT-backed `FetchGitLabClient` (adapted to
    `GitHubClient`); the agent containers clone the configured GitLab host + open merge requests
    (via `resolveRepoOrigin`); and the GitLab host is added to the harness clone/push allow-list
    (`GITHUB_ALLOWED_HOSTS`) so the container doesn't reject the GitLab clone URL. A GitLab-only
    local deployment is now a first-class source-control backend. Set `GITLAB_API_BASE` for a
    self-managed instance. The boot warning and the cross-provider `vcs-conformance` test cover
    both providers.
  - **`@cat-factory/executor-harness`** opens a GitLab **merge request** (not a GitHub PR) when the
    job's `repo.provider` is `gitlab` (set authoritatively by the server, so a self-managed GitLab
    on an arbitrarily-named host is routed correctly), falling back to host inference from the
    clone URL. The REST base + project path are derived from the host, and an already-open MR is
    reused on a resumed run. The GitHub path is unchanged. (The runner image must be republished
    for this to take effect in a deployed worker.)

### Patch Changes

- Updated dependencies [2961b05]
  - @cat-factory/node-server@0.37.0
  - @cat-factory/server@0.43.0
  - @cat-factory/gitlab@0.3.0

## 0.20.1

### Patch Changes

- Updated dependencies [5ad45de]
  - @cat-factory/orchestration@0.39.1
  - @cat-factory/server@0.42.1
  - @cat-factory/node-server@0.36.1

## 0.20.0

### Minor Changes

- 3d0b85c: feat(environments): wire the live environment-provider config-repair agent (PR #416 increment 2)

  When mechanical config bootstrap can't produce a valid provider config (`needsAgent`, or the
  post-commit re-validation still fails) and the caller passed `allowAgentFallback`, the engine now
  dispatches a coding agent that clones the target repo at the write branch, fixes the provider's
  config file in place, and pushes the fix back onto the same branch — then `EnvironmentConnectionService`
  re-validates.

  - New `ContainerEnvConfigRepairer` (`@cat-factory/server`) dispatches a plain `coding` job via the
    shared `RunnerJobClient`/`RunnerTransport` (no `bootstrap` block, no PR) and awaits it. It is
    distinct from the repo-bootstrap flow — it never reinitialises history or force-pushes.
  - The `dispatchConfigRepair` / `CoreDependencies.dispatchEnvConfigRepair` seam now returns `void`
    (it only pushes the fix); re-validation moved into `EnvironmentConnectionService`, where the
    decrypted secrets + manifest config live.
  - Wired symmetrically across the Cloudflare and Node facades (local inherits via `buildNodeContainer`),
    gated on the container prerequisites plus an injected provider that supports `describeRepairAgent`,
    so a stock deployment running the generic manifest provider is unchanged.

### Patch Changes

- Updated dependencies [3d0b85c]
  - @cat-factory/server@0.42.0
  - @cat-factory/integrations@0.29.0
  - @cat-factory/orchestration@0.39.0
  - @cat-factory/node-server@0.36.0

## 0.19.5

### Patch Changes

- c2ec53b: Local mode: env-PAT sign-in that's remembered across restarts.

  Local-mode sign-in is now purely **provider selection** — a "Sign in with configured
  GitHub/GitLab PAT" button for whichever of `GITHUB_PAT` / `GITLAB_PAT` is set in env. The
  paste-a-token textarea is **removed**: a pasted token only ever resolved an identity (it never
  became the operational clone/push token, which comes from env), so it was a dead-end. When
  neither PAT is configured, the login screen shows an informational notice (with scopes-preset
  token-creation links) instead of an empty form; email/password sign-in is unchanged.

  The chosen provider (a non-secret label — never the token) is remembered in `localStorage`, so
  on a later load the SPA silently re-mints a session from the env PAT without showing the login
  screen. Logout clears it (so logout sticks, no re-login loop); a transient/expiry 401 keeps it
  so the next load re-mints rather than bouncing to the login screen. The PAT never leaves the
  server.

  `AUTH_SESSION_SECRET` and `ENCRYPTION_KEY` are now **required** in local mode (no longer
  auto-generated per process). The per-process auto-generation was the original cause of "re-enter
  the PAT every restart" — a fresh session secret each boot invalidated the persisted session, and
  a fresh encryption key orphaned credentials sealed at rest. Boot now **fails loudly** with an
  actionable message when either is unset. A new `pnpm secrets` script in `deploy/local` prints
  both in the correct format (cross-platform, no `openssl` needed) to paste into `.env`.

  **Breaking (pre-1.0, no migration):**

  - the `localMode.patLogin.available` field is removed from the auth-config wire shape; only
    `configured` + `setupUrls` remain.
  - local mode no longer auto-generates `AUTH_SESSION_SECRET` / `ENCRYPTION_KEY`; both must be set
    in the environment (generate via `pnpm secrets`).

- Updated dependencies [c2ec53b]
  - @cat-factory/contracts@0.45.1
  - @cat-factory/server@0.41.1
  - @cat-factory/agents@0.21.9
  - @cat-factory/gitlab@0.2.2
  - @cat-factory/integrations@0.28.1
  - @cat-factory/kernel@0.47.1
  - @cat-factory/orchestration@0.38.1
  - @cat-factory/node-server@0.35.5

## 0.19.4

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0
  - @cat-factory/contracts@0.45.0
  - @cat-factory/integrations@0.28.0
  - @cat-factory/server@0.41.0
  - @cat-factory/orchestration@0.38.0
  - @cat-factory/node-server@0.35.4
  - @cat-factory/agents@0.21.8
  - @cat-factory/gitlab@0.2.1

## 0.19.3

### Patch Changes

- Updated dependencies [0784fe0]
- Updated dependencies [0784fe0]
  - @cat-factory/orchestration@0.37.3
  - @cat-factory/server@0.40.3
  - @cat-factory/node-server@0.35.3

## 0.19.2

### Patch Changes

- Updated dependencies [5e54936]
- Updated dependencies [5e54936]
  - @cat-factory/orchestration@0.37.2
  - @cat-factory/server@0.40.2
  - @cat-factory/node-server@0.35.2

## 0.19.1

### Patch Changes

- Updated dependencies [cc101a7]
  - @cat-factory/orchestration@0.37.1
  - @cat-factory/server@0.40.1
  - @cat-factory/node-server@0.35.1

## 0.19.0

### Minor Changes

- 8727f2b: Filesystem blob backend + UI-managed, per-account content storage.

  - New `FilesystemBinaryBlobBackend` (Node/local) stores binary artifacts (UI-tester
    screenshots, reference designs) on disk under a base path (default `.file-storage`,
    git-ignored). Added `'fs'` to `BinaryArtifactStorageKind`.
  - Content-storage configuration moves entirely into the UI, scoped per **account**
    (Account → Deployment settings), stored in `account_settings` (no DB migration; the
    S3 access keys are sealed in the existing secrets blob). The blob backend is now
    resolved per request/run from the account's settings via the new
    `makeResolveBinaryArtifactStore` seam (`@cat-factory/server`), replacing the static
    `binaryArtifactStore` on the container with a `resolveBinaryArtifactStore(workspaceId)`.
  - Available backends per runtime: **Node/local** offer `fs` / `s3` / `db`, **Cloudflare**
    offers `r2` only (S3 is deliberately not offered on the Worker — the AWS SDK does not belong
    in the Worker bundle). Defaults when an account hasn't configured storage: **local** defaults
    to the filesystem backend (works out of the box); **Node** defaults to off (storage requires
    explicit configuration); **Cloudflare** defaults to its R2 bucket.

  BREAKING: the env-var content-storage configuration is removed — `BINARY_STORAGE_BACKEND`,
  `S3_ARTIFACT_*`, and `AppConfig.binaryStorage`/`BinaryStorageConfig` no longer exist.
  Configure storage per-account in the UI instead. Switching an account's backend orphans its
  previously-stored artifacts (no migration of existing bytes), which is acceptable pre-1.0.

- 56e6ce6: Local mode: sign in with a source-control PAT (GitHub or GitLab) or email/password.

  Local mode previously ran fully anonymous (dev-open, no user), so per-user features —
  personal subscriptions, your own API keys — failed with 401 ("Sign in to manage …") with
  no way to sign in. Local mode now establishes a real identity:

  - A new provider-agnostic `VcsIdentityResolver` port (kernel) turns a raw PAT into a
    neutral identity (the provider's stable numeric user id — the SAME subject GitHub OAuth
    uses, so a PAT login and an OAuth login resolve to one canonical user). GitHub and GitLab
    resolvers ship in `@cat-factory/server` / `@cat-factory/gitlab`; adding an Nth provider is
    one more resolver entry, no endpoint or UI changes.
  - A new `POST /auth/pat` endpoint (served only where resolvers are wired — local mode)
    mints a session for the account a PAT belongs to. The local login screen offers one-click
    "Continue with GitHub/GitLab" when a `GITHUB_PAT`/`GITLAB_PAT` is configured, an inline
    "paste a PAT" form otherwise, and email/password sign-in (enabled by default in local
    mode, with open signup on the developer's own machine).
  - The SPA now requires sign-in in local mode (anonymous use can't store per-user
    credentials); the session is honored even though the API otherwise runs dev-open.
  - `'gitlab'` is now an identity provider. Identities remain collision-safe via the
    `(provider, subject)` key: a GitHub user and a GitLab user with the same numeric id, and
    a password account (keyed on email), are always distinct.

  Also adds a guard on the per-user credential forms (personal subscriptions, your own API
  keys): when there is genuinely no signed-in user (a non-local deployment running with auth
  disabled), the inputs are blocked with a clear notice instead of accepting data that can't
  be saved.

  BREAKING (local mode only): existing anonymously-created local boards have no owner, so
  after upgrading they become inaccessible once sign-in is required — recreate them under
  your signed-in account. (Pre-1.0, no data migration.)

### Patch Changes

- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/orchestration@0.37.0
  - @cat-factory/kernel@0.46.0
  - @cat-factory/contracts@0.44.0
  - @cat-factory/integrations@0.27.0
  - @cat-factory/server@0.40.0
  - @cat-factory/node-server@0.35.0
  - @cat-factory/gitlab@0.2.0
  - @cat-factory/agents@0.21.7

## 0.18.11

### Patch Changes

- 8fad695: Update dependencies to latest.

  - `undici` 7→8 (test-only `MockAgent`). undici's MockAgent must match Node's
    bundled undici to intercept the global `fetch`; Node 26 bundles undici 8.5.0,
    so the test runner / CI is pinned to **Node 26**. Production runtime is
    unaffected — `undici` is a dev/test dependency only, and the service still runs
    on any Node >=20 (e.g. the example `deploy/node` image stays on Node 24).
  - Minor/patch bumps: `wrangler` 4.105, `@cloudflare/*`, `@types/node` 26.0.1,
    `vue` 3.5.39, `msw` 2.14.6, `valibot` 1.4.2, `workers-ai-provider` 3.2.1,
    `@toad-contracts/*` (core 0.4.0, valibot 0.5.0, hono/testing/http-client 0.3.2),
    `@aws-sdk/client-s3` 3.1075.
  - The AI SDK (`ai`, `@ai-sdk/*`) is intentionally held at v6 / v3-v4: the latest
    `workers-ai-provider` (3.2.1, the Cloudflare Workers AI provider) still peers on
    `ai@^6` / `@ai-sdk/provider@^3` and is not yet compatible with `ai` v7.
  - Pinned the whole Vue runtime family to one version via a pnpm `override`
    (`vue` + `@vue/*` → 3.5.39). Bumping `vue` to 3.5.39 left Nuxt 4.4.8's
    transitive deps pinning parts of the graph to 3.5.38, so two copies of Vue were
    bundled into the SPA; Vue's render internals are module-level singletons, so the
    second copy crashed the app on boot (`Cannot read properties of null (reading
'ce')` in `renderSlot`) — a blank 500 page that hung the whole e2e suite. One
    version = one singleton.
  - GitHub Actions: `actions/checkout` v6→v7, `pnpm/action-setup` v6.0.9,
    `zizmorcore/zizmor-action` v0.5.7, `changesets/action` pinned to v1.9.0. CI Node 24→26.

- Updated dependencies [8fad695]
  - @cat-factory/integrations@0.26.5
  - @cat-factory/orchestration@0.36.5
  - @cat-factory/node-server@0.34.8
  - @cat-factory/contracts@0.43.3
  - @cat-factory/kernel@0.45.5
  - @cat-factory/server@0.39.8
  - @cat-factory/agents@0.21.6

## 0.18.10

### Patch Changes

- Updated dependencies [fb339db]
  - @cat-factory/contracts@0.43.2
  - @cat-factory/agents@0.21.5
  - @cat-factory/integrations@0.26.4
  - @cat-factory/kernel@0.45.4
  - @cat-factory/orchestration@0.36.4
  - @cat-factory/server@0.39.7
  - @cat-factory/node-server@0.34.7

## 0.18.9

### Patch Changes

- Updated dependencies [7d219ab]
  - @cat-factory/server@0.39.6
  - @cat-factory/node-server@0.34.6

## 0.18.8

### Patch Changes

- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3
  - @cat-factory/orchestration@0.36.3
  - @cat-factory/server@0.39.5
  - @cat-factory/node-server@0.34.5
  - @cat-factory/agents@0.21.4
  - @cat-factory/integrations@0.26.3

## 0.18.7

### Patch Changes

- Updated dependencies [1a349b5]
  - @cat-factory/server@0.39.4
  - @cat-factory/node-server@0.34.4

## 0.18.6

### Patch Changes

- Updated dependencies [80e5fc9]
  - @cat-factory/server@0.39.3
  - @cat-factory/node-server@0.34.3

## 0.18.5

### Patch Changes

- Updated dependencies [c11a0cc]
  - @cat-factory/agents@0.21.3
  - @cat-factory/contracts@0.43.1
  - @cat-factory/integrations@0.26.2
  - @cat-factory/kernel@0.45.2
  - @cat-factory/orchestration@0.36.2
  - @cat-factory/server@0.39.2
  - @cat-factory/node-server@0.34.2

## 0.18.4

### Patch Changes

- Updated dependencies [5363166]
- Updated dependencies [5363166]
  - @cat-factory/orchestration@0.36.1
  - @cat-factory/kernel@0.45.1
  - @cat-factory/server@0.39.1
  - @cat-factory/node-server@0.34.1
  - @cat-factory/agents@0.21.2
  - @cat-factory/integrations@0.26.1

## 0.18.3

### Patch Changes

- Updated dependencies [eab73b8]
- Updated dependencies [eab73b8]
  - @cat-factory/contracts@0.43.0
  - @cat-factory/kernel@0.45.0
  - @cat-factory/integrations@0.26.0
  - @cat-factory/orchestration@0.36.0
  - @cat-factory/server@0.39.0
  - @cat-factory/node-server@0.34.0
  - @cat-factory/agents@0.21.1

## 0.18.2

### Patch Changes

- Updated dependencies [67c7196]
  - @cat-factory/orchestration@0.35.1
  - @cat-factory/server@0.38.1
  - @cat-factory/node-server@0.33.2

## 0.18.1

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/contracts@0.42.0
  - @cat-factory/kernel@0.44.0
  - @cat-factory/agents@0.21.0
  - @cat-factory/orchestration@0.35.0
  - @cat-factory/server@0.38.0
  - @cat-factory/integrations@0.25.2
  - @cat-factory/node-server@0.33.1

## 0.18.0

### Minor Changes

- bbafec9: Add `@cat-factory/gitlab`: the opt-in GitLab VCS provider, the proof-of-concept
  second backend for the provider-neutral VCS abstraction. It implements the
  neutral `VcsClient` (repo/branch/MR/issue/CI reads + writes over the GitLab REST
  v4 API), a `VcsWebhookVerifier` + `VcsWebhookMapper` (constant-time
  `X-Gitlab-Token` check; `Merge Request`/`Issue`/`Push`/`Pipeline` hooks →
  neutral events), and a `VcsProvisioningClient`, and registers itself via
  `registerGitLab()` → `registerVcsProvider('gitlab')`. Depends only on
  `@cat-factory/kernel` + `@cat-factory/contracts`. Also refines the kernel
  `VcsWebhookMapper` port to take the resolved connection as a parameter.

  The provider is now WIRED into all runtime facades (single-token model, mirroring
  local-mode's PAT): a `GITLAB_TOKEN` (+ optional `GITLAB_API_BASE` /
  `GITLAB_CONNECTION_ID` / `GITLAB_WEBHOOK_SECRET`) enables it, the Worker + Node
  facades call `registerGitLab()` at container build (local inherits Node), and a
  new provider-neutral webhook receiver `POST /vcs/:provider/webhooks`
  (`@cat-factory/server`) verifies the signature against the registered
  `VcsWebhookVerifier`, maps the delivery via the registered `VcsWebhookMapper`, and
  hands the neutral event to the optional `VcsWebhookSink` kernel port. Adds a
  `GitLabConfig` to `AppConfig` and `vcsWebhookSink` to the server container.

  Bug fixes to the GitLab adapter: mergeability now prefers `detailed_merge_status`
  and only maps a genuine `conflict` to the `dirty` state the conflicts gate
  escalates on (a non-conflict block — CI pending, unresolved discussions, behind
  target — no longer spuriously spawns a conflict-resolver); `commitFiles` pins the
  commit parent via `start_sha` when `baseSha` is given; `getFileContent` resolves
  the project default branch instead of an unreliable `HEAD`; listing truncation at
  the page cap is now surfaced via an optional logger; the webhook mapper takes an
  injected `Clock` (deterministic timestamps) and reads the issue author.

  NOT yet migrated: the existing execution consumers (`resolveRepoTarget`, the
  CI/mergeability/merger/repo-files providers, the `github_*` projection
  persistence) still key on the GitHub installation id — projecting a neutral
  webhook event into provider-aware persistence is the remaining strangler step.

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/kernel@0.43.0
  - @cat-factory/server@0.37.0
  - @cat-factory/node-server@0.33.0
  - @cat-factory/agents@0.20.3
  - @cat-factory/integrations@0.25.1
  - @cat-factory/orchestration@0.34.1

## 0.17.11

### Patch Changes

- Updated dependencies [63e2177]
  - @cat-factory/contracts@0.41.0
  - @cat-factory/integrations@0.25.0
  - @cat-factory/orchestration@0.34.0
  - @cat-factory/node-server@0.32.0
  - @cat-factory/agents@0.20.2
  - @cat-factory/kernel@0.42.2
  - @cat-factory/server@0.36.3

## 0.17.10

### Patch Changes

- Updated dependencies [6903cd7]
  - @cat-factory/orchestration@0.33.0
  - @cat-factory/server@0.36.2
  - @cat-factory/node-server@0.31.2

## 0.17.9

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/contracts@0.40.1
  - @cat-factory/kernel@0.42.1
  - @cat-factory/agents@0.20.1
  - @cat-factory/integrations@0.24.1
  - @cat-factory/orchestration@0.32.1
  - @cat-factory/server@0.36.1
  - @cat-factory/node-server@0.31.1

## 0.17.8

### Patch Changes

- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
  - @cat-factory/kernel@0.42.0
  - @cat-factory/server@0.36.0
  - @cat-factory/node-server@0.31.0
  - @cat-factory/contracts@0.40.0
  - @cat-factory/agents@0.20.0
  - @cat-factory/orchestration@0.32.0
  - @cat-factory/integrations@0.24.0

## 0.17.7

### Patch Changes

- Updated dependencies [b5231b0]
  - @cat-factory/contracts@0.39.0
  - @cat-factory/kernel@0.41.0
  - @cat-factory/agents@0.19.0
  - @cat-factory/orchestration@0.31.0
  - @cat-factory/server@0.35.0
  - @cat-factory/node-server@0.30.0
  - @cat-factory/integrations@0.23.5

## 0.17.6

### Patch Changes

- Updated dependencies [6d829bb]
  - @cat-factory/contracts@0.38.0
  - @cat-factory/kernel@0.40.0
  - @cat-factory/orchestration@0.30.0
  - @cat-factory/server@0.34.0
  - @cat-factory/node-server@0.29.0
  - @cat-factory/agents@0.18.5
  - @cat-factory/integrations@0.23.4

## 0.17.5

### Patch Changes

- Updated dependencies [714b7c9]
  - @cat-factory/contracts@0.37.0
  - @cat-factory/kernel@0.39.0
  - @cat-factory/orchestration@0.29.0
  - @cat-factory/server@0.33.0
  - @cat-factory/node-server@0.28.0
  - @cat-factory/agents@0.18.4
  - @cat-factory/integrations@0.23.3

## 0.17.4

### Patch Changes

- Updated dependencies [efbd910]
  - @cat-factory/contracts@0.36.0
  - @cat-factory/server@0.32.2
  - @cat-factory/agents@0.18.3
  - @cat-factory/integrations@0.23.2
  - @cat-factory/kernel@0.38.1
  - @cat-factory/orchestration@0.28.3
  - @cat-factory/node-server@0.27.4

## 0.17.3

### Patch Changes

- Updated dependencies [ae7bfcd]
  - @cat-factory/node-server@0.27.3

## 0.17.2

### Patch Changes

- Updated dependencies [692ccb4]
- Updated dependencies [692ccb4]
  - @cat-factory/server@0.32.1
  - @cat-factory/agents@0.18.2
  - @cat-factory/node-server@0.27.2
  - @cat-factory/orchestration@0.28.2

## 0.17.1

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/contracts@0.35.0
  - @cat-factory/kernel@0.38.0
  - @cat-factory/server@0.32.0
  - @cat-factory/agents@0.18.1
  - @cat-factory/integrations@0.23.1
  - @cat-factory/orchestration@0.28.1
  - @cat-factory/node-server@0.27.1

## 0.17.0

### Minor Changes

- 76543fa: Add a **Human Review gate** — an opt-in pipeline step (`human-review`, pipeline `pl_pr_review`
  "Build & PR review") that watches a task's PR for a human code review on GitHub and loops the
  existing `fixer` agent to address feedback:

  - Advances once the PR meets GitHub's required approvals (read from branch protection) with no
    unresolved review threads.
  - Dispatches the `fixer` to address outstanding review threads (immediately when approved; after a
    per-task grace window otherwise), then resolves each handed thread on GitHub via the GraphQL
    review-thread API so the next probe sees it cleared. A reviewer re-opening a thread re-triggers a fix.
  - Waits indefinitely for the human (re-arming, never auto-failing), surfacing a `human_review`
    notification while it waits.
  - A human can request a freeform fix at any time from the gate window
    (`POST /workspaces/:ws/blocks/:blockId/human-review/request-fix`), dispatched immediately.

  Built as a registry gate in `@cat-factory/gates` (new `PullRequestReviewProvider` port +
  `GitHubPullRequestReviewProvider`, wired in every facade) reusing the generic gate driver, plus
  small generic engine seams: `pollExhaustion: 'rearm'`, a `GateDefinition.onHelperComplete` side-effect
  hook, and a `pendingFix` manual-inject path. Adds a per-task `humanReviewGraceMinutes` merge-preset
  knob (D1 ⇄ Drizzle migration). The cross-runtime conformance suite asserts the gate on every runtime.

  Review hardening:

  - Branch-protection's required-approval count is read against the PR's **actual base branch**
    (`pulls/{n}.base.ref`), not the repo default — so a PR into a stricter protected branch is gated
    against its own rule instead of silently defaulting to 1.
  - A **stalled fixer** (no progress on an unchanged head while feedback is outstanding) now raises a
    `human_review` notification instead of waiting silently/invisibly forever.
  - The awaiting-approval `human_review` card carries the run's `executionId`, so the inbox deep-links
    into the gate window (the "request a fix here" affordance) instead of merely selecting the block.
  - The thread-resolve reconcile is scoped strictly to threads the gate itself handed the fixer
    (retained until confirmed resolved) — a **third-party review bot's** open thread is never silently
    closed, and its feedback isn't mistaken for the fixer's own.
  - `requestHumanReviewFix` rejects (409) when the gate has no review provider / async executor wired,
    instead of accepting a request it would silently drop.
  - The static branch-protection read is cached on the gate state after the first probe, so an
    indefinite wait no longer re-reads it every poll.

  **Breaking:** `FIXER_AGENT_KIND` moved from `@cat-factory/orchestration`'s `ci.logic` to
  `@cat-factory/kernel` (re-exported from `ci.logic` for existing call sites); the `merge_threshold_presets`
  table gains a non-null `human_review_grace_minutes` column.

### Patch Changes

- Updated dependencies [76543fa]
  - @cat-factory/kernel@0.37.0
  - @cat-factory/contracts@0.34.0
  - @cat-factory/server@0.31.0
  - @cat-factory/agents@0.18.0
  - @cat-factory/orchestration@0.28.0
  - @cat-factory/integrations@0.23.0
  - @cat-factory/node-server@0.27.0

## 0.16.0

### Minor Changes

- 17adf4c: Local mode: warm container pool + checkout reuse, and optional native (host-process)
  execution of the developer's installed Claude Code / Codex CLI.

  **Warm pool + persistent checkout (default off = unchanged):** the local runner transport
  can keep idle harness containers warm and lease one — preferring a member that already holds
  the run's repo — instead of cold-starting a container per run. A leased member reuses a
  stable per-repo checkout (`git reset --hard` + a keep-list clean sweep that preserves
  dependency caches like `node_modules`, then `fetch` + switch branch) rather than cloning from
  scratch. New harness job field `persistentCheckout` drives this; it is set only by the local
  pool transport, so every other runtime keeps the ephemeral fresh-clone path byte-for-byte.
  Pooling is Docker-family only (the new `capabilities.pooling`); Apple `container` keeps the
  per-run path.

  **Configured in the UI + DB, not env:** the warm-pool sizing (size / pre-warm / max / idle
  timeout) and the per-repo checkout-reuse knobs (workspace root + dep-cache keep list) are a
  new per-deployment singleton (`local_settings`, Postgres/Drizzle only — local-mode-only, so
  no D1 mirror) exposed through a dedicated **"Local mode"** settings panel
  (Integrations → Local mode), served by a new `GET|PUT /local-settings` controller wired only
  on the local facade (503 elsewhere). This REPLACES the env vars `LOCAL_POOL_SIZE`,
  `LOCAL_POOL_MIN_WARM`, `LOCAL_POOL_MAX`, `LOCAL_POOL_IDLE_TTL_MS`, `HARNESS_WORKSPACE_ROOT`,
  `HARNESS_CLEAN_KEEP` (no longer read). The container transport forwards the checkout knobs to
  the harness container as `HARNESS_*` env. Breaking: those env vars are dropped — set the
  values in the UI instead.

  **Native execution (`LOCAL_NATIVE_AGENTS`, default off):** an allow-list of subscription
  harnesses (`claude-code,codex`) to run as a host process (new `LocalProcessRunnerTransport`)
  driving the developer's OWN installed `claude` / `codex` CLI with its ambient login (new
  harness `ambientAuth` mode) — no leased credential, no personal-credential gate for those
  vendors. Native applies ONLY to a listed harness's NATIVE vendor (Anthropic `claude` /
  OpenAI `codex`): a non-native vendor that reuses the `claude-code` harness (GLM/Kimi/DeepSeek
  carries its own base URL) and proxy/`pi` models are NOT run unsandboxed on the host — they
  keep the sandboxed per-run container path (so they still lease their real credential and
  still need `LOCAL_HARNESS_IMAGE`). Gated, local-facade-only, with the explicit no-sandbox /
  own-subscription trade documented. Requires `LOCAL_HARNESS_ENTRY`. The Tester's local
  docker-compose infra is reported unsupported in native mode for now (host-compose +
  git-worktree isolation are a follow-up phase).

  Breaking: none (all paths default off). The executor-harness image is bumped (1.16.0) for
  the new `persistentCheckout` / `ambientAuth` handling.

### Patch Changes

- Updated dependencies [17adf4c]
  - @cat-factory/node-server@0.26.0
  - @cat-factory/server@0.30.0
  - @cat-factory/integrations@0.22.0
  - @cat-factory/contracts@0.33.0
  - @cat-factory/kernel@0.36.0
  - @cat-factory/orchestration@0.27.1
  - @cat-factory/agents@0.17.2

## 0.15.0

### Minor Changes

- eb48652: Local-mode infrastructure delegation + native runner-adapter seam.

  Local mode now lets a workspace opt, independently, into delegating its container agents
  and/or its Tester ephemeral environments to an external service instead of running
  everything on the host container runtime. Two new per-workspace settings drive it
  (`delegateAgentsToRunnerPool`, `delegateTestEnvToProvider`, both default off), surfaced as
  toggles on the Ephemeral environments screen (local mode only) and enabled only once the
  respective provider — a self-hosted runner pool / an environment provider — is registered.

  - **Agents**: when delegated, container jobs dispatch to the workspace's registered runner
    pool instead of host Docker (a clean 409 at start, and the existing dispatch error, when
    delegated with no pool registered).
  - **Environments**: the toggle sets the local-mode default Tester environment — `local`
    (host Docker / DinD) by default, `ephemeral` (the provider) when on; per-service / per-task
    choices still win. An `ephemeral` run is refused at start when delegated with no provider
    connected.
  - **Native runner-adapter seam**: an injected `runnerPoolProvider` now drives the actual
    dispatch transport on both the Cloudflare and Node facades (falling back to the generic
    `HttpRunnerPoolProvider`), fully symmetric with `environmentProvider`. A wrapper can thus
    ship one package implementing `EnvironmentProvider` + `RunnerPoolProvider` (e.g. an in-house platform) to
    serve both concerns with native code on every runtime.

  BREAKING (pre-1.0, internal): an un-pinned Tester task in local mode now defaults to the
  `local` (DinD) environment instead of `ephemeral`. New `workspace_settings` columns are
  added on both runtimes (D1 migration + Drizzle migration); local mode now defaults
  `ENVIRONMENTS_ENABLED=true` so the env module assembles for the opt-in.

### Patch Changes

- Updated dependencies [eb48652]
- Updated dependencies [518aff7]
  - @cat-factory/contracts@0.32.0
  - @cat-factory/kernel@0.35.0
  - @cat-factory/orchestration@0.27.0
  - @cat-factory/node-server@0.25.0
  - @cat-factory/agents@0.17.1
  - @cat-factory/server@0.29.1

## 0.14.2

### Patch Changes

- Updated dependencies [9f7ee39]
- Updated dependencies [81b60d4]
  - @cat-factory/contracts@0.31.0
  - @cat-factory/kernel@0.34.0
  - @cat-factory/agents@0.17.0
  - @cat-factory/orchestration@0.26.0
  - @cat-factory/server@0.29.0
  - @cat-factory/node-server@0.24.0

## 0.14.1

### Patch Changes

- Updated dependencies [4dd6e97]
  - @cat-factory/agents@0.16.1
  - @cat-factory/server@0.28.1
  - @cat-factory/orchestration@0.25.1
  - @cat-factory/node-server@0.23.1

## 0.14.0

### Minor Changes

- ea59e91: Add the Kaizen agent: a post-run, continuous-improvement reviewer (toggleable per
  workspace, never a pipeline-builder step) that grades each completed agent step on how
  smooth/efficient vs confused/chaotic the interaction was and recommends prompt/model
  improvements.

  - After a run completes, the engine schedules a grading per completed agent step
    (skipping verified combos); a background sweep (Cloudflare cron / Node interval) runs
    the inline LLM grade. The grader's model is configured in Model Configuration like
    every other agent (the hidden-from-palette `kaizen` kind).
  - A `(promptVersion, agentKind, model)` combo that grades strongly (>=4) with no
    recommendations five times in a row is marked **verified** and is no longer graded.
  - New persisted tables `kaizen_gradings` + `kaizen_verified_combos` (D1 ⇄ Drizzle parity,
    asserted by a new cross-runtime conformance suite) and a per-workspace `kaizenEnabled`
    setting (a new `workspace_settings.kaizen_enabled` column).
  - New read API (`GET /workspaces/:ws/kaizen`, `GET /workspaces/:ws/executions/:id/kaizen`),
    a `kaizen` real-time event, a Kaizen screen (grading history + verified combos), and
    per-step grading status (scheduled/running/complete + results) inside the run window —
    never on the board.
  - A step with neither a provided-context snapshot nor any recorded LLM calls (e.g. prompt
    recording is off deployment-wide) is settled `failed` rather than graded blind, so a
    guessed grade can't advance a combo toward a bogus `verified`.
  - The Worker Kaizen sweep gains an in-isolate re-entrancy guard (mirroring the Node
    sweeper) so overlapping passes don't race the per-combo streak update.

### Patch Changes

- Updated dependencies [ea59e91]
  - @cat-factory/contracts@0.30.0
  - @cat-factory/kernel@0.33.0
  - @cat-factory/agents@0.16.0
  - @cat-factory/orchestration@0.25.0
  - @cat-factory/server@0.28.0
  - @cat-factory/node-server@0.23.0

## 0.13.4

### Patch Changes

- Updated dependencies [18f6b3b]
  - @cat-factory/server@0.27.2
  - @cat-factory/orchestration@0.24.2
  - @cat-factory/node-server@0.22.2

## 0.13.3

### Patch Changes

- Updated dependencies [4849c66]
- Updated dependencies [b82304e]
  - @cat-factory/server@0.27.1
  - @cat-factory/contracts@0.29.0
  - @cat-factory/kernel@0.32.0
  - @cat-factory/orchestration@0.24.1
  - @cat-factory/node-server@0.22.1
  - @cat-factory/agents@0.15.2

## 0.13.2

### Patch Changes

- Updated dependencies [765cc42]
  - @cat-factory/kernel@0.31.0
  - @cat-factory/contracts@0.28.0
  - @cat-factory/orchestration@0.24.0
  - @cat-factory/server@0.27.0
  - @cat-factory/node-server@0.22.0
  - @cat-factory/agents@0.15.1

## 0.13.1

### Patch Changes

- Updated dependencies [52d886a]
  - @cat-factory/kernel@0.30.0
  - @cat-factory/contracts@0.27.0
  - @cat-factory/agents@0.15.0
  - @cat-factory/orchestration@0.23.0
  - @cat-factory/node-server@0.21.1
  - @cat-factory/server@0.26.1

## 0.13.0

### Minor Changes

- a639189: Observability for ephemeral-environment and container provisioning.

  - **Unified provisioning event log.** A new append-only log records every attempt to
    spin up / tear down throwaway infrastructure — ephemeral environments
    (provision/teardown/status) and the runner-pool / per-run containers
    (dispatch/release/poll-failure) — with the outcome and the verbatim provider/runtime
    error on failure. Surfaced via `GET /workspaces/:ws/provisioning-logs` and a "View
    logs" button in the ephemeral-environment provider and self-hosted runner-pool config
    panels.
  - **Env lifecycle in run details.** An agent run's step now carries the ephemeral
    environment it runs against (spinning up / running / shut down / errored + URL/expiry
    - exact error), shown in the step detail (notably for the Tester).
  - **Container-start failures.** When a container/runner never accepts the job, the run
    details now say "Container failed to start" and show the exact provider/runtime error
    (a `dispatch`-kind failure) instead of a generic "Run failed". A run's step detail also
    has an "Infrastructure attempts" drawer (filtered by execution id) that surfaces that
    run's container/runner/env spin-up + tear-down attempts.
  - **Secret redaction.** The verbatim provider/runtime error and structured detail are
    scrubbed at the single recorder choke point before they are persisted/served — bearer
    tokens, `Authorization`/`x-api-key` header echoes, credentialed URLs, and recognisable
    token shapes (`sk-`/`ghp_`/`AKIA`/JWT) are replaced with `[REDACTED]` while the
    surrounding context (field name, URL host, token scheme) is kept for diagnosis.

  **Breaking / operational:** the provisioning log lives in a PHYSICALLY SEPARATE store to
  isolate its high write churn. The Cloudflare Worker needs a new `PROVISIONING_DB` D1
  binding (its own `migrations-provisioning` dir — create the database and apply its
  migrations); when absent, the feature is simply off. The Node service uses a dedicated
  `provisioning` Postgres schema, created with `CREATE SCHEMA IF NOT EXISTS` by `migrate()`
  on boot (the DB role needs `CREATE` on the database — the same privilege the app already
  uses to create its `public` tables). Retention is governed by `PROVISIONING_LOG_RETENTION_DAYS`
  (default 14). Catching a container dispatch error at the dispatch site means a transient
  dispatch blip is now a terminal `dispatch` failure (retry from the failure card) rather
  than relying on a Workflows step retry.

### Patch Changes

- Updated dependencies [a639189]
  - @cat-factory/kernel@0.29.0
  - @cat-factory/contracts@0.26.0
  - @cat-factory/orchestration@0.22.0
  - @cat-factory/server@0.26.0
  - @cat-factory/node-server@0.21.0
  - @cat-factory/agents@0.14.9

## 0.12.2

### Patch Changes

- Updated dependencies [ed3a673]
  - @cat-factory/contracts@0.25.1
  - @cat-factory/orchestration@0.21.1
  - @cat-factory/server@0.25.1
  - @cat-factory/agents@0.14.8
  - @cat-factory/kernel@0.28.1
  - @cat-factory/node-server@0.20.1

## 0.12.1

### Patch Changes

- Updated dependencies [69d2270]
  - @cat-factory/orchestration@0.21.0
  - @cat-factory/server@0.25.0
  - @cat-factory/node-server@0.20.0
  - @cat-factory/contracts@0.25.0
  - @cat-factory/kernel@0.28.0
  - @cat-factory/agents@0.14.7

## 0.12.0

### Minor Changes

- 3546e3d: Move operator/integration config out of environment variables into encrypted, UI-editable
  DB settings. DB is now the source of truth — the moved env vars are **removed** (no
  fallback), so the listed vars below no longer have any effect.

  **Per-workspace budget (Workspace settings → Budget).** A workspace's spend currency,
  monthly limit, and per-model price overrides now live on the `workspace_settings` row.
  The spend safeguard resolves each workspace's effective pricing (base table + overrides)
  behind a short-TTL cache, scoping the budget gate to the workspace's own usage
  (`SpendService.status`/`isOverBudget` now take a `workspaceId`; new
  `TokenUsageRepository.totalsSinceForWorkspace`). **Behaviour change:** spend is metered +
  gated per workspace, not deployment-wide; a workspace with no budget inherits the built-in
  default (~100 EUR/month). Removes env: `SPEND_MONTHLY_LIMIT`, `SPEND_CURRENCY`,
  `SPEND_MODEL_PRICES`. A budget of `0` is intentional ("no PAID spend"): metered runs are
  refused **up front** at start/retry with a clear `409` (not just a silent mid-run pause),
  while LOCAL-runner models (keyless) and connected SUBSCRIPTIONS (flat-rate quota) keep
  running since they incur no metered cost — so `0` is the "local-/subscription-only" setting.
  The over-budget exemption (previously subscription-only) now also covers local-runner steps,
  inline and container alike. The hot-path per-workspace rollup is indexed
  (`idx_token_usage_workspace` on `(workspace_id, created_at)`, both runtimes).

  **Per-workspace incident enrichment (service inspector → Post-release health).** PagerDuty

  - incident.io credentials are sealed in a new per-workspace `incident_enrichment_connections`
    table (one grouped blob) and resolved/decrypted at enrichment time by a new
    `WorkspaceIncidentEnrichmentProvider`. Removes env: `PAGERDUTY_API_TOKEN`,
    `PAGERDUTY_FROM_EMAIL`, `INCIDENTIO_API_KEY`. The write API is three-state per provider
    group (omit ⇒ keep, `null` ⇒ clear, value ⇒ set) so one vendor can be removed without
    wiping the other.

  **Per-account integration secrets (Account settings → Deployment integrations, admin only).**
  The Slack app OAuth credentials and the container web-search upstream keys (Brave /
  SearXNG) now live in a new per-account `account_settings` table (one sealed secrets blob,
  HKDF tag `cat-factory:account-settings`), behind an admin-gated
  `GET|PUT /accounts/:id/settings`. Resolved dynamically: Slack OAuth at connect time, the
  web-search upstream per run (off the container session's account id). The executor now
  advertises the container `web_search` tool to a run **only when its account actually has
  keys** (so an agent is never handed a tool that always fails); a run with no upstream gets
  an empty result set rather than a hard `503`. Removes env:
  `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URL`, `WEB_SEARCH_BRAVE_API_KEY`,
  `WEB_SEARCH_SEARXNG_URL`, `WEB_SEARCH_SEARXNG_API_KEY` (the env-built upstream + its
  `createWebSearchUpstreamFromEnv`/`gateways.webSearch` fallback are deleted, not just
  unwired). (`SLACK_ENABLED` still gates Slack module assembly; the new tables/services
  assemble whenever `ENCRYPTION_KEY` is set.)

  **Hardening.** Re-sealing a partial settings/credentials write now **refuses** (clear `409`)
  when the stored blob can't be decrypted (e.g. after an encryption-key change) instead of
  silently dropping the un-edited secret group on the re-seal.

  New tables mirror across both runtimes (D1 migrations 0012–0014 ⇄ Drizzle schema +
  generated migration) with cross-runtime conformance assertions for the budget +
  incident-enrichment round-trips. `ENCRYPTION_KEY`, `AUTH_SESSION_SECRET`, and the GitHub
  App/OAuth secrets stay in env (bootstrap/auth). Retention windows, inline-web-search
  toggles, Langfuse keys, and execution timeouts intentionally remain env-configured.

### Patch Changes

- Updated dependencies [3546e3d]
  - @cat-factory/contracts@0.24.0
  - @cat-factory/kernel@0.27.0
  - @cat-factory/orchestration@0.20.0
  - @cat-factory/server@0.24.0
  - @cat-factory/node-server@0.19.0
  - @cat-factory/agents@0.14.6

## 0.11.11

### Patch Changes

- Updated dependencies [a62044d]
  - @cat-factory/kernel@0.26.1
  - @cat-factory/orchestration@0.19.2
  - @cat-factory/agents@0.14.5
  - @cat-factory/server@0.23.6
  - @cat-factory/node-server@0.18.6

## 0.11.10

### Patch Changes

- Updated dependencies [a0d5efc]
  - @cat-factory/server@0.23.5
  - @cat-factory/node-server@0.18.5

## 0.11.9

### Patch Changes

- Updated dependencies [2aae8bc]
  - @cat-factory/kernel@0.26.0
  - @cat-factory/agents@0.14.4
  - @cat-factory/orchestration@0.19.1
  - @cat-factory/server@0.23.4
  - @cat-factory/node-server@0.18.4

## 0.11.8

### Patch Changes

- Updated dependencies [f4f954b]
  - @cat-factory/kernel@0.25.0
  - @cat-factory/orchestration@0.19.0
  - @cat-factory/node-server@0.18.3
  - @cat-factory/agents@0.14.3
  - @cat-factory/server@0.23.3

## 0.11.7

### Patch Changes

- Updated dependencies [ce81233]
  - @cat-factory/contracts@0.23.0
  - @cat-factory/kernel@0.24.0
  - @cat-factory/agents@0.14.2
  - @cat-factory/orchestration@0.18.1
  - @cat-factory/server@0.23.2
  - @cat-factory/node-server@0.18.2

## 0.11.6

### Patch Changes

- Updated dependencies [7346a4f]
  - @cat-factory/kernel@0.23.0
  - @cat-factory/orchestration@0.18.0
  - @cat-factory/agents@0.14.1
  - @cat-factory/server@0.23.1
  - @cat-factory/node-server@0.18.1

## 0.11.5

### Patch Changes

- Updated dependencies [6ff1f10]
  - @cat-factory/contracts@0.22.0
  - @cat-factory/kernel@0.22.0
  - @cat-factory/agents@0.14.0
  - @cat-factory/orchestration@0.17.0
  - @cat-factory/server@0.23.0
  - @cat-factory/node-server@0.18.0

## 0.11.4

### Patch Changes

- Updated dependencies [04befe8]
  - @cat-factory/contracts@0.21.0
  - @cat-factory/kernel@0.21.0
  - @cat-factory/agents@0.13.0
  - @cat-factory/server@0.22.0
  - @cat-factory/orchestration@0.16.0
  - @cat-factory/node-server@0.17.0

## 0.11.3

### Patch Changes

- Updated dependencies [be182e8]
  - @cat-factory/kernel@0.20.0
  - @cat-factory/agents@0.12.0
  - @cat-factory/orchestration@0.15.0
  - @cat-factory/server@0.21.0
  - @cat-factory/node-server@0.16.0

## 0.11.2

### Patch Changes

- Updated dependencies [2c24da8]
  - @cat-factory/contracts@0.20.0
  - @cat-factory/kernel@0.19.0
  - @cat-factory/orchestration@0.14.0
  - @cat-factory/server@0.20.0
  - @cat-factory/node-server@0.15.0
  - @cat-factory/agents@0.11.16

## 0.11.1

### Patch Changes

- 4120ac5: Nested tasks (epics) + a first-class task dependency graph.

  **Epics** are a new non-structural block level (`level: 'epic'`). An epic groups tasks
  that may live under different services/modules via the tasks' new `epicId` membership
  link (independent of `parentId`, so deleting an epic clears membership but never deletes
  the member tasks). The board draws an epic node linked to all its members, and the epic
  inspector shows the full member tree grouped service → module → task. Add one via
  `POST /workspaces/:ws/epics`; assign/detach a task via `POST /blocks/:id/epic`.

  **Importing a Jira epic / GitHub parent issue** spawns the epic + its children onto the
  board in one shot (`POST /workspaces/:ws/task-sources/:source/epics/spawn`, or the "As
  epic" button in the issue-import modal): an epic node, a board task per child issue
  (joined to the epic), and `dependsOn` edges seeded from the issues' **"blocked by" /
  "depends on"** links. Jira links come from `issuelinks` + `parent`/`subtasks` + epic
  children (JQL); GitHub children come from native **sub-issues** and dependency links are
  parsed from the issue body (`Blocked by #12`, `Depends on owner/repo#34`). The
  `GitHubClient` port gains `listSubIssues` + a `parentRef` on issue detail.

  **Dependency enforcement** is now hard and server-side: `ExecutionService.start()` refuses
  (409) to start a task while any block it `dependsOn` is unfinished — enforced for manual,
  recurring, auto-start and direct-API starts alike. Adding a dependency edge that would
  close a **cycle** is rejected (422).

  **Auto-start**: a preceding task carries an `autoStartDependents` toggle (task inspector).
  When it merges, the engine automatically starts every task that depends on it whose other
  dependencies are also done — skipping any on an individual-usage model (which can't unlock
  unattended).

  **Board UX**: a drag-to-connect handle on task cards creates dependency edges directly on
  the canvas (drag from the prerequisite onto the dependent); the dependency-edge overlay
  also draws epic→member membership links.

  Persisted on both runtimes (D1 migration `0010_epics_dependencies` ⇄ Drizzle
  `epic_id` / `auto_start_dependents` columns); the cross-runtime conformance suite asserts
  the epic + membership round-trip, the cycle rejection, and the dependency start gate on
  each store.

  Breaking (pre-1.0, acceptable): the `blocks` table gains `epic_id` / `auto_start_dependents`
  columns and the `level` enum gains `epic`; no migration shims.

- Updated dependencies [4120ac5]
  - @cat-factory/contracts@0.19.0
  - @cat-factory/kernel@0.18.0
  - @cat-factory/orchestration@0.13.0
  - @cat-factory/server@0.19.0
  - @cat-factory/node-server@0.14.1
  - @cat-factory/agents@0.11.15

## 0.11.0

### Minor Changes

- 25efe48: Add UI-configurable provider config + per-user GitHub PAT, with provider self-describe and connection-test.

  - Providers self-describe the config they expect (`describeConfig`) and can be connection-tested (`testConnection`) before saving — added as optional methods on the `EnvironmentProvider` and `RunnerPoolProvider` kernel ports, implemented by the generic HTTP adapters (secret-key fields from the manifest + an authed probe), and surfaced via new `GET …/environments/provider`, `POST …/environments/connection/test`, `GET …/runner-pool/provider`, `POST …/runner-pool/connection/test` endpoints. The SPA renders the descriptor fields generically.
  - New generic, `kind`-discriminated per-user secret store (`user_secrets`, mirrored D1 ⇄ Drizzle) with `UserSecretService` + a kind registry (first kind: `github_pat`). User-scoped `GET/POST/DELETE /user-secrets` + `…/test`; a "My GitHub token" entry under Integrations → Source control.
  - A run you initiate now prefers YOUR stored GitHub PAT over the deployment's GitHub App / env token for the container push token AND the engine CI-gate + merge reads (resolved by the run initiator via an ambient `RunInitiatorScope`), falling back to the existing source when you have none. Wired symmetrically across the Cloudflare, Node and local facades.

  Breaking: none for existing data. The local-mode `GITHUB_PAT` env var still works as a fallback.

### Patch Changes

- Updated dependencies [25efe48]
  - @cat-factory/contracts@0.18.0
  - @cat-factory/kernel@0.17.0
  - @cat-factory/server@0.18.0
  - @cat-factory/orchestration@0.12.0
  - @cat-factory/node-server@0.14.0
  - @cat-factory/agents@0.11.14

## 0.10.11

### Patch Changes

- c7b8012: Improve the requirements-review experience.

  **Auto-save answers (no button).** The requirements-review window no longer has a "Save
  answer" button: an answer is seeded into its textarea from the recorded reply and persisted
  on blur (and flushed before incorporate/proceed), so a value just needs to be typed.

  **"Recommend something" + the Requirement Writer.** A finding can now be marked for a
  grounded recommendation instead of being answered or dismissed. A new second companion of
  the requirements reviewer — the **Requirement Writer** (an inline LLM call, `WRITER_SYSTEM_PROMPT`
  `requirement-writer@v1`) — produces a suggested answer per finding, grounded in this
  precedence order: the block's **best-practice fragments** (team/org standards — checked
  FIRST; a match is flagged as the "current standard" and surfaced with a badge), then the
  in-repo `spec/` + `tech-spec/` (via the checkout-free `RepoFiles` port), then web search
  (provider-hosted on Anthropic/OpenAI models; gateway-RAG wiring lands separately).
  Recommendations are NOT AI-reviewed — the human accepts (it becomes the finding's answer,
  folded into the next incorporation), rejects, or re-requests with a "do it differently"
  note. Recommendations are a first-class collection on the review that survives the re-review
  item churn.

  - Contracts: `recommend_requested` item status, `RequirementRecommendation` +
    `recommendations[]` on `RequirementReview`, and the request schemas.
  - Persistence (both runtimes): a `recommendations` JSON column on `requirement_reviews`
    (new D1 migration `0009` ⇄ Drizzle column + generated migration).
  - Service: `RequirementReviewService.recommend` / `acceptRecommendation` /
    `rejectRecommendation` / `reRequestRecommendation`, with optional `resolveRunRepoContext`
    - best-practice-fragment resolver deps (degrade gracefully when unwired).
  - Controller: `POST /blocks/:blockId/requirement-review/recommend` and the
    `…/recommendations/:recId/{accept,reject,re-request}` routes.

  **Board progress for the review companions.** While the review is incorporating, re-reviewing
  or recommending, the board task card / mini-pipeline / inspector now show a spinning stage
  label (`Recommending…` added alongside the existing `Incorporating…` / `Re-reviewing…`).

- Updated dependencies [c7b8012]
  - @cat-factory/contracts@0.17.1
  - @cat-factory/kernel@0.16.2
  - @cat-factory/agents@0.11.13
  - @cat-factory/orchestration@0.11.1
  - @cat-factory/server@0.17.2
  - @cat-factory/node-server@0.13.4

## 0.10.10

### Patch Changes

- Updated dependencies [aa06003]
  - @cat-factory/contracts@0.17.0
  - @cat-factory/orchestration@0.11.0
  - @cat-factory/kernel@0.16.1
  - @cat-factory/server@0.17.1
  - @cat-factory/node-server@0.13.3
  - @cat-factory/agents@0.11.12

## 0.10.9

### Patch Changes

- Updated dependencies [208c933]
  - @cat-factory/kernel@0.16.0
  - @cat-factory/server@0.17.0
  - @cat-factory/agents@0.11.11
  - @cat-factory/orchestration@0.10.9
  - @cat-factory/node-server@0.13.2

## 0.10.8

### Patch Changes

- 494fb34: Finish the Task-5 strangler: migrate the last two built-in agents (conflict-resolver and
  repo bootstrap) onto the single, manifest-driven `agent` harness kind, then delete every
  bespoke per-kind handler and collapse the dispatch surface. The harness is now a generic
  LLM-over-a-checkout runner with **one** kind — WHAT each agent does is decided entirely by
  the backend and carried as job data.

  **conflict-resolver** now dispatches `kind: 'agent'` `mode: 'coding'` with a `mergeBase`
  (full clone of the PR branch). `handleAgent`'s coding flow merges `origin/<mergeBase>` in to
  surface the conflicts, leads the prompt with the actual conflict hunks it discovers, then
  completes the merge commit and pushes back onto the same branch (no new PR) — refusing to
  push a half-resolved tree. Routed through `buildMigratedBuiltInBody`; the bespoke
  `/resolve-conflicts` body + handler are gone.

  **bootstrap** now dispatches `kind: 'agent'` `mode: 'coding'` with a `bootstrap` spec
  (`{ target, reference?, reinit, forcePush, fromScratch? }`). `handleAgent` clones the
  reference architecture (or scaffolds from an empty dir), runs the agent, guards against a
  no-op, then force-pushes a fresh single-commit history to the separate target repo's default
  branch (lifted `reinitAndPush` / `producedRepoContent`). `ContainerRepoBootstrapper` builds
  the generic body; its `linkRepoToBlock` post-op already lives in `pollBootstrapJob`.

  **Harness cleanup (image bump).** Deleted the bespoke handlers (`blueprint`/`spec`/`explore`/
  `merger`/`on-call`/`tester`/`ci-fixer`/`fixer`/`conflict-resolver`/`bootstrap`/`handleRun`),
  collapsed `server.ts`'s `KINDS` to `{ agent }`, and stripped the bespoke job types + parsers
  from `job.ts` (keeping `parseAgentJob` + the shared helpers + `BootstrapTargetSpec`). The
  executor-harness image is bumped (1.13.0 → 1.14.0; deploy tag + `wrangler.toml`).

  **Kernel (breaking, pre-1.0).** `RunnerDispatchKind` collapses to the single member
  `'agent'`, and `RunnerJobResult` is slimmed to `prUrl` / `branch` / `summary` / `error` /
  `defaultBranch` / `pushed` / `custom` / `usage` (the per-kind `service`/`spec`/`assessment`/
  `onCallAssessment`/`report`/`resolved` channels are removed — every structured agent returns
  its doc on `custom`, coerced kind-aware in `toRunResult`). The transports default to
  `kind: 'agent'`; the runner-pool result coercion passes only `custom` through.

  Two fixes ride along. (1) `toRunResult` now surfaces an opened PR (`prUrl`) **before** the
  in-place-fixer `pushed` branch — the migrated coder returns BOTH `pushed: true` and `prUrl`,
  so the previous ordering silently dropped its structured `pullRequest` (the worker test only
  passed because its fake omitted `pushed`). (2) The local transport ran the per-run container
  privileged off `kind === 'test'`, which never matched after the tester migration; the
  container is per-RUN (created by the run's first step, not the tester), so it now runs
  privileged whenever `privilegedTestJobs` is enabled (gated by the `localDind` capability).

- Updated dependencies [494fb34]
  - @cat-factory/server@0.16.1
  - @cat-factory/kernel@0.15.1
  - @cat-factory/node-server@0.13.1
  - @cat-factory/agents@0.11.10
  - @cat-factory/orchestration@0.10.8

## 0.10.7

### Patch Changes

- Updated dependencies [0ac64b8]
  - @cat-factory/kernel@0.15.0
  - @cat-factory/contracts@0.16.0
  - @cat-factory/server@0.16.0
  - @cat-factory/node-server@0.13.0
  - @cat-factory/agents@0.11.9
  - @cat-factory/orchestration@0.10.7

## 0.10.6

### Patch Changes

- Updated dependencies [7d1f829]
  - @cat-factory/server@0.15.1
  - @cat-factory/agents@0.11.8
  - @cat-factory/node-server@0.12.3
  - @cat-factory/orchestration@0.10.6

## 0.10.5

### Patch Changes

- Updated dependencies [fde0437]
  - @cat-factory/contracts@0.15.0
  - @cat-factory/kernel@0.14.0
  - @cat-factory/server@0.15.0
  - @cat-factory/agents@0.11.7
  - @cat-factory/orchestration@0.10.5
  - @cat-factory/node-server@0.12.2

## 0.10.4

### Patch Changes

- Updated dependencies [77b7d31]
  - @cat-factory/agents@0.11.6
  - @cat-factory/server@0.14.1
  - @cat-factory/orchestration@0.10.4
  - @cat-factory/kernel@0.13.4
  - @cat-factory/node-server@0.12.1

## 0.10.3

### Patch Changes

- Updated dependencies [82d771e]
  - @cat-factory/contracts@0.14.0
  - @cat-factory/server@0.14.0
  - @cat-factory/node-server@0.12.0
  - @cat-factory/agents@0.11.5
  - @cat-factory/kernel@0.13.3
  - @cat-factory/orchestration@0.10.3

## 0.10.2

### Patch Changes

- Updated dependencies [ce27690]
  - @cat-factory/contracts@0.13.1
  - @cat-factory/kernel@0.13.2
  - @cat-factory/agents@0.11.4
  - @cat-factory/server@0.13.2
  - @cat-factory/orchestration@0.10.2
  - @cat-factory/node-server@0.11.2

## 0.10.1

### Patch Changes

- Updated dependencies [c8bd144]
  - @cat-factory/server@0.13.1
  - @cat-factory/orchestration@0.10.1
  - @cat-factory/kernel@0.13.1
  - @cat-factory/node-server@0.11.1
  - @cat-factory/agents@0.11.3

## 0.10.0

### Minor Changes

- 5c915fd: Replace the deployment-level `TASK_SOURCES` env allow-list with a per-workspace,
  UI-driven on/off toggle for each task source (Jira / GitHub Issues), persisted in DB.

  A source is now offered to a workspace when it is **available** AND **enabled**:

  - Availability is intrinsic, not a deployment switch. Jira is always registered (its
    credentials are per-workspace, entered in the UI) and is available once connected.
    GitHub Issues registers whenever the GitHub integration is configured and is available
    once the workspace has installed the GitHub App — it rides that App, so there is nothing
    to "connect" (the credentialless connect path now returns a clear error).
  - `enabled` is the new per-workspace toggle (defaults to on). A workspace can disable
    GitHub Issues to use GitHub repos without offering their issues, or park a connected
    Jira without disconnecting it. A disabled source is hidden from the import/link UI and
    its import/search endpoints are refused (409).

  New surface:

  - `task_source_settings` table, mirrored D1 (migration `0008_task_source_settings.sql`)
    ⇄ Drizzle (`taskSourceSettings` + generated migration), behind a new
    `TaskSourceSettingsRepository` kernel port.
  - `GET /workspaces/:ws/task-sources` now returns each source's descriptor plus
    `available` + `enabled`; `PUT /workspaces/:ws/task-sources/:source/enabled` toggles it.
  - The SPA settings modal hosts the toggle, and import entry points key off the offered
    (available + enabled) set instead of raw connections.

  BREAKING: the `TASK_SOURCES` env var (Cloudflare `wrangler.toml` / Node `.env`) and
  `TasksConfig.sources` are removed. Delete `TASK_SOURCES` from any deployment config —
  which sources a workspace uses is now controlled in the app, not by the operator.

### Patch Changes

- Updated dependencies [5c915fd]
  - @cat-factory/contracts@0.13.0
  - @cat-factory/kernel@0.13.0
  - @cat-factory/orchestration@0.10.0
  - @cat-factory/server@0.13.0
  - @cat-factory/node-server@0.11.0
  - @cat-factory/agents@0.11.2

## 0.9.1

### Patch Changes

- Updated dependencies [22d7fff]
  - @cat-factory/server@0.12.1
  - @cat-factory/agents@0.11.1
  - @cat-factory/node-server@0.10.1
  - @cat-factory/orchestration@0.9.1

## 0.9.0

### Minor Changes

- 128e12e: Custom agents: live pre/post-op execution + data-driven palette + generic result view.

  Registered custom agent kinds now run end to end. A kind's deterministic backend hooks
  fire around its agent step: `ExecutionService` runs its `preOps` before dispatch and its
  `postOps` after the result is recorded, over a per-run, checkout-free `RepoFiles` bound to
  the run's repo. The binding is a new optional engine dependency `resolveRunRepoContext`
  (`CoreDependencies` / `ExecutionServiceDependencies`), composed from a facade's wired
  `GitHubClient` + the executor's `resolveRepoTarget` via the new
  `makeResolveRunRepoContext` (`@cat-factory/server`) and wired symmetrically across ALL
  three facades (Worker `selectGitHubDeps`, Node `githubGateDeps`, local via
  `buildNodeContainer`). When GitHub isn't connected the hooks are skipped, so pipelines run
  unchanged without the feature. `runRepoOps` moved to `@cat-factory/agents` so the
  orchestration engine drives the hooks without importing the server HTTP layer. New kernel
  ports: `RunRepoContext` + `ResolveRunRepoContext`. The cross-runtime conformance suite
  asserts a registered kind's pre-op read + post-op commit on both D1 and Postgres.

  Frontend: the workspace snapshot now carries `customAgentKinds` (kind + presentation +
  container flag), which the SPA merges into its palette catalog
  (`useAgentsStore().registerCustomKinds`) so a registered kind is a first-class palette
  block + result view instead of the generic fallback. A `container-explore` structured
  kind's `result.custom` JSON is recorded on the step (new `PipelineStep.custom`) and
  rendered read-only by a new shared `generic-structured` result view — a custom agent gets
  a usable result window with no bespoke UI.

  The built-in agents are not yet migrated to this model (their rendering still lives in the
  executor-harness); that strangler conversion is sequenced as follow-up work. See
  `backend/docs/custom-agents.md` and the `@cat-factory/example-custom-agent` worked example.

### Patch Changes

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
- Updated dependencies [4de2f5f]
  - @cat-factory/kernel@0.12.0
  - @cat-factory/agents@0.11.0
  - @cat-factory/contracts@0.12.0
  - @cat-factory/orchestration@0.9.0
  - @cat-factory/server@0.12.0
  - @cat-factory/node-server@0.10.0

## 0.8.3

### Patch Changes

- f8a24e0: Refresh dependencies to latest. Notable major bumps: TypeScript 5→6 (tooling
  packages), vitest 3→4, pino 9→10, `@hono/node-server` 1→2, `@hono/valibot-validator`
  0.5→0.6, happy-dom 15→20, and `@types/node` →26. Patch/minor refreshes for `ai`,
  `hono`, `wrangler`, `pg-boss`, `ws`, `@ai-sdk/*`, `oxlint`, and the Cloudflare
  workers tooling.
- Updated dependencies [f8a24e0]
  - @cat-factory/agents@0.10.1
  - @cat-factory/kernel@0.11.1
  - @cat-factory/orchestration@0.8.1
  - @cat-factory/server@0.11.1
  - @cat-factory/node-server@0.9.1

## 0.8.2

### Patch Changes

- Updated dependencies [1e31cbc]
  - @cat-factory/contracts@0.11.0
  - @cat-factory/kernel@0.11.0
  - @cat-factory/orchestration@0.8.0
  - @cat-factory/agents@0.10.0
  - @cat-factory/server@0.11.0
  - @cat-factory/node-server@0.9.0

## 0.8.1

### Patch Changes

- Updated dependencies [d0081e1]
  - @cat-factory/contracts@0.10.0
  - @cat-factory/agents@0.9.0
  - @cat-factory/server@0.10.0
  - @cat-factory/kernel@0.10.1
  - @cat-factory/orchestration@0.7.7
  - @cat-factory/node-server@0.8.1

## 0.8.0

### Minor Changes

- ae29687: OpenRouter: dynamic multi-tenant catalog + flavour unification.

  **Flavour unification.** A catalog model can now carry an `openrouter` flavour alongside
  `cloudflare`/`direct`/`subscription`. `effectiveVariant` resolves in the precedence
  direct → openrouter → cloudflare (the subscription override still wins in `ModelRouter`),
  so the SAME logical model routes through OpenRouter when only an OpenRouter key is
  configured, and through its native vendor when that key is present. The standalone
  `openrouter-*` catalog entries are folded into their native twins: `deepseek`, `gpt-5.5`
  and `claude-opus` gain an `openrouter` route; Gemini 3 Pro becomes a curated `gemini`
  entry. **Breaking (pre-1.0, acceptable):** the catalog ids `openrouter-claude-opus`,
  `openrouter-gpt`, `openrouter-deepseek`, `openrouter-gemini-pro` and `openrouter-llama`
  are removed — a block pinned to one falls through to default routing.

  **Dynamic catalog.** A workspace can now browse OpenRouter's live `/models` and enable a
  subset in the UI (the new "OpenRouter models" panel), rather than a hardcoded handful.
  Enabled models surface in the per-workspace picker as `openrouter:<slug>` entries with
  their live context window and price (overlaid onto the spend table, so budgets meter
  accurately). Persisted in a new generic per-workspace `provider_model_catalog` table
  (D1 ⇄ Drizzle, keyed by `(workspace_id, provider)` so future gateways like LiteLLM reuse
  it), behind the new kernel `ProviderModelCatalogRepository` port and the
  `OpenRouterCatalogService` (refresh leases the workspace's pooled OpenRouter key). New
  routes: `GET|PUT /workspaces/:ws/openrouter/catalog`, `POST /workspaces/:ws/openrouter/refresh`.
  Cross-runtime conformance asserts the enabled-subset round-trip + catalog surfacing on
  both D1 and Postgres.

### Patch Changes

- Updated dependencies [ae29687]
  - @cat-factory/contracts@0.9.0
  - @cat-factory/kernel@0.10.0
  - @cat-factory/server@0.9.0
  - @cat-factory/node-server@0.8.0
  - @cat-factory/agents@0.8.2
  - @cat-factory/orchestration@0.7.6

## 0.7.6

### Patch Changes

- Updated dependencies [5c20968]
  - @cat-factory/kernel@0.9.0
  - @cat-factory/server@0.8.0
  - @cat-factory/agents@0.8.1
  - @cat-factory/orchestration@0.7.5
  - @cat-factory/node-server@0.7.5

## 0.7.5

### Patch Changes

- Updated dependencies [c70df09]
  - @cat-factory/agents@0.8.0
  - @cat-factory/contracts@0.8.0
  - @cat-factory/kernel@0.8.0
  - @cat-factory/orchestration@0.7.4
  - @cat-factory/server@0.7.4
  - @cat-factory/node-server@0.7.4

## 0.7.4

### Patch Changes

- Updated dependencies [a0a1bcc]
  - @cat-factory/kernel@0.7.3
  - @cat-factory/node-server@0.7.3
  - @cat-factory/agents@0.7.3
  - @cat-factory/orchestration@0.7.3
  - @cat-factory/server@0.7.3

## 0.7.3

### Patch Changes

- fef2964: Add `@cat-factory/sandbox` and `@cat-factory/local-server` to the root `tsc -b`
  build graph (`backend/tsconfig.build.json`). They were publishable (`private: false`,
  `publishConfig.access: public`) and declared `files: ["dist"]`, but neither was
  referenced by the build graph nor pulled in transitively, so `pnpm build` (which
  `ci:publish` runs before `changeset publish`) never produced their `dist`. The last
  release therefore published both with only `package.json` + `LICENSE` and no code.
  This patch re-releases them with their built output. (`@cat-factory/consensus` was
  unaffected — it builds transitively via the cloudflare/node graphs.)

## 0.7.2

### Patch Changes

- 4fa5ed9: Re-release all publishable packages. The previous release bumped these on `main` but never reached npm (the publish job was never triggered), so npm is a release behind. This changeset re-triggers the release so every package publishes.
- Updated dependencies [4fa5ed9]
  - @cat-factory/agents@0.7.2
  - @cat-factory/contracts@0.7.2
  - @cat-factory/kernel@0.7.2
  - @cat-factory/node-server@0.7.2
  - @cat-factory/orchestration@0.7.2
  - @cat-factory/server@0.7.2

## 0.7.1

### Patch Changes

- 7463cf2: Add `repository` metadata (url + monorepo `directory`) to every published package.json. npm provenance attestation rejected the previous release because `repository.url` was empty and could not be matched against the source repo; declaring it lets the publish (and provenance) succeed, and re-triggers publishing of all packages from the failed release.
- Updated dependencies [7463cf2]
  - @cat-factory/agents@0.7.1
  - @cat-factory/contracts@0.7.1
  - @cat-factory/kernel@0.7.1
  - @cat-factory/node-server@0.7.1
  - @cat-factory/orchestration@0.7.1
  - @cat-factory/server@0.7.1

## 0.7.0

### Minor Changes

- 385bd93: Add an optional consensus-orchestration framework + a core Task Estimator.

  A new opt-in `@cat-factory/consensus` package lets an eligible agent step run through
  a multi-model **consensus** process — a specialist panel, a debate, or ranked
  voting/scoring — to produce a higher-quality result of the same shape the single-actor
  agent would have (a polished document, an aggregate of observations, an estimate). It
  integrates via the `AgentExecutor` seam: a `ConsensusAgentExecutor` wraps the standard
  composite and delegates to it when a step isn't consensus-enabled or gating marks the
  task ineligible. Eligibility is surfaced through a new group of assignable capability
  traits (`specialist-panel-capable` / `debate-capable` / `ranked-voting-capable`); the
  pipeline builder shows an "Enable Consensus" toggle (strategy, participants + models,
  optional risk/impact gating) on eligible steps. Each session persists a full transcript
  (`consensus_sessions`, both runtimes) rendered in a dedicated Consensus Session window
  and streamed live via a new `consensus` workspace event; every sub-call flows to
  `llm_call_metrics`. Wired per facade behind `CONSENSUS_ENABLED` (off ⇒ unchanged).

  A new **core** `task-estimator` agent rates a task's Complexity/Risk/Impact (0..1) after
  requirements are clarified; the engine persists it on `block.estimate` (new column on
  both stores) and the inspector shows the ratings. It gates the expensive consensus step
  and is useful standalone for triage.

  BREAKING (pre-1.0, no migration): `Block` gains `estimate`, the pipeline + pipeline-step
  shapes gain `consensus`, `AgentRunContext` gains `consensus` + `block.estimate`, and the
  `WorkspaceEvent` union + `ExecutionEventPublisher` gain a consensus variant. Stale rows /
  shapes simply re-create.

- e8005ba: Datadog post-release-health gate + Agent-On-Call.

  After a release ships, a new **`post-release-health`** polling gate watches the team's
  Datadog **monitors/SLOs** over a monitoring window. It reuses the existing gate machinery
  (`ci`/`conflicts`): a clean window advances with nothing spun up; a regression escalates —
  Datadog credentials stay on the backend and never enter containers.

  The gate is **opt-in**: it is NOT in any default pipeline. A user adds it deliberately in
  the pipeline builder, and it only appears in the palette — and is only accepted by the
  backend — once the workspace has an **observability integration connected** (today a
  Datadog connection). `PipelineService` rejects a `create`/`update` that adds an enabled
  `post-release-health` step otherwise.

  - **No blind revert.** On a regression the gate dispatches an **`on-call`** container agent
    that clones the base branch (the merged release; the work branch is deleted on merge),
    locates the merged commit and correlates its diff with the regression evidence (alerting
    monitors/SLOs + recent error logs), returning a JSON assessment (culprit confidence +
    `revert`/`hold`/`monitor` recommendation). It makes no commits and reverts nothing — the
    engine raises a **`release_regression`** notification for a human to decide. The gate only
    engages once the PR actually merged, attributes only post-release alerts (not pre-existing
    ones) to the release, and honours the full configured watch window even when it outlasts a
    single poll budget.
  - **Datadog connection + monitor/SLO mapping** are per-workspace (keys sealed at rest under
    a `cat-factory:datadog` cipher, write-only), managed in a new settings panel and the
    `GET|PUT|DELETE /workspaces/:ws/datadog/connection` + `/release-health-configs/:blockId`
    API. The gate maps a run's repo to its service-frame config (monitor + SLO ids + env tag).
  - **Merge-preset knobs**: `releaseWatchWindowMinutes` (default 30) and `releaseMaxAttempts`
    (default 1) bound the watch window + on-call dispatches.
  - **Incident enrichment (optional, additive):** PagerDuty / incident.io are NOT used to
    re-alert (they already page off the same monitors/SLOs) — instead the on-call
    investigation is posted onto an incident they already opened (annotate, never duplicate),
    behind a new `IncidentEnrichmentProvider` port. Slack + the in-app inbox carry the
    human-facing `release_regression` notification.
  - Runtime-symmetric: D1 (`datadog_connections`, `release_health_configs` + the two preset
    columns) ⇄ Drizzle/Postgres, wired in both the Cloudflare Worker and Node/local facades.
  - New harness route `POST /on-call`; the executor-harness image is bumped to `1.7.1`.

  **Breaking (pre-1.0, acceptable):** `merge_threshold_presets` gains two columns — stale rows
  are re-seeded with the defaults.

- f73652c: LLM key management overhaul: DB-backed, multi-scope, pooled provider API keys;
  opt-in Cloudflare AI; provider-gated pipelines; account roles.

  - **Direct-provider API keys move from env to the DB** (BREAKING). The
    OpenAI/Anthropic/Qwen/DeepSeek/Moonshot keys that were read from
    `*_API_KEY` env vars are now onboarded via the UI and stored encrypted (the
    shared `WebCryptoSecretCipher`, HKDF info `cat-factory:provider-api-keys`).
    They are pooled and leased with usage-aware rotation, and scoped to an
    **account, workspace, or user** — within a workspace the candidate pool merges
    the workspace's keys, its owning account's keys, and the run initiator's own
    user keys. Operators must re-enter their keys via the app after upgrading.
  - **Cloudflare Workers AI is no longer assumed available.** It becomes a separate
    opt-in provider lib (like `provider-bedrock`), explicitly registered per
    deployment (the Worker `AI` binding; Node REST account/token). The unconditional
    `workers-ai` fallback is removed, so a bare deployment exposes no models until a
    key is added or the Cloudflare lib is enabled.
  - **Model selectability is derived from what is configured**, and starting a
    pipeline is blocked when any step's canonical model has no usable provider
    (no direct key, no subscription, no registered registry).
  - **Account roles** (admin / developer / product, combinable) layered on the
    membership model: only admins may modify org-account settings; a product member
    can be set as a task's responsible person and is notified when requirement review
    raises findings.

- f9d3647: Local mode: first-class support for Podman, OrbStack, Colima and Apple `container`
  alongside Docker (for both spinning the per-run harness containers and the Tester's
  ephemeral/local test environments).

  The local runner backend (`LocalDockerRunnerTransport`, now
  `LocalContainerRunnerTransport`) no longer assumes the Docker CLI and Docker Desktop
  networking. HOW it talks to the runtime is delegated to a `ContainerRuntimeAdapter`
  (`backend/runtimes/local/src/runtimes/*`), selected by a new `LOCAL_CONTAINER_RUNTIME`
  env (`docker` | `podman` | `orbstack` | `colima` | `apple`, default `docker`):

  - **Docker / Podman / OrbStack / Colima** share the Docker-CLI adapter (`docker run`,
    publish `:8080` to an ephemeral host port, `cat-factory.runId` label), parameterised by
    binary + host-networking. Per-runtime defaults set the right host alias the harness
    uses to reach the LLM proxy (`host.docker.internal`, `host.lima.internal` for Colima),
    overridable via the new `LOCAL_HARNESS_HOST_ALIAS` / `PUBLIC_URL`. `PUBLIC_URL` now
    derives from the selected runtime's alias.
  - **Apple `container`** (macOS) gets its own adapter: one VM per container, addressed by a
    deterministic name, connected to the container's own IP (no published-port model), via
    `container run | list | inspect | delete`.

  **Tester "limited mode".** Apple `container` has no Docker-in-Docker, so the Tester's
  **Local** infra mode (`docker compose up` inside the job container) can't run there. Each
  adapter exposes a `localDind` capability that the local facade threads into the engine as
  `localTestInfraSupported`; `ExecutionService` now refuses a local-infra Tester pipeline at
  start on an incapable runtime (`tester-infra.logic.ts`), with an actionable message. The
  Tester still runs there via the **Ephemeral** test environment (offloaded to a configured
  environment provider — e.g. a custom container pool) or a **No infra dependencies**
  service. This gate defaults to permissive (`localTestInfraSupported` defaults `true`), so
  Cloudflare, Node and tests are unchanged.

  `startLocal()` now logs the resolved runtime + capabilities + host alias and probes that
  the CLI is installed, so a misconfiguration fails loudly at boot rather than on the first
  agent job. The executor-harness image is unchanged.

- 8807f5c: Run agents on locally-hosted LLMs (Ollama, LM Studio, llama.cpp, vLLM, or any
  custom OpenAI-compatible server). Each user configures their own runners in
  Settings → "My local runners" (a runner lives on that person's machine), stored
  per-user in the DB with on-the-fly connection validation that probes the runner's
  `/v1/models` and lists the installed models to enable. The enabled models appear
  in the picker as the `direct` flavour and need no API key — the LLM proxy resolves
  the run initiator's endpoint and skips the DB key lease (new optional
  `LlmUpstreamEndpoint.apiKey` signal / keyless local branch), and inline LLM calls
  register the user's runners as keyless resolvers. Resolution is by the run
  initiator, exactly like personal subscriptions.

  New per-user `local_model_endpoints` table mirrored across both runtimes (D1
  migration `0002` ⇄ Drizzle), a user-scoped `GET|PUT|DELETE /local-model-endpoints`

  - `POST /local-model-endpoints/test` API, and a cross-runtime conformance
    assertion for the store (CRUD + bearer-key encryption round-trip + enabled-models
    JSON). Container kinds (coder/tester/merger/…) and the inline reviewer/planner all
    run on the local model. Breaking only in the pre-1.0 sense: a new table is added,
    no migration of existing data is needed.

  Because the user-supplied base URL is forwarded server-side (the test probe + the
  LLM proxy), it is constrained to a loopback/LAN allow-list (`localRunnerUrlError`):
  `localhost`, `*.local`, and RFC1918/ULA private addresses are accepted, while public
  hosts and the link-local cloud-metadata endpoint (`169.254.169.254` / `fe80::`) are
  rejected at the write boundary and the probe (anti-SSRF). Model usability is gated on
  the specific enabled model id (`localModels` capability), not merely the runner being
  configured, so a stale pin to a since-disabled model is caught at the pipeline-start
  guard.

- f0a847d: Local mode can link GitHub repos with the PAT, lighting up the "Add from existing
  repo" board flow (previously the GitHub integration was App-only, so it returned 503
  and the button stayed hidden — repos could only be linked via the `linkRepo` CLI).

  With a `GITHUB_PAT` set, the local facade now serves the GitHub read/link endpoints
  through the PAT-backed client:

  - `config.github.enabled` is forced on in local mode when a PAT is present (the Node
    loader only enables it for a configured GitHub App).
  - A workspace's installation is auto-provisioned from the PAT on first read
    (`AutoProvisioningInstallationRepository`), so `GET /github/connection` reports
    connected with no connect flow. The synthetic installation id matches the `linkRepo`
    CLI's, so CLI- and UI-linked repos share one installation.
  - The repo picker lists repos via `/user/repos` (`PatGitHubClient.listInstallationRepos`),
    the PAT analogue of the App-only `/installation/repositories` (which 403s for a PAT).
  - The connection reports `workflows: write` granted (the local PAT carries `workflow`
    scope), suppressing the advisory "missing workflows permission" banner.

  `@cat-factory/node-server` gains a `githubInstallationRepository` option on
  `buildNodeContainer` (default unchanged) so the local facade can wrap the repository,
  and re-exports `DrizzleGitHubInstallationRepository`. This is a local-mode differentiator
  (like the Docker runner and PAT token source); the Cloudflare/Node-proper facades keep
  using the GitHub App.

  The "Add from existing repo" picker also gains a search/filter input (filter by
  owner/name, with a "showing X of Y" count), since a PAT or wide App install can expose
  hundreds of repos that overflowed the plain dropdown.

- 0b21ff3: Add a local-mode runtime facade (`@cat-factory/local-server`) so a developer can run
  the whole product on their own machine. It is the Node.js facade
  (`@cat-factory/node-server`: shared Hono app + Drizzle/Postgres + pg-boss) with two
  local differentiators: agent jobs run as per-job local Docker/Podman containers (the
  new `LocalDockerRunnerTransport` — the local analogue of the Worker's per-run
  Cloudflare Container and an org's self-hosted runner pool, driven through the same
  `RunnerTransport` port), and GitHub is reached via a personal access token (`GITHUB_PAT`)
  instead of a GitHub App. `startLocal()` boots the service; `buildLocalContainer()` is
  the composition root. The agent containers clone, push branches and open real PRs on
  github.com with the PAT; pipelines run end to end locally.

  To support this cleanly, `@cat-factory/node-server` gained composition seams used by
  the local facade (all default to the existing Node behaviour): `buildNodeContainer`
  now accepts an injected `resolveTransport`, `mintInstallationToken` and `githubClient`,
  and `start()` accepts an injected `buildContainer` and a `host` bind address (else
  `HOST` from the env, else all interfaces — so a deployment can keep the service off the
  LAN). It also re-exports `createApp`. The local facade runs the shared cross-runtime
  conformance suite (with a fake agent executor) so it can't drift from the Node and
  Cloudflare facades.

  The runtime-neutral fetch-based GitHub client and the CI / merge / mergeability
  providers (`FetchGitHubClient`, `GitHubCiStatusProvider`, `GitHubMergeabilityProvider`,
  `GitHubPullRequestMerger`) move from the Cloudflare runtime into `@cat-factory/server`
  (re-exported from the Worker for existing imports — no behaviour change), so every
  facade can gate on real CI and merge for real. `FetchGitHubClient` now accepts any
  `AppTokenSource` (the App registry or a static PAT). Local mode wires these from a
  PAT-backed client, so a local pipeline gates on real GitHub Actions CI and merges the
  PR for real. The Node facade now also wires these gates when a GitHub App is configured
  — it builds a `FetchGitHubClient` from its own shared App registry — so a stock
  Node-with-App deployment gates on real CI and merges for real too (parity with the
  Worker; previously only local mode did).

  Local-mode robustness: the Docker transport is now constructed lazily, so the service
  boots (to serve the board + inline kinds) even without `LOCAL_HARNESS_IMAGE` — only
  repo-operating kinds then fail, loudly. On boot it reaps per-job containers orphaned by
  a previous crash, and on re-dispatch it removes any lingering container for the same job
  id before starting a fresh one. The `linkRepo` helper clears a stale installation row
  for the workspace before upserting (robust against the `github_installations`
  workspace-unique index), and local mode warns when the auth gate is left open on a
  network-reachable bind.

- f066c59: Make the **native environment-adapter** path first-class, so a deployment can inject a
  hand-written `EnvironmentProvider` (e.g. a native ephemeral-environment adapter) instead of the generic
  manifest-driven `HttpEnvironmentProvider` — with per-workspace config and the supported
  local-mode entry point.

  - **Manifest `providerConfig` bag** (`@cat-factory/contracts`): `environmentManifestSchema`
    gains an optional, opaque `providerConfig: Record<string, unknown>`. The generic
    `HttpEnvironmentProvider` ignores it; a native adapter reads + validates it off the
    per-call `manifest`. Because an injected provider is a deployment-wide singleton, the
    per-workspace connection's manifest is its only per-workspace config carrier — so a
    single deployment can now target a different native project (provider project, link key,
    status map, …) per workspace. It rides inside the existing `manifest_json` JSON column on
    both runtimes — no migration, automatic D1 ⇄ Drizzle parity. **Not** covered by the
    manifest URL/SSRF checks (which only guard `baseUrl`/`tokenUrl`); an adapter that reads a
    URL from `providerConfig` must guard it itself.
  - **`startLocal({ environmentProvider })`** (`@cat-factory/local-server`): the local-mode
    entry point gains an `environmentProvider` seam (and a `host` option, matching `start()`),
    threaded through `buildLocalContainer` → `buildNodeContainer`. A local deployment can now
    wire a native provider through the supported entry point — keeping local mode's boot
    preflight (orphan reaping, PAT/auth warnings) and differentiators — instead of bypassing
    `startLocal()` and re-implementing the preflight. `buildContainer` is intentionally not
    exposed (overriding it would discard local mode's differentiators).
  - New `backend/docs/native-environment-adapter.md` documents the injection contract, the
    env-port-vs-runner-port boundary, teardown/TTL idempotency, the `@cat-factory/kernel`
    adapter dependency, and a reference native-adapter sketch.

  No backwards-incompatible changes: every addition is optional and defaults to today's
  behaviour.

- 7d5e060: Bridge the Cloudflare ⇄ Node/local runtime feature-parity gaps: seven product
  features that worked on the Worker but `503`'d on the Node + local facades (their
  repositories were never wired) now work identically on all three, each landed with
  a cross-runtime conformance assertion.

  - **Merge threshold presets** — `merge_threshold_presets` + `DrizzleMergePresetRepository`.
  - **Board-scan repository blueprints** — `repo_blueprints` + `DrizzleRepoBlueprintRepository`
    (the blueprint reads; the `blueprints` pipeline step already ran on Node).
  - **Document sources** — `document_connections`/`documents` + repos; the Confluence /
    Notion / GitHub-docs provider shells are promoted into `@cat-factory/integrations`
    so both facades compose the same providers.
  - **Ephemeral environments** — `environment_connections`/`environments` + repos;
    `HttpEnvironmentProvider` promoted into `@cat-factory/integrations`; a Node
    `setInterval` TTL-teardown sweeper mirrors the Worker's expiry cron.
  - **GitHub projections + inline sync** — `github_branches`/`github_pull_requests`/
    `github_issues`/`github_commits`/`github_check_runs` + `github_sync_cursors` and the
    full read/write projection repos, so the runtime-neutral `GitHubSyncService`'s inline
    webhook/backfill ingest persists on Node; `WebCryptoWebhookVerifier` promoted into
    `@cat-factory/server`.
  - **Repo bootstrap** — `reference_architectures` + bootstrap runs stored as
    `kind='bootstrap'` rows of `agent_runs`; `ContainerRepoBootstrapper` promoted into
    `@cat-factory/server`; a **pg-boss durable bootstrap driver** (the analogue of the
    Worker's `BootstrapWorkflow`) replaces the previous "bootstrap isn't durable on Node
    yet" gap, and the stale-run sweeper now re-drives orphaned bootstrap runs too. The
    self-hosted runner pool (`RunnerPoolTransport`) now accepts the `bootstrap` dispatch
    kind — the harness `/bootstrap` route needs no Cloudflare primitive, so a pool runner
    serves it just like the local Docker transport — so a real bootstrap run dispatches +
    pushes for real on Node, not just on local.
  - **Prompt-fragment library (ADR 0006)** — `prompt_fragments`/`fragment_sources` +
    `DrizzlePromptFragmentRepository`/`DrizzleFragmentSourceRepository`; the runtime-neutral
    `LlmFragmentSelector` promoted into `@cat-factory/agents`. Opt-in via
    `PROMPT_LIBRARY_ENABLED`/`PROMPT_LIBRARY_SELECTOR`, wired exactly like the Worker's
    `selectFragmentLibraryDeps` (repos + installation resolver + selector), so the managed
    tenant fragment catalog feeding every agent run works identically on all three.

  The Worker keeps the same behaviour (it gains the new conformance assertions and the
  shared promoted classes). **Breaking on Node/local:** these features now require their
  new tables — boot-time `migrate()` applies them; there is no data to preserve.

  The Node/local Drizzle migration lineage was re-baselined to a single fresh
  `drizzle-kit generate` migration off the current `schema.ts` (the prior hand-authored
  folders had no snapshots, which blocked `db:generate`); `db:generate`/`db:check` are
  green again. Safe because no deployed database depends on the old lineage.

  Deferred (still Worker-only, flagged for follow-up): real-time push (Node `realtime`
  gateway still `501`s — needs a WebSocket hub over Postgres `LISTEN/NOTIFY`),
  queue-backed async GitHub ingest (Node ingests inline rather than via a pg-boss queue),
  and GitHub rate-limit telemetry (Node keeps the no-op repository).

- 75bd29d: Implement the real-time WebSocket transport on the Node + local facades, closing the
  last "Worker-only" runtime gap for live board updates. Previously the SPA's
  `ws://…/workspaces/:ws/events` handshake had no server on Node/local (the realtime
  gateway returned null and `@hono/node-server` doesn't upgrade on its own), so the
  browser logged a perpetual `connection refused` and only got updates by reconnect-time
  snapshot refresh.

  - New `runtimes/node/src/realtime.ts`: `NodeRealtimeHub` (in-memory per-workspace
    subscriber registry), `NodeEventPublisher` (mirrors the Worker's
    `DurableObjectEventPublisher` event shapes), and `attachRealtime` — a `ws` server bound
    to the HTTP `upgrade` event. The SPA speaks raw WebSocket (not socket.io), so the
    client is unchanged across runtimes; `@hono/node-ws` was rejected because its
    `upgradeWebSocket` middleware can't compose with the shared, `Response`-returning
    `EventsController`.
  - `start()` creates the hub, wires it into `buildNodeContainer` (as the engine's
    `executionEventPublisher`, decorated with `FanOutEventPublisher` so a shared service's
    events reach every mounting board, plus an `InAppNotificationChannel` composed
    alongside Slack), and attaches it to the HTTP listener. Local mode inherits all of
    this through `buildLocalContainer`'s pass-through, so a developer running locally now
    gets live execution/bootstrap/notification updates.
  - Ticket mint/verify is extracted into the shared `@cat-factory/server`
    `auth/wsTicket.ts` (`mintWsTicket`/`authorizeWsUpgrade`), used by both the Worker's
    `EventsController` and the Node upgrade handler so both handshakes authorise
    identically. `InAppNotificationChannel` is promoted from the Worker into
    `@cat-factory/server` so both facades deliver in-app notifications through one class.

  Single-process only for now: a multi-replica Node deployment would need a shared bus
  (Postgres `LISTEN/NOTIFY`) in front of the in-memory hub. The Worker's behaviour is
  unchanged (it gains the shared ticket/channel helpers).

- 7157fd7: Rework run timing, add task types, and add a per-service running-task limit.

  **Run timing.** A run parked waiting for a human is no longer auto-failed after a
  fixed timeout — it waits indefinitely. The old `decision_timeout` machinery is gone
  (the Cloudflare driver re-arms its `waitForEvent` instead of failing; the Node driver
  drops the decision-timeout queue/worker; the `decision_timeout` failure kind is
  removed). Instead, notifications carry a `severity` and a periodic sweep escalates any
  open notification from `normal` (yellow) to `urgent` (red, "Overdue") once it has
  waited past the workspace's `waitingEscalationMinutes` threshold. Every human-input
  park now also guarantees an open notification, so a waiting run is never silently
  stuck. **Breaking:** the `decision_timeout` agent-failure kind is removed.

  **Task types.** Tasks gain a `taskType` (`feature` / `bug` / `document` / `spike` /
  `recurring`) chosen at creation, plus small per-type fields (e.g. a bug's severity /
  repro, a spike's time-box). `recurring` is created through the existing recurring-
  pipeline schedule flow, which now also accepts a free-text prompt for its reused task.

  **Per-service running-task limit.** A new per-workspace settings object
  (`waitingEscalationMinutes` + a task-limit policy) caps how many tasks may run
  concurrently under one service — off, a single shared bucket, or one bucket per task
  type. Starting a task over the limit is refused with a human-readable 409. Managed via
  `GET|PUT /workspaces/:ws/settings` and a new Workspace settings panel. Persisted in a
  new `workspace_settings` table on both runtimes (D1 ⇄ Drizzle), with cross-runtime
  conformance assertions for the task type round-trip and the limit enforcement.

- 8eed95b: Service-scoped best-practice prompt fragments, delivered by agent traits.

  A service (frame block) now owns an explicit selection of best-practice / guideline
  fragments — its programming standards — chosen from the **universal fragment pool**.
  That pool is the built-in catalog plus any fragments a deployment registers at startup
  via the new `registerPromptFragment` seam in `@cat-factory/prompt-fragments` (mirroring
  `registerAgentKind` / the model-provider registry); `GET /prompt-fragments` serves the
  merged pool. A workspace can also configure a **default set new services inherit**
  (`GET|PUT /workspaces/:ws/service-fragment-defaults`), seeded onto a frame's
  `serviceFragmentIds` when it is created (board drop, repo import, or bootstrap).

  Agents gain first-class **capability traits** (`@cat-factory/agents`): a registry of
  standard + custom traits with `traitsFor` / `hasTrait`, assignable to built-in kinds and
  to custom kinds via `AgentKindDefinition.traits`. Two standard traits ship:

  - **`code-aware`** (coder, ci-fixer, fixer, reviewer, architect): the running service's
    selected fragments are folded into the agent's system prompt, unioned with the block's
    own manual pins. Other kinds keep only their block pins.
  - **`spec-aware`** (every code-touching kind): the agent's system prompt gains guidance to
    read the in-repo `spec/` artifact (overview.md → rules.md → features/\*.feature →
    spec.json) and treat it as the source of truth for required behaviour.

  This **replaces the automatic per-run relevance selector**: fragment delivery is now
  explicit (the service's selection) and trait-gated (code-aware) rather than guessed per
  run. Per-block manual pins (`Block.fragmentIds`) still apply to that block's own agents.
  The tenant fragment **library** (account/workspace CRUD + repo sources) remains as a
  management surface but no longer feeds the run path.

  Persistence is mirrored on both runtimes: a `service_fragment_ids` column on `blocks`
  and a `workspace_fragment_defaults` table (Cloudflare D1 migration `0040` +
  `D1ServiceFragmentDefaultsRepository`; Node Drizzle schema/migration +
  `DrizzleServiceFragmentDefaultsRepository`), with the cross-runtime conformance suite
  asserting the workspace-default round-trip, new-service inheritance, and the
  code-aware-only folding on both facades. The UI adds a per-service "Service best
  practices" picker in the inspector and a "Default service best practices" workspace
  settings panel.

  BREAKING (Node facade dev/test only): the Drizzle migration lineage under
  `runtimes/node/drizzle/` was squashed into a single fresh baseline migration — the prior
  incremental migrations had a forked, non-commutative history (left by merging two
  branches) that broke `drizzle-kit generate`/`check`. There are no production Postgres
  deployments, so existing dev/test databases should be dropped and re-created from the
  new baseline rather than migrated. CI now runs `db:check` to keep the lineage honest.

- 5ca8086: Add alternate subscription-backed coding harnesses (Claude Code / Codex) alongside
  the Pi proxy harness.

  - New per-workspace **subscription token pool** (`provider_subscription_tokens`,
    D1 + Postgres, encrypted at rest) with usage-aware rotation, behind a kernel
    port + `ProviderSubscriptionService`, wired into all three runtimes.
  - A guided **LLM Vendors** navbar UI to connect Claude / Codex / GLM (Z.ai) /
    Kimi (Moonshot) / DeepSeek subscription credentials (token pool, write-only).
    GLM / Kimi / DeepSeek all run via Claude Code against the vendor's
    Anthropic-compatible endpoint; the unfiltered credential list covers every vendor.
  - The executor-harness image now bundles the Claude Code and Codex CLIs; the
    harness selects `pi` / `claude-code` / `codex` per job from the model, and the
    subscription harnesses authenticate direct-to-vendor (no proxy) and report token
    usage from the CLI event stream for rotation + telemetry.
  - The model catalog becomes a canonical-model → provider map with precedence
    **subscription > direct > cloudflare** ("subscriptions always win"): latest
    Opus/Sonnet + GPT-5.5/5.4 (subscription-only), GLM-5.2/Kimi gain a Claude-Code
    subscription flavour, and `ModelOption` now carries per-flavour cost, context
    window, and a `quotaBased` flag (subscription usage is flat-rate quota, never
    billed against the spend budget).
  - A block's model is shared by all its pipeline steps, so a pin to a subscription-only
    model (Claude Code / Codex — container-only, no provider key) is degraded to the
    step's env-routing default for every INLINE LLM path through one shared seam
    (`inlineModelRef` / `resolveInlineModelRef`): both the inline agent executor and the
    requirements reviewer/rework, so the inline steps run instead of hard-failing and the
    two paths can't drift. The claude-code subscription harness repairs malformed
    structured output through the vendor's own Anthropic-compatible endpoint (the Pi
    harness still uses the proxy; Codex keeps the graceful no-repair path).
  - Hardening: the per-vendor token pool is capped to bound growth; the leased
    subscription credential is scrubbed from subscription-repair error details (not just
    GitHub-shaped secrets); and Codex token usage is read from its cumulative
    `total_token_usage` so multi-turn runs attribute usage correctly for rotation.

- cc8d96a: Flesh out the Tester agent, add an agent configuration-contribution mechanism, and
  make Mocker always precede Tester.

  - **Pipelines:** every built-in pipeline that runs a `tester` now runs `mocker`
    immediately before it, so the Tester has its external-dependency mocks up.
  - **Config contribution:** agents (built-in or custom, via the agent registry's new
    `configContributions`) declare task-level config parameters. The union over a
    task's pipeline appears on task creation + the inspector and freezes once the
    contributing agent's step starts. Values persist as a sparse `agentConfig` map on
    the block (keys/values length-capped); the catalog rides the workspace snapshot. The
    Tester contributes its `environment` (local vs ephemeral) and Playwright its e2e
    target (CI vs ephemeral). The old fixed `testTarget` block field is dropped — its
    column is dropped on both runtimes too (no backwards-compat shim).
  - **Tester → Fixer loop:** `tester` is now a container agent that runs the project's
    tests — standing infra up locally via the service's docker-compose (rootless
    Docker-in-Docker in the harness) or against an ephemeral environment — and returns
    a structured report (what was tested, outcomes, concerns, greenlight). On a
    withheld greenlight the engine loops a new dedicated `fixer` agent with the report
    and re-tests, up to the task's merge-preset attempt budget. Only **blocking
    (high/critical)** concerns withhold the greenlight — low/medium are advisory, so a
    trivial nit can't burn the whole fixer budget — and the engine re-applies that rule
    defensively over the report. When the budget is spent (or there's no PR branch to
    fix, or the report is unparseable) the run fails for real (the tester step is left
    un-`done`) and raises a human-actionable `test_failed` notification (retry action),
    mirroring the CI gate. New harness `/test` + `/fix-tests` endpoints; reports + fixer
    summaries render in the inspector and step detail.
  - **Service + provisioning config:** a service frame carries the Tester's
    docker-compose path / "no infra dependencies" toggle (a Tester pipeline can't start
    until one is set), plus a cloud provider and abstract instance size that resolve to
    the concrete instance-type id forwarded to the runner. Per-service sizing applies to
    the self-hosted-pool and local-Docker backends; the Cloudflare Container backend has
    a fixed per-class instance type (`wrangler.toml`) with no per-dispatch override, so
    it ignores the hints (pick `cloudflare` when you don't need per-service sizing).
  - **Account default cloud provider (fully wired):** accounts carry a
    `defaultCloudProvider` new services inherit — persisted on both runtimes, settable
    via `PATCH /accounts/:id` (owner-only) and the account menu, returned on the account
    wire, and pre-filled as the service editor's provider default.
  - **Local mode is 100% Docker/Podman:** a new first-class `docker` cloud provider
    represents the local daemon. The local runner backend sizes each per-job container
    from the abstract instance size (`--memory`/`--cpus`) and runs the Tester job
    `--privileged` so it stands its docker-compose infra up with Docker-in-Docker on the
    host daemon — never Cloudflare. A Tester-only pipeline with no PR branch now fails
    cleanly (no fixer to push to) instead of throwing.
  - Mirrored across both runtimes (D1 migration ⇄ Drizzle schema + migration).

- 3e6a844: Workspace creation/onboarding overhaul: real users, non-GitHub auth, invites,
  named+described boards.

  - **Persistent identity**: a new `users` + `user_identities` model replaces the
    GitHub-numeric-id identity. Memberships, `blocks.created_by`, personal
    subscriptions, and the session payload are all re-keyed to a generated `usr_*`
    id. (BREAKING: pre-existing personal accounts — keyed by GitHub login with a null
    `owner_user_id` — stop matching and a fresh personal account is created on next
    sign-in; old member-mapping rows keyed by GitHub id are orphaned. No migration,
    per the pre-1.0 policy.)
  - **Non-GitHub auth**: email/password (WebCrypto PBKDF2 hashing) and Google OAuth
    login alongside GitHub. New-user creation is invite-only plus an optional
    `AUTH_ALLOWED_EMAIL_DOMAINS` self-signup allowlist (fail-closed). A user without
    a GitHub account works fully — repo access is via the GitHub App, not a user token.
  - **Email invitations**: invite teammates by email into an org account; the invitee
    redeems a tokened link to gain membership. Email is sent via a pluggable
    `EmailSender` (SendGrid / Resend adapters) whose provider + API key are
    **onboarded per-account in the UI and stored sealed in the DB** (not env), like
    the Slack bot token. New tables: `users`, `user_identities`, `account_invitations`,
    `email_connections` (D1 + Drizzle).
  - **Board name + description**: `Workspace.description` end to end (create + edit).
  - **Onboarding discovery**: org members see and open existing org boards from the
    switcher instead of being forced to create one.
  - Slack member-mapping is re-keyed from `githubUserId` to the internal `userId`.

### Patch Changes

- 9d3a956: Clarity reviewer (bug-report triage) + bug investigator: a new bug-fix pipeline front.

  Adds two new agents at the front of a new `pl_bugfix` ("Triage & fix bug") pipeline preset:

  - **`bug-investigator`** — a read-only container agent (it runs the shared `/explore`
    harness path used by `architect`/`analysis`, so no new harness endpoint or image change).
    It clones the repo, reads the codebase from the raw bug report, and returns a prose
    enriched report plus an OPTIONAL working hypothesis — which it omits unless reasonably
    confident, so a low-confidence guess never misdirects the fix. Its output feeds the
    clarity reviewer (the triage subject) and the coder (a non-binding lead, via `priorOutputs`).
  - **`clarity-review`** — an inline engine gate step that triages the bug report for
    _fixability_ (repro steps, expected-vs-actual, environment, affected area), mirroring the
    requirements-review iterative loop (raise findings → answer/dismiss → incorporate into one
    standard-format clarified report → re-review until it converges, with the same per-task
    `maxRequirementIterations` / `maxRequirementConcernAllowed` knobs). The converged clarified
    report substitutes downstream as the task description for the spec-writer/coder (when both
    a requirements and a clarity review exist, the requirements doc wins).

  Persisted as a new `clarity_reviews` table on BOTH runtimes (D1 migration
  `0002_clarity_reviews` + Drizzle migration), wired in both facades' containers with a new
  `clarity` event on the real-time transport and a `clarity_review` notification type. A
  cross-runtime conformance assertion pins the clarified-brief substitution against both
  stores.

- 8d11833: Companion agents + acceptance-test rework (the structured spec replaces the
  client-only scenario surface), plus a vocabulary split so "requirements" (the
  linked-prose context review) and "spec" (the structured in-repo document) are no
  longer the same word.

  - **Companion agents.** A companion grades a prior producer step's output, returns
    an overall quality rating (0..1), and — below the step's threshold (default 0.8) —
    loops the producer back for automatic rework BEFORE a human is asked, failing the
    run (`companion_rejected`) once the rework budget is spent. Companions declare an
    allow-list of target kinds and are placed as their own chain step in the pipeline
    builder (with a per-step `thresholds` array, parallel to `gates`). Built-ins:
    `architect-companion`, `spec-companion`, and `reviewer` reframed as the coder's
    companion. Wired into `ExecutionService` (`evaluateCompanion` + a unified rework
    revision path shared with the human "request changes" flow).
  - **Companion-gated requirements rework.** The per-block requirements review's
    rework step is now gated by a quality companion: below threshold the reworked doc
    is NOT accepted (the review stays `ready`), and the companion's challenge is
    surfaced in the review window and fed into the next rework. Persisted on
    `requirement_reviews.companion` (D1 migration 0036 + Drizzle).
  - **Acceptance tests via the spec.** The client-only scenarios store/UI is removed;
    the structured Given/When/Then acceptance scenarios live in the service spec
    (authored by the `spec-writer`, reviewed on its gated step) and are derived into
    Gherkin. The redundant `acceptance` polish agent is dropped; `playwright` still
    writes the runnable tests. `spec-writer`'s prompt now treats complete
    acceptance-scenario coverage as a first-class deliverable.
  - **`architect` is now a container agent** that explores the repo (read-only, like
    `analysis`) before proposing. Both read-only kinds share one reusable execution
    path: a new harness `/explore` endpoint (dispatch kind `explore`) clones the branch,
    runs the agent read-only and returns its prose report/proposal — making no commit,
    opening no PR, and (unlike `/run`) NOT treating an edit-free run as a failure. A
    shared read-only guardrail is appended to their system prompts.
  - **Companion rework correctness.** When a companion loops a producer back, EVERY step
    between the producer and the companion is now reset and re-run (clearing stale
    container job handles), so an intermediate container step re-dispatches fresh work
    instead of re-attaching to its evicted job. The automatic rework budget now counts
    only automatic attempts (`companion.attempts`); a human "request changes" on a
    companion's gate re-runs the producer without consuming it.
  - **Rename: requirements → spec** for the structured family. In-repo `requirements/`
    → `spec/` (`spec.json`, `spec/features/*.feature`; legacy `requirements/`
    relocated on first run); `RequirementsDoc` → `SpecDoc`; `requirements-writer` →
    `spec-writer`; the pipeline analyst `requirements` → `requirements-review`;
    `pl_requirements` → `pl_spec`. The context-review family (`RequirementReview*`,
    `requirement_reviews`) keeps the `requirements` name.

  The harness image changed (the `/requirements` endpoint + `requirements/` paths
  became `/spec` + `spec/`), so `@cat-factory/executor-harness` and the
  `deploy/backend` image tag are bumped to 1.0.6 and must be re-published + rolled out.

- 157cd02: Standardize the executor-harness job API on a single `POST /jobs` endpoint with the
  agent kind carried in the request body, instead of one route per kind (`/run`,
  `/bootstrap`, `/merge`, …).

  Breaking wire change between the runtime transports and the harness image (acceptable
  pre-1.0: the two ship together, no external consumers). The old per-kind-route image
  is incompatible with the new transports, so the runner image MUST be republished and
  deployed.

  - Harness: `server.ts` is now table-driven — one `KINDS` registry keyed by kind drives
    a single `POST /jobs` dispatcher (reads the body's `kind` to pick the validator +
    registry) and a single `GET /jobs/{id}` poll. Adding an agent kind is one table
    entry, not a new endpoint + registry global + poll-chain branch. Bumps the runner
    image tag (1.7.2 -> 1.7.3) in `deploy/backend` (`image:publish` + wrangler.toml).
  - Harness: the explore job's temp-dir/log label field is renamed `kind` -> `label` so
    it no longer collides with the reserved dispatch discriminator `kind`.
  - Server: `ContainerAgentExecutor` stamps the kind into the dispatch body (the explore
    body now sends `label` for its agent-kind label).
  - Worker + local-server transports POST `{ ...spec, kind }` to `/jobs`;
    `LocalDockerRunnerTransport` drops its `KIND_ROUTE` map. The self-hosted pool already
    forwards `kind` in the spec, so it needs no code change — only the manifest docs
    (kernel/contracts/integrations) are updated to note the harness routes by the body's
    `kind`.

- db77061: Add an **individual-usage restricted mode** for subscriptions licensed for personal
  use only (`claude`, `glm` and `codex` — see their terms of service). Such vendors are no
  longer poolable on a workspace; instead each user stores their OWN credential and only
  that user's runs may use it.

  - **Per-user, double-encrypted storage.** A personal subscription's token is sealed
    under a key derived from the user's personal **password** (PBKDF2 → AES-GCM, never
    stored) and then encrypted again with the system key, so it cannot be recovered
    without BOTH the system key AND the password. New `personal_subscriptions` table on
    both runtimes (D1 migration `0039` ⇄ Drizzle), `PersonalSubscriptionService`, and
    `GET/POST/DELETE /personal-subscriptions` (user-scoped).
  - **One password per user.** All of a user's individual-usage subscriptions must share a
    single personal password (enforced at store time), since a run unlocks every vendor it
    touches with one password. Passwords are restricted to printable ASCII so they are
    HTTP-header-safe.
  - **Per-run activation, short TTL, transparently extended.** At task start/retry the user
    supplies their password — carried on the ambient `X-Personal-Password` header (never a
    body field), cached client-side (~40h) so it usually rides along transparently — to mint a
    short-lived (~12h), system-encrypted, per-run activation (`subscription_activations`
    table) that the asynchronous container steps lease, so the whole step chain authenticates
    without the user present. The activation is **re-minted from the cached password on each
    interaction** (resolve a decision / approve a step / retry), so an actively-tended run
    never lapses under the short TTL; the user is only re-prompted once the password cache
    expires. Activations are deleted when the run finishes (or its block's run is replaced)
    and swept on TTL expiry.
  - **No recurring runs.** A recurring schedule whose block resolves to an individual-usage
    model — by pin **or** workspace per-kind default — is refused at fire time (it can't be
    unlocked unattended).
  - **Gating.** Starting/retrying a run that resolves to individual-usage model(s)
    requires a signed-in user with the stored subscription(s); a missing password returns
    `428 credential_required` so the client prompts. The gate mirrors dispatch's model
    precedence (block pin → workspace per-kind default) across the pipeline's steps, so a
    block with no pin but an individual-usage workspace default is gated up-front instead
    of failing at dispatch. The container executor leases the initiator's activation and
    fails clearly (retryable) if it has lapsed. Expiry/renewal is surfaced in advance.

  **Breaking (no migration — backwards compatibility is a non-goal here):** `glm` and `codex`
  join `claude` as individual-only, and individual-only vendors are no longer poolable on ANY
  workspace. Any existing **pooled** `claude`/`glm`/`codex` workspace tokens become orphaned
  (no longer leased or listed) — reconnect them as personal subscriptions.

  See `backend/docs/individual-subscription-usage.md` for the full model + safeguards.

- 160837f: Default `ENCRYPTION_KEY` in local mode so the server boots out of the box. The
  Node config loader requires `ENCRYPTION_KEY` (it backs credential encryption at
  rest), but `applyLocalDefaults` only defaulted the auth/session/PUBLIC_URL vars,
  so a stock local install crashed on boot with "ENCRYPTION_KEY is required" despite
  the docs promising a local default. It now generates a per-process key when unset,
  mirroring `AUTH_SESSION_SECRET`. Set `ENCRYPTION_KEY` explicitly to keep
  encrypted-at-rest credentials decryptable across restarts.
- 7a9cabf: Local mode now warns when no GitHub PAT is configured — in the UI, not just the
  console. At boot, `startLocal()` still logs a warning, but the local facade also tags
  its `AppConfig` with a `localMode` block carrying a GitHub "new personal access token
  (classic)" URL (scopes pre-selected: `repo`, `workflow`) when `GITHUB_PAT` is unset.
  The shared `/auth/config` endpoint surfaces that block, and the SPA renders a
  dismissible banner with a one-click link straight to the token-creation page, so the
  prompt isn't lost in a dev terminal. Exposed as `githubPatCreationUrl()` from the local
  facade and `LocalModeConfig` from `@cat-factory/server`.
- b287996: Give every pipeline step its own runner job id so sibling steps in one run can't read
  back each other's results.

  Every container step of a run was dispatched and polled under the bare execution id,
  which is ALSO the per-run container's address. The harness keys its per-kind job
  registries by that id and `GET /jobs/{id}` checks them in a fixed order, so two steps
  that ran close enough together to share the still-warm container collided: a poll for
  one step returned another step's finished result. The visible symptom was an
  `architect` (`/explore`) step returning the `spec-writer`'s (`/spec`) document verbatim
  with no model call of its own — and, latently, `blueprints`/`mocker` reading back the
  `coder`'s result.

  The fix separates the two conflated identifiers into an explicit `RunnerJobRef`:

  - **`runId`** — the run (execution). On backends that share one container across a run
    (the Cloudflare per-run Container, the local Docker container) this addresses that
    container, and `release` reclaims it.
  - **`jobId`** — the job itself, now UNIQUE PER STEP (`<executionId>-<agentKind>`). The
    harness registers and polls each step's job by it, so siblings never alias.

  `RunnerTransport.dispatch`/`poll`/`release` and `RunnerJobClient` now take the ref;
  `AgentJobHandle` carries the `runId` so the poll/stop site can re-address the per-run
  container. The Cloudflare and local transports key the container by `runId` (one
  container per run, reclaimed as a unit) and read the harness job by the per-step
  `jobId`; a self-hosted pool, being per-job, keys on `jobId` (which already kept its
  steps distinct). Single-job flows (repo bootstrap/scan) use the same value for both.
  The engine reclaims a run by its id and passes the in-flight step's job id so a pool can
  cancel exactly it.

  Breaking: `RunnerTransport` implementers now receive a `RunnerJobRef` instead of a bare
  job-id string. The local container label moves from `cat-factory.jobId` to
  `cat-factory.runId`.

- 311a110: Requirements review: dedicated window + iterative convergence loop, and a universal
  result-view seam.

  The pipeline's `requirements-review` gate step no longer runs as a prose agent behind the
  generic approve/reject panel. It now drives the purpose-built structured review window: the
  reviewer raises findings (each with a severity), the human answers or dismisses them, an
  incorporation companion folds the answers into one standard-format document, and the
  reviewer re-reviews that document. The cycle repeats until the reviewer converges (or every
  remaining finding is dismissed). The human can reject a bad merge and redo the incorporation
  with a freeform "do it differently" comment.

  Two new per-task knobs live on the merge-threshold preset:

  - `maxRequirementIterations` (default 3) — reviewer passes allowed before the run stops on
    its own and the human picks: one more round / proceed anyway (with the last incorporated
    document) / stop and reset the task to phase zero (editable; the last incorporated
    document stays on the inspector as a base).
  - `maxRequirementConcernAllowed` (default `none`) — when every outstanding finding is at or
    below this severity, the findings are recorded but the run advances automatically (no
    human gate, companion skipped).

  Frontend gains a UNIVERSAL result-view seam: an agent archetype can declare a `resultView`
  id and register a window component, and the renderer dispatches to it instead of the generic
  prose panel — requirements review is the first consumer, not a hardcoded special case.

  Breaking (pre-1.0, acceptable): the requirements-rework quality-companion gate is removed
  (convergence is now reviewer-driven), so `RequirementReview` drops `companionVerdicts` and
  gains `iteration`/`maxIterations` and the `merged`/`exceeded` statuses; the
  `requirement_reviews` and `merge_threshold_presets` tables change shape on both runtimes
  (D1 migration `0044` ⇄ a generated Drizzle migration — additive `ALTER`s: `companion` is
  dropped, the new columns take defaults, so existing rows are not lost but their old review
  state is re-created on the next run).

- de5a9d7: Add configurable Slack notifications as an additional delivery transport for the
  existing notification mechanism (merge_review / pipeline_complete / ci_failed) —
  not a parallel system. A new `SlackNotificationChannel` implements the same
  `NotificationChannel` port the in-app channel does and is composed alongside it via
  `CompositeNotificationChannel`, so the engine call sites that raise notifications
  are untouched.

  Two scopes, mirroring the GitHub-App precedent:

  - The Slack **connection** (the installed team + its bot token) is bound
    **per-account**. The bot token is multi-tenant data, so it is encrypted at rest
    with `WebCryptoSecretCipher` (HKDF tag `cat-factory:slack`) and never returned on
    the wire — only safe metadata (team name/icon, bot user, scopes) is exposed.
    Onboarding is UI-based: a full OAuth "Add to Slack" flow when the app credentials
    are configured (`SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`/`SLACK_REDIRECT_URL`),
    with manual bot-token paste always available as a fallback.
  - Notification **routing** (which types post, to which channel) is configured
    **per-workspace**.
  - Optional **@-mentions** are **role- and audience-aware**, not a workspace
    broadcast. The per-account member map tags each member `product` or `engineering`,
    and each notification type mentions a specific audience: requirement-review
    findings ping **product** people **plus the task's creator**, while the engineering
    notifications (merge_review / pipeline_complete / ci_failed) ping **only the task's
    creator**. This adds a `requirement_review` notification type (raised by the
    requirements reviewer when it produces findings) and records a `createdBy` on
    blocks (a new nullable column on both runtimes), captured from the authenticated
    user at task creation.

  New surface: the `slack` contracts, the kernel Slack repository ports, the
  `@cat-factory/integrations` Slack module (`SlackNotificationChannel`,
  `SlackConnectionService`, `SlackSettingsService`, `SlackMemberMappingService`,
  `SlackApiClient`), the shared `SlackController` (+ public OAuth callback) and
  `SlackConfig`, and the orchestration `SlackModule`. Persisted on **both** runtimes:
  the Cloudflare D1 tables (migration `0037_slack.sql`) and the Node Postgres tables
  (Drizzle schema + generated migration), with both facades wiring the channel +
  management module. The cross-runtime conformance suite asserts the routing and
  member-map persistence parity on both stores.

  This change also closes a pre-existing parity gap: the Node/Drizzle facade now has
  a `notifications` table + `DrizzleNotificationRepository` and wires
  `notificationRepository`, so the notification subsystem — and any channel composed
  onto it — fires on the Node runtime exactly as on the Worker.

  Opt-in via `SLACK_ENABLED=true` (requires `ENCRYPTION_KEY`); off by default, so
  unconfigured deployments are unaffected.

- e0230a0: Surface the real reason a run failed instead of a generic "the implementation container
  reported a failure", and stop the cross-runtime conformance suite from hiding driver bugs.

  - **Fix the clobbered failure record.** Two inline gates that already knew the precise
    failure — an unparseable companion (Spec Reviewer) verdict (`companion_rejected`, with
    the companion's raw reply as the detail) and a Tester gate that exhausted its fixer
    budget (`agent`) — recorded a rich `failRun` AND then returned `job_failed`. The durable
    driver (Cloudflare `ExecutionWorkflow` / Node `driveExecution`) treated `job_failed` as
    "fail the run" and fired a SECOND `failRun`, overwriting the good record with a generic
    one: kind `job_failed`, message the literal `"companion_rejected"`, no detail, and the
    misleading "inspect the container logs" hint. Those gates now RETURN the classification +
    detail on the `job_failed` result (`failureKind`/`detail` on `AdvanceResult`), and the
    driver funnels them through the single `failRun` — so the board shows the actual message,
    the precise kind/hint, and the raw reply under "Show detail".

  - **`failRun` is now idempotent.** A run already in a terminal `failed` state keeps its
    first (richest) failure rather than being overwritten, so no future
    record-then-return-`job_failed` path can clobber it.

  - **Share the production driver loop.** The runtime-neutral per-run driver
    (`driveExecution`) moved into `@cat-factory/orchestration` and is now exported; the Node
    service injects a real `setTimeout` sleep, the Cloudflare workflow wraps the same
    advance/poll calls in durable steps. The cross-runtime conformance harnesses no longer
    hand-roll their own advance/poll loop (which never re-called `failRun` on `job_failed`,
    the gap that let this ship) — both drive runs through the SAME `driveExecution` via a
    shared `driveWorkspace` helper, so the suite exercises real production driving logic. The
    companion-rejected conformance assertion now checks the rich message + stored detail.

- Updated dependencies [fe53445]
- Updated dependencies [8eed38c]
- Updated dependencies [d94e75c]
- Updated dependencies [6406c8c]
- Updated dependencies [e0e89a7]
- Updated dependencies [3d9a9d8]
- Updated dependencies [db77061]
- Updated dependencies [28d3c28]
- Updated dependencies [a48c620]
- Updated dependencies [3bc8c79]
- Updated dependencies [9d3a956]
- Updated dependencies [8d11833]
- Updated dependencies [ad9ba9e]
- Updated dependencies [3e0d753]
- Updated dependencies [f83ffd7]
- Updated dependencies [3e7ab89]
- Updated dependencies [8065fed]
- Updated dependencies [385bd93]
- Updated dependencies [4ee8a4b]
- Updated dependencies [e50e78a]
- Updated dependencies [0972696]
- Updated dependencies [b48c455]
- Updated dependencies [e9b9356]
- Updated dependencies [8eed38c]
- Updated dependencies [e8005ba]
- Updated dependencies [3a12f15]
- Updated dependencies [3a12f15]
- Updated dependencies [8eed38c]
- Updated dependencies [b40da13]
- Updated dependencies [3a12f15]
- Updated dependencies [ec0c416]
- Updated dependencies [8eed38c]
- Updated dependencies [084bf43]
- Updated dependencies [14840ec]
- Updated dependencies [268c15d]
- Updated dependencies [c9d3f49]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
- Updated dependencies [157cd02]
- Updated dependencies [794b628]
- Updated dependencies [7c37653]
- Updated dependencies [db77061]
- Updated dependencies [f49fa30]
- Updated dependencies [6406c8c]
- Updated dependencies [57d70fa]
- Updated dependencies [1a0686f]
- Updated dependencies [6406c8c]
- Updated dependencies [918764f]
- Updated dependencies [918764f]
- Updated dependencies [88b3170]
- Updated dependencies [fe0b7f8]
- Updated dependencies [f73652c]
- Updated dependencies [db336b1]
- Updated dependencies [f9d3647]
- Updated dependencies [8807f5c]
- Updated dependencies [7a9cabf]
- Updated dependencies [f0a847d]
- Updated dependencies [0b21ff3]
- Updated dependencies [9c9c1b5]
- Updated dependencies [9be11e1]
- Updated dependencies [5ec0d25]
- Updated dependencies [197264e]
- Updated dependencies [a691853]
- Updated dependencies [f066c59]
- Updated dependencies [c664fe6]
- Updated dependencies [8eed38c]
- Updated dependencies [7d5e060]
- Updated dependencies [75bd29d]
- Updated dependencies [8eed38c]
- Updated dependencies [4a08935]
- Updated dependencies [2796a42]
- Updated dependencies [6406c8c]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [b287996]
- Updated dependencies [b156b4b]
- Updated dependencies [f49fa30]
- Updated dependencies [5c8ca33]
- Updated dependencies [b156b4b]
- Updated dependencies [7cf2a2d]
- Updated dependencies [2d66d34]
- Updated dependencies [197264e]
- Updated dependencies [1a0686f]
- Updated dependencies [3a12f15]
- Updated dependencies [861d363]
- Updated dependencies [8eed38c]
- Updated dependencies [37baa7f]
- Updated dependencies [c664fe6]
- Updated dependencies [553a67d]
- Updated dependencies [b80d657]
- Updated dependencies [4026793]
- Updated dependencies [311a110]
- Updated dependencies [f16ae62]
- Updated dependencies [ba1c0cf]
- Updated dependencies [36018cb]
- Updated dependencies [799be66]
- Updated dependencies [cc39497]
- Updated dependencies [d65c979]
- Updated dependencies [75a0441]
- Updated dependencies [7157fd7]
- Updated dependencies [21ca647]
- Updated dependencies [c4ef995]
- Updated dependencies [8eed95b]
- Updated dependencies [0b38aa6]
- Updated dependencies [861d363]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
- Updated dependencies [a97e485]
- Updated dependencies [de5a9d7]
- Updated dependencies [f647733]
- Updated dependencies [d5e9141]
- Updated dependencies [2dd7e56]
- Updated dependencies [2d66d34]
- Updated dependencies [86a5843]
- Updated dependencies [a54ada2]
- Updated dependencies [e0f21a0]
- Updated dependencies [2dd7e56]
- Updated dependencies [5ca8086]
- Updated dependencies [d0697d1]
- Updated dependencies [e0230a0]
- Updated dependencies [0090313]
- Updated dependencies [7dc8e57]
- Updated dependencies [cc8d96a]
- Updated dependencies [7c37653]
- Updated dependencies [43f2443]
- Updated dependencies [acac735]
- Updated dependencies [b98923c]
- Updated dependencies [3841315]
- Updated dependencies [48d2f0d]
- Updated dependencies [3e6a844]
  - @cat-factory/contracts@0.7.0
  - @cat-factory/orchestration@0.7.0
  - @cat-factory/node-server@0.7.0
  - @cat-factory/server@0.7.0
  - @cat-factory/kernel@0.7.0
  - @cat-factory/agents@0.7.0
