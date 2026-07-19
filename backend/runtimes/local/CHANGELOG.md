# @cat-factory/local-server

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

  This lets a deployment that registers a custom environment/runner backend by reference (e.g. a
  Kargo ephemeral-environment provider) call `startLocal()` — and inherit its boot preflights
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
    ship one package implementing `EnvironmentProvider` + `RunnerPoolProvider` (e.g. Kargo) to
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
  hand-written `EnvironmentProvider` (e.g. a Kargo adapter) instead of the generic
  manifest-driven `HttpEnvironmentProvider` — with per-workspace config and the supported
  local-mode entry point.

  - **Manifest `providerConfig` bag** (`@cat-factory/contracts`): `environmentManifestSchema`
    gains an optional, opaque `providerConfig: Record<string, unknown>`. The generic
    `HttpEnvironmentProvider` ignores it; a native adapter reads + validates it off the
    per-call `manifest`. Because an injected provider is a deployment-wide singleton, the
    per-workspace connection's manifest is its only per-workspace config carrier — so a
    single deployment can now target a different native project (Kargo project, link key,
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
    adapter dependency, and a reference `KargoEnvironmentProvider` sketch.

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
