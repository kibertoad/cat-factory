# @cat-factory/server

## 0.93.0

### Minor Changes

- f596090: Record successful step outputs in the step-detail "execution history", not just failures.

  A restart-from-step resets the chosen step and every later one, dropping their `output`;
  previously that successful work was lost and the per-step history could only ever show
  errors. The run now keeps an `outputHistory` — the positive complement of `failureHistory`
  — capturing the successful outputs a restart superseded (attributed by step index, bounded
  in count + per-entry size, riding the run's `detail` JSON with no schema migration). The
  step-detail overlay renders a merged, newest-first timeline of these superseded outputs and
  the failed attempts. A plain retry (which re-runs only unfinished steps) records nothing.

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/contracts@0.110.0
  - @cat-factory/kernel@0.101.0
  - @cat-factory/orchestration@0.83.0
  - @cat-factory/agents@0.40.4
  - @cat-factory/integrations@0.73.4
  - @cat-factory/prompt-fragments@0.10.17
  - @cat-factory/spend@0.11.1

## 0.92.0

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
  - @cat-factory/spend@0.11.0
  - @cat-factory/orchestration@0.82.0
  - @cat-factory/agents@0.40.3
  - @cat-factory/integrations@0.73.3
  - @cat-factory/prompt-fragments@0.10.16

## 0.91.0

### Minor Changes

- e66accb: Stack recipes & shared stacks (slice 7): make the Deployer the sole docker-compose provisioner + the environment setup wizard scaffolding.

  **Deployer becomes the single docker-compose provisioner (the compose-centralization follow-up owed by this slice).** Now that the setup wizard can save a `docker-compose` handler, docker-compose is provisioned by the single Deployer step through a workspace handler, exactly like `kubernetes`/`custom` — the in-container (DinD) bring-up is retired from the run-mode decision:

  - `decideTesterInfra` (`tester-infra.logic.ts`): `docker-compose` is handler-based (drops the `localTestInfraSupported`/`hasComposePath` inputs and the `limited-local`/`compose-unconfigured` reasons).
  - `needsDeployerBeforeConsumer` + `ExecutionService.assertTesterInfraConfigured`'s `needsHandler` now cover `docker-compose`, so a compose chain that reaches a tester with no resolvable handler is refused at run start (fail-fast, same as k8s/custom) instead of dead-ending.
  - `testerInfraSpec` (`@cat-factory/server`): `docker-compose` targets the Deployer-provisioned env (`environment: 'ephemeral'`); the `local`/`composePath` branch is gone.
  - (The harness's in-container `docker compose up` is now unreachable and retired in a later image-bumping slice.)

  **Environment setup wizard.** The guided detect → review → preflight → save flow the compose-centralization depends on: `EnvironmentSetupWizard.vue` (stepper shell over the `environmentWizard` store — detection, opt-in deep analysis via `pl_environment_analysis` with live provenance-merged review, compose-file/profile/seed candidate pickers, a raw-recipe editor, the preflight checklist, save the workspace compose handler + the frame recipe, and an optional trial provision with live provisioning logs), a docker-compose service-inspector nudge, a SideBar entry, the mount in `pages/index.vue`, and the `environmentWizard` i18n namespace across all 8 locales. Backed by the `preflights` API + store (`POST /workspaces/:ws/preflights/run`) and the `provisionEnvironment` API. (The `data-testid`-only e2e spec is deferred — it needs a fake `ProvisioningRepoReader` e2e seam so detection returns a canned recommendation with GitHub off; tracked in the slice-7 checklist.)

  Breaking (pre-1.0, acceptable): a `docker-compose` service reaching a tester/human-test with no configured compose handler is now refused at run start rather than falling back to an in-container compose bring-up.

  Review follow-ups in the same slice: the `environmentWizard` store now fully resets per-frame state when re-targeted (`selectFrame` no longer leaves a prior frame's `saved`/service/port behind), resolves the analyst run by preferring a live/succeeded instance over a bare `.at(-1)` (so a retry's dead predecessor can't mask the successful run), validates the exposed port before registering the handler, and surfaces a real (non-503) preflight failure instead of swallowing it. The now-dead `localTestInfraSupported` dependency (its only reads were removed with the DinD path) is dropped from `CoreDependencies`/`ExecutionService` and the local facade's wiring, and the stale DinD doc comments on `assertTesterInfraConfigured` / `testerInfraSpec` are corrected.

### Patch Changes

- Updated dependencies [e66accb]
  - @cat-factory/orchestration@0.81.0
  - @cat-factory/contracts@0.108.1
  - @cat-factory/agents@0.40.2
  - @cat-factory/integrations@0.73.2
  - @cat-factory/kernel@0.99.1
  - @cat-factory/prompt-fragments@0.10.15
  - @cat-factory/spend@0.10.109

## 0.90.3

### Patch Changes

- Updated dependencies [9cc02a0]
  - @cat-factory/integrations@0.73.1
  - @cat-factory/orchestration@0.80.1

## 0.90.2

### Patch Changes

- Updated dependencies [1afa003]
- Updated dependencies [f91b99d]
  - @cat-factory/kernel@0.99.0
  - @cat-factory/orchestration@0.80.0
  - @cat-factory/integrations@0.73.0
  - @cat-factory/contracts@0.108.0
  - @cat-factory/agents@0.40.1
  - @cat-factory/spend@0.10.108
  - @cat-factory/prompt-fragments@0.10.14

## 0.90.1

### Patch Changes

- Updated dependencies [eef8612]
- Updated dependencies [bf31df7]
  - @cat-factory/integrations@0.72.1
  - @cat-factory/contracts@0.107.0
  - @cat-factory/agents@0.40.0
  - @cat-factory/kernel@0.98.0
  - @cat-factory/orchestration@0.79.1
  - @cat-factory/prompt-fragments@0.10.13
  - @cat-factory/spend@0.10.107

## 0.90.0

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
  - @cat-factory/agents@0.39.4
  - @cat-factory/prompt-fragments@0.10.12
  - @cat-factory/spend@0.10.106

## 0.89.0

### Minor Changes

- 5490103: Surface web search on container agent run details, and store/display performed search queries as telemetry.

  - Container steps now carry a `search` availability fact (`{ available, provider }`), resolved backend-side at dispatch from the run's account web-search keys (else the deployment default). The observability drill-down shows whether web search was available and which provider (Brave / SearXNG) served the run — a static per-run fact, not gated by prompt-recording.
  - New `agent_search_queries` telemetry sink records every web search a container agent performs through the backend search proxy (query, provider, result count), gated by the same double switch as agent-context snapshots (`LLM_RECORD_PROMPTS` + the workspace `storeAgentContext` setting) and pruned on the same telemetry retention window. Mirrored across the D1 (Cloudflare) and Drizzle/Postgres (Node) stores with a cross-runtime conformance suite, and surfaced on demand via `GET /workspaces/:ws/executions/:executionId/search-queries` in a new "Web search" observability view.

### Patch Changes

- e5b9462: Show a step's failure trail on its step-detail overlay. The step-detail overlay now has an "Execution history" toggle that reveals the prior failed attempts recorded for that specific step (plus the current failure when the run is presently failed at it): the run-level "previous errors" history narrowed to one step. Each `AgentFailure` now carries the `stepIndex` it failed at (stamped by the engine's failure funnel), so the trail can be attributed per step.
- Updated dependencies [5490103]
- Updated dependencies [e5b9462]
- Updated dependencies [dd6df12]
  - @cat-factory/contracts@0.105.0
  - @cat-factory/kernel@0.96.0
  - @cat-factory/orchestration@0.78.0
  - @cat-factory/integrations@0.71.0
  - @cat-factory/agents@0.39.3
  - @cat-factory/prompt-fragments@0.10.11
  - @cat-factory/spend@0.10.105

## 0.88.0

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
  - @cat-factory/orchestration@0.77.0
  - @cat-factory/agents@0.39.2
  - @cat-factory/integrations@0.70.1
  - @cat-factory/prompt-fragments@0.10.10
  - @cat-factory/spend@0.10.104

## 0.87.0

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
  - @cat-factory/agents@0.39.1
  - @cat-factory/prompt-fragments@0.10.9
  - @cat-factory/spend@0.10.103

## 0.86.0

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

## 0.85.0

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
  - @cat-factory/agents@0.39.0
  - @cat-factory/integrations@0.69.1
  - @cat-factory/kernel@0.93.0
  - @cat-factory/orchestration@0.75.0
  - @cat-factory/contracts@0.102.0
  - @cat-factory/spend@0.10.102
  - @cat-factory/prompt-fragments@0.10.8

## 0.84.3

### Patch Changes

- Updated dependencies [029a689]
- Updated dependencies [029a689]
  - @cat-factory/contracts@0.101.1
  - @cat-factory/integrations@0.69.0
  - @cat-factory/kernel@0.92.0
  - @cat-factory/agents@0.38.2
  - @cat-factory/orchestration@0.74.3
  - @cat-factory/prompt-fragments@0.10.7
  - @cat-factory/spend@0.10.101

## 0.84.2

### Patch Changes

- Updated dependencies [f6399cf]
  - @cat-factory/integrations@0.68.0
  - @cat-factory/orchestration@0.74.2

## 0.84.1

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/contracts@0.101.0
  - @cat-factory/kernel@0.91.0
  - @cat-factory/agents@0.38.1
  - @cat-factory/integrations@0.67.1
  - @cat-factory/orchestration@0.74.1
  - @cat-factory/prompt-fragments@0.10.6
  - @cat-factory/spend@0.10.100

## 0.84.0

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
  - @cat-factory/prompt-fragments@0.10.5
  - @cat-factory/spend@0.10.99

## 0.83.2

### Patch Changes

- Updated dependencies [3981bbb]
  - @cat-factory/contracts@0.99.0
  - @cat-factory/agents@0.37.2
  - @cat-factory/integrations@0.66.1
  - @cat-factory/kernel@0.89.1
  - @cat-factory/orchestration@0.73.1
  - @cat-factory/prompt-fragments@0.10.4
  - @cat-factory/spend@0.10.98

## 0.83.1

### Patch Changes

- Updated dependencies [cfcb6c7]
- Updated dependencies [48f9d97]
  - @cat-factory/kernel@0.89.0
  - @cat-factory/contracts@0.98.0
  - @cat-factory/orchestration@0.73.0
  - @cat-factory/integrations@0.66.0
  - @cat-factory/agents@0.37.1
  - @cat-factory/spend@0.10.97
  - @cat-factory/prompt-fragments@0.10.3

## 0.83.0

### Minor Changes

- f4c321e: feat(documents): add the `doc-quality` gate (WS4) to the forward document pipelines

  A new deterministic polling gate `doc-quality`, authored through the public `registerGate`
  seam in `@cat-factory/gates`, is inserted into `pl_document` (after `doc-finalizer`) and
  `pl_document_quick` (after `doc-reviewer`). It reads the drafted document on the PR head
  checkout-free via a new `DocQualityProvider` (wired per facade over `RepoFiles`) and checks
  — against the WS1 template (`docTemplateFor`, the single source of truth) — that every
  required section is present, no leftover placeholders remain, the heading hierarchy is sane,
  and in-repo relative links resolve. On a red verdict it escalates to a new `doc-fixer`
  container helper that repairs the document on the PR branch; a green document advances with
  nothing spun up. Both doc pipelines' `version` is bumped (reseed offer).

### Patch Changes

- Updated dependencies [f4c321e]
  - @cat-factory/kernel@0.88.0
  - @cat-factory/agents@0.37.0
  - @cat-factory/integrations@0.65.3
  - @cat-factory/orchestration@0.72.1
  - @cat-factory/spend@0.10.96

## 0.82.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [13a284f]
  - @cat-factory/kernel@0.87.0
  - @cat-factory/agents@0.36.0
  - @cat-factory/orchestration@0.72.0
  - @cat-factory/integrations@0.65.2
  - @cat-factory/spend@0.10.95

## 0.81.1

### Patch Changes

- Updated dependencies [102c049]
  - @cat-factory/contracts@0.97.0
  - @cat-factory/agents@0.35.0
  - @cat-factory/integrations@0.65.1
  - @cat-factory/kernel@0.86.1
  - @cat-factory/orchestration@0.71.1
  - @cat-factory/prompt-fragments@0.10.2
  - @cat-factory/spend@0.10.94

## 0.81.0

### Minor Changes

- 49b498a: Bug-triage pipeline, Phase D — issue-intake foundations (ports + persistence).

  The plumbing the upcoming `bug-intake` step (Phase E) drives: a predicate search across the
  three task-source vendors, the per-schedule intake configuration, the "taken by cat-factory"
  pickup writeback, and the replace-link that keeps a recurring block's issue context from
  accumulating across fires. No engine step yet — this phase is ports, vendor implementations,
  and persistence only.

  - **`TaskSourceProvider.searchIssues` + `IssueIntakeQuery`** (kernel port): open issues on one
    vendor board matching every predicate (title fragment / labels / issue type), oldest-first,
    deduped against the already-worked exclusion list. Predicates are pushed into the vendor
    query wherever expressible — Jira compiles ONE JQL (`statusCategory != Done`, `issuetype`,
    `labels`, `summary ~`, `issuekey NOT IN`, `ORDER BY created ASC`; excluded ids validated
    against the key shape so a malformed id can't inject), GitHub compiles search qualifiers
    (`repo:` `is:open` `type:` `label:` `in:title`, the title fragment quoted as a literal phrase
    so it can't inject a qualifier) with the API's `created-asc` sort (a new `order` param on
    `GitHubClient.searchIssues`, honoured by the GitLab-backed client too) and filters the
    exclusion list case-insensitively from a bounded, paged overscan, Linear compiles a GraphQL
    `IssueFilter` (team, state type not completed/canceled, per-label `labels.some`,
    `title.containsIgnoreCase`) asked for oldest-created-first, also paged so a run of
    already-worked issues at the front can't starve the pickup.
  - **`PipelineSchedule.issueIntake`** (contracts + both runtimes, kept symmetric): the
    schedule-scoped intake config (`source`, per-vendor `board` scope, `predicates`, the GitHub
    `inProgressLabel`) as a new `pipeline_schedules.issue_intake` JSON column — D1 migration
    `0038_schedule_issue_intake.sql` ⇄ Drizzle schema + generated migration — parsed/serialized
    by shared `@cat-factory/server` mapper helpers so the column can't drift, accepted on
    schedule create/update (PATCH is tri-state: omitted = unchanged, null = clear), and pinned
    by a cross-runtime conformance round-trip. Requiring it when the pipeline carries a
    `bug-intake` step is Phase E's schedule validation.
  - **`IssueWritebackProvider.onIssuePickedUp`**: comments "Taken by cat-factory" (+ run link)
    on the block's linked issue(s) and marks them in-progress — Jira transitions into the
    `indeterminate` status category (`pickDoneTransition` generalized into
    `pickTransitionByCategory`), Linear transitions to the team's `started` state (the Linear
    state pickers generalized into `pickStateIdByType`), GitHub applies the schedule's
    `inProgressLabel` (default `in-progress`) via a new `GitHubClient.applyIssueLabel` that
    creates the label — with the required colour — when absent.
    Best-effort per issue like the existing hooks, and deliberately NOT gated on the workspace
    writeback settings — claiming the issue is intake semantics. Wired in both facades.
  - **`TaskLinkService.replaceForBlock`** + `TaskRepository.unlinkAllFromBlock`: detach every
    issue linked to the reused block in ONE batched write (D1 ⇄ Drizzle), then link the newly
    picked issue — so linked context never accumulates across recurring fires.

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

- c20a69a: feat(initiatives): slice 4 — follow-ups & polish

  Complete the Initiatives feature: a settling spawned-task run's forward-looking
  follow-ups (and, on failure, its real cause) are harvested onto the initiative
  tracker at the terminal emit; a human promotes an open follow-up into a new
  `pending` tracker item or dismisses it, retries/skips/re-scopes items, and retunes
  the execution policy — all over the existing rev-CAS single-writer path. No new
  persistence or facade wiring: the curation state rides the initiative `doc` blob
  (D1 ⇄ Drizzle parity unchanged), and the harvest reuses the in-hand run instance
  so it costs no extra read.

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
- 49b498a: Service connections Phase 4 (= bug-triage Phase C) — multi-PR gates + merge-all. The `ci`,
  `conflicts` and `merger` tail now operate across ALL of a multi-repo task's pull requests
  (own-service + peer-service repos from Phase 3), not just the own PR — no runner-image change
  (the ci-fixer reuses the existing sibling-checkout harness path via a widened `peerRepos` job
  body).

  - **CI gate** aggregates check runs across every PR: a red check in ANY repo fails the gate,
    the failing repo(s) are named, and `step.gate.headShas` tracks each PR head. The `ci-fixer`
    helper now fans out across the sibling checkouts (the `coder`-only multi-repo dispatch is
    widened to `ci-fixer`) so one fixer round covers every failing repo. `CiStatusReport` becomes
    per-PR (`repos: RepoCiStatus[]`).
  - **Conflicts gate** probes mergeability per PR (`MergeabilityReport.repos`); any PR still
    computing keeps polling, the first conflicted repo is recorded on `step.gate.conflictTarget`.
    The conflict-resolver stays single-repo.
  - **Merger** merges every PR in provider-before-consumer order (`orderPrsForMerge`), stopping at
    the first failure. The task is `done` only when ALL PRs merged; a mid-sequence failure
    (cross-repo merges are non-atomic) leaves the block `blocked` and raises an enumerated
    `merge_review` notification (`payload.mergedRepos` / `unmergedRepos`, decision reason
    `merge_partial`). `PullRequestMerger.mergeForBlock` becomes `mergePullRequests(prs)` returning
    a `MergeAllOutcome`.
  - Cross-runtime conformance asserts multi-repo CI aggregation + escalation on both runtimes;
    the merge-all ordering + provider fan-out are unit-tested.
  - A partially-merged multi-repo task (block left `blocked`) is now replay-idempotent: a
    durable-driver retry no longer re-merges the already-merged PRs (which threw and downgraded
    the block to `pr_ready` + raised a duplicate card).
  - A conflict on a PEER repo no longer burns the conflict-resolver attempt budget on the
    own-repo resolver (which can't reach it): the gate declines escalation (`GateProbe.escalatable`)
    and goes straight to the manual-resolution give-up. Own-repo conflicts are unchanged.

### Patch Changes

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
  - @cat-factory/agents@0.34.0
  - @cat-factory/prompt-fragments@0.10.1
  - @cat-factory/spend@0.10.93

## 0.80.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [1f6d9fc]
  - @cat-factory/kernel@0.85.0
  - @cat-factory/integrations@0.64.0
  - @cat-factory/orchestration@0.70.1
  - @cat-factory/agents@0.33.1
  - @cat-factory/spend@0.10.92

## 0.79.4

### Patch Changes

- Updated dependencies [8eaa3f2]
  - @cat-factory/prompt-fragments@0.10.0
  - @cat-factory/agents@0.33.0
  - @cat-factory/orchestration@0.70.0

## 0.79.3

### Patch Changes

- Updated dependencies [e5ddaa4]
- Updated dependencies [6213771]
  - @cat-factory/kernel@0.84.0
  - @cat-factory/integrations@0.63.0
  - @cat-factory/agents@0.32.0
  - @cat-factory/orchestration@0.69.1
  - @cat-factory/spend@0.10.91

## 0.79.2

### Patch Changes

- Updated dependencies [9bac054]
  - @cat-factory/kernel@0.83.0
  - @cat-factory/agents@0.31.0
  - @cat-factory/orchestration@0.69.0
  - @cat-factory/integrations@0.62.1
  - @cat-factory/spend@0.10.90

## 0.79.1

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/contracts@0.95.0
  - @cat-factory/kernel@0.82.0
  - @cat-factory/integrations@0.62.0
  - @cat-factory/agents@0.30.5
  - @cat-factory/orchestration@0.68.1
  - @cat-factory/prompt-fragments@0.9.55
  - @cat-factory/spend@0.10.89

## 0.79.0

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
  - @cat-factory/orchestration@0.68.0
  - @cat-factory/agents@0.30.4
  - @cat-factory/prompt-fragments@0.9.54
  - @cat-factory/spend@0.10.88

## 0.78.0

### Minor Changes

- ef57cb1: Bug-triage pipeline, Phase A — pipeline `availability` (one-off / recurring / both).

  A library pipeline can now declare HOW it may be launched, so a recurring-only pipeline (the
  upcoming `pl_bug_triage`) can't be started as a manual one-off, and a one-off-only pipeline can't
  be attached to a schedule. Absent means `'both'` (unrestricted) — pre-1.0, no migration/back-fill,
  existing rows read unchanged.

  - **Contract**: `pipelineSchema` gains `availability?: 'one-off' | 'recurring' | 'both'` (+ the
    `PipelineAvailability` type, re-exported from kernel); `createPipeline`/`updatePipeline` accept
    and persist it.
  - **Persistence** (both runtimes, kept symmetric): `availability` is a new `pipelines.availability`
    column — D1 migration `0037_pipeline_availability.sql` ⇄ Drizzle schema + generated migration —
    read/written by the shared `rowToPipeline` mapper and both repos, so the field round-trips
    instead of being silently dropped on save.
  - **Server enforcement** (the pickers are convenience, not the gate): `ExecutionService.start`
    gains an `origin: 'manual' | 'recurring'` option (default `'manual'`), and a start-only
    `assertPipelineLaunchable` gate rejects a manual start of a recurring-only pipeline (and a
    scheduled fire of a one-off-only one). `RecurringPipelineService.fire` passes `'recurring'`; its
    `create`/`update` reject attaching a one-off-only pipeline to a schedule. A retry/restart
    re-drives an already-validated run, so it never re-checks the launch constraint. A pipeline
    carrying an ENABLED `bug-intake` step must be `'recurring'` (validated at builder save + start;
    a disabled step imposes no requirement). The schedule-attach check delegates to the same gate
    (one rule, one `ValidationError`), and `clone` re-runs it so an un-launchable copy can't be
    minted. Editing a pipeline to `'one-off'` while a schedule still references it is rejected
    (`ConflictError`) rather than silently breaking every future fire.
  - **SPA pickers**: the manual-start surfaces (add-task modal, board/inspector Run menus, task
    run-settings default) filter out `'recurring'`-only pipelines, and the recurring-pipeline modal
    filters out `'one-off'`-only ones — composed with the existing `pipelineAllowedForFrame`
    predicate.

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/contracts@0.93.0
  - @cat-factory/kernel@0.80.0
  - @cat-factory/orchestration@0.67.0
  - @cat-factory/agents@0.30.3
  - @cat-factory/integrations@0.60.2
  - @cat-factory/prompt-fragments@0.9.53
  - @cat-factory/spend@0.10.87

## 0.77.0

### Minor Changes

- 1d738f7: feat(recurring): on-demand (manual-only) recurring tasks that can use individual-usage subscriptions

  A recurring pipeline can now be flagged **on-demand**: it has no cadence and is never
  fired by the sweeper — it runs ONLY when a person triggers it via "run now". Because a
  human is present at every fire, an on-demand schedule's block MAY target an individual-usage
  subscription model (Claude / Codex / GLM), unlocked per run-now with the initiator's personal
  password exactly like a manual task start. A cadence schedule still refuses individual-usage
  models (no one is present to unlock them unattended).

  - New `onDemand` flag on `PipelineSchedule` + `createScheduleSchema` (recurrence is now
    optional — an on-demand schedule needs none). Persisted as an `on_demand` column on both
    runtimes (D1 migration `0037` ⇄ Drizzle), with `listDue` filtering `on_demand = 0` so the
    sweeper skips them. Cross-runtime conformance asserts the flag round-trips and run-now fires.
  - `RecurringPipelineService.fire` exempts on-demand schedules from the individual-usage
    refusal and threads the run-now initiator + credential-activation closure into the run;
    the run-now controller resolves the personal-credential gate (428 when a password is needed).
  - Frontend: an "on-demand" toggle in the add-recurring modal (hides the cadence editor), an
    on-demand inspector view (no cadence/pause, just run-now), and run-now now rides the cached
    personal password through the credential modal. i18n in all 8 locales.

### Patch Changes

- Updated dependencies [1d738f7]
  - @cat-factory/contracts@0.92.0
  - @cat-factory/orchestration@0.66.0
  - @cat-factory/agents@0.30.2
  - @cat-factory/integrations@0.60.1
  - @cat-factory/kernel@0.79.1
  - @cat-factory/prompt-fragments@0.9.52
  - @cat-factory/spend@0.10.86

## 0.76.0

### Minor Changes

- 47a2975: Initiatives slice 3 — the execution loop.

  An approved initiative plan now RUNS: a new `InitiativeLoopService` drives each `executing`
  initiative — reconciling its spawned tasks, spawning the next wave just-in-time, and completing
  the initiative once every tracker item settles.

  - **The loop** (`orchestration/modules/initiative/InitiativeLoopService.ts`): per-initiative
    `tick` = reconcile (fold each spawned task block's status back onto its item — done + PR link /
    `pr_open` / `blocked` + deviation, one batched block read, no N+1) → complete (all items settled
    → initiative + anchor block `done`, tracker re-commit, notify) → spawn (create task blocks for
    the eligible `pending` items — current phase, deps met, phase not halted — up to the concurrency
    cap, each pipeline chosen by the policy's estimate→pipeline rules). Spawning is CLAIM-FIRST (a
    rev-CAS write records the pre-generated block id before any side effect), so a concurrent ticker
    never orphans a double-spawn. A per-service task-limit conflict leaves the item `pending` for the
    next sweep; a missing pipeline (deleted after ingest) records a deviation + notification and
    blocks the item — the sweep never throws.
  - **Blocked = halt the phase, notify.** A blocked item stops new spawns in its phase (and keeps the
    phase current, so the initiative never advances past it) and raises the new `initiative`
    notification type; in-flight siblings finish. A human retries/skips the item to unblock.
  - **Both cron seams + terminal pokes.** `runDue` is wired into the Worker `scheduled` handler and a
    Node one-minute interval sweeper (symmetric). A settling child run pokes its owning initiative's
    loop immediately (`RunStateMachine.emitInstance` on a terminal run, `ExecutionService.finalizeMerge`
    on a merge), so work advances without waiting for the next sweep.
  - **Controls.** Pause / resume / cancel endpoints + `InitiativeService` CAS transitions; the sweep
    skips a non-`executing` initiative. The tracker window gains a live progress bar and the inspector
    the loop controls (`initiative.inspector.pause/resume/cancel`, all locales).
  - **`listExecuting()` now returns `{ workspaceId, initiative }[]`** (the entity carries no workspace
    id) — mirrored in the D1 + Drizzle repos and asserted, with the persisted loop-state round-trip,
    by the cross-runtime conformance suite.

  No new persistence (the `initiatives` table already exists on both facades) — so no D1/Drizzle
  migration and no executor-harness image bump.

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/contracts@0.91.0
  - @cat-factory/kernel@0.79.0
  - @cat-factory/integrations@0.60.0
  - @cat-factory/orchestration@0.65.0
  - @cat-factory/agents@0.30.1
  - @cat-factory/prompt-fragments@0.9.51
  - @cat-factory/spend@0.10.85

## 0.75.2

### Patch Changes

- 0477068: Mothership mode: widen the persistence-RPC allow-list to four more repository surfaces (the
  prompt-fragment library + two account-onboarding reads) so mothership-mode local nodes can drive
  them against a hosted mothership. Adds two new scope rules, `owner` (an `(ownerKind, ownerId)`
  positional pair) and `ownerField` (the same as record fields on `upsert`), which resolve a
  `workspace` owner to its account and take an `account` owner as the accountId directly — so a
  machine token scoped to one account can never read/write another tenant's rows.

  - `promptFragmentRepository` — the tenant-scoped prompt-fragment library management surface
    (`listByOwner`/`get`/`softDelete` via the `owner` rule, `upsert` via `ownerField`). Rows carry no
    secrets and both tiers are member-level (account-tier routes guard on `requireMember`, not
    `requireAdmin`). The `sourceId`-keyed `listBySource` (repo-sync fan-out) stays mothership-internal.
  - `fragmentSourceRepository` — the fragment-source library list + link (`listByOwner` via `owner`,
    `upsert` via `ownerField`). The `sourceId`-keyed `get`/`updateSyncState`/`softDelete` stay off —
    they back the repo-sync the mothership owns (its source service needs a GitHub client a mothership
    node lacks). Node routes both fragment repos through the `pickRepoSource`/`if (remoteRepos)` seam
    ONLY when the library is configured, so the module isn't spuriously turned on in mothership mode.
  - `invitationRepository.listByAccount` — the account members panel's pending-invite read (member-level,
    `account` rule). Invite `create`/`setStatus` (admin-gated) + the pre-auth `findByTokenHash`/`get`
    accept-invite lookups stay off.
  - `emailConnectionRepository.getByAccount` — the email-settings panel read (member-level, `account`
    rule). Its provider key rides a sealed `apiKeyCipher` blob (the repo never decrypts), so no
    plaintext crosses the machine API. Connect/disconnect (`upsert`/`softDelete`, admin-gated) stay off.

## 0.75.1

### Patch Changes

- 4a59f45: Mothership mode: widen the persistence-RPC allow-list to three more repository surfaces so
  mothership-mode local nodes can drive them against a hosted mothership.

  - `runnerPoolConnectionRepository` (whole repo) — the self-hosted runner-backend connection
    settings panel (`getByWorkspace`/`softDelete` via the `workspace` rule, the record-based
    `upsert` via `workspaceField`). Credentials ride a sealed `secretsCipher` blob, so no plaintext
    crosses the machine API (the observability/environment-connection precedent).
  - `binaryArtifactMetadataStore` (metadata surface) — the visual-confirmation gate's artifact
    metadata (`insert` via `workspaceField`; `get`/`listByExecution`/`countByExecution`/`listByBlock`/
    `delete` via `workspace`). The blob BYTES stay per-account local; only the metadata is proxied,
    and the retention sweep stays mothership-internal. It is folded into both facades' reflected
    `repositories` registry (it isn't a `CoreDependencies` member).
  - `serviceRepository.listByFrameBlocks` — the batched board-composition / frame-deletion read, via
    the `blockList` scope kind.

## 0.75.0

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
  - @cat-factory/prompt-fragments@0.9.50
  - @cat-factory/spend@0.10.84

## 0.74.0

### Minor Changes

- 7fa7578: Initiatives slice 2 — interactive planning.

  The Initiative Planning pipeline (`pl_initiative`) now interviews the human and analyses the
  codebase before the planner drafts, so the plan is grounded in the stakeholder's intent and the
  real code. The pipeline becomes
  `[initiative-interviewer → initiative-analyst → initiative-planner → approval gate → initiative-committer]`
  (catalog `version` bumped to 2, so workspaces get the reseed offer).

  - **`initiative-interviewer`** — a new inline LLM gate that asks clarifying questions about goals,
    scope and constraints, PARKS the planning run on a durable decision-wait while the human answers
    through a dedicated planning Q&A window, then synthesizes the agreed goal / constraints / non-goals
    brief. It is **entity-native**: the questions, answers and brief live directly on the `initiatives`
    entity (its `qa` + new `interview` fields) via the CAS `mutate` — no new table. Reuses the shared
    `RunStateMachine` park/answer/resume spine (the review-gate model). Passes through when no
    interviewer model is wired, so pipelines run unchanged.
  - **`initiative-analyst`** — a new container-explore agent that reads the repo and writes a prose
    codebase analysis onto the entity (`analysisSummary`), grounding the plan.
  - The **planner** and **analyst** prompts now fold in the interview brief + analysis (threaded onto
    the agent context for `initiative`-level runs).
  - New endpoints (`POST /blocks/:blockId/initiative-planning/{answer,continue,proceed}`), store
    actions and the `initiative-planning` result-view window; the inspector surfaces an "Answer
    planning questions" button while the interviewer is parked. `initiative.planning.*` copy added to
    all locales.

  Runtime-symmetric with no facade changes (the interviewer resolves its model exactly like the
  requirements reviewer, from the routing default already wired in both runtimes) and no new
  persistence — so no D1/Drizzle migration and no executor-harness image bump.

### Patch Changes

- f372f4e: Mothership mode: allow-list the ephemeral-environment connection management surface.

  The environment provider-connection + per-type infra-handler settings panels
  (`EnvironmentController` → `EnvironmentConnectionService`: connect / list / disconnect a
  backend, register / test / re-secret / unregister a per-type engine handler) are now
  functional in mothership mode, alongside the workspace-defined custom-manifest-type catalog
  the infra configurator reads + edits.

  - Newly allow-listed in `REMOTE_PERSISTENCE_METHODS`: the whole `environmentConnectionRepository`
    (`listByWorkspace`/`getByWorkspaceAndType`/`softDelete` via the `workspace` rule, the
    record-based `upsert` via the `workspaceField` rule) and the whole `customManifestTypeRepository`
    (`listByWorkspace`/`remove` via `workspace`, `upsert` via `workspaceField`). Member-level,
    workspace-scoped — the same policy as the observability / other settings panels.
  - Safe to expose like the observability connection: the connection record carries handler secrets
    as a **sealed** `secretsCipher` blob (the repo returns it verbatim; sealing/decryption live in
    the service under the local key), so no plaintext credential crosses the machine API and the
    mothership only ever stores ciphertext. Custom-manifest-type rows carry no secrets.
  - `customManifestTypeRepository` (built directly over `db` by `selectNodeEnvironmentsDeps`) is now
    routed through the `pickRepoSource`/`remoteRepos` seam in `buildNodeContainer` so it resolves
    from the remote registry when there is no Postgres (`environmentConnectionRepository` was already
    routed).

  Deliberately still off (a later secrets-delegation slice): actually provisioning an environment
  (`environmentRegistryRepository.insert`/`update`) + decrypting a remotely-sealed access cipher.
  Server-only allow-list change + one routing line, symmetric by construction.

- Updated dependencies [7fa7578]
  - @cat-factory/contracts@0.89.0
  - @cat-factory/kernel@0.77.0
  - @cat-factory/orchestration@0.63.0
  - @cat-factory/agents@0.29.1
  - @cat-factory/integrations@0.58.1
  - @cat-factory/prompt-fragments@0.9.49
  - @cat-factory/spend@0.10.83

## 0.73.1

### Patch Changes

- 6917962: mothership: allow-list the VCS / GitHub projection read surface

  In mothership mode the SPA's VCS board panels (repos / branches / pull requests / issues) were not
  functional over `/internal/persistence`: the projection reads `GitHubService` (`container.github`)
  serves straight from the local projections came back `unknown_method`. This widens
  `REMOTE_PERSISTENCE_METHODS` with those reads, each workspace-scoped on arg0 (the existing
  `workspace` rule — no new scope machinery), read-only and member-level (the GitHub read endpoints
  mount under `/workspaces/:workspaceId`, not admin-gated):

  - `repoProjectionRepository.list` — the repos panel.
  - `branchProjectionRepository.listByRepo` — a repo's branches.
  - `pullRequestProjectionRepository.listByWorkspace` — the pull-requests panel.
  - `issueProjectionRepository.listByWorkspace` — the issues panel.
  - `githubInstallationRepository.getByWorkspace` — the run path's installation lookup (see below).

  `repoProjectionRepository.list` is ALSO on the run path — `resolveRepoTarget` walks the
  `github_repos` projection to find a block's repo on EVERY container-agent dispatch. But it reads
  `githubInstallationRepository.getByWorkspace` FIRST (returning null when GitHub isn't connected),
  so closing the run-path gap for real (non-fake-executor) runs needs BOTH reads: with only `list`
  allow-listed the resolver still failed one call earlier on the un-remoted installation read. Its
  other deps — `blockRepository.get`, `serviceRepository.getByFrameBlock` — are already remote, so
  adding `getByWorkspace` + `list` genuinely closes it (the merge-gate integration test uses the
  `FakeAgentExecutor`, which bypasses repo resolution, so the gap didn't surface there).

  Still off the SPA path (a later GitHub sync + repo-write slice): the projection WRITE surface —
  `upsertMany` (the sync/webhook ingest; the mothership owns GitHub sync, since the App + webhooks
  live there), the board-linkage writes `repoProjectionRepository.linkBlock` / `setMonorepo`, the
  installationId-keyed sync cursors, `tombstoneMissing`, and the per-repo `listByRepo` variants the
  panels don't drive. `repoProjectionRepository.get` stays off too: it backs only
  `GitHubService.resolve` for the repo-WRITE endpoints (create-branch / open-PR / merge / comment),
  and exposing it alone would let create-branch/open-PR do the real GitHub write and THEN fail on the
  un-remoted `upsertMany` projection refresh — a worse failure than today's clean pre-write refusal.

  Still off on the installation repo: only the workspace-scoped `getByWorkspace` the run path needs
  is opened; its installationId-keyed reads, the token/sync writes, the webhook fan-out, and the
  cron `listActive` stay off (the same later GitHub sync + repo-write slice).

  The projection repos + the installation repo are already routed through the `pickRepoSource`/
  `sourced` seam, so a mothership-mode node already sources them from the full-surface remote registry
  when `db` is undefined — an allow-list change only, symmetric by construction (the dispatcher
  reflects over each facade's registry).

## 0.73.0

### Minor Changes

- 55661f4: Add a public, key-authenticated external API (`/api/v1`) whose first use-case is "break down an
  initiative": an external system picks a public, inline pipeline and posts a brief, and the platform
  runs it headlessly and persists the result in the DB for asynchronous retrieval (poll
  `GET /api/v1/jobs/:id` or stream `GET /api/v1/jobs/:id/events` over SSE). Nothing is committed to
  GitHub — the run uses an inline agent (`initiative-breakdown`) with no container/repo.

  - Inbound public-API keys (`public_api_keys`, mirrored D1 ⇄ Drizzle) are revocable and stored as a
    one-way peppered hash (`HMAC-SHA256(secret, ENCRYPTION_KEY)`) — never plaintext, never
    recoverable. Managed per-workspace via `GET|POST|DELETE /workspaces/:ws/public-api-keys`; the raw
    key is shown once on create.
  - Runs are anchored on a headless `internal` block excluded from every board projection, so the
    external runs never appear in the UI.
  - Requires `ENCRYPTION_KEY` (the HMAC pepper); the surface 503s when unconfigured.

### Patch Changes

- Updated dependencies [55661f4]
  - @cat-factory/contracts@0.88.0
  - @cat-factory/kernel@0.76.0
  - @cat-factory/agents@0.29.0
  - @cat-factory/integrations@0.58.0
  - @cat-factory/orchestration@0.62.0
  - @cat-factory/prompt-fragments@0.9.48
  - @cat-factory/spend@0.10.82

## 0.72.0

### Minor Changes

- ca5c3e8: Initiatives (slice 1 of 4): the long-running, multi-task counterpart to a task — see
  `docs/initiatives/initiatives-feature.md` for the full multi-slice plan.

  - **New `initiative` block level** — a container block under a service frame (created via the
    new "Create initiative" button in the frame header, next to add-task/import-task). Tasks a
    later slice's execution loop spawns link back via the new `blocks.initiative_id` membership
    column (epic-style). D1 migration `0035_initiatives.sql` ⇄ Drizzle schema, shared mapper.
  - **New `initiatives` entity + store** — the DB row is the source of truth (phases, items with
    planner-authored estimates + dependencies, the execution policy with estimate→pipeline rules,
    decisions / deviations / follow-ups / caveats), guarded by a `rev` compare-and-swap so the
    loop has a single logical writer. Mirrored D1 ⇄ Drizzle repositories with a cross-runtime
    conformance suite (CRUD, doc round-trip, CAS conflict, `blocks.initiative_id`).
  - **Initiative Planning pipeline skeleton (`pl_initiative`)** — `initiative-planner` (a
    read-only structured container explore that drafts the multi-phase plan, gated for human
    approval) + `initiative-committer` (a deterministic engine step that flips the entity to
    `executing` and commits the rendered tracker to `docs/initiatives/<slug>/` — canonical
    `initiative.json` + human `tracker.md` + `version.json`, hash-short-circuited and
    replay-safe, following the blueprint artifact pattern). A bidirectional guard in the
    engine's shared `assertRunnable` makes `pl_initiative` the ONLY pipeline runnable on an
    initiative block (and vice versa), across start/retry/restart.
  - **API + snapshot + realtime** — `POST/GET /workspaces/:ws/initiatives` (+ by-block read),
    the snapshot's optional `initiatives` field, and a new `initiative` WorkspaceEvent pushed
    from both runtimes' publishers.
  - **Frontend** — the Create Initiative modal + frame-header button, the initiative board card,
    an inspector body (run planning / open tracker) and the read-only Initiative Tracker window
    (`initiative-tracker` result view), with the `initiative.*` i18n namespace across all 8
    locales.

  Later slices add the interactive planning interview, the execution loop (just-in-time task
  spawning with estimate-gated pipeline selection), and follow-up/deviation harvesting.

### Patch Changes

- Updated dependencies [ca5c3e8]
  - @cat-factory/contracts@0.87.0
  - @cat-factory/kernel@0.75.0
  - @cat-factory/agents@0.28.0
  - @cat-factory/orchestration@0.61.0
  - @cat-factory/integrations@0.57.2
  - @cat-factory/prompt-fragments@0.9.47
  - @cat-factory/spend@0.10.81

## 0.71.2

### Patch Changes

- Updated dependencies [cc924a9]
  - @cat-factory/agents@0.27.1
  - @cat-factory/orchestration@0.60.4

## 0.71.1

### Patch Changes

- 803fa76: mothership: allow-list the Kaizen grading read surface

  In mothership mode the Kaizen SCREEN (`KaizenController` → `KaizenService.getOverview` /
  `listForExecution`) was not functional over `/internal/persistence`: the run-path grade
  reads/writes (`kaizenGradingRepository.getByStep`/`upsert`,
  `kaizenVerifiedComboRepository.getByKey`) were remotely callable, but the screen's list reads
  came back `unknown_method`, so a mothership-mode SPA could not display the grading history, the
  verified-combo library, or a run's per-step grading status. This widens
  `REMOTE_PERSISTENCE_METHODS` with the screen's reads, each workspace-scoped on arg0 (the existing
  `workspace` rule), read-only and member-level (the Kaizen endpoints are not admin-gated):

  - `kaizenGradingRepository.listByWorkspace` — the Kaizen screen's bounded grading history.
  - `kaizenGradingRepository.listByExecution` — the run-window per-step grading status.
  - `kaizenVerifiedComboRepository.listByWorkspace` — the verified-combo library.

  Still off the SPA path: the internal-only single-grade `kaizenGradingRepository.get` (the service
  never calls it), the background-sweep reads (`listPending`/`claim`, kind-spanning cron), and the
  combo `upsert` (the streak/verified write) — kaizen GRADING itself is best-effort in mothership
  mode until the Phase 5 telemetry/local-first sync, but the screen that VIEWS prior grades now reads
  them over the RPC. These are core repositories (`createDrizzleRepositories`), so a mothership-mode
  node already sources them from the full-surface remote registry (`composeMothership`) when `db` is
  undefined — an allow-list change only, symmetric by construction (the dispatcher reflects over each
  facade's registry).

## 0.71.0

### Minor Changes

- b216fdc: Fragment GitHub-source staleness is now a lightweight commit-version check.

  The full fragment bodies were already cached on our side; the "check for changes"
  probe previously re-listed the whole source directory and hashed every blob sha.
  It now reads only the source directory's current head commit sha and compares it to
  the commit the source was last synced to — a single cheap GitHub/GitLab call, no
  directory listing or file reads.

  Breaking (pre-1.0, no migration): `FragmentSource`/`FragmentSyncResult` now expose
  `lastSyncedCommit` instead of `lastSyncedSha`, and `FragmentSourceStatus` is
  `{ changed, lastSyncedCommit, remoteCommit }` (the per-file `changedCount`/`remoteSha`
  are gone — the resync badge is now a plain "changes available" indicator). A new
  `latestCommitSha` port method is added to `GitHubClient` and `VcsClient`. The physical
  `fragment_sources.last_synced_sha` column is unchanged and reused to store the commit
  sha, so no database migration is required; existing rows re-derive their commit on the
  next sync.

### Patch Changes

- Updated dependencies [b216fdc]
  - @cat-factory/kernel@0.74.0
  - @cat-factory/contracts@0.86.0
  - @cat-factory/agents@0.27.0
  - @cat-factory/integrations@0.57.1
  - @cat-factory/orchestration@0.60.3
  - @cat-factory/spend@0.10.80
  - @cat-factory/prompt-fragments@0.9.46

## 0.70.0

### Minor Changes

- 7fd6a19: Import-from-repo picker: find and link accessible repos in realtime instead of enumerating the whole installation and filtering in memory. The old path listed every installation repo (capped at a bounded page count) then substring-filtered client-of-the-cap — so on a wide App install a repo beyond that window returned "no matches" for a repo you actually had access to, and every keystroke re-fetched all pages. Two new `GitHubClient` primitives fix it end to end: `searchInstallationRepos` issues one bounded, account-scoped GitHub search per query, and `getRepoById` point-reads the picked repo by id when linking it (so a repo surfaced by search from beyond the enumeration cap links instead of spuriously 409-ing). Blank-query browse-all is unchanged; PAT (local) and GitLab connections filter their bounded token listing. When an installation has no resolvable account to scope the GitHub search to, the App adapter filters its own bounded listing rather than running an unscoped global search (which would surface arbitrary, unlinkable public repos).

### Patch Changes

- Updated dependencies [7fd6a19]
  - @cat-factory/kernel@0.73.0
  - @cat-factory/integrations@0.57.0
  - @cat-factory/agents@0.26.18
  - @cat-factory/orchestration@0.60.2
  - @cat-factory/spend@0.10.79

## 0.69.1

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/contracts@0.85.0
  - @cat-factory/kernel@0.72.0
  - @cat-factory/orchestration@0.60.1
  - @cat-factory/agents@0.26.17
  - @cat-factory/integrations@0.56.5
  - @cat-factory/prompt-fragments@0.9.45
  - @cat-factory/spend@0.10.78

## 0.69.0

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

- 36f4cf6: Frontend UI-test bindings: surface how each backend binding resolves + a non-fatal run-start note.

  - **Shared resolution helpers moved to `@cat-factory/contracts`** (next to `frontendOriginsForService`)
    so the SPA and the backend share ONE source of truth: `resolveFrontendBindings`,
    `indexLiveServiceEnvUrls`, `boundServiceFrameIds`, the `ResolvedFrontendBinding`/`LiveEnvHandle`
    types, and a new pure `buildFrontendRunNotes`. Orchestration re-exports them, so existing importers
    are unchanged.
  - **Inspector resolved-binding visibility**: `FrontendConfig.vue` now shows, live, how each backend
    binding resolves — `envVar → a bound service's live ephemeral URL | mocked (WireMock)` — mirroring
    what a UI-test run resolves, plus a warning for duplicate env vars. Backed by a new lightweight
    `environments` store over `GET /workspaces/:ws/environments`.
  - **Run/step detail projection + run-start note**: the engine stamps BOTH the resolved bindings
    (`ExecutionInstance.frontendBindings`) and the non-fatal advisories (`ExecutionInstance.notes`:
    duplicate env vars, or a partial-live set where some bound services fall back to WireMock) on the
    run ONCE at start — the SPA-visible mirror of the harness's own `buildInfraNotes`. A `tester-ui`
    step's detail projects the FROZEN start-time bindings (so a finished run shows what it actually
    drove against, not a live re-resolution that could disagree with the co-located note after the
    envs are torn down); the run-start note shows on any step detail of a frontend-frame run. Both
    ride in the run's `detail` JSON (no migration) and round-trip identically on D1 ⇄ Postgres.

  No wire/behaviour break: the notes field is optional, the moved helpers are re-exported, and a
  non-frontend run is unaffected.

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
  - @cat-factory/contracts@0.84.0
  - @cat-factory/orchestration@0.60.0
  - @cat-factory/kernel@0.71.0
  - @cat-factory/agents@0.26.16
  - @cat-factory/integrations@0.56.4
  - @cat-factory/prompt-fragments@0.9.44
  - @cat-factory/spend@0.10.77

## 0.68.2

### Patch Changes

- e0aab3f: Connections between services, phase 1 of the service-connections initiative (see
  `backend/docs/service-connections.md` + `docs/initiatives/service-connections.md`):

  - **Service connections**: a `service`-type frame carries `serviceConnections` — directed
    consumer→provider edges to the other services it uses, each with an optional
    description ("sends transactional email via it"). Stored as a JSON column on the block
    (D1 migration `0034` ⇄ Drizzle), validated at the `updateBlock` write gate (no
    self-connection, no duplicates, targets must be service frames; cycles are deliberately
    legal), pruned when a connected frame is deleted, and drawn as emerald consumer→provider
    edges on the board. A new inspector panel on service frames edits the connections and
    shows the reverse "Used by" list.
  - **Per-task involved services**: a task carries `involvedServiceIds` — the connected
    services directly involved in it beyond its own service, picked (in the task's run
    settings) from the frame's connection neighbors in either direction. Validated at the
    write gate against the neighbor set; a selection whose connection was later removed is
    badged stale in the UI and dropped on the next change. Later phases use the selection
    to provision every involved service as an ephemeral environment and to let the coding
    agent change every involved repo (multi-repo sibling checkouts) — designed in the
    docs, not yet implemented.
  - Cross-runtime conformance now round-trips both JSON columns and asserts the write-gate
    rejections on both stores.

- Updated dependencies [e0aab3f]
  - @cat-factory/contracts@0.83.0
  - @cat-factory/kernel@0.70.2
  - @cat-factory/orchestration@0.59.2
  - @cat-factory/agents@0.26.15
  - @cat-factory/integrations@0.56.3
  - @cat-factory/prompt-fragments@0.9.43
  - @cat-factory/spend@0.10.76

## 0.68.1

### Patch Changes

- 0d51638: Harden three server-side SSRF surfaces:

  - **Local-runner allow-list** no longer treats a DNS hostname that merely starts with `fc`/`fd`
    (e.g. `fc2.com`) as a private IPv6 ULA — the ULA/loopback tests are now gated behind an
    "is IPv6 literal" check and the classification reuses the vetted kernel `ip-host` primitives.
  - **Runner-pool provider** (`HttpRunnerPoolProvider.execute`/`oauthToken`) and the shared
    `probeConnection` now follow redirects by hand and re-run the SSRF guard on every hop, so a
    permitted scheduler host can't 302 the secret-bearing dispatch body to an internal/metadata
    target. Factored the per-hop `safeFetch` + capped-read helpers into a shared module reused by
    the environment provider. `safeFetch` additionally drops the request body and strips
    credential headers (`authorization`/`cookie`/`proxy-authorization`) on any **cross-origin**
    redirect hop, so a permitted host also can't bounce the secrets to a _different_ public host
    (re-establishing the cross-origin credential stripping the platform `fetch` would have done,
    which the manual `redirect: 'manual'` follower had bypassed).
  - **Account-configured SearXNG web-search URL** is now validated (public host, http/https, no
    private/internal/metadata target) both at the write boundary and with per-hop revalidation on
    fetch.

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

- 0d51638: Secret-handling hardening:

  - **LLM telemetry** (`LlmObservabilityService`) now scrubs credential shapes from the
    prompt/response/reasoning bodies AND the `errorMessage` with a shared `redactSecrets`
    (promoted to `@cat-factory/kernel`, reused by the provisioning-log path) BEFORE anything is
    stored or fanned out to an external trace sink (Langfuse). `errorMessage` is kept as
    diagnostic metadata even when bodies are dropped and is fanned out ungated, so it is
    scrubbed too (an upstream 4xx/5xx string can echo an auth header). Prompt/response/reasoning
    body capture is additionally gated on the per-workspace `storeAgentContext` toggle (numeric
    telemetry is always recorded). Also fixed a latent O(n²) regex backtrack in the URL-userinfo
    redaction rule that a large prompt could trigger.
  - **Signed tokens** (`HmacSigner`) now derive an independent HKDF-SHA256 subkey per audience
    (`session`/`oauth-state`/`llm-proxy`/`ws`/`machine`), so a token class is cryptographically
    isolated rather than sharing one raw HMAC key. Key derivation is bounded to that fixed
    audience set — `verify` selects the key from the token's attacker-controlled claimed `aud`
    before the MAC check, so an unrecognised (or absent) audience falls back to the raw-secret
    base key rather than deriving+caching a fresh subkey, preventing an unbounded key-cache /
    per-request-HKDF DoS from a flood of junk-audience tokens. Breaking: any tokens signed before
    this change no longer verify (pre-1.0, no migration — clients re-authenticate).

- Updated dependencies [0d51638]
- Updated dependencies [0d51638]
  - @cat-factory/integrations@0.56.2
  - @cat-factory/kernel@0.70.1
  - @cat-factory/orchestration@0.59.1
  - @cat-factory/agents@0.26.14
  - @cat-factory/spend@0.10.75

## 0.68.0

### Minor Changes

- eb67d40: Record per-call LLM telemetry for the Claude Code and Codex subscription harnesses,
  so their calls appear in the same `llm_call_metrics` store (and the "Model activity"
  observability panel) as the proxy-metered Pi harness.

  These harnesses talk direct to the vendor and bypass the LLM proxy, so the harness now
  lifts per-call metrics off each CLI's event stream: Claude Code (`stream-json --verbose`)
  carries full request/response bodies, per-turn tokens, model, and finish reason; Codex
  (`exec --json`) is thinner — flat assistant text plus per-turn token counts, with no
  request transcript (a CLI limitation). The executor records these into the SAME
  `LlmObservabilityService` the proxy uses (with zero per-HTTP timing, since the CLIs don't
  expose it), wired symmetrically on the Cloudflare and Node facades. Captured bodies are
  credential-scrubbed and honour the existing `LLM_RECORD_PROMPTS` switch. Telemetry is
  recorded on failed runs too (not only successful ones), so a token-spending run that
  ends with no changes / unusable output stays observable, and each row is minted a
  deterministic id off the job id so a durable-driver replay re-records idempotently.

  Also tightens `LLM_RECORD_PROMPTS`: it now empties the response and reasoning bodies as
  well as the prompt when recording is off (previously only the prompt was suppressed),
  so a deployment that opts out of retaining prompts no longer retains model replies
  either.

  Bumps the executor-harness runner image (harness `src/**` changed).

### Patch Changes

- Updated dependencies [eb67d40]
  - @cat-factory/kernel@0.70.0
  - @cat-factory/orchestration@0.59.0
  - @cat-factory/agents@0.26.13
  - @cat-factory/integrations@0.56.1
  - @cat-factory/spend@0.10.74

## 0.67.0

### Minor Changes

- 5ce03c6: Frontend-config inspector: add repo autodetection, a frontend-directory field, clearer serve-mode
  help, and collapsible field groups.

  - **Detect from repo**: a new deterministic, checkout-free detector proposes a frontend config
    (package manager from the lockfile, install command, build script + output dir from
    package.json/framework markers, serve mode/script, and backend-binding env-var names from dotenv
    examples). Exposed as `POST /workspaces/:ws/environments/detect-frontend-config`
    (`detectFrontendConfig` on the environments connection service) and surfaced in the panel as a
    non-binding preview the user reviews and applies (backend bindings are appended, never
    overwriting existing service links).
  - **Frontend directory**: `FrontendConfig.directory` scopes a monorepo frontend's build/serve to a
    subdirectory (threaded into the harness job-body builder).
  - **Serve mode**: replaced the single hint with per-mode descriptions and a note distinguishing it
    from the separate env-injection axis.
  - **Grouping**: the panel's fields are now collapsible sections (Build / Serve / Mocking / Env
    injection / Backend bindings / Preview), collapsed by default.

### Patch Changes

- Updated dependencies [5ce03c6]
  - @cat-factory/contracts@0.82.0
  - @cat-factory/integrations@0.56.0
  - @cat-factory/agents@0.26.12
  - @cat-factory/kernel@0.69.8
  - @cat-factory/orchestration@0.58.1
  - @cat-factory/prompt-fragments@0.9.42
  - @cat-factory/spend@0.10.73

## 0.66.7

### Patch Changes

- 7f9d215: Fix critical/high race conditions from the July 2026 audit:

  - **Spend-resume on Cloudflare (1.1):** a spend-paused run's `ExecutionWorkflow`
    instance no longer returns (going terminal). It now stays alive **parked on a
    `waitForEvent`** (like a human-decision wait, not a busy sleep-loop), so a long pause
    no longer accretes unbounded durable steps. `/spend/resume` wakes it immediately via a
    new `WorkRunner.signalResume` (a `spend-resume` event), and a 24h re-check chunk
    auto-resumes it when the monthly budget frees — instead of the terminal-instance-id
    trap that let the cron sweeper force-fail the "resumed" run.
  - **Spend-resume on Node/local (parity):** Node/local now auto-resume spend-paused runs
    when the monthly budget frees, via a new `agentRunRepository.listPausedExecutions`
    polled by the reclaim sweeper (gated on `isOverBudget`, so a still-exhausted workspace
    causes no churn) — matching the Cloudflare facade. Covered by a conformance assertion.
  - **BootstrapWorkflow re-drive (1.2):** past the poll-read tolerance the workflow no
    longer returns (going terminal, which made the sweeper force-fail a merely-busy
    container). It keeps the instance alive and keeps polling, so a long clone/install
    recovers.
  - **One live execution run per block (2.1):** a new partial unique index on live
    execution rows per block (D1 migration `0033` ⇄ Drizzle) plus an **atomic**
    `ExecutionRepository.insertLive` that deletes the block's terminal rows (and the
    caller's own `replaceId`) and inserts the new run **in one transaction** (D1
    `db.batch` / Drizzle `transaction`). `start`/`retry`/`restartFromStep` no longer
    `deleteByBlock` first, so a genuinely-concurrent double start is rejected with a 409
    instead of the pre-delete wiping a concurrent winner and creating two live runs — two
    drivers, two containers — on one branch. Covered by cross-runtime conformance
    assertions (terminal cleanup + `replaceId` supersede).

- Updated dependencies [7f9d215]
- Updated dependencies [05d1b08]
  - @cat-factory/kernel@0.69.7
  - @cat-factory/orchestration@0.58.0
  - @cat-factory/integrations@0.55.0
  - @cat-factory/agents@0.26.11
  - @cat-factory/spend@0.10.72

## 0.66.6

### Patch Changes

- 4955639: Fix five bugs in how best-practice prompt fragments are managed and applied:

  - **Code-aware helper agents now receive the service fragments.** `ci-fixer`, `fixer`
    and `on-call` are dispatched off their HOSTING step (a `ci`/`post-release-health`
    gate, the tester, the human-test/visual-confirmation loops), and the fragment fold
    keyed off that step's kind — so the helpers never received the service's standards
    despite being marked `code-aware`. `AgentContextBuilder.buildContext` now takes an
    explicit `agentKind` override and every helper dispatch passes it; the on-call job
    body additionally folds the resolved fragments into its bespoke system prompt
    (previously bypassed). A stale `step.selectedFragmentIds` is also cleared when a
    re-dispatch resolves to nothing, so observability can't over-report.
  - **Tier tombstones now stick on the run path.** `resolveBodiesForRun` used to fall
    back to the static pool for any id missing from the merged catalog — which is
    exactly what a tombstone does to a built-in, so suppressing a fragment a service
    had selected silently resurrected it. The fallback is gone; a missing id is dropped.
  - **Deployment-registered fragments join the tenant catalog.** The library's built-in
    tier now reads the UNIVERSAL pool (shipped catalog + `registerPromptFragment`
    entries, lazily) instead of the raw shipped array, so a registered override of a
    built-in id actually reaches runs and the resolved catalog, and registered
    fragments can be tier-shadowed/tombstoned like any built-in.
  - **Repo-source resync no longer mishandles renames and id edits.** The tombstone
    sweep is keyed by the fragment ids the current tree produces, not by stale paths:
    renaming a file that pins an explicit frontmatter `id` no longer tombstones the
    fragment the rename just updated, and changing a file's explicit `id` in place now
    retires the old id instead of leaving a live duplicate forever. The GitHub
    installation is also resolved once per sync instead of once per file, and the
    requirement writer's fragment grounding resolves through the merged tenant catalog
    when the library is wired.
  - **The SPA pickers now offer the merged catalog.** The per-service / per-block /
    workspace-default fragment pickers loaded only the static built-in pool, so
    managed, repo-sourced and document-backed fragments could be authored but never
    attached (and a managed id set via API rendered no chip). The fragments store now
    loads the workspace's resolved catalog (falling back to the static pool when the
    library is off), invalidates on library edits, and unknown selected ids render as
    removable chips instead of disappearing. The catalog is per-board, so a workspace
    switch now invalidates it and the task inspector reloads it on mount — otherwise the
    task picker kept showing the previous board's fragments.

  Review follow-ups: `AgentContextBuilder` now clears a stale `step.selectedFragmentIds`
  on the non-code-aware and error paths too (not only when a code-aware resolve is empty);
  the requirement-writer grounding resolves the merged catalog once (reused for titles and
  bodies) instead of twice; a repo-source RENAME of an explicit-id file inherits the
  fragment's `version`/`createdAt` by id instead of resetting them; and the source `status`
  count no longer double-counts a pure rename.

- Updated dependencies [4955639]
  - @cat-factory/agents@0.26.10
  - @cat-factory/orchestration@0.57.7

## 0.66.5

### Patch Changes

- 4a7a3f1: Preserve a task run's error trail across retries. A failed run's `failure` is now
  appended to a new `failureHistory` on the fresh attempt (persisted in the shared
  `agent_runs.detail`, so both runtimes get it with no migration), and cleared on the
  running attempt — so the top failure banner disappears the moment the task restarts
  while every previous error stays viewable in a "previous errors" history on the task
  inspector. Applies to both retry (resume-from-failure) and restart-from-step.
- Updated dependencies [4a7a3f1]
  - @cat-factory/contracts@0.81.3
  - @cat-factory/orchestration@0.57.6
  - @cat-factory/agents@0.26.9
  - @cat-factory/integrations@0.54.3
  - @cat-factory/kernel@0.69.6
  - @cat-factory/prompt-fragments@0.9.41
  - @cat-factory/spend@0.10.71

## 0.66.4

### Patch Changes

- 6347d0e: `GitHubPullRequestMerger` now logs (at warn) when the best-effort delete of a merged work
  branch fails, instead of swallowing it silently. A skipped delete is what strands a
  resumable-but-empty branch that a later re-dispatch then fails to open a PR for — so making
  it observable is the diagnostic hook for that class of stuck run.
- 6439181: mothership: allow-list the bootstrap / reference-architecture / env-config-repair management surface

  In mothership mode the repo-bootstrap flow and the env-config-repair retry/stop path were only
  partially remotely callable over `/internal/persistence`: the board-load reads
  (`bootstrapJobRepository.listByWorkspace`/`listByServices`, `envConfigRepairJobRepository.listByWorkspace`)
  were exposed, but the single-job reads and the write methods the flows drive came back
  `unknown_method`, so a mothership-mode SPA could list bootstrap/repair runs but not start a
  bootstrap, poll a single job's card, retry a failed run, or stop a running one. This completes the
  `AgentRunController` retry/stop surface for those two run kinds (the execution-run branch landed
  earlier) and makes the bootstrap modal + reference-architecture library functional. It widens
  `REMOTE_PERSISTENCE_METHODS`, each with a correct scope rule:

  - `bootstrapJobRepository.get`/`update` — the board-card poll (`GET .../bootstrap/jobs/:id`) and the
    retry/stop patches. Workspace-scoped on arg0 (the `workspace` rule).
  - `bootstrapJobRepository.insert` — the record-based start/retry write. Bound by the `workspaceField`
    rule on the job's `workspaceId` FIELD (the row is stored under — and later read by — that
    workspace). The record's sibling ids (`blockId`, `referenceArchitectureId`) are not re-validated
    over the RPC: a foreign `referenceArchitectureId` is harmless because the retry run re-resolves it
    via the workspace-scoped `referenceArchitectureRepository.get`, which 404s a cross-workspace id.
  - `referenceArchitectureRepository.get`/`listByWorkspace`/`update`/`softDelete` — the reference-arch
    library the bootstrap modal reads + edits and that a retry re-resolves its base repo from.
    Workspace-scoped on arg0; the record-based `insert` binds on the record's `workspaceId` field.
  - `envConfigRepairJobRepository.get`/`update` — the repair retry (reads the prior failed job before
    starting a fresh one) and stop (patches the running job). Workspace-scoped on arg0; `insert` binds
    on the job's `workspaceId` field.

  Each method is member-level (none of the bootstrap / reference-arch / env-config-repair endpoints is
  admin-gated) and workspace-scoped, matching the block/pipeline mutation policy. These are the
  non-core repositories the Node/local facade routes through the `pickRepoSource` seam, which already
  sources them from the full-surface remote registry when `db` is undefined — so this is an allow-list
  change only, symmetric by construction (the dispatcher reflects over each facade's registry).
  Round-trip + cross-account-scope + missing-workspaceId (fail-closed) unit tests for every new method
  are in `packages/server/test/persistenceRpc.spec.ts`; the static drift guard
  (`runtimes/node/test/mothership-allowlist.spec.ts`) moves them out of `pending` — the whole
  `bootstrapJob` (bar the serviceId-keyed `listByService` + the `blockServiceId` helper),
  `referenceArchitecture`, and `envConfigRepairJob` repos are now remote.

## 0.66.3

### Patch Changes

- 6243bea: Scope the "create task from a GitHub issue" picker's already-imported list to the
  target service's repo. The quick-pick list of imported issues was filtered only by
  source and free text, so it leaked in issues from every repo in the workspace even
  though the live search was already repo-scoped. `listTasks` now accepts an optional
  `blockId` that resolves the service's linked repo (via the same `resolveRepoTarget`
  the search uses) and drops GitHub issues from other repos; repo-less sources (Jira,
  Linear) are unaffected. The picker fetches its own repo-scoped list rather than
  reading the shared workspace-wide store.
- Updated dependencies [6243bea]
  - @cat-factory/contracts@0.81.2
  - @cat-factory/integrations@0.54.2
  - @cat-factory/agents@0.26.8
  - @cat-factory/kernel@0.69.5
  - @cat-factory/orchestration@0.57.5
  - @cat-factory/prompt-fragments@0.9.40
  - @cat-factory/spend@0.10.70

## 0.66.2

### Patch Changes

- fc8df61: Fix a cross-tenant access hole on the fragment-source routes: `unlink`/`status`/`sync`
  resolved the source by its id alone, so an authenticated member of one account/workspace
  could read, resync or delete another tenant's fragment source by addressing its id under
  their own prefix. `FragmentSourceService.unlink/sync/status` now take the addressed
  `(ownerKind, ownerId)` and 404 when the source belongs to a different owner (breaking
  signature change for direct callers of those three methods).
- Updated dependencies [fc8df61]
  - @cat-factory/agents@0.26.7
  - @cat-factory/orchestration@0.57.4

## 0.66.1

### Patch Changes

- 2a91615: Frontend↔backend ephemeral-stack wiring (slice 6a of the frontend-preview initiative):

  - **Reverse CORS origin injection.** A `deployer` step now passes `inputs.frontendOrigins` — the
    comma-joined browser origins (`http://localhost:<servePort>`) of every `frontend` frame that
    binds the service being provisioned (the reverse of the frontend's `backendBindings`). A
    backend manifest folds it into its CORS allow-list via `{{input.frontendOrigins}}` (HTTP-manifest
    provider) or `{{frontendOrigins}}` (Kubernetes native adapter, flat scope), so an ephemeral
    frontend can reach an ephemeral backend. Derivation is automatic (`frontendOriginsForService`,
    a single workspace block-list read — no N+1); the CORS env-var mapping stays operator-authored,
    and the backend must be re-provisioned to pick up a newly-linked frontend. The served port is
    resolved through the shared `resolveFrontendServePort` (contracts) — the same reserved-port
    sanitization the harness infra spec uses — so a `servePort` set to a reserved in-container port
    (8080/8089) injects the port the app is actually served on (4173), not the raw value.
  - **Binding-resolution correctness.** `resolveFrontendBindings` now dedupes a repeated `envVar`
    deterministically (last non-empty binding wins, matching the injected env map) instead of leaving
    it to insertion order. New `duplicateBindingEnvVars` predicate (contracts) surfaces the collision
    for the inspector + run-start notes (a follow-up slice); it is advisory, not a schema reject
    (bindings persist per-blur with an allowed empty `envVar`).

  Runtime-neutral (all facades). The inspector visibility panel + run-detail projection (6b) and the
  deterministic local preview host port (6c) are tracked follow-ups in
  `docs/initiatives/frontend-preview-ui-testing.md`.

- Updated dependencies [2a91615]
  - @cat-factory/contracts@0.81.1
  - @cat-factory/orchestration@0.57.3
  - @cat-factory/integrations@0.54.1
  - @cat-factory/agents@0.26.6
  - @cat-factory/kernel@0.69.4
  - @cat-factory/prompt-fragments@0.9.39
  - @cat-factory/spend@0.10.69

## 0.66.0

### Minor Changes

- 67d3876: feat(github): search available repos server-side in the "add service from repo" picker.
  The picker no longer prefetches the entire installation repo list on open (slow for a wide
  App install or PAT with hundreds of repos, and it blocked filtering until the whole list
  loaded). Instead the user types at least 3 characters and the (debounced) query is sent to
  `GET /github/available-repos?q=…`, which returns only the `owner/name` matches. The `q`
  param is optional, so the repo-link management panel's browse-all is unchanged. The now-moot
  manual "refresh list" button is removed (each search hits GitHub live).

### Patch Changes

- Updated dependencies [67d3876]
  - @cat-factory/contracts@0.81.0
  - @cat-factory/integrations@0.54.0
  - @cat-factory/agents@0.26.5
  - @cat-factory/kernel@0.69.3
  - @cat-factory/orchestration@0.57.2
  - @cat-factory/prompt-fragments@0.9.38
  - @cat-factory/spend@0.10.68

## 0.65.2

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
  - @cat-factory/integrations@0.53.2
  - @cat-factory/agents@0.26.4
  - @cat-factory/spend@0.10.67
  - @cat-factory/prompt-fragments@0.9.37

## 0.65.1

### Patch Changes

- Updated dependencies [120de05]
  - @cat-factory/contracts@0.80.0
  - @cat-factory/orchestration@0.57.0
  - @cat-factory/kernel@0.69.1
  - @cat-factory/agents@0.26.3
  - @cat-factory/integrations@0.53.1
  - @cat-factory/prompt-fragments@0.9.36
  - @cat-factory/spend@0.10.66

## 0.65.0

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
  - @cat-factory/integrations@0.53.0
  - @cat-factory/contracts@0.79.0
  - @cat-factory/kernel@0.69.0
  - @cat-factory/agents@0.26.2
  - @cat-factory/prompt-fragments@0.9.35
  - @cat-factory/spend@0.10.65

## 0.64.4

### Patch Changes

- Updated dependencies [16ee6cc]
- Updated dependencies [16ee6cc]
  - @cat-factory/orchestration@0.55.1
  - @cat-factory/contracts@0.78.1
  - @cat-factory/kernel@0.68.1
  - @cat-factory/agents@0.26.1
  - @cat-factory/integrations@0.52.2
  - @cat-factory/prompt-fragments@0.9.34
  - @cat-factory/spend@0.10.64

## 0.64.3

### Patch Changes

- 6da6637: mothership: allow-list the shared-service mount management surface

  In mothership mode the org-catalog / shared-service mounting flow (`ServiceMountService` /
  `ServiceMountController` — mount / unmount / re-layout a shared account service onto a workspace
  board) was not fully remotely callable over `/internal/persistence`: the reads that badge the
  catalog (`workspaceMountRepository.listByWorkspace` / `countByServiceIds`) were exposed, but the
  single-service read the mount flow performs and the mount write/update/remove methods came back
  `unknown_method`, so a mothership-mode SPA could display the catalog but not mount from it. This
  widens `REMOTE_PERSISTENCE_METHODS` to the write surface, each with a correct scope rule:

  - `serviceRepository.get(serviceId)` — the single-service read behind `ServiceMountService.mount`
    (the cross-org guard that a service is mounted only within its own account). Bound by a NEW
    `service` scope kind (a single serviceId → owning account, the single-id form of `serviceList`),
    reusing the controller's existing service→account resolver — no controller change. The dispatched
    `get` is routed through the same per-request `listByIds` memo the scope check already reads, so a
    mount precheck resolves the service in ONE query, not two.
  - `workspaceMountRepository` — `get` / `update` / `remove` (arg0 = workspaceId → the `workspace`
    rule) and the record-based `upsert(mount)` (bound by a NEW `serviceMount` scope kind).

  Each is member-level (the mount endpoints are not admin-gated) and workspace-scoped. The cross-org
  mount invariant ("a service can only be mounted within its own organization") is enforced at the
  RPC layer, not only in the bypassed service layer: the `serviceMount` rule binds `upsert` on the
  mount's `workspaceId` FIELD (out-of-scope workspace → refused) AND requires the mounted `serviceId`
  to be owned by the SAME account as that workspace. So a raw `upsert` can never plant a cross-org
  mount — including for a machine token that spans several accounts (a user in multiple orgs, where a
  workspace-only check would let one org's service be mounted onto another org's board). Board
  composition (`blockRepository.listByServices` / `serviceRepository.listByIds`) stays account-scoped
  as a second line of defence. The real-time fan-out reads (`listByService` /
  `listWorkspaceIdsMountingBlock`) and the frame-deletion batch cleanup (`removeByServices`) stay off
  the SPA path. These are core repos, so a mothership-mode node already sources them from the
  full-surface remote registry — no `pickRepoSource` routing change, just the allow-list plus the two
  new scope kinds. Server-only, symmetric by construction (the dispatcher reflects over each facade's
  registry). Round-trip + cross-account-scope tests cover every new method (incl. the `service` kind's
  fail-closed edges and the `serviceMount` rule's cross-org / multi-account denials); the static drift
  guard moves them out of `pending`.

## 0.64.2

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/contracts@0.78.0
  - @cat-factory/kernel@0.68.0
  - @cat-factory/agents@0.26.0
  - @cat-factory/orchestration@0.55.0
  - @cat-factory/integrations@0.52.1
  - @cat-factory/prompt-fragments@0.9.33
  - @cat-factory/spend@0.10.63

## 0.64.1

### Patch Changes

- Updated dependencies [08be94c]
  - @cat-factory/orchestration@0.54.1

## 0.64.0

### Minor Changes

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

- f21279e: Warn when required infrastructure is undefined. The workspace snapshot now carries an
  `infraSetup` projection (computed server-side in `WorkspaceController` from whatever the
  deployment actually wired) that tracks three areas explicitly as `not_defined` /
  `configured` / `not_applicable`:

  - **Ephemeral environments** (all runtimes that wire the environments integration) —
    `not_defined` when no environment provider connection is registered, so testing agents
    that need a live environment can't run.
  - **Agent executor** (stock/remote Node only — Cloudflare has built-in per-run containers, and
    local mode runs agents in per-run HOST containers) — `not_defined` when no self-hosted runner
    pool is registered, so NO container agents can run. This area fires only where the pool is the
    SOLE executor (the new `agentExecutorRequiresRunnerPool` container flag, set by the Node facade
    when it uses the default pool transport); Cloudflare and local both wire the runner surface but
    keep a built-in executor, so the pool is optional there and the area is `not_applicable` — a bare
    `!!container.runners` check would otherwise falsely nag on every local deployment.
  - **Binary storage** (remote Node only — Cloudflare binds R2, local defaults to a filesystem
    store) — `not_defined` when the account selected no content-storage backend, so UI
    screenshots / reference images have nowhere to live.

  The SPA surfaces each `not_defined` area as a loud, per-area setup banner with a deep-link
  into the relevant configuration. Dismissing a banner asks whether to hide it just for this
  session (re-nags next load) or permanently — "I'm OK with the limitations, don't notify me
  again" — the latter persisted per-user in localStorage.

  The advisory top-of-board banners (AI-readiness, provider-config, infra-setup) now render in a
  single shared, click-through column so concurrent prompts on a fresh deployment stack vertically
  instead of drawing on top of each other. The `RunnerPoolConnectionService` and
  `EnvironmentConnectionService` gain a `hasConnection` presence probe (no secret decrypt) that the
  projection uses on the hot board-load path.

  Each area probe is additionally bounded by a timeout and its swallowed faults are logged, so a slow
  or misconfigured backend read degrades that area to `not_applicable` (advisory-only, never 500s or
  stalls the board load) while staying diagnosable. The banner's permanent-dismissal `localStorage`
  key + the infra-setup area list are exported from `@cat-factory/contracts`
  (`INFRA_SETUP_DISMISSED_STORAGE_KEY` / `INFRA_SETUP_AREAS`) so the SPA and the e2e seed share one
  source of truth, and the stacked banner cards announce through a single polite live region instead
  of one assertive alert each.

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

- 456a992: mothership: allow-list the advanced review / structured-dialogue session surface

  In mothership mode the clarity-review (bug-report triage), brainstorm (structured dialogue) and
  consensus (multi-strategy orchestration) session repositories were not fully remotely callable over
  `/internal/persistence`, so a mothership-mode SPA could run/re-read the board-load view of a review
  but could not persist or replace one as its window iterates (the write/delete methods came back
  `unknown_method`). This widens `REMOTE_PERSISTENCE_METHODS` to their full read+write surface,
  mirroring the requirements-review surface already exposed — member-level and workspace-scoped (none
  of the review endpoints is admin-gated):

  - `clarityReviewRepository` — `get` / `upsert` / `deleteByBlock` (`getByBlock` was already exposed).
  - `brainstormSessionRepository` — `get` / `upsert` / `deleteByBlockStage` (`getByBlockStage` was
    already exposed).
  - `consensusSessionRepository` — `get` / `getByStep` / `getByBlock` / `upsert` (new repo entry).
  - `requirementReviewRepository` — `deleteByBlock`, the pre-review-run drop that completes the repo.

  Every method takes the workspaceId as arg0 (the `upsert(workspaceId, review)` signature carries it
  positionally, so the existing `workspace` rule binds it — resolve the owning account, reject
  out-of-scope as 404). These are core repos, so a mothership-mode node already sources them from the
  full-surface remote registry — no `pickRepoSource` routing change, just the allow-list. Server-only,
  symmetric by construction (the dispatcher reflects over each facade's registry). Round-trip +
  cross-account-scope tests cover every new method; the static drift guard moves them out of `pending`.

- 1d2684f: mothership: allow-list the post-release-health / observability settings surface

  In mothership mode the observability connection, per-block release-health config, and
  incident-enrichment connection repositories were not remotely callable over
  `/internal/persistence`, so a mothership-mode SPA could not manage the post-release-health
  flow's settings panels (every call came back `unknown_method`). This widens
  `REMOTE_PERSISTENCE_METHODS` to their full management surface, member-level and workspace-scoped
  (the controllers mount under `/workspaces/:workspaceId`, none is admin-gated) — matching the
  settings-panel policy already exposed:

  - `observabilityConnectionRepository` / `incidentEnrichmentConnectionRepository` — `get` +
    `delete` via the `workspace` rule (arg0 = workspaceId), `upsert(record)` via a new
    `workspaceField` scope rule.
  - `releaseHealthConfigRepository` — `getByBlock` / `listByWorkspace` / `delete` via `workspace`,
    `upsert(record)` via `workspaceField`.

  The new `workspaceField` scope rule binds a call whose workspaceId is a FIELD of the record arg
  (not a positional arg): the write targets exactly `record.workspaceId`, so binding on it means a
  record can only be persisted into an in-scope workspace; a missing/non-string field or an
  out-of-scope workspace is refused as 404. Server-only allow-list change, symmetric by construction
  (the dispatcher reflects over each facade's registry). Round-trip + cross-account-scope tests cover
  every new method; the static drift guard moves them out of `pending`.

  Scope: this makes the settings PANELS functional end-to-end (persist + read back the redacted
  summary). It does NOT yet make a saved observability connection drive a post-release-health gate
  probe in mothership mode — decrypting the sealed connection cipher at gate-probe time is the later
  secrets-delegation slice.

- Updated dependencies [9e93fe8]
- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [edf4e69]
- Updated dependencies [f21279e]
- Updated dependencies [ab7d589]
- Updated dependencies [6c51e31]
- Updated dependencies [33687cf]
  - @cat-factory/contracts@0.77.0
  - @cat-factory/kernel@0.67.0
  - @cat-factory/integrations@0.52.0
  - @cat-factory/orchestration@0.54.0
  - @cat-factory/agents@0.25.0
  - @cat-factory/prompt-fragments@0.9.32
  - @cat-factory/spend@0.10.62

## 0.63.3

### Patch Changes

- 3135ae8: Make GitLab a first-class auth identity on the hosted (Cloudflare Worker + Node) path.

  **Wire hosted PAT sign-in into the Cloudflare Worker.** The Worker now registers the PAT-login
  identity registry (`vcsIdentity`) like the Node facade — GitHub always, GitLab when a GitLab
  connection is configured (`GITLAB_TOKEN` / `config.gitlab.enabled`) — so a user can sign in by
  pasting their own GitHub **or** GitLab PAT at `/auth/pat`. Previously the Worker wired none,
  leaving it OAuth-only; since GitLab has no OAuth browser flow, a GitLab user had no way to sign
  in to a Worker deployment at all, even though its engine already gated CI and merged on GitLab.
  `/auth/config` now advertises `patLogin.providers` accordingly, so the SPA renders the PAT form.

  **Implement `GitLabIdentityResolver.resolveOrgs`.** A hosted deployment admits a pasted PAT only
  when the account's login, an org/group it belongs to, or its email domain is allowlisted. Only
  `GitHubIdentityResolver` implemented `resolveOrgs`, so `isPatIdentityAllowed`'s org branch was
  skipped for GitLab — a GitLab account could be a primary identity via `AUTH_ALLOWED_LOGINS` or
  `AUTH_ALLOWED_EMAIL_DOMAINS`, but never `AUTH_ALLOWED_ORGS`. The resolver now enumerates the
  user's GitLab **group** memberships (`GET /groups?min_access_level=10`, lowercased full paths, so
  only groups the user actually belongs to admit), bringing group-based admission to parity with
  GitHub org admission.

  **Bound and diagnose PAT-login org/group admission.** Both `resolveOrgs` implementations
  (GitHub `/user/orgs`, GitLab `/groups`) now follow `Link: rel="next"` pagination up to a ~1000-entry
  cap (and `logger.warn` on truncation, wired from each facade — Node included), so a user whose only
  allowlisted org/group sat past the first 100 is no longer wrongly denied. When org enumeration fails
  because a token can authenticate `/user` but lacks the broader org/group-read scope
  (`read:org` / `read_api`), the `/auth/pat` 403 now hints at the missing scope instead of a flat
  "not allowed", and a hosted deployment's missing-token prompt tells the user to paste their PAT
  rather than to set an env var they don't control.

  Comment-only touches to `@cat-factory/server`'s `AuthController`, the kernel `VcsIdentityRegistry`
  doc, and the SPA login screen to correct the now-stale "hosted facades are OAuth-only" notes.

## 0.63.2

### Patch Changes

- 39534d6: Mothership mode: allow-list `agentRunRepository.getRef`, so the board's run controls (retry /
  stop a failed or running run) are functional for execution runs in a no-Postgres mothership-mode
  local node.

  Wiring fix (both facades): `agentRunRepository` is the one repo surfaced on the container OUTSIDE
  `CoreDependencies`, so the mothership `repositories` registry (`ServerContainer.repositories`,
  reflected by `/internal/persistence`) was built from `dependencies` alone and did not carry it —
  a remote `getRef` call came back `Repository 'agentRunRepository.getRef' is not wired`. Both
  `buildNodeContainer` and the Cloudflare `buildContainer` now fold it into the registry explicitly,
  so either facade acting as a mothership serves the retry/stop `getRef` read.

  `AgentRunController` (`POST /workspaces/:ws/agent-runs/:id/{retry,stop}`) resolves a run's KIND via
  `agentRunRepository.getRef(workspaceId, id)` before dispatching to the matching service. That read
  was the last thing on the execution-run retry/stop path still coming back `unknown_method` over
  `/internal/persistence`. It is now allow-listed, workspace-scoped on arg0 (reusing the existing
  `workspace` rule — resolve the owning account, reject out-of-scope as 404). Every downstream
  read+write the execution retry/stop services make (`executionRepository.get`/`deleteByBlock`/
  `upsert`/`markFailed`, `blockRepository.update`, `pipelineRepository.get`, the budget/binary-storage
  prechecks) was already exposed on the run/start path, so `getRef` is the only new entry.

  The bootstrap + env-config-repair retry BRANCHES read their own repos (`bootstrapJobRepository.get`,
  `referenceArchitectureRepository.get`, …) and stay `pending` — a later slice. The sweeper-only
  `agentRunRepository.listStale`/`liveRunIds` stay mothership-internal.

  Server-only allow-list change, symmetric by construction (the dispatcher reflects over each facade's
  registry). Round-trip + cross-account-scope + off-allow-list unit tests cover it; the static
  allow-list drift guard moves `getRef` out of `pending`; and the fake-mothership integration test
  asserts the retry endpoint resolves a run's kind over the real RPC and 404s an unknown run id.

## 0.63.1

### Patch Changes

- eab2b60: Mothership mode: allow-list the workspace-scoped settings / preset / recurring-schedule
  management WRITE methods, so the settings panels are functional (not read-only) in a
  no-Postgres mothership-mode local node.

  Previously only the board-load READS of these repositories were remotely callable over
  `/internal/persistence`, so a mothership-mode SPA could display settings but not save them
  (every write came back `unknown_method`). Newly allow-listed — each takes the workspaceId as
  arg0, reusing the existing `workspace` scope rule, and each is member-level (none is
  admin-gated), matching the block/pipeline mutation policy already exposed:

  - `workspaceSettingsRepository.upsert`, `trackerSettingsRepository.put`,
    `serviceFragmentDefaultsRepository.set` — the workspace settings panels' saves.
  - `mergePresetRepository` / `modelPresetRepository` `get` + `remove` — completing both
    preset libraries' CRUD (`list`/`getDefault`/`upsert` were already exposed).
  - `pipelineScheduleRepository` `get`/`upsert`/`remove`/`insertRun`/`updateRun`/`listRuns` —
    the recurring-pipeline management surface (`RecurringPipelineService` CRUD + `runNow`,
    which fires in-process). The sweeper-only `listDue`/`pruneRunsBefore` and the serviceId-keyed
    `listByService` stay mothership-internal.

  Server-only allow-list change, symmetric by construction (the dispatcher reflects over each
  facade's registry). Round-trip + cross-account-scope tests cover every new method; the static
  allow-list drift guard moves them out of `pending`.

## 0.63.0

### Minor Changes

- 762fe66: Add a first-class `frontend`-frame configuration. A frontend frame now carries a
  `frontendConfig` (package manager, install/build/serve knobs, WireMock mappings path,
  preview toggle) plus `backendBindings` that map each env var the frontend reads to an
  upstream: a bound service frame's ephemeral environment, or a WireMock stub. The bindings
  double as board links, drawn as frontend→service edges on the canvas. New inspector panel
  (`FrontendConfig.vue`), the `frontend_config` JSON column mirrored across D1 and Drizzle
  with a cross-runtime conformance round-trip, and `frontendConfig` on the update-block input.

  Second slice of the frontend-preview + in-context UI-testing initiative
  (docs/initiatives/frontend-preview-ui-testing.md).

### Patch Changes

- Updated dependencies [762fe66]
  - @cat-factory/contracts@0.76.0
  - @cat-factory/agents@0.24.16
  - @cat-factory/integrations@0.51.4
  - @cat-factory/kernel@0.66.1
  - @cat-factory/orchestration@0.53.2
  - @cat-factory/prompt-fragments@0.9.31
  - @cat-factory/spend@0.10.61

## 0.62.3

### Patch Changes

- Updated dependencies [fb53662]
  - @cat-factory/kernel@0.66.0
  - @cat-factory/contracts@0.75.0
  - @cat-factory/orchestration@0.53.1
  - @cat-factory/agents@0.24.15
  - @cat-factory/integrations@0.51.3
  - @cat-factory/spend@0.10.60
  - @cat-factory/prompt-fragments@0.9.30

## 0.62.2

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/contracts@0.74.0
  - @cat-factory/kernel@0.65.0
  - @cat-factory/orchestration@0.53.0
  - @cat-factory/agents@0.24.14
  - @cat-factory/integrations@0.51.2
  - @cat-factory/prompt-fragments@0.9.29
  - @cat-factory/spend@0.10.59

## 0.62.1

### Patch Changes

- d4d4cbc: Make credential-decryption failures actionable and isolate them.

  Previously, a stored secret sealed under a rotated/regenerated `ENCRYPTION_KEY` surfaced as
  the opaque Web Crypto `OperationError` ("The operation failed for an operation-specific
  reason") with no context — e.g. an inline requirements-review run failed at step 0 with that
  bare message and no detail, because the reviewer leases + decrypts the workspace's provider
  API keys before any LLM call (outside its own error-wrapping).

  - `WebCryptoSecretCipher.decrypt` now rethrows an actionable error on an AES-GCM auth failure,
    naming `ENCRYPTION_KEY` and the likely key-rotation cause, preserving the original as `cause`.
  - `ApiKeyService.lease` wraps a decrypt failure with the offending provider + key id.
  - `createScopedModelProviderResolver.forScope` no longer lets ONE provider's undecryptable key
    sink the whole scoped provider: it registers a deferred-failure resolver for that provider, so
    calls targeting a different, healthy provider still resolve and only a call that actually needs
    the broken provider fails (with the real cause).

- Updated dependencies [d4d4cbc]
  - @cat-factory/integrations@0.51.1
  - @cat-factory/orchestration@0.52.1

## 0.62.0

### Minor Changes

- 3643708: Custom manifest types can now declare an optional `defaultManifestPath` and `fixerPrompt`.
  A `custom` service prefills its manifest path from the type's default on selection, and
  "Detect from repo" resolves the path monorepo-aware (keep an accurate current value; else
  the exact default within the service subtree/repo root; else, for a bare filename, one level
  deep; else pre-fill the default location). A new **Generate / fix manifest** button (shown
  only when the type defines a `fixerPrompt`) dispatches the fixer coding agent — reusing the
  durable `env-config-repair` run — to create the manifest at the entered path or fix it when
  invalid, after best-effort `validateRepo`. Adds the `default_manifest_path` / `fixer_prompt`
  columns to `custom_manifest_types` on both runtimes (D1 + Drizzle).

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/contracts@0.73.0
  - @cat-factory/kernel@0.64.0
  - @cat-factory/integrations@0.51.0
  - @cat-factory/orchestration@0.52.0
  - @cat-factory/agents@0.24.13
  - @cat-factory/prompt-fragments@0.9.28
  - @cat-factory/spend@0.10.58

## 0.61.0

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
  - @cat-factory/agents@0.24.12
  - @cat-factory/integrations@0.50.2
  - @cat-factory/kernel@0.63.4
  - @cat-factory/orchestration@0.51.7
  - @cat-factory/prompt-fragments@0.9.27
  - @cat-factory/spend@0.10.57

## 0.60.3

### Patch Changes

- 37c488f: Internal refactor of mothership-mode code (no behaviour change): share one `node:sqlite` open
  helper between the local credential store and work queue, make `statusForPersistenceError` a
  lookup table, inline the trivial mothership db-path wrappers, bind `pickRepoSource` through a
  local `sourced` helper (collapsing the repeated `remoteRepos`/`db` wiring, including the five
  GitHub projection repos) in the Node container, and centralize the mothership-vs-Postgres
  persistence decision in the local container behind a single `resolveLocalPersistence` helper.

## 0.60.2

### Patch Changes

- Updated dependencies [b744822]
- Updated dependencies [c40736e]
  - @cat-factory/integrations@0.50.1
  - @cat-factory/orchestration@0.51.6

## 0.60.1

### Patch Changes

- Updated dependencies [77c6842]
  - @cat-factory/contracts@0.71.0
  - @cat-factory/integrations@0.50.0
  - @cat-factory/agents@0.24.11
  - @cat-factory/kernel@0.63.3
  - @cat-factory/orchestration@0.51.5
  - @cat-factory/prompt-fragments@0.9.26
  - @cat-factory/spend@0.10.56

## 0.60.0

### Minor Changes

- 91f876b: Mothership-mode tech-debt cleanup (functionality-preserving): rename the persistence
  allow-list export `PILOT_PERSISTENCE_METHODS` → `REMOTE_PERSISTENCE_METHODS` (it is the
  functional surface, no longer a pilot) and drop the unused `accountField` `ScopeRule` kind
  that was defined but never allow-listed or exercised. Also refresh stale comments/docs that
  predated the Phase-3 merge gate (which is now MET): the `MothershipComposition.repos` JSDoc,
  the `buildNodeContainer` `db: undefined` service-matrix note, and the mothership-mode tracker
  banner. No runtime behavior change.

### Patch Changes

- Updated dependencies [79a0f48]
  - @cat-factory/integrations@0.49.0
  - @cat-factory/orchestration@0.51.4

## 0.59.2

### Patch Changes

- 2e1354f: Improve the Kubernetes per-type engine configurator:

  - **k3s feedback** — picking the `local-k3s` engine now prefills the engine form's loopback
    defaults (API server `https://127.0.0.1:6443`, label, skip-TLS) and shows a hint banner that
    explains the prefill and how to mint a ServiceAccount token, instead of leaving the form
    unchanged. Switching back to `remote-kubernetes` clears those local-only defaults. k3s/k3d/kind
    share the same loopback defaults, so they remain one preset rather than separate options.
  - **Test connection** — the Kubernetes engine form (workspace + per-user override) gains a working
    "Test connection" button. A new `POST /workspaces/:ws/environments/handlers/test` endpoint lowers
    the engine config to a backend config and reaches the apiserver with the supplied token (nothing
    persisted), reusing the existing connection-probe path. Reported as `{ ok, message }`.

- Updated dependencies [2e1354f]
  - @cat-factory/contracts@0.70.1
  - @cat-factory/kernel@0.63.2
  - @cat-factory/integrations@0.48.2
  - @cat-factory/agents@0.24.10
  - @cat-factory/orchestration@0.51.3
  - @cat-factory/prompt-fragments@0.9.25
  - @cat-factory/spend@0.10.55

## 0.59.1

### Patch Changes

- Updated dependencies [66a8c71]
  - @cat-factory/integrations@0.48.1
  - @cat-factory/orchestration@0.51.2

## 0.59.0

### Minor Changes

- b4c7e60: Provisioning auto-detection now prioritizes the option matching the user's selected
  provision-type tab.

  The "Detect from repo" affordance sends the currently-selected tab (`kubernetes` vs
  `docker-compose`) as a new optional `prefer` field on `POST /environments/detect-provisioning`.
  The detector honors it: on the `docker-compose` tab a compose file wins when present (even if
  Kubernetes manifests also exist, surfaced as a low-confidence "switch to kubernetes" hint),
  falling back to the other kind when the preferred one isn't found. With no preference (or any
  non-compose tab) it keeps the historical kubernetes-first order, so existing behavior is
  unchanged unless a caller opts in.

### Patch Changes

- Updated dependencies [b4c7e60]
  - @cat-factory/contracts@0.70.0
  - @cat-factory/integrations@0.48.0
  - @cat-factory/agents@0.24.9
  - @cat-factory/kernel@0.63.1
  - @cat-factory/orchestration@0.51.1
  - @cat-factory/prompt-fragments@0.9.24
  - @cat-factory/spend@0.10.54

## 0.58.0

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
  - @cat-factory/agents@0.24.8
  - @cat-factory/integrations@0.47.1
  - @cat-factory/spend@0.10.53
  - @cat-factory/prompt-fragments@0.9.23

## 0.57.0

### Minor Changes

- 41203db: Per-service provision types (slice 11): auto-detect a recommended Kubernetes provisioning
  config from a service's repo.

  A deterministic, pure-TS heuristic detector reads a service's repo checkout-free over the
  `RepoFiles` port and proposes a NON-BINDING recommended provisioning config. High-confidence
  facts are inferred deterministically (renderer from a `kustomization.yaml`; the URL source from
  the manifest kinds — `Ingress`/`Gateway`/`HTTPRoute`/`LoadBalancer Service`; a pinned namespace;
  `generatorEnvFile` secret injections with keys read from a `.env.example`; image overrides
  defaulting the tag to `{{branch}}`); ambiguous ones (which `overlays/*` is the ephemeral one,
  helm releases from a `helmfile.yaml`/`Chart.yaml`) are surfaced as candidates with a hint
  rather than guessed. The user always confirms/edits — nothing is applied silently.

  - Contracts: `provisioningRecommendationSchema` + `detectServiceProvisioningSchema` +
    `detectServiceProvisioningContract` (`POST /workspaces/:ws/environments/detect-provisioning`).
  - `EnvironmentConnectionService.detectServiceProvisioning` runs the detector over the
    workspace-bound `RepoFiles`; new `provision-detect.logic.ts` with unit tests.
  - Frontend: a "Detect from repo" affordance in the service inspector's test-infra section that
    prefills `block.provisioning` + surfaces the per-field confidence notes, overlay candidates,
    and engine-level URL/namespace suggestions; new i18n keys across all 8 locales.

  No migration (detection is pure repo introspection — nothing persisted).

### Patch Changes

- Updated dependencies [41203db]
  - @cat-factory/contracts@0.68.0
  - @cat-factory/integrations@0.47.0
  - @cat-factory/agents@0.24.7
  - @cat-factory/kernel@0.62.4
  - @cat-factory/orchestration@0.50.1
  - @cat-factory/prompt-fragments@0.9.22
  - @cat-factory/spend@0.10.52

## 0.56.1

### Patch Changes

- 3ec9c90: Widen the mothership-mode persistence allow-list (`PILOT_PERSISTENCE_METHODS`) to cover the
  org/durable repository methods the run lifecycle exercises — merge-preset `getDefault`, service
  `getByFrameBlock`, notification/requirement-review `get`, requirement-review `upsert`, kaizen
  grade `getByStep`/`upsert`, the kaizen run-path LLM-metric summary, and the env-config-repair +
  kaizen-combo run-path reads — each bound by a scope rule (admin-gated and sweeper methods stay
  mothership-internal). This is what makes a no-Postgres mothership-mode node drive a full run
  to a persisted terminal state over the remote RPC.

  Adds a cross-runtime `[mothership]` conformance configuration (the shared suite's execution
  group run against a real in-process Node mothership) and a static allow-list completeness guard,
  so a new Drizzle repository or method that isn't proxied — or is mis-scoped — fails a test
  instead of a developer's first board load.

## 0.56.0

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
  - @cat-factory/agents@0.24.6
  - @cat-factory/kernel@0.62.3
  - @cat-factory/prompt-fragments@0.9.21
  - @cat-factory/spend@0.10.51

## 0.55.2

### Patch Changes

- Updated dependencies [1e55e77]
  - @cat-factory/contracts@0.66.1
  - @cat-factory/integrations@0.45.0
  - @cat-factory/orchestration@0.49.0
  - @cat-factory/agents@0.24.5
  - @cat-factory/kernel@0.62.2
  - @cat-factory/prompt-fragments@0.9.20
  - @cat-factory/spend@0.10.50

## 0.55.1

### Patch Changes

- Updated dependencies [ecf4cc1]
  - @cat-factory/contracts@0.66.0
  - @cat-factory/orchestration@0.48.2
  - @cat-factory/agents@0.24.4
  - @cat-factory/integrations@0.44.1
  - @cat-factory/kernel@0.62.1
  - @cat-factory/prompt-fragments@0.9.19
  - @cat-factory/spend@0.10.49

## 0.55.0

### Minor Changes

- f9678df: Mothership mode (Phase 3 slice 1): widen the persistence-RPC allow-list to the workspace-scoped
  board-load read surface. `PILOT_PERSISTENCE_METHODS` now exposes the reads a `GET /workspaces/:id`
  snapshot assembles — `workspaceMountRepository.listByWorkspace`, `workspaceSettingsRepository.get`,
  `mergePresetRepository.list`, `modelPresetRepository.list`, `serviceFragmentDefaultsRepository.get`,
  `pipelineScheduleRepository.list`/`getByBlock`, `trackerSettingsRepository.get`,
  `notificationRepository.listOpen`, `bootstrapJobRepository.listByWorkspace`,
  `tokenUsageRepository.totalsSinceForWorkspace`, and the per-block reviews
  (`requirementReviewRepository.getByBlock`, `clarityReviewRepository.getByBlock`,
  `brainstormSessionRepository.getByBlockStage`).

  Every newly-listed method takes the workspaceId as arg0, so they reuse the existing `workspace`
  scope rule (resolve the owning account; reject anything outside the machine token's scope as 404).
  Reads only — no new mutation is exposed, and the admin-gated mutations / global sweeper reads stay
  excluded. No registry change was needed: the dispatcher already reflects over the full
  `CoreDependencies` object, so allow-listing a method is enough. Round-trip + cross-account-scope
  tests for every newly-listed method are in `packages/server/test/persistenceRpc.spec.ts`.

  Still a DRAFT-gated initiative (see `docs/initiatives/mothership-mode.md`): the cross-service +
  entity-id-keyed reads (which need a new scope kind), routing the direct-db stores through the
  remote registry, and the fake-mothership integration test remain before the mothership boot can
  ship.

- f9678df: Mothership mode (Phase 3 slice 2): widen the persistence-RPC allow-list to the cross-service
  entity-id-keyed board-composition reads, via two new scope kinds that resolve the entity's owning
  account server-side before the scope check.

  - `serviceList` (arg0 = `serviceIds[]`): resolve each service's owning account; EVERY requested id
    must be in scope (a missing or out-of-scope service fails closed as 404); an empty list is a
    no-op read that binds no service. Exposes `serviceRepository.listByIds`,
    `blockRepository.listByServices`, `executionRepository.listByServices`,
    `bootstrapJobRepository.listByServices`, `pipelineScheduleRepository.listByServices`, and
    `workspaceMountRepository.countByServiceIds`.
  - `block` (arg0 = blockId, no workspace arg): resolve the block's home workspace, then that
    workspace's account. Exposes `blockRepository.findById`.
  - `serviceRepository.listByAccount` reuses the existing `account` rule, so the `null` (auth-disabled,
    unscoped) org listing is refused over a scoped machine token.

  The two resolvers (`resolveBlockAccountId`, `resolveServiceAccountIds`) are wired in
  `PersistenceController` and the dispatcher fails closed when a kind's resolver is absent. Round-trip,
  cross-account-scope, unknown-id, and empty-list tests for every newly-listed method are in
  `packages/server/test/persistenceRpc.spec.ts`.

  `subscriptionActivationRepository.deleteByExecution` is deliberately NOT exposed: per the per-repo
  bucket checklist it is the local-sqlite bucket, not the remote surface.

  Still a DRAFT-gated initiative (see `docs/initiatives/mothership-mode.md`): routing the direct-db
  stores through the remote registry when `db` is undefined, and the fake-mothership integration test,
  remain before the mothership boot can ship.

- f9678df: Mothership mode (Phase 3 slice 4): the fake-mothership functional integration test — the merge
  gate's exit criteria — plus the agent-context run-path repo surface it surfaced.

  New test `runtimes/local/test/mothership-integration.spec.ts` boots a stock Node mothership
  (`buildNodeContainer` over real Postgres) on a 127.0.0.1 loopback and a no-Postgres mothership-mode
  `buildLocalContainer` whose `CoreRepositories` are the RPC-backed remote registry pointing at it,
  then asserts the two things the build-only tests can't: a board **loads** over the remote
  persistence RPC, and a run **drives to a persisted terminal state** (`done`) over it, with the
  execution read back straight from the mothership's Postgres. Only the agent executor is faked; the
  whole persistence path is real, so an un-allow-listed method, a mis-scoped call, or an unrouted
  direct-db store fails the test instead of a developer's first board load.

  Standing it up surfaced that `AgentContextBuilder` resolves a block's linked docs/tasks and its
  provisioned environment on EVERY agent dispatch — so those feature-flagged sub-helper repos are on
  the board-load + run path, not off it as previously assumed. Fixes:

  - `@cat-factory/node-server`: in mothership mode (`db` undefined) route the context-builder
    run-path repos — `documentRepository`, `taskRepository`, `environmentRegistryRepository` /
    `environmentConnectionRepository` — from the remote registry (the sub-helpers built them directly
    over the absent `db`). Their connect/provision surfaces stay db-direct (off the run path).
  - `@cat-factory/server`: widen `PILOT_PERSISTENCE_METHODS` to the run/board methods the path
    exercises, each workspace-scoped: `documentRepository.{listByBlock,get,getByUrl}`,
    `taskRepository.{listByBlock,get,getByUrl}`, `environmentRegistryRepository.{getByBlock,get}`, the
    run-start `modelPresetRepository.getDefault`, the board-load lazy default-preset seeds
    `mergePresetRepository.upsert` / `modelPresetRepository.upsert`, and the completion notification
    raise + inbox transitions `notificationRepository.{findOpenByBlock,upsertOpenForBlock,upsert}`.
    (`*.getByUrl` resolves a URL named in a block's description, and `notificationRepository.upsert`
    backs block-less raises + inbox act/dismiss/escalate — both squarely on the same run/post-run
    path as the reads they sit next to, so omitting them would fail any task whose description
    contains a link, or any inbox action after a run.) Round-trip + cross-account-scope unit tests
    for each are added to `persistenceRpc.spec.ts`, and the integration test patches a task with a
    URL + Jira/GitHub refs and enables the environment integration so these reads round-trip over the
    RPC end-to-end (not just in the unit suite).

  Still DRAFT-gated (`docs/initiatives/mothership-mode.md`): decrypting a remotely-sealed provisioned
  environment's access cipher needs the mothership's key (a later secrets-delegation slice); the
  kaizen-grading, LLM-metric and subscription-activation calls a run also makes degrade as best-effort
  no-ops over the remote (telemetry is Phase 5 local-first; activation is the local-sqlite bucket); and
  the remaining sub-helper surfaces (fragments / slack connect/provision) are follow-ups.

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

- f9678df: Mothership Phase 3 review fixes:

  - `ExecutionService.start` now clears a replaced block's prior per-run subscription activation
    best-effort (try/catch), mirroring the terminal cleanup in `RunStateMachine.emit`. In mothership
    mode `subscriptionActivationRepository` is remote and `deleteByExecution` is not yet allow-listed
    (it throws `unknown_method`), so the previously-unguarded call would break re-running any block;
    the TTL sweep reclaims the stale row as the backstop.
  - The persistence RPC controller memoises the `block` / `serviceList` scope reads
    (`blockRepository.findById` / `serviceRepository.listByIds`) per request, so when the request
    also dispatches that same read it reuses the resolver's result instead of issuing a second
    identical query.

- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [858799e]
  - @cat-factory/contracts@0.65.0
  - @cat-factory/orchestration@0.48.1
  - @cat-factory/kernel@0.62.0
  - @cat-factory/integrations@0.44.0
  - @cat-factory/agents@0.24.3
  - @cat-factory/prompt-fragments@0.9.18
  - @cat-factory/spend@0.10.48

## 0.54.0

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
  - @cat-factory/agents@0.24.2
  - @cat-factory/kernel@0.61.1
  - @cat-factory/prompt-fragments@0.9.17
  - @cat-factory/spend@0.10.47

## 0.53.0

### Minor Changes

- 15c5894: feat(auth): remote node mode — surface the unauthenticated state and support PAT sign-in.

  - A remote facade (node service / Worker) has no anonymous tier, so once the auth handshake
    resolves with no signed-in user the SPA now routes to the login screen — even when the
    backend reports auth "disabled" (a dev-open / unconfigured remote). Previously this dropped
    the user onto a board where every per-user action silently failed with no sign-in affordance.
    An unreachable backend still falls through to the board's own error UI.
  - Source-control PAT sign-in now works on the remote node facade: a user pastes their own
    GitHub/GitLab PAT and is resolved to the account it belongs to. A hosted PAT login is held
    to the SAME login/org/domain allowlist as GitHub OAuth (admit when the login, an org it
    belongs to, or its email domain is allowlisted; fail closed when none are configured). Local
    mode keeps its configured-token, allowlist-exempt flow. `GET /auth/config` advertises the
    available PAT providers and the login screen renders a PAT option alongside OAuth/password;
    when a remote deployment has no sign-in method at all the screen explains that instead of
    showing a blank card.
  - New `TESTING_NO_AUTH` escape hatch (test-only, refused in a production-like ENVIRONMENT):
    a stronger `AUTH_DEV_OPEN` that both leaves the API open AND advertises (via `GET
/auth/config`) that the SPA may render the board anonymously instead of gating to login. The
    e2e suite opts into it; `AUTH_DEV_OPEN` on its own keeps the SPA's login gate, since a
    dev-open remote still has no anonymous tier.

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/contracts@0.63.0
  - @cat-factory/kernel@0.61.0
  - @cat-factory/agents@0.24.1
  - @cat-factory/integrations@0.42.1
  - @cat-factory/orchestration@0.47.1
  - @cat-factory/prompt-fragments@0.9.16
  - @cat-factory/spend@0.10.46

## 0.52.0

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
  - @cat-factory/spend@0.10.45
  - @cat-factory/prompt-fragments@0.9.15

## 0.51.3

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/kernel@0.59.0
  - @cat-factory/contracts@0.61.0
  - @cat-factory/agents@0.23.4
  - @cat-factory/integrations@0.41.1
  - @cat-factory/orchestration@0.46.1
  - @cat-factory/spend@0.10.44
  - @cat-factory/prompt-fragments@0.9.14

## 0.51.2

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/kernel@0.58.0
  - @cat-factory/contracts@0.60.0
  - @cat-factory/integrations@0.41.0
  - @cat-factory/orchestration@0.46.0
  - @cat-factory/agents@0.23.3
  - @cat-factory/spend@0.10.43
  - @cat-factory/prompt-fragments@0.9.13

## 0.51.1

### Patch Changes

- Updated dependencies [6009266]
  - @cat-factory/agents@0.23.2
  - @cat-factory/integrations@0.40.1
  - @cat-factory/kernel@0.57.1
  - @cat-factory/orchestration@0.45.3
  - @cat-factory/spend@0.10.42

## 0.51.0

### Minor Changes

- bd23c46: Add the mothership-mode persistence-RPC spine (the pilot core of the mothership-mode
  initiative). A new machine-token audience (`TOKEN_AUDIENCE.machine`) and a reflective
  `POST /internal/persistence` endpoint let a mothership-mode local node forward its
  org/durable repository calls to a hosted mothership: the controller reflects over a
  facade-attached repository registry (`ServerContainer.repositories`) and enforces a per-repo
  method allow-list plus per-call account scoping (an out-of-scope call is a 404, no existence
  leak). The client side ships `createRemoteRepositories` — a `Proxy`-backed `CoreRepositories`
  subset whose wire envelope round-trips `undefined`/`null`, writes a mutated `execution.rev`
  back in place (the optimistic-concurrency contract), and re-throws `DomainError`s. The
  endpoint 503s on any facade that has not attached its repository registry, so existing
  deployments are unaffected.

### Patch Changes

- 1952d6b: Per-service provision types (slice 1 — additive foundation). Adds the
  `provisionType`/`infraEngine`/`serviceProvisioning`/`infraHandlerConfig` and
  custom-manifest-type contracts, a `provisioning` field on the service-frame `Block`
  (persisted as a JSON column on both runtimes and settable via the block update endpoint),
  and `provisionType`/`engine` fields on the environment handle. Introduces the per-user
  infra handler override table (`environment_user_handlers`, local-mode) and the workspace
  custom-manifest-type catalog (`custom_manifest_types`) — mirrored across D1 and Drizzle
  with a cross-runtime conformance suite — plus `provision_type`/`engine` columns on the
  `environments` registry. No behaviour is wired yet; the single→multi reshape of
  `environment_connections`, the resolver, and the UI follow in later slices. See
  `docs/initiatives/per-service-provision-types.md`.
- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/contracts@0.59.0
  - @cat-factory/kernel@0.57.0
  - @cat-factory/integrations@0.40.0
  - @cat-factory/agents@0.23.1
  - @cat-factory/orchestration@0.45.2
  - @cat-factory/prompt-fragments@0.9.12
  - @cat-factory/spend@0.10.41

## 0.50.3

### Patch Changes

- Updated dependencies [2ac148d]
  - @cat-factory/integrations@0.39.0
  - @cat-factory/orchestration@0.45.1

## 0.50.2

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/orchestration@0.45.0
  - @cat-factory/contracts@0.58.0
  - @cat-factory/agents@0.23.0
  - @cat-factory/integrations@0.38.1
  - @cat-factory/kernel@0.56.1
  - @cat-factory/prompt-fragments@0.9.11
  - @cat-factory/spend@0.10.40

## 0.50.1

### Patch Changes

- 1ff013f: Add fail-fast guards that surface invalid state early and loudly instead of letting it
  flow silently into the domain.

  - **Persistence read boundary** (`@cat-factory/server`): a new `decode` helper
    (`decodeEnum`/`decodeEnumOr`/`decodeJson`/`tryDecodeRow`/`tryDecodeRows` + `DataIntegrityError`)
    re-asserts the Valibot wire contract at row→domain mapping time, replacing erased
    `as SomeType` casts. Wired through the shared mappers (block status/level, `depends_on`,
    and `rowToExecution` — which now rejects an empty `block_id` and an out-of-bounds
    `currentStep`) and, symmetrically across both runtimes, the agent-run kind, notification
    type/status/severity, and subscription vendor reads. A corrupt enum/JSON now logs with
    row context and throws a 500 (engine-critical) or degrades (cosmetic) rather than
    smuggling a fake-valid value downstream. Snapshot-facing list reads (block + execution
    `listByWorkspace`/`listByService`/`listByServices` on both runtimes) decode through
    `tryDecodeRows`, so one corrupt row is logged and dropped instead of failing the whole
    board load — the single-row `get`/`getByBlock` point reads keep the loud throw.
  - **Execution engine** (`@cat-factory/orchestration`): `disposeReview` rejects a
    non-positive iteration cap / sub-1 counter; `StepGraph.loopCompanionProducer` replaces
    `companion!`/`steps[-1]!` force-unwraps with diagnostic guards.
  - **Gates** (`@cat-factory/gates`): `warnUnwiredGates(logger)` logs (once per gate per
    process) any built-in gate left as a silent pass-through, so a deployment that forgot to
    wire the GitHub App no longer auto-merges without checking CI. Called at both facades'
    container build.

  Scope notes: lower-severity source-kind casts and deep JSON-blob shape validation are
  deliberately deferred (the primitives are in place to extend to them). No guards were
  added inside the durable drive path (e.g. `finalizeBlock`) where a throw would wedge the
  retry loop, and the intentional Node-vs-Cloudflare container-executor fail-mode asymmetry
  is left unchanged.

- Updated dependencies [1ff013f]
  - @cat-factory/orchestration@0.44.1

## 0.50.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/contracts@0.57.0
  - @cat-factory/kernel@0.56.0
  - @cat-factory/orchestration@0.44.0
  - @cat-factory/integrations@0.38.0
  - @cat-factory/agents@0.22.6
  - @cat-factory/prompt-fragments@0.9.10
  - @cat-factory/spend@0.10.39

## 0.49.6

### Patch Changes

- Updated dependencies [fdeb466]
  - @cat-factory/kernel@0.55.4
  - @cat-factory/orchestration@0.43.4
  - @cat-factory/integrations@0.37.1
  - @cat-factory/agents@0.22.5
  - @cat-factory/spend@0.10.38

## 0.49.5

### Patch Changes

- 0dd9532: Internal refactor: extract the per-kind harness job-body builders (`buildKindBody`,
  `buildRegisteredAgentBody` and `buildMigratedBuiltInBody`) out of
  `ContainerAgentExecutor.ts` into a dedicated `jobBody.ts` module as free functions over a
  shared `KindBodyParts`, re-imported at the single `buildJobBody` call site. The existing
  `containerAgentJobBody.spec.ts` snapshots (driven through the public `startJob`) stay
  byte-identical. Pure code move — no behaviour, API, or wiring change.

## 0.49.4

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
  - @cat-factory/contracts@0.56.1
  - @cat-factory/agents@0.22.4
  - @cat-factory/kernel@0.55.3
  - @cat-factory/prompt-fragments@0.9.9
  - @cat-factory/spend@0.10.37

## 0.49.3

### Patch Changes

- 123336c: Internal refactor: extract the per-kind prompt material (the blueprint/spec-writer/merger/
  on-call system prompts, the structured-output shape hints, and the
  `blueprintUserPrompt`/`specWriterUserPrompt`/`mergerUserPrompt`/`onCallUserPrompt`/
  `testerInfraSpec`/`prBody` builders) out of `ContainerAgentExecutor.ts` into a dedicated
  `prompts.ts` module, with co-located characterisation tests. Pure code move — no behaviour,
  API, or wiring change.

## 0.49.2

### Patch Changes

- 4ec514a: Internal refactor: extract the runner-output → engine-result normalisation (`toRunResult`
  and its per-kind coercions) out of `ContainerAgentExecutor.ts` into a dedicated
  `containerAgentResult.ts` module, with co-located characterisation tests. Pure code move —
  no behaviour, API, or wiring change.

## 0.49.1

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
  - @cat-factory/agents@0.22.3
  - @cat-factory/integrations@0.36.1
  - @cat-factory/kernel@0.55.2
  - @cat-factory/orchestration@0.43.2
  - @cat-factory/prompt-fragments@0.9.8
  - @cat-factory/spend@0.10.36

## 0.49.0

### Minor Changes

- 4897078: Make the ephemeral-environment AND self-hosted runner-pool backend registries extensible to
  custom third-party kinds, so a single-tenant / self-hosted deployment can register a bespoke
  provider **programmatically** (an import side effect via `registerEnvironmentBackend` /
  `registerRunnerBackend`), mirroring custom agent kinds. This restores the capability the
  removed `buildNodeContainer({ environmentProvider })` / `startLocal({ environmentProvider })`
  deployment-wide injection used to provide, and serves both single- and multi-tenant.

  - **Contracts (breaking, additive):** `environmentBackendConfigSchema` /
    `runnerBackendConfigSchema` gain a generic custom-kind member (a lower-kebab `kind` slug,
    guarded to exclude the reserved built-ins, carrying the subsystem manifest body), so a
    custom kind's connect config validates with no new variant. The workspace snapshot gains
    `environmentBackendKinds` / `runnerBackendKinds`, and the describe routes accept an optional
    `kind` query. Existing `manifest`/`kubernetes` rows still parse — no migration.
  - **Registries:** `EnvironmentBackendProvider` / `RunnerBackendProvider` `kind` is now an open
    `string` with an optional `displayLabel`; new `environmentBackendKinds()` /
    `runnerBackendKinds()` accessors. `describeProvider(workspaceId, kind?)` can describe a
    registered kind before it is connected.
  - **Frontend:** the provider-connect backend-kind selector is snapshot-driven (built-in
    fallback) instead of a hardcoded `manifest`/`kubernetes` list; a custom kind's flat-form /
    manifest-editor save is tagged with its slug.
  - A custom kind requires a per-workspace connection (the encrypted-secret + `providerConfig`
    anchor) exactly like the built-ins. The `runnerPoolProvider` facade option is unchanged and
    remains the HTTP-pool override for the manifest backend, NOT the custom-kind seam.

### Patch Changes

- Updated dependencies [4897078]
  - @cat-factory/contracts@0.55.0
  - @cat-factory/integrations@0.36.0
  - @cat-factory/agents@0.22.2
  - @cat-factory/kernel@0.55.1
  - @cat-factory/orchestration@0.43.1
  - @cat-factory/prompt-fragments@0.9.7
  - @cat-factory/spend@0.10.35

## 0.48.4

### Patch Changes

- d5a0637: Close the GitLab-vs-GitHub provider parity gaps so a GitLab deployment behaves like a GitHub
  one across every runtime facade.

  - **Facade parity (the showstopper):** the engine's CI / mergeability / PR-review gate
    providers, the PR merger, the branch updater and the checkout-free `RepoFiles` resolvers are
    now wired from a GitLab-backed client on the **Node and Cloudflare** facades too — previously
    only local mode bridged GitLab into the gates, so a stock GitLab-only Node/CF deployment did
    not gate on real CI or merge for real. Both facades now build the engine VCS client via the
    shared `buildGitLabEngineClient` (GitHub App wins when both are configured).
  - **Review provider:** `FetchGitLabClient` now implements the human-review reads
    (`getPullRequestBaseRef`, `listRequestedReviewers`, `listPullRequestReviews` +
    `getRequiredApprovingReviewCount` from GitLab approvals, `listReviewThreads` /
    `replyToReviewThread` / `resolveReviewThread` over resolvable MR discussions, plus
    `listIssueComments`).
  - **Branch update:** new optional `VcsClient.rebasePullRequest` / `GitHubClient.rebasePullRequest`
    — GitLab has no server-side merge-branch-into-branch endpoint, so the conflicts / human-testing
    gate's "pull latest base" action advances a GitLab MR branch by rebasing it; `GitHubBranchUpdater`
    prefers rebase when the client exposes it and falls back to `mergeBranch` (GitHub) otherwise.
  - **Conformance:** the cross-provider VCS client suite now asserts GitHub and GitLab normalise the
    human-review gate inputs identically and exposes the correct branch-advancing capability per
    provider; a reusable `FakeVcsClient` drives the real gate / merge / branch-update providers
    through the GitLab-backed adapter.
  - **Rebase verdict robustness:** the GitLab MR-rebase poll now sleeps before each status read (so
    a not-yet-started async rebase is never mistaken for a finished one) and decides the outcome by
    whether the source-branch head actually advanced, ignoring the persisted `merge_error` field
    (shared with merge attempts) unless the branch did not move. Covered by poll-transition,
    stale-`merge_error`, conflict and up-to-date tests.
  - **Accurate required-approval count:** `getRequiredApprovingReviewCount` now reads the effective
    per-MR `approvals_required` (it accounts for the rule on the MR's target branch) when the PR
    number is known, falling back to the project default; the port carries the PR number alongside
    the branch (GitHub still reads branch protection and ignores it).
  - **Node facade wiring:** the GitLab-backed engine client feeds only the gate / merge / RepoFiles
    seams; GitHub-issue-specific consumers (the GitHub Issues task source, issue writeback) stay
    gated on a real GitHub client, so a GitLab-only Node deployment no longer offers a
    non-functional "GitHub Issues" task source (parity with the Worker).

- 915861c: Surface the Tester's in-container docker-compose dependency stand-up logs on the test report
  window.

  A `local`-infra Tester stands the service's dependencies up inside its container with
  `docker compose up --wait` before running. Until now that command's output was written only
  to the harness's own logs — so when the dependencies failed to come up (a port clash, an
  image pull-auth failure, a healthcheck timeout, a service that exits immediately) the run
  showed an opaque failure and the single highest-signal artifact for diagnosing it was
  unreachable from the UI. This was flagged as the natural follow-up to the container-lifecycle
  observability work (the orchestrator-side provisioning logs can't see it — the stand-up runs
  _inside_ the container).

  - **Harness.** `standUpInfra` now captures the `docker compose up` stdout+stderr (on success
    _and_ failure), redacts credentials (the shared `redact` now also scrubs credential-named
    `KEY=value` / `KEY: value` assignments — e.g. a dependency echoing `POSTGRES_PASSWORD=…` —
    which are neither a token shape nor a known value), tail-bounds it, and returns an
    `infraSetup` record
    (started / compose path / duration / logs / error) on the agent result.
  - **Propagation.** The record rides the existing `RunnerJobResult` → `AgentRunResult` path
    (forwarded verbatim by both transports) and the engine persists it on the Tester step as
    `step.test.infraSetup`, refreshed on each Tester round.
  - **UI.** The test report window's Infrastructure section now shows a "Dependency stand-up"
    panel — the outcome, the compose file, how long it took, the verbatim error on failure, and
    the captured stand-up logs behind a toggle.
  - **Parity.** The cross-runtime conformance suite asserts the record round-trips onto
    `step.test.infraSetup` identically on D1 and Postgres.

  Bumps the `@cat-factory/executor-harness` image to `1.26.0` (the harness `src/` changed) and
  the matching tag in `deploy/backend`.

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/kernel@0.55.0
  - @cat-factory/contracts@0.54.0
  - @cat-factory/orchestration@0.43.0
  - @cat-factory/agents@0.22.1
  - @cat-factory/integrations@0.35.4
  - @cat-factory/spend@0.10.34
  - @cat-factory/prompt-fragments@0.9.6

## 0.48.3

### Patch Changes

- Updated dependencies [b76f303]
  - @cat-factory/orchestration@0.42.1

## 0.48.2

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
  - @cat-factory/agents@0.22.0
  - @cat-factory/integrations@0.35.3
  - @cat-factory/spend@0.10.33
  - @cat-factory/prompt-fragments@0.9.5

## 0.48.1

### Patch Changes

- Updated dependencies [614e985]
  - @cat-factory/integrations@0.35.2
  - @cat-factory/orchestration@0.41.4

## 0.48.0

### Minor Changes

- 0577404: feat: move infrastructure configuration into its own top-level navbar menu. Agent-container execution + Tester environments + (local mode) the warm-container pool / checkout reuse now live in a dedicated tabbed "Infrastructure" window reached from the navbar, instead of being buried in the Integrations hub and a separate "Local mode" entry. The old bare "delegate to runner pool" toggle is replaced by a clear execution-backend selector that reflects the backends available for THIS deployment (local Docker host / Cloudflare Containers / self-hosted runner pool) and which is active — driven by a new symmetric `infrastructure` capability descriptor on `GET /auth/config` (set by every facade; asserted by the cross-runtime conformance suite). The raw-JSON runner manifest editor is kept but collapsed behind an "Advanced: custom API-based scheduler" disclosure, since the common backends don't need it.

### Patch Changes

- Updated dependencies [0577404]
  - @cat-factory/contracts@0.52.0
  - @cat-factory/agents@0.21.17
  - @cat-factory/integrations@0.35.1
  - @cat-factory/kernel@0.53.1
  - @cat-factory/orchestration@0.41.3
  - @cat-factory/prompt-fragments@0.9.4
  - @cat-factory/spend@0.10.32

## 0.47.0

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
  - @cat-factory/orchestration@0.41.2
  - @cat-factory/agents@0.21.16
  - @cat-factory/prompt-fragments@0.9.3
  - @cat-factory/spend@0.10.31

## 0.46.3

### Patch Changes

- 29d8b5d: Harness error handling & observability: structured failure cause, stuck-run diagnosis, and transient API retry.

  - **Structured failure cause.** The executor-harness now reports a structured `failureCause`
    (`inactivity-timeout` | `max-duration` | `agent` | `git` | `api` | `no-usable-output` |
    `no-changes`) and an extended `detail` on a failed job view, alongside the existing one-line
    `error`. The backend prefers the structured cause to classify a failure (→ `AgentFailureKind`
    / `BootstrapFailureKind`) and falls back to the existing error-string regex when it's absent
    (older image, or a manifest pool that doesn't map the cause), so the change is backward
    compatible. The fallback now matches the bootstrap path's regex on BOTH the agent and
    bootstrap paths (a watchdog timeout classifies as `timeout`, not a generic `agent`). A `git`
    operation or an upstream `api` call that fails carries its real cause rather than `agent`.
    The Node/self-hosted runner pool forwards the structured cause/detail too (new optional
    `failureCausePath`/`detailPath` on the pool response manifest), so it isn't Cloudflare-only.
    Container eviction stays facade-detected (the harness never emits the eviction marker). The
    watchdog phrases are centralized so they can't drift from the regex that still reads them.
  - **Stuck-run diagnosis.** An inactivity kill now reports which phase was hung and the last tool
    that ran (e.g. "...likely hung in agent phase; last tool bash 40s ago"), with a per-phase
    timing breakdown in `detail` and on the failure log. A per-job child logger binds the run's
    correlation fields (jobId/repo/branch/kind) onto every line.
  - **Transient API retry.** Opening a PR/MR now retries a transient upstream failure (5xx / 429 /
    network) with bounded, abort-aware exponential backoff (honoring `Retry-After`), so a momentary
    blip no longer fails an otherwise-complete run. The 422/409 "already exists" success paths are
    unaffected.
  - **Surfaced silent degradation.** Checkpoint-push failures, dropped follow-up lines, malformed
    Pi JSONL records, and SIGKILL escalation are now logged at warn with counts instead of being
    swallowed. A final non-newline-terminated Pi event is flushed so its progress/span isn't lost.

  Bumps the `@cat-factory/executor-harness` image to `1.22.0` (and the matching tag in
  `deploy/backend`).

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0
  - @cat-factory/contracts@0.50.1
  - @cat-factory/orchestration@0.41.1
  - @cat-factory/integrations@0.34.1
  - @cat-factory/agents@0.21.15
  - @cat-factory/spend@0.10.30
  - @cat-factory/prompt-fragments@0.9.2

## 0.46.2

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/contracts@0.50.0
  - @cat-factory/kernel@0.51.0
  - @cat-factory/integrations@0.34.0
  - @cat-factory/orchestration@0.41.0
  - @cat-factory/agents@0.21.14
  - @cat-factory/prompt-fragments@0.9.1
  - @cat-factory/spend@0.10.29

## 0.46.1

### Patch Changes

- e0f1149: Design-context sources: add Zeplin, generalize the abstraction, drop the Claude Design backend connector.

  - **New source: Zeplin** (`source='zeplin'`, per-workspace Bearer PAT) — a real server-fetchable
    REST handoff source exposing screens, components and design tokens. On by default; a no-op until a
    workspace connects it.
  - **De-Figma-shaped abstraction:** Figma and Zeplin now map into a shared, source-neutral
    `DesignContext` model rendered by `renderDesignContext` (`integrations/documents/design.logic.ts`).
    The per-source prompt fragments collapse into a single `design.context` fragment.
  - **Breaking — Claude Design backend connector removed.** Its only real read path is login-bound
    (Claude Code's `DesignSync` / `/design-sync`, via the user's claude.ai login), so a headless
    multi-tenant backend can never authenticate. The provider, the `'claude-design'` source value, the
    descriptor `credentialScope` field, and the entire per-user `user_document_connections` store
    (D1 + Drizzle tables, repositories, kernel ports, scope-aware `DocumentConnectionService`) are
    removed — all document sources are workspace-scoped again. The supported Claude Design workflow is
    now: `/design-sync` into the repo → commit → agents read it as checkout files. Stale
    `user_document_connections` rows are dropped (D1 migration `0020`, Drizzle drop migration); per the
    pre-1.0 policy there is no data migration.

- Updated dependencies [e0f1149]
  - @cat-factory/contracts@0.49.0
  - @cat-factory/kernel@0.50.0
  - @cat-factory/integrations@0.33.0
  - @cat-factory/prompt-fragments@0.9.0
  - @cat-factory/orchestration@0.40.2
  - @cat-factory/agents@0.21.13
  - @cat-factory/spend@0.10.28

## 0.46.0

### Minor Changes

- fc324d2: Add Kubernetes support for executor containers via a universal "agent runner backend"
  abstraction.

  The self-hosted runner pool is generalized into a discriminated runner-backend
  connection (a new `kind` field): `manifest` (the existing BYO HTTP scheduler pool) and
  `kubernetes` (new), with a `registerRunnerBackend` provider-registry seam so future
  backends (Nomad, EKS, …) are a single registry entry + a config variant + a UI form — no
  new table, service, controller, or integration window.

  The Kubernetes backend (`KubernetesRunnerTransport`, target k8s 1.35+) runs one bare Pod
  per run and reaches the per-pod executor-harness through the kube-apiserver **pod-proxy
  subresource** (Bearer ServiceAccount token), so the orchestrator needs only HTTPS to the
  apiserver — no in-cluster networking or per-run Service — and full `RunnerJobView`
  fidelity is preserved with zero executor-harness changes. It is wired symmetrically into
  both the Cloudflare and Node facades (and local mode via Node), and surfaced in the
  existing runner-backend Integrations window via a backend-type selector.

  BREAKING (pre-1.0): the `runner-pool/connection` register/test wire shape now takes a
  discriminated `config` instead of a bare `manifest`, and the `runner_pool_connections`
  table gains a `kind` column (existing rows backfill to `manifest`). The
  `executor-harness` image is unchanged (no image/tag bump).

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/contracts@0.48.0
  - @cat-factory/kernel@0.49.0
  - @cat-factory/integrations@0.32.0
  - @cat-factory/orchestration@0.40.1
  - @cat-factory/agents@0.21.12
  - @cat-factory/prompt-fragments@0.8.9
  - @cat-factory/spend@0.10.27

## 0.45.0

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
  - @cat-factory/integrations@0.31.0
  - @cat-factory/orchestration@0.40.0
  - @cat-factory/agents@0.21.11
  - @cat-factory/prompt-fragments@0.8.8
  - @cat-factory/spend@0.10.26

## 0.44.0

### Minor Changes

- 704c99e: Fill the gaps in Linear support:

  - **Connection pagination**: the Linear task source now walks the `children` and
    `comments` GraphQL connection cursors, so an epic with more than one page of
    sub-issues imports its full child set (no longer silently capped at ~50) — matching
    the Jira provider's epic-children pagination.
  - **Team picker for ticket filing**: a new `GET /workspaces/:ws/task-sources/linear/teams`
    endpoint lists the connected workspace's Linear teams, and the issue-tracker settings
    UI offers a searchable (typeahead) team picker instead of requiring a hand-pasted team
    UUID.
  - **OAuth connect flow**: Linear can now be connected via OAuth ("Connect with Linear")
    in addition to a personal API key. The OAuth app credentials (client id / secret /
    redirect URL) are configured **per account in the UI** (account Deployment settings,
    sealed in the DB and resolved dynamically — mirroring the Slack OAuth model), NOT via
    env vars, so an admin can set/rotate them without a redeploy. Absent ⇒ only the manual
    API-key path is offered. The exchanged access token is stored as the connection and
    used as a `Bearer` token across import, search, ticket filing and PR writeback.
  - **Search exact-ref match**: pasting a Linear issue identifier or URL into search now
    resolves and surfaces that exact issue first (de-duped against the term hits), like the
    GitHub Issues source.

### Patch Changes

- Updated dependencies [704c99e]
  - @cat-factory/integrations@0.30.0
  - @cat-factory/contracts@0.46.0
  - @cat-factory/orchestration@0.39.2
  - @cat-factory/agents@0.21.10
  - @cat-factory/kernel@0.47.2
  - @cat-factory/prompt-fragments@0.8.7
  - @cat-factory/spend@0.10.25

## 0.43.0

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

## 0.42.1

### Patch Changes

- Updated dependencies [5ad45de]
  - @cat-factory/orchestration@0.39.1

## 0.42.0

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
  - @cat-factory/integrations@0.29.0
  - @cat-factory/orchestration@0.39.0

## 0.41.1

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
  - @cat-factory/agents@0.21.9
  - @cat-factory/integrations@0.28.1
  - @cat-factory/kernel@0.47.1
  - @cat-factory/orchestration@0.38.1
  - @cat-factory/prompt-fragments@0.8.6
  - @cat-factory/spend@0.10.24

## 0.41.0

### Minor Changes

- 4b5d267: Environment provider repo-config lifecycle: validate + bootstrap (+ agent-repair seam)

  Adds optional `EnvironmentProvider` capabilities so a native adapter (e.g. a future Kargo
  adapter) can manage its config file inside the deployed repo:

  - `validateRepo` — mechanical repo-config validation, run on-demand
    (`POST /environments/connection/validate-repo`) and as a provision pre-flight gate that
    fails synchronously before `provider.provision()` instead of as an async failed environment.
  - `describeBootstrapInputs` + `bootstrapProviderConfiguration` — mechanically generate the
    config file from UI-collected variables; the engine commits it (idempotent; optional PR) and
    re-validates (`POST /environments/connection/bootstrap-repo`).
  - `describeRepairAgent` — agent-repair prompt + dispatch seam (the live engine dispatch is
    scaffolded but not yet wired; see `backend/docs/env-lifecycle.md`).

  All repo I/O flows through the existing VCS-neutral `RepoFiles` abstraction, so the provider
  never sees a VCS host or token (GitHub today, GitLab later). The provider descriptor now
  carries `supportsRepoValidation` / `supportsRepoBootstrap` / `bootstrapInputs`. The generic
  `HttpEnvironmentProvider` implements none of these, so manifest-driven providers are unchanged.

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0
  - @cat-factory/contracts@0.45.0
  - @cat-factory/integrations@0.28.0
  - @cat-factory/orchestration@0.38.0
  - @cat-factory/agents@0.21.8
  - @cat-factory/spend@0.10.23
  - @cat-factory/prompt-fragments@0.8.5

## 0.40.3

### Patch Changes

- 0784fe0: ExecutionService split (take 2), phase 5: group the gate-window actions into per-feature
  sub-facades. The dedicated review/test windows drove a parked gate through ~30 near-identical
  3-line delegations on `ExecutionService` (`reviewRequirements` / `incorporateClarity` /
  `proceedBrainstorm` / `confirmHumanTest` / `approveVisualConfirm` / …), bloating its public
  surface. They are now grouped into cohesive sub-facades exposed as getters on the still-injected
  `executionService` — `.requirementsReview` / `.clarityReview` / `.brainstorm` / `.humanTest` /
  `.visualConfirm` — and the matching server controllers call through them
  (`executionService.requirementsReview.review(...)` etc.). The composition roots are untouched
  (the single `executionService` is still what every facade injects), so the runtimes stay
  symmetric. No behaviour change.
- Updated dependencies [0784fe0]
- Updated dependencies [0784fe0]
  - @cat-factory/orchestration@0.37.3

## 0.40.2

### Patch Changes

- Updated dependencies [5e54936]
- Updated dependencies [5e54936]
  - @cat-factory/orchestration@0.37.2

## 0.40.1

### Patch Changes

- Updated dependencies [cc101a7]
  - @cat-factory/orchestration@0.37.1

## 0.40.0

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
  - @cat-factory/agents@0.21.7
  - @cat-factory/spend@0.10.22
  - @cat-factory/prompt-fragments@0.8.4

## 0.39.8

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
  - @cat-factory/contracts@0.43.3
  - @cat-factory/kernel@0.45.5
  - @cat-factory/agents@0.21.6
  - @cat-factory/prompt-fragments@0.8.3
  - @cat-factory/spend@0.10.21

## 0.39.7

### Patch Changes

- Updated dependencies [fb339db]
  - @cat-factory/contracts@0.43.2
  - @cat-factory/agents@0.21.5
  - @cat-factory/integrations@0.26.4
  - @cat-factory/kernel@0.45.4
  - @cat-factory/orchestration@0.36.4
  - @cat-factory/prompt-fragments@0.8.2
  - @cat-factory/spend@0.10.20

## 0.39.6

### Patch Changes

- 7d219ab: Allow the `X-Connection-Id` request header in CORS so the SPA can reach the backend.

  The SPA sends `X-Connection-Id` on every API call (the per-tab connection id for real-time
  self-echo suppression), but the Worker's CORS preflight only allow-listed
  `Content-Type, Authorization, X-Personal-Password`. The browser's preflight asked permission
  for `x-connection-id`, the response omitted it, so the browser dropped every cross-origin
  request with "CORS Missing Allow Header" and the board failed to load ("Can't reach the
  backend"). curl/server-side callers were unaffected because they don't send the header.

  Move the allow-list to a single shared `CORS_ALLOWED_HEADERS` constant in
  `@cat-factory/server` (now including `X-Connection-Id`) and use it in both runtime facades.
  The Node facade previously passed no `allowHeaders` and so let Hono echo the requested
  headers, which silently masked the drift; it now uses the same explicit list as the Worker.

## 0.39.5

### Patch Changes

- ab146e5: Suppress the real-time self-echo for board moves/reparents so dragging a task several
  times in quick succession is reliable. The SPA now tags every request with a stable
  per-tab connection id (`X-Connection-Id`) and the realtime WebSocket connect with the
  matching `?cid=`; the board `move`/`reparent` controllers forward it through
  `BoardService` to `boardChanged`, and both realtime hubs (the Cloudflare
  `WorkspaceEventsHub` Durable Object and the Node `NodeRealtimeHub`) skip delivering the
  coarse `board` event back to the connection that caused it. The originating client keeps
  its optimistic state plus its own authoritative REST response instead of refreshing off
  its own move (a mid-flight snapshot of which carried a stale position, snapping the block
  back). Other subscribers still receive the event and refresh.
- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3
  - @cat-factory/orchestration@0.36.3
  - @cat-factory/agents@0.21.4
  - @cat-factory/integrations@0.26.3
  - @cat-factory/spend@0.10.19

## 0.39.4

### Patch Changes

- 1a349b5: Drop persisted agent failures carrying a removed kind so a stale row can't brick the board.

  `decision_timeout` was removed from the `AgentFailure` kind picklist when human decisions
  stopped being timeout-limited. A run that failed before then still carries the obsolete kind
  in its persisted failure JSON, which violates the now-closed picklist. Because the server
  ships rows without validating them against the contract, one stale failure made the SPA's
  response validation reject the entire workspace snapshot ("Can't reach the backend").

  The three failure-column parsers (the shared execution mapper plus both runtimes' bootstrap
  repositories) now drop a failure whose kind is no longer known, via the new shared
  `isKnownAgentFailureKind` predicate. The run's `status` + `error` string still describe what
  happened. This repair is temporary and marked for removal after the 2026-07-15 migration
  grace cutoff.

## 0.39.3

### Patch Changes

- 80e5fc9: Repair pre-#94 numeric user ids on read so a stale row can't brick the board.

  PR #94 re-keyed user ids (block `createdBy`, execution `initiatedBy`) from the GitHub
  numeric id to the canonical `usr_*` string with no data migration. The wire contract now
  types these as `string | null`, and the server ships rows without validating them against
  the contract, so a single pre-#94 row made the SPA's response validation reject the entire
  workspace snapshot and the board failed to load with "Can't reach the backend".

  The shared row→domain mapper (used by both the D1 and Drizzle stores) now drops a
  non-string legacy id to null on read. The stale number is an old GitHub id that matches no
  `usr_*` user, so dropping it loses nothing real. This repair is temporary and marked for
  removal after the 2026-07-15 migration grace cutoff.

## 0.39.2

### Patch Changes

- c11a0cc: Add a `prepublishOnly` build hook so each package is compiled to `dist/` before it is
  packed, regardless of how publish is invoked. `dist/` is gitignored and was only built by
  the canonical `pnpm ci:publish` flow, so a bare `pnpm publish` could ship an empty shell
  (this is what happened to `@cat-factory/gitlab` and `@cat-factory/provider-s3`). The hook
  removes that footgun for every publishable library.
- Updated dependencies [c11a0cc]
  - @cat-factory/agents@0.21.3
  - @cat-factory/contracts@0.43.1
  - @cat-factory/integrations@0.26.2
  - @cat-factory/kernel@0.45.2
  - @cat-factory/orchestration@0.36.2
  - @cat-factory/prompt-fragments@0.8.1
  - @cat-factory/spend@0.10.18

## 0.39.1

### Patch Changes

- Updated dependencies [5363166]
- Updated dependencies [5363166]
  - @cat-factory/orchestration@0.36.1
  - @cat-factory/kernel@0.45.1
  - @cat-factory/agents@0.21.2
  - @cat-factory/integrations@0.26.1
  - @cat-factory/spend@0.10.17

## 0.39.0

### Minor Changes

- eab73b8: feat(documents): add Claude Design as a per-user design-context document source

  Implements the Claude Design half of the design record in
  `backend/docs/figma-claude-design-context.md`. Claude Design becomes a new
  `DocumentSourceProvider` (`source='claude-design'`) that reuses the whole documents
  integration (link plumbing, controller, `.cat-context/` materialization, prompt
  fragment), with a deterministic design-system normalizer that turns a project's
  `_ds_manifest.json` / `@dsCard`-marked component HTML + CSS custom properties into the
  same `### Components` / `### Design tokens` Markdown shape the Figma provider emits — so
  it earns its place over a plain HTML upload.

  Auth is a **personal per-user PAT**, supported on every runtime: a new descriptor flag
  `credentialScope: 'user'` routes such a source to a new per-user
  `user_document_connections` store (D1 ⇄ Drizzle, encrypted at rest under a distinct HKDF
  info), keyed by the acting user and never shared with the workspace. `DocumentConnectionService`
  becomes scope-aware; the import path threads the acting user. Workspace-scoped sources
  (Notion/Confluence/GitHub/Figma/Linear) are unchanged. The acting user falls back to the
  empty user id ONLY when auth is disabled (dev-open / single-user local mode) so those
  deployments still connect; when auth is enabled the controller fails closed with a 401
  rather than silently using the shared empty-user bucket.

  Claude Design is **opt-in**, not on by default: its credentialed project-read API is
  still provisional (the read is claude.ai-login-bound, no per-user service token yet), so
  it is excluded from the default `DOCUMENT_SOURCES` set and must be enabled explicitly
  (`DOCUMENT_SOURCES=…,claude-design`) once the API is real — every other source stays on
  by default.

  Also hoists the host-pinned `safeFetch`/SSRF guard/capped-read into a shared
  `documents/http.ts` reused by Figma and Claude Design. Wired symmetrically into both
  facades and gated by a new cross-runtime conformance case (per-user connect → list →
  disconnect).

- eab73b8: feat(documents): add Figma as a design-context document source

  Implements the Figma half of the design record in
  `backend/docs/figma-claude-design-context.md`. Figma becomes a new
  `DocumentSourceProvider` (`source='figma'`) authenticated by a per-workspace
  personal access token, reusing the whole documents integration (connection table,
  sealing, link plumbing, controller, `.cat-context/` materialization). `fetchDocument`
  renders a frame/file's layout tree, text, components-used and (Enterprise-gated)
  design tokens to Markdown, with a best-effort rendered-preview URL on a reference
  line. Wired symmetrically into both the Cloudflare and Node facades (and the
  `DOCUMENT_SOURCES` allow-list), gated by a cross-runtime conformance case. Adds the
  `design.figma-context` prompt fragment for frontend agents. (Claude Design ships in a
  companion changeset.)

  Also makes a URL pasted into a block description auto-match its imported document by the
  document's stable `(source, externalId)` — canonicalised through the providers'
  `parseRef` (`AgentContextBuilder.documentUrlResolver`) — instead of by exact URL-string
  equality, which silently failed for a real Figma share link (title path segment, dash
  node id, `&t=` tracking params) whose canonical stored `url` omits that noise.

### Patch Changes

- Updated dependencies [eab73b8]
- Updated dependencies [eab73b8]
  - @cat-factory/contracts@0.43.0
  - @cat-factory/kernel@0.45.0
  - @cat-factory/integrations@0.26.0
  - @cat-factory/orchestration@0.36.0
  - @cat-factory/prompt-fragments@0.8.0
  - @cat-factory/agents@0.21.1
  - @cat-factory/spend@0.10.16

## 0.38.1

### Patch Changes

- Updated dependencies [67c7196]
  - @cat-factory/orchestration@0.35.1

## 0.38.0

### Minor Changes

- e641417: Add a document-authoring pipeline and a richer document task definition.

  **Reviewers now read the real repository.** The `reviewer` (code) and `doc-reviewer`
  companions run as read-only container reviewers: they clone the producer's PR branch and
  read the ACTUAL changed files / committed document with tools before rating, instead of
  grading the producer's summary reply (a review of a summary is worthless). They are
  dispatched through the same async container path the coder/merger use and return their
  verdict as structured JSON, resolved by the same threshold / rework-loop / human-gate
  handling as before. Inline companions (`architect-companion` / `spec-companion`) are
  unchanged. A container companion is gated on a wired sandbox like any other container kind.

  A new forward-authoring track produces an in-repo Markdown document (PRD / RFC / design
  doc / ADR / technical reference / runbook / research report) shipped as a pull request —
  distinct from the reverse-documentation kinds (`documenter` / `business-documenter` /
  `blueprints`) that describe existing code. Four new agent kinds are registered through the
  public `registerAgentKind` seam — `doc-researcher` and `doc-outliner` (inline), `doc-writer`
  (container-coding, opens the PR coder-style) and `doc-finalizer` (container-coding, polishes
  on the PR branch) — plus a `doc-reviewer` companion that loops the writer back for rework.

  Two built-in pipelines are seeded: `pl_document` (research → outline [human gate] → write →
  AI review loop [human gate] → finalize → conflicts → ci → merger) and `pl_document_quick`.

  The `document` task type gains a wider `docKind` set (`prd`/`rfc`/`adr`/`design`/`technical`/
  `api`/`runbook`/`research`/`reference`/`other`) and optional `audience`, `targetPath` and
  `outlineHints` fields, threaded into the agent context so the document agents specialise their
  prompts. No new persisted tables — the committed Markdown is the durable artifact.

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/contracts@0.42.0
  - @cat-factory/kernel@0.44.0
  - @cat-factory/agents@0.21.0
  - @cat-factory/orchestration@0.35.0
  - @cat-factory/integrations@0.25.2
  - @cat-factory/prompt-fragments@0.7.41
  - @cat-factory/spend@0.10.15

## 0.37.0

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
  - @cat-factory/agents@0.20.3
  - @cat-factory/integrations@0.25.1
  - @cat-factory/orchestration@0.34.1
  - @cat-factory/spend@0.10.14

## 0.36.3

### Patch Changes

- Updated dependencies [63e2177]
  - @cat-factory/contracts@0.41.0
  - @cat-factory/integrations@0.25.0
  - @cat-factory/orchestration@0.34.0
  - @cat-factory/agents@0.20.2
  - @cat-factory/kernel@0.42.2
  - @cat-factory/prompt-fragments@0.7.40
  - @cat-factory/spend@0.10.13

## 0.36.2

### Patch Changes

- Updated dependencies [6903cd7]
  - @cat-factory/orchestration@0.33.0

## 0.36.1

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/contracts@0.40.1
  - @cat-factory/kernel@0.42.1
  - @cat-factory/agents@0.20.1
  - @cat-factory/integrations@0.24.1
  - @cat-factory/orchestration@0.32.1
  - @cat-factory/prompt-fragments@0.7.39
  - @cat-factory/spend@0.10.12

## 0.36.0

### Minor Changes

- 32c653f: Add a runtime-neutral binary-artifact storage abstraction (the foundation for the
  visual-confirmation gate's UI screenshots + reference design images).

  - New kernel port `BinaryArtifactStore` with a split, mix-and-match seam: a per-runtime
    `BinaryArtifactMetadataStore` (the queryable metadata) + a pluggable `BinaryBlobBackend`
    (the bytes — the "custom adapter interface"), composed by `createBinaryArtifactStore`.
  - Adapters: D1 metadata + R2 blob backend (Cloudflare — D1 can't hold large values, so
    bytes always go to R2); Drizzle/Postgres metadata + a Postgres `bytea` blob backend
    (Node/local, size-guarded); and a new opt-in `@cat-factory/provider-s3` package
    implementing the blob backend over an S3 (or S3-compatible) bucket.
  - Metadata table `binary_artifacts` mirrored D1 ⇄ Drizzle; a Node-only
    `binary_artifact_blobs` `bytea` table backs the `db` backend (no D1 equivalent).
  - `AppConfig.binaryStorage` selects the backend (`db` | `r2` | `s3`); wired in all three
    facades and surfaced on the request container. New workspace-scoped artifact API
    (upload reference / stream blob / list a run's artifacts). Cross-runtime conformance
    suite `defineBinaryArtifactsSuite` asserts store parity on both runtimes.

- 32c653f: Add the Visual Confirmation gate and split the tester into an API + UI tester.

  - **Tester split:** the `tester` kind is renamed to `tester-api` (general/API exploratory
    testing) and a new `tester-ui` kind drives a real browser (Playwright), captures a
    non-redundant screenshot of each distinct view, uploads them to the binary-artifact
    store, and reports them under `TestReport.screenshots[]`. Both share the Tester→Fixer
    loop and the `tester.environment` infra choice (`isTesterKind`). The UI tester dispatches
    with `image:'ui'` so a transport can route it to a dedicated Playwright/browser image.
  - **Visual Confirmation gate** (`visual-confirmation`): a park-on-decision engine gate
    (modelled on `human-test`) that gathers the UI tester's screenshots + the human-uploaded
    reference design images (paired by view) and parks for a person to review actual-vs-reference.
    The human approves (advance), requests a fix (dispatches the Tester's `fixer`, then re-parks),
    or recaptures. Raises a `visual_confirmation_ready` notification; passes through when no
    binary-artifact store is wired. New `pl_visual` pipeline (`… tester-ui → visual-confirmation
→ merger`) and the `GET /blocks/:id/artifacts` + visual-confirmation action endpoints.
  - Cross-runtime conformance covers the gate's no-store pass-through and the artifact store's
    `listByBlock`.

  BREAKING: the `tester` agent kind is renamed to `tester-api`. Per this repo's pre-1.0 policy
  (no backwards-compatibility shims), any persisted state that still names `tester` simply stops
  matching: a saved/custom pipeline referencing `tester` is detected as outdated and reseeded from
  the catalog, and an execution that is parked mid-`tester` at upgrade time will no longer be
  recognised by the tester gate (re-run the task). New runs are unaffected — the seeded pipelines
  all use `tester-api`.

  NOTE: the dedicated UI-tester container image (Playwright/Chromium) and the per-kind image
  routing into it (a second Cloudflare container class; image-per-step on the local/pool
  transports) are a deploy-time follow-up — the `image:'ui'` dispatch seam is in place. Until that
  routing AND the harness env-passthrough (`ARTIFACT_UPLOAD_URL`/`ARTIFACT_UPLOAD_TOKEN` + a
  Playwright driver) land, `tester-ui` has no browser and the `pl_visual` gate runs in MANUAL mode
  (a human uploads references + screenshots and reviews them), which is why `pl_visual` is flagged
  `experimental`.

- 32c653f: Harden + complete the Visual Confirmation gate / binary-artifact storage after review.

  - **Security (artifact serving):** the artifact upload + blob endpoints now pin the content
    type to a raster-image allow-list (`png`/`jpeg`/`webp`/`gif`, SVG/HTML rejected `415`) at the
    write boundary, and serve blobs with `X-Content-Type-Options: nosniff` + a clamped
    `Content-Type`/`Content-Disposition` — closing a stored-XSS vector where an attacker-controlled
    type could be served inline same-origin. Shared `imageArtifacts.ts` keeps the workspace upload
    and the in-container ingest paths consistent.
  - **Configurable artifact retention (new):** a per-workspace `artifactRetentionDays` setting
    (default 14, bounded 1–3650), editable in the workspace settings panel. A daily Cloudflare cron
    / hourly Node timer sweep prunes each workspace's screenshots + reference images past its window
    — BOTH the metadata rows and the bytes (`BinaryArtifactStore.pruneOlderThan`), so the store no
    longer grows unbounded. Mirrored D1 ⇄ Drizzle (migration `0018` / a generated Drizzle migration)
    and asserted by the cross-runtime binary-artifacts conformance suite.
  - **tester-ui ingest seam (backend half):** `ContainerAgentExecutor` injects an `artifactUpload`
    `{ url, token }` into the `tester-ui` job body, reusing the run's existing container session
    token + proxy base URL, and a new container-token-authed `POST ${proxyBaseUrl}/artifacts/ingest`
    route stores the bytes as a run-scoped `screenshot`. (The UI-tester image routing + harness env
    passthrough remain the deploy-time follow-up — see the handover doc.)
  - **Gate UX:** a `request-fix` that can't dispatch (no PR branch / no async executor) now surfaces
    a reason + records a failed round instead of silently re-parking; after a fix the gate flags that
    the shown screenshots predate it (recapture to refresh); the unused `headSha` placeholder is
    dropped; and the gate window revokes its cached screenshot object URLs on unmount.

### Patch Changes

- 32c653f: Second review pass on the Visual Confirmation gate / binary-artifact storage — hardening + a
  gap-closing follow-up:

  - **Retention no longer orphans bytes.** `BinaryArtifactStore.pruneOlderThan` now keeps a
    metadata row whenever its blob delete fails (instead of dropping the row and orphaning the
    bytes forever), so the next sweep retries it; the all-succeeded path still collapses to one
    bulk delete.
  - **Upload size guarded before buffering.** Both the workspace upload and the in-container
    ingest endpoints reject a grossly oversized body from `Content-Length` BEFORE reading it into
    memory (`exceedsRequestSizeLimit`), with the exact per-file 16 MiB ceiling still enforced after
    parsing.
  - **Per-run screenshot ceiling.** The container ingest route caps a single run at 100 uploaded
    screenshots (`429` past it), so a runaway/compromised container can't fill the blob store.
  - **Consistent content-type posture.** The harness ingest now rejects a recognised non-image
    type (`415`) instead of silently storing it mislabelled as PNG, matching the workspace upload
    endpoint; a typeless upload still defaults to PNG.
  - **Tighter human-upload scoping.** The workspace artifact endpoint ignores any client-supplied
    `executionId` (reference images are block-scoped and precede any run; run-scoped captures come
    through the token-authed ingest, where the run is derived from the verified token).
  - **`created_at` retention index** added on `binary_artifacts` (D1 `0017` + a generated Drizzle
    migration) so the per-workspace prune is an indexed range delete.
  - **`pl_visual` flagged experimental** (`labels: ['experimental']`): until UI-tester image
    routing + harness env-passthrough land, the gate runs in manual mode — the label keeps the
    pipeline discoverable without implying automatic screenshot capture.
  - Removed the unused `capturing` phase from `visualConfirmStepStateSchema` (the auto re-capture
    loop it anticipated is still deferred), and added a cross-runtime conformance test for the
    gate's request-fix → fixer → re-park → approve loop.

  Note (breaking, already in this PR): the `tester` agent kind was renamed to `tester-api` (with a
  new browser-driven `tester-ui` sibling). Per the project's pre-1.0 no-backwards-compat policy,
  custom pipelines/blocks persisted with the old `tester` kind are not migrated and will need to be
  re-pointed at `tester-api`.

- 32c653f: Third review pass on the Visual Confirmation gate / binary-artifact storage:

  - **Frontend build fix.** `VisualConfirmationWindow.vue` still referenced the `capturing`
    phase that round 2 removed from `visualConfirmStepStateSchema` (a TS2353 excess-property
    on `PHASE_LABEL` and a TS2367 no-overlap comparison in `working`), which broke
    `nuxt typecheck`. Dropped both.
  - **Reference re-upload now wins.** `VisualConfirmationController.gatherPairs` kept the
    OLDEST reference image per view (`?? ref.id`), so a human re-uploading a corrected
    reference for a view they already populated never saw it. References are now assigned
    last-writer (newest), matching the oldest-first `listByBlock` ordering.
  - **Upload buffering is now actually bounded.** The `Content-Length` precheck was
    bypassable by a chunked / header-less body, after which `formData()` buffered the whole
    request into memory before the per-file ceiling ran. Both upload routes (workspace +
    in-container ingest) now wrap the body in `hono/body-limit`, which counts bytes as the
    stream is read, so a missing/spoofed `Content-Length` can't buffer past the ceiling.
  - **Per-run screenshot cap holds under concurrency.** The container-ingest cap was a
    check-then-act race; concurrent ingests could each pass it before any row landed. A
    post-insert reconcile now rolls back (deletes) any insert that lands in the overflow
    tail, so the store is bounded to exactly the cap per run without dropping earlier shots.
  - **Removed the vestigial `headSha`** from `visualConfirmStepStateSchema` (and its
    `begin()` initializer) — it was always null and never read; round 1 claimed it was
    dropped but it wasn't.
  - **Reuse:** the harness ingest route now uses the exported `bearerToken` helper instead
    of a fourth private copy of the `Bearer` parser.

- 32c653f: Review round 4 (visual-confirmation gate / binary artifacts):

  - **Don't load the AWS SDK unless S3 is actually used.** `@cat-factory/provider-s3` now imports
    `@aws-sdk/client-s3` lazily (on the first S3 operation) instead of at module load, so a
    Node/local deployment running the `db` (or no) blob backend no longer pays the SDK's load cost
    even though the facade statically imports `S3BinaryBlobBackend` to wire its container.
  - **Guard Approve when the gate flags its screenshots as unreliable.** The visual-confirmation
    window now requires an explicit "I've reviewed this manually" acknowledgement before Approve is
    enabled whenever the gate set a `degradedReason` (no capture happened, a fix failed, or a fix
    landed AFTER the shown screenshots) — so a stale/empty gallery can't be approved in one blind
    click.
  - **Cheaper per-run upload cap.** The harness screenshot ingest precheck uses an indexed
    `countByExecution` (no row materialise) and only runs the post-insert overflow reconcile when the
    insert could actually cross the cap, so the steady-state upload is one COUNT + one insert.
  - **Serve a blob in a single metadata read** via `BinaryArtifactStore.getBlobWithMetadata`.
  - **Drop dangling screenshot refs.** The gate validates the agent-reported screenshot `artifactId`s
    against what the run actually uploaded, so a fabricated id or one removed by the retention sweep
    renders as "not captured" rather than a 404 image.
  - Make the UI-tester prompt honest: it now only instructs an upload when `ARTIFACT_UPLOAD_URL` is
    provided to the run (manual mode otherwise), and treats the reference-design directory as
    optional.

  The new `countByExecution` / `getBlobWithMetadata` store methods are mirrored D1 ⇄ Drizzle and
  asserted by the cross-runtime binary-artifacts conformance suite.

- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
  - @cat-factory/kernel@0.42.0
  - @cat-factory/contracts@0.40.0
  - @cat-factory/agents@0.20.0
  - @cat-factory/orchestration@0.32.0
  - @cat-factory/integrations@0.24.0
  - @cat-factory/spend@0.10.11
  - @cat-factory/prompt-fragments@0.7.38

## 0.35.0

### Minor Changes

- b5231b0: Make prompt-caching a first-class, visible capability and add per-kind progress-guard
  leniency.

  **Caching capability + observability.** `providerCachePolicy` moves to the kernel
  (`domain/cache-policy.ts`, re-exported from `@cat-factory/agents`) so the model catalog
  can derive a per-flavour `ModelOption.cachesPrompts` from the effective provider — the
  same model reads `false` on its cache-less Cloudflare/Workers-AI flavour and `true` once
  a direct key upgrades it to its caching `direct` flavour. The already-recorded
  `cachedPromptTokens` is now aggregated per agent kind in `summarizeByExecution` (D1 +
  Drizzle, kept symmetric) and surfaced as `cachedPromptTokens` + a derived `cacheHitRate`
  on the step rollup and the LLM-metrics export.

  **Vendor-selection UI.** The model picker shows a `Prompt caching` / `No prompt caching`
  badge per flavour, the API-keys panel notes which direct keys enable caching, and the
  step metrics bar shows a cached-token split when present — so a user can see (and act on)
  the hot path running cache-less. Shipped model defaults are intentionally NOT changed;
  extending `providerCachePolicy` to more providers (Moonshot / OpenRouter / LiteLLM) is
  gated on benchmark evidence (see `backend/docs/prompt-caching.md`).

  **Per-kind guard leniency.** The container progress guard can now be loosened per agent
  kind via an optional `guardLimits` job-body field (clamped per knob in the harness;
  merged over the env/built-in defaults — loosen-only, never tighten). A data-driven
  `agentTuningFor` seam (`@cat-factory/agents`, plus an `AgentKindDefinition.tuning` hook
  for custom kinds) supplies the profile, which `ContainerAgentExecutor` folds into the
  dispatch body. Initial profiles give `conflict-resolver` more error headroom and the
  research-heavy kinds a higher consecutive-web cap, so a legitimately-progressing run is
  not killed for its normal pattern. Output-token ceilings are unchanged.

### Patch Changes

- Updated dependencies [b5231b0]
  - @cat-factory/contracts@0.39.0
  - @cat-factory/kernel@0.41.0
  - @cat-factory/agents@0.19.0
  - @cat-factory/orchestration@0.31.0
  - @cat-factory/integrations@0.23.5
  - @cat-factory/prompt-fragments@0.7.37
  - @cat-factory/spend@0.10.10

## 0.34.0

### Minor Changes

- 6d829bb: Make invalid-state pipelines more robust. On app open, a startup advisory surfaces pipelines that
  reference a nonexistent agent kind or have an invalid shape (delete a custom one, reseed a built-in)
  and built-in pipelines whose seeded definition is newer than the stored copy (reseed to adopt it).

  Built-in pipelines now carry a per-pipeline `version` (persisted on both runtimes via a new D1
  migration and a Drizzle column), the snapshot ships the current catalog versions
  (`pipelineCatalogVersions`), and a new `POST /workspaces/:ws/pipelines/:id/reseed` endpoint restores a
  built-in's canonical definition while preserving its labels/archive state.

  BREAKING: existing workspaces' persisted built-in pipelines have no stored `version`, so they read as
  "update available" once until reseeded — intentional adoption of the now-versioned definitions.

### Patch Changes

- Updated dependencies [6d829bb]
  - @cat-factory/contracts@0.38.0
  - @cat-factory/kernel@0.40.0
  - @cat-factory/orchestration@0.30.0
  - @cat-factory/agents@0.18.5
  - @cat-factory/integrations@0.23.4
  - @cat-factory/prompt-fragments@0.7.36
  - @cat-factory/spend@0.10.9

## 0.33.0

### Minor Changes

- 714b7c9: Add "forgot my password" self-service reset for password-based logins.

  A user can request a reset link by email (`POST /auth/forgot-password`) and set a new
  password via a one-time, expiring token (`POST /auth/reset-password`). Tokens are stored
  hashed (SHA-256), single-use, and mirror the invitation flow; the reset email is sent
  through a new deployment-level **system** email sender configured via
  `EMAIL_SYSTEM_PROVIDER` / `EMAIL_SYSTEM_FROM` / `EMAIL_SYSTEM_API_KEY` (when unset, the
  link is logged for local/dev). The request endpoint never reveals whether an email is
  registered.

  Schema addition (both runtimes): a new `password_reset_tokens` table (D1 migration
  `0017_password_reset_tokens.sql` ⇄ a Drizzle Postgres migration). No data migration is
  needed — the table starts empty.

### Patch Changes

- Updated dependencies [714b7c9]
  - @cat-factory/contracts@0.37.0
  - @cat-factory/kernel@0.39.0
  - @cat-factory/orchestration@0.29.0
  - @cat-factory/agents@0.18.4
  - @cat-factory/integrations@0.23.3
  - @cat-factory/prompt-fragments@0.7.35
  - @cat-factory/spend@0.10.8

## 0.32.2

### Patch Changes

- efbd910: Fix the SPA error handling broken by the `@toad-contracts/*` migration.

  The contract client (`sendByApiContract`) reports a contract-declared non-2xx as a plain
  `{ statusCode, headers, body }` value (not an `Error`), with the `{ error: { code, message,
details } }` envelope under `body`. The old `$fetch` threw an ofetch `FetchError` with the
  body under `data` and was always an `Error`. Several handlers still read the old shape, so:

  - `parseCredentialError` returned `null` for every 428, so the personal-subscription
    password modal never opened and individual-usage runs (Claude/Codex/GLM) could not be
    started or retried.
  - `parseConflict` returned `null` for every 409, so run-control conflict toasts lost their
    tailored guidance (including the `providers_unconfigured` "Configure AI" jump).
  - `instanceof Error` message extraction across many catch blocks rendered `"[object Object]"`
    for declared 4xx/5xx, and the login/account/tracker-probe handlers dropped the server's
    message.

  `sendContract` now wraps a bare non-2xx into a real `ApiError` (an `Error` carrying
  `statusCode`, the parsed `body`, and the server's message), and a shared
  `apiErrorEnvelope` / `apiErrorStatus` reads the envelope from either client shape. The
  provisioning-logs query now validates through the contract schema so an invalid query
  returns the standard `{ code: 'validation' }` 400 like every other route. `@cat-factory/contracts`
  gains a `singleStringParam` helper that collapses the one-key path-param schemas the route
  files each re-declared (typing preserved).

- Updated dependencies [efbd910]
  - @cat-factory/contracts@0.36.0
  - @cat-factory/agents@0.18.3
  - @cat-factory/integrations@0.23.2
  - @cat-factory/kernel@0.38.1
  - @cat-factory/orchestration@0.28.3
  - @cat-factory/prompt-fragments@0.7.34
  - @cat-factory/spend@0.10.7

## 0.32.1

### Patch Changes

- 692ccb4: Refactor the shared block row<->domain mappers to a field-map-driven factory.

  `rowToBlock` / `blockInsertValues` / `blockPatchToColumns` were three hand-enumerated
  functions kept in sync by eye — a new persisted column meant 3–4 coordinated edits and a
  renamed column only surfaced at runtime. They now derive all three directions from a single
  `blockFields` table (one `FieldMapper` per column, with `scalarField` / `optField` /
  `optJsonField` / `optBoolIntField` builders that default the column to the snake_case of the
  property). The genuinely divergent columns (the `position`/`size` composites, the tri-state
  `technical`, and `serviceFragmentIds`/`agentConfig` whose insert vs patch emptiness rules
  differ) stay spelled out inline. Behaviour is unchanged — the existing mapper test suite is
  preserved and extended to cover the tri-state, length-clear, and insert-only columns.

- Updated dependencies [692ccb4]
  - @cat-factory/agents@0.18.2
  - @cat-factory/orchestration@0.28.2

## 0.32.0

### Minor Changes

- a4ea607: Adopt `@toad-contracts/*` for end-to-end typed, validated API contracts.

  The HTTP boundary is now a single source of truth. Each route is defined once with
  `defineApiContract` in `@cat-factory/contracts` (`src/routes/*`) and consumed by both
  sides: the backend mounts it with `@toad-contracts/hono`'s `buildHonoRoute` (method,
  path and request validation derived from the contract; the handler's `c.req.valid(...)`
  inputs and `c.json(body, status)` return are type-checked against it), and the SPA calls
  it with `@toad-contracts/frontend-http-client`'s `sendByApiContract` over `wretch`
  (runtime-validating every response). The frontend wire-type mirror in
  `frontend/app/app/types/*` no longer hand-redefines shapes — it re-exports the inferred
  types from `@cat-factory/contracts`, so backend and frontend can't drift.

  Breaking / notable:

  - `@cat-factory/server` no longer exports `jsonBody`, and drops the
    `@hono/valibot-validator` dependency (request validation now comes from the contract
    via `buildHonoRoute`); request-validation failures still return the same
    `{ error: { code: 'validation', issues } }` 400 envelope, mapped centrally in
    `handleError`.
  - `updateBlockSchema` now accepts `responsibleProductUserId` (it was silently dropped on
    the wire despite the domain block carrying it and the mapper persisting it).
  - The runtime-internal endpoints that are not request/response JSON APIs (the WebSocket
    event stream, the LLM/web-search proxies, the GitHub webhook, the Slack OAuth callback)
    are intentionally left on plain Hono routing.
  - The wire-returned shapes that the kernel ports also describe (`ProvisionedRepo`,
    `AgentContextSnapshot`/`AgentContextFile`/`AgentContextFragment`) now have their single
    source of truth in `@cat-factory/contracts` valibot schemas; the `@cat-factory/kernel`
    ports re-export the inferred types, so the route contract and the port can't drift. The
    `/auth/config` `localMode` field is now a real schema (`localModeConfigSchema`) instead
    of `v.unknown()`, and `AppConfig.localMode` derives its type from it.

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/contracts@0.35.0
  - @cat-factory/kernel@0.38.0
  - @cat-factory/agents@0.18.1
  - @cat-factory/integrations@0.23.1
  - @cat-factory/orchestration@0.28.1
  - @cat-factory/prompt-fragments@0.7.33
  - @cat-factory/spend@0.10.6

## 0.31.0

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
  - @cat-factory/agents@0.18.0
  - @cat-factory/orchestration@0.28.0
  - @cat-factory/integrations@0.23.0
  - @cat-factory/spend@0.10.5
  - @cat-factory/prompt-fragments@0.7.32

## 0.30.0

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
  - @cat-factory/integrations@0.22.0
  - @cat-factory/contracts@0.33.0
  - @cat-factory/kernel@0.36.0
  - @cat-factory/orchestration@0.27.1
  - @cat-factory/agents@0.17.2
  - @cat-factory/prompt-fragments@0.7.31
  - @cat-factory/spend@0.10.4

## 0.29.1

### Patch Changes

- Updated dependencies [eb48652]
  - @cat-factory/contracts@0.32.0
  - @cat-factory/kernel@0.35.0
  - @cat-factory/orchestration@0.27.0
  - @cat-factory/agents@0.17.1
  - @cat-factory/integrations@0.21.7
  - @cat-factory/prompt-fragments@0.7.30
  - @cat-factory/spend@0.10.3

## 0.29.0

### Minor Changes

- 9f7ee39: Add "Requirements brainstorm" and "Architecture brainstorm" agents — structured-dialogue
  gates that PROPOSE options with explicit trade-offs and let a human converge on a direction,
  rather than doing all the work themselves or expecting the work done upfront.

  - One shared, stage-discriminated engine (`BrainstormService` over the existing
    `IterativeReviewService`), driven through the generic `ReviewGateController`. Two agent kinds
    (`requirements-brainstorm`, `architecture-brainstorm`) reuse it via a stage-bound repository
    adapter.
  - Persistence: a new `brainstorm_sessions` table keyed per (block, **stage**) — a block may hold
    a live requirements AND a live architecture session at once — mirrored across both runtimes
    (D1 + Drizzle/Postgres) with a cross-runtime conformance suite.
  - Handoffs (DB session state → next stage's prompt): `requirements-brainstorm` → the
    requirements review (its converged direction becomes the reviewed subject);
    `architecture-brainstorm` → the architect (surfaced additively as a prior output).
  - Pipelines: both steps are added to `pl_full` and `pl_fullstack` but **disabled by default**
    (opt-in per pipeline) — existing runs are unchanged.
  - Frontend: a shared brainstorm window (option cards with trade-offs → choose/steer/dismiss →
    incorporate → re-run), wired through the result-view seam, the workspace stream, and the
    palette catalog.

  Breaking: adds a new required table on both runtimes (`brainstorm_sessions` D1 migration +
  Drizzle migration) and a new optional `ExecutionEventPublisher.brainstormSessionChanged` event.
  No data migration — pre-1.0, stale state is acceptable.

  The brainstorm iteration cap reuses the merge preset's `maxRequirementIterations` /
  `maxRequirementConcernAllowed` knobs (no new preset field).

- 81b60d4: Add the future-looking **Follow-up companion** to the Coder agent.

  As the Coder works it now surfaces forward-looking items — genuine loose ends, useful
  side-tasks it is deliberately not acting on, and clarifying questions — by appending them
  to a `.cat-follow-ups.jsonl` sentinel file in its working directory. The executor-harness
  tails that file and streams the items **out** on the job view (drain-on-read, like tool
  spans), so a blinking **Follow-up companion** chip on the Coder step lights up the moment
  the first item appears — while the container is still running.

  A human triages each item at any point: file a follow-up as a tracker issue (GitHub Issues
  / Jira, via the existing `TicketTrackerProvider`), send it back to the Coder to address
  after delivering the key task, answer a question, or dismiss it. The pipeline's following
  steps do not start until **every** item is decided: an undecided follow-up or unanswered
  question parks the run at the Coder's completion (a new `followup_pending` notification).
  Once all are decided the engine loops the Coder for the queued / answered items (within a
  per-step budget) before advancing. The companion is enabled by default on Coder steps and
  disableable per step in the pipeline builder.

  This is pure engine + run-step state (no new table) so it is runtime-symmetric across the
  Cloudflare and Node facades — the cross-runtime conformance suite asserts the park →
  decide → loop → advance behaviour on both. Wire contracts (`followUpItem` /
  `followUpsStepState`, the `followup_pending` notification, the `follow-ups` result view),
  the `streamFollowUps` harness job flag + `RunnerJobView.followUps` channel (with an
  optional pool-manifest `followUpsPath`), and the `FOLLOW_UP_GUIDANCE` Coder prompt fragment
  are added across the stack.

  Bumps the executor-harness image (new src) — publish + redeploy to roll it out.

### Patch Changes

- Updated dependencies [9f7ee39]
- Updated dependencies [81b60d4]
  - @cat-factory/contracts@0.31.0
  - @cat-factory/kernel@0.34.0
  - @cat-factory/agents@0.17.0
  - @cat-factory/orchestration@0.26.0
  - @cat-factory/integrations@0.21.6
  - @cat-factory/prompt-fragments@0.7.29
  - @cat-factory/spend@0.10.2

## 0.28.1

### Patch Changes

- 4dd6e97: Fix: container agent (and repo-bootstrap) runs on **OpenRouter** and **LiteLLM** models
  were rejected at start with `'openrouter' is not supported` even though the LLM proxy
  already forwards both (their base URLs resolve in `resolveOpenAiCompatibleUpstream`). The
  proxyability guard hardcoded only `qwen`/`deepseek`/`moonshot`/`openai`/`workers-ai` and
  was duplicated (out of step) across `ContainerAgentExecutor` and `ContainerRepoBootstrapper`.
  Replaced both copies with a single shared `isProxyableProvider` in `@cat-factory/agents`,
  derived from `DEFAULT_OPENAI_COMPATIBLE_BASE_URLS` (so every OpenAI-compatible direct
  provider — including OpenRouter) plus the operator-hosted `litellm` gateway and the per-user
  local runners, so the start guard and the proxy can no longer disagree.
- Updated dependencies [4dd6e97]
  - @cat-factory/agents@0.16.1
  - @cat-factory/orchestration@0.25.1

## 0.28.0

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
  - @cat-factory/integrations@0.21.5
  - @cat-factory/prompt-fragments@0.7.28
  - @cat-factory/spend@0.10.1

## 0.27.2

### Patch Changes

- 18f6b3b: Security hardening across three surfaces.

  Local-runner SSRF: the server-side fetches to a user-supplied runner base URL (the "Test
  connection" probe and the run-time LLM proxy forward) now follow redirects manually and
  re-validate every hop against the loopback/LAN allow-list, so a reachable runner can no
  longer `302` the server into the cloud-metadata endpoint or a public host. `localRunnerUrlError`
  also rejects URLs with embedded credentials. New `fetchLocalRunner` helper in
  `@cat-factory/integrations`.

  Harness inbound auth: the Cloudflare container transport now sends the `x-harness-secret`
  header and injects `HARNESS_SHARED_SECRET` into each per-run container's env when the secret
  is configured, matching the harness server and the local Docker transport. Unset leaves the
  harness open as before (it is only reachable via DO-internal addressing). The self-hosted
  runner pool reaches the harness through its own control plane, so its secret is configured
  pool-side.

  GitHub API requests in the executor harness now build the PR-lookup query with
  `URLSearchParams` and encode the owner/name path segments, so a branch or owner containing
  `&`/`#` can't split the query or inject a parameter.

- Updated dependencies [18f6b3b]
  - @cat-factory/integrations@0.21.4
  - @cat-factory/orchestration@0.24.2

## 0.27.1

### Patch Changes

- 4849c66: Two follow-ups to the agent-context observability feature:

  - **Worker:** the daily retention `scheduled` handler now fails fast with the same clear
    "TELEMETRY_DB binding is required" error as the request-path container build (via a
    shared `requireTelemetryDb` helper) instead of producing an opaque NPE deep in a
    telemetry repo when the binding is unbound.
  - **Server:** the agent-context snapshot now strips any embedded `user:pass@` userinfo
    from the stored injected-doc URLs and the tester's ephemeral `environmentUrl`, upholding
    the allow-list's "never a credential-bearing URL" promise even when an operator's
    environment-provider mapping populates a credentialed URL.

- Updated dependencies [b82304e]
  - @cat-factory/contracts@0.29.0
  - @cat-factory/kernel@0.32.0
  - @cat-factory/spend@0.10.0
  - @cat-factory/orchestration@0.24.1
  - @cat-factory/agents@0.15.2
  - @cat-factory/integrations@0.21.3
  - @cat-factory/prompt-fragments@0.7.27

## 0.27.0

### Minor Changes

- 765cc42: Capture the complete context provided to each container agent as observability, in an
  isolated telemetry store.

  - New `agent_context_snapshots` table records, per container-agent dispatch, the fully
    fragment-composed system + user prompts, the best-practice fragment bodies folded in,
    and the full content of the files injected into the container (`.cat-context/*`) — the
    gap the per-call LLM telemetry can't see (the agent reads those files via tools). The
    snapshot is a redacted allow-list projection of the dispatched job (never any token or
    credential-bearing URL). Recorded best-effort at dispatch by `ContainerAgentExecutor`
    via the new `AgentContextObservabilityService`, gated by the deployment prompt-recording
    switch (`LLM_RECORD_PROMPTS`) AND a new per-workspace `storeAgentContext` setting
    (on by default; a toggle in Workspace settings). Surfaced on demand via
    `GET /workspaces/:ws/executions/:executionId/agent-context` and a "Provided context"
    view in the observability panel.
  - Telemetry now lives in an isolated store, separate from the transactional domain
    (append-heavy/high-volume/short-retention write profile). `llm_call_metrics` and the new
    `agent_context_snapshots` table both move there: a dedicated `telemetry` Postgres schema
    on Node (same connection) and a separate, **required** `TELEMETRY_DB` D1 database on
    Cloudflare. Both ride the existing `LLM_CALL_METRICS_RETENTION_DAYS` retention window.

  BREAKING (pre-1.0, no migration provided): the Cloudflare Worker now requires a
  `TELEMETRY_DB` D1 binding (provision with `wrangler d1 create cat_factory_telemetry` and
  add the `[[d1_databases]]` entry pointing `migrations_dir` at
  `telemetry-migrations`). `llm_call_metrics` is dropped from the main D1 / `public` schema;
  existing rows are not migrated.

### Patch Changes

- Updated dependencies [765cc42]
  - @cat-factory/kernel@0.31.0
  - @cat-factory/contracts@0.28.0
  - @cat-factory/orchestration@0.24.0
  - @cat-factory/agents@0.15.1
  - @cat-factory/integrations@0.21.2
  - @cat-factory/spend@0.9.5
  - @cat-factory/prompt-fragments@0.7.26

## 0.26.1

### Patch Changes

- Updated dependencies [52d886a]
  - @cat-factory/kernel@0.30.0
  - @cat-factory/contracts@0.27.0
  - @cat-factory/agents@0.15.0
  - @cat-factory/orchestration@0.23.0
  - @cat-factory/integrations@0.21.1
  - @cat-factory/spend@0.9.4
  - @cat-factory/prompt-fragments@0.7.25

## 0.26.0

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
  - @cat-factory/integrations@0.21.0
  - @cat-factory/orchestration@0.22.0
  - @cat-factory/agents@0.14.9
  - @cat-factory/spend@0.9.3
  - @cat-factory/prompt-fragments@0.7.24

## 0.25.1

### Patch Changes

- ed3a673: Requesting Requirement-Writer recommendations is now asynchronous, like every other
  requirements-review operation. The request returns at once with `pending` placeholder
  recommendations and the user is handed back to the board; the Writer runs per finding in
  the durable driver (signalled through the parked requirements gate, mirroring the
  incorporate flow), filling each placeholder (`pending` → `ready`) with live progress and
  raising a notification when the batch is ready. The review window shows "N / M ready" plus
  per-finding "generating…" placeholders, and the board's "Recommending…" badge is now driven
  by server state (a `pending` recommendation), so it survives closing the window. A finding's
  typed answers are flushed before the request and preserved across the async cycle, so the
  user's explicit answers are still there when they return to confirm recommendations.
  Re-requesting a single recommendation rides the same async path; rejecting one now reopens
  its source finding so it can be answered manually. No schema migration (recommendation
  status lives in the existing JSON column) and no prompt/image change.
- Updated dependencies [ed3a673]
  - @cat-factory/contracts@0.25.1
  - @cat-factory/orchestration@0.21.1
  - @cat-factory/agents@0.14.8
  - @cat-factory/integrations@0.20.1
  - @cat-factory/kernel@0.28.1
  - @cat-factory/prompt-fragments@0.7.23
  - @cat-factory/spend@0.9.2

## 0.25.0

### Minor Changes

- 69d2270: Surface the Sandbox (the parallel prompt/model testing surface) end to end. Previously
  only the domain logic (`@cat-factory/sandbox`), wire contracts and kernel ports existed,
  with no way to use the feature; this wires the full stack:

  - **Services** (`@cat-factory/orchestration`): `SandboxService` (prompt-version lineage,
    fixture library with lazy builtin seeding, experiment definitions) + `SandboxRunService`
    (the run-driver + judge — expands an experiment matrix into cells, runs each inline
    candidate against the prompt-version's system text + the fixture input, grades it with a
    judge model against the task rubric, and records the deterministic objective findings
    score). Assembled as the `sandbox` core module when its repositories are wired.
  - **HTTP API** (`@cat-factory/server`): `SandboxController` mounts the prompt/fixture/
    experiment CRUD + `POST /sandbox/experiments/:id/launch`. 503 when unconfigured.
  - **Persistence**: the Sandbox gets its **own database** per runtime for blast-radius
    isolation — a dedicated `SANDBOX_DB` D1 database on the Cloudflare Worker (its own
    `sandbox-migrations/` lineage) and a dedicated `sandbox` Postgres schema on Node
    (Drizzle). Both runtimes contribute the repositories via a single sandbox-owned
    `Partial<CoreDependencies>` mixin, so neither facade enumerates them. Cross-runtime
    conformance asserts parity.
  - **Frontend** (`@cat-factory/app`): a Sandbox window (opened from the sidebar +
    command palette) to clone/version prompts, browse graded fixtures, and define + run
    experiments with a scored results grid.

  BREAKING (deployment): the Cloudflare Worker reads an optional new `SANDBOX_DB` binding;
  without it the Sandbox API answers 503 (the rest of the product is unaffected). To enable
  it, provision a second D1 database and point the binding + its `migrations_dir` at the
  package's `sandbox-migrations/` (see `deploy/backend/wrangler.toml`). On Node the
  `sandbox` schema is created automatically by the boot migrator.

  Container/repo fixtures (a real checkout) are not yet supported by the in-product run
  driver and are refused at launch; the builtin fixtures are all inline.

  Run-driver hardening: a relaunch clears the prior result grid first (new
  `SandboxRunRepository`/`SandboxGradeRepository.removeByExperiment`, mirrored on D1 +
  Drizzle) instead of accumulating duplicate cells; the experiment's terminal status is
  derived from whether any cell was actually graded (`failed` when every candidate failed OR
  every grade failed — never a misleading `done` over a grid of unscored cells, and never
  left `running`); the token budget must be ≥ 1 (a `0` budget is rejected at create rather
  than silently failing every cell) and is documented as a soft cap enforced between cells;
  the judge model defaults to the deployment routing default (no hardcoded vendor) and
  requires an explicit `judgeModel` when none is configured (the experiment builder now
  exposes a judge-model picker so a deployment with no default still has recourse); an
  unparseable / empty / reasoning-only judge reply is now recorded as a grading **error** on
  the cell rather than silently flooring every dimension to the minimum (which read as a
  confident bottom-of-scale grade); the judge-reply JSON extractor — now the single robust
  `extractJson` promoted to `@cat-factory/kernel` and shared by the requirements reviewer, the
  document planner and the Sandbox judge (replacing two weaker object-only copies) — is
  string-literal aware, scans forward past any leading bracket whose span isn't valid JSON
  (so prose like `I weighed [the auth flow]: {…}` no longer defeats extraction for the
  object-returning reviewers), and falls back past a leading non-JSON code fence. The judge
  prompt appends the shared `FINAL_ANSWER_IN_REPLY` directive like the other parsed-reply
  agents, and the provider-for-scope resolution the Sandbox shares with the reviewers is now
  one `resolveScopedModelProvider` kernel helper instead of two copies. The Sandbox window now surfaces a
  non-503 load failure (with a retry) instead of rendering an empty, healthy-looking panel.
  The fixture↔kind mapping the UI filters by now lives on the `@cat-factory/sandbox` catalog
  (`SandboxAgentKindMeta.fixtureKinds`) instead of a parallel frontend switch. Concurrent
  launches of the same experiment are now serialised by an atomic
  `SandboxExperimentRepository.claimForRun` (a conditional transition to `running`, mirrored on
  D1 + Drizzle): only the winner clears + re-expands the result grid, so two simultaneous
  launches can't duplicate the grid or race the grid-clearing deletes, and the grid setup runs
  inside the terminal-status `finally` so a failure there can't strand the experiment
  `running`. The matrix cell cap is surfaced on the overview (`maxCells`) so the builder gates
  on the SAME limit instead of re-encoding the literal. NOTE: the run-driver still executes the
  matrix inline in the launch request (bounded by the cell cap + token budget); a durable
  fan-out (Workflows / pg-boss) for large matrices remains a follow-up.

### Patch Changes

- Updated dependencies [69d2270]
  - @cat-factory/orchestration@0.21.0
  - @cat-factory/contracts@0.25.0
  - @cat-factory/kernel@0.28.0
  - @cat-factory/integrations@0.20.0
  - @cat-factory/agents@0.14.7
  - @cat-factory/prompt-fragments@0.7.22
  - @cat-factory/spend@0.9.1

## 0.24.0

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
  - @cat-factory/spend@0.9.0
  - @cat-factory/integrations@0.19.0
  - @cat-factory/orchestration@0.20.0
  - @cat-factory/agents@0.14.6
  - @cat-factory/prompt-fragments@0.7.21

## 0.23.6

### Patch Changes

- Updated dependencies [a62044d]
  - @cat-factory/kernel@0.26.1
  - @cat-factory/orchestration@0.19.2
  - @cat-factory/agents@0.14.5
  - @cat-factory/integrations@0.18.3
  - @cat-factory/spend@0.8.26

## 0.23.5

### Patch Changes

- a0d5efc: Fix the bootstrap write-permission pre-flight (`FetchGitHubClient.canPush`), which
  never passed for a GitHub App installation (only for local-mode PATs).

  Two bugs:

  1. Wrong source of truth. The check read the repo object's `permissions.push`, which
     reflects a user/collaborator role. A GitHub App installation token isn't a
     collaborator, so that field is empty for it and `push` is never true regardless of
     the grant. The authoritative signal for an App is its granted `contents` scope from
     the token mint response. `canPush` now consults `installationPermissions` (added to
     the `AppTokenSource` seam) and treats `contents: 'write'` as pushable, keeping the
     repo-object role as the path for user/PAT tokens.

  2. Stale token. Installation tokens bake in their grant at mint time and are cached
     in-memory for ~1h, so a token minted before the user granted access kept reporting
     the old grant — a retry right after adding the App would still fail. `canPush` now
     mints a fresh token and rechecks on a negative answer (failure path only). The fresh
     mint also replaces the cached entry the container's push token reads, so a real grant
     fixes the push too. `installationToken` gains an optional `{ forceRefresh }` across
     `AppTokenSource` / `GitHubAppRegistry` / `GitHubAppAuth`.

## 0.23.4

### Patch Changes

- Updated dependencies [2aae8bc]
  - @cat-factory/kernel@0.26.0
  - @cat-factory/spend@0.8.25
  - @cat-factory/agents@0.14.4
  - @cat-factory/integrations@0.18.2
  - @cat-factory/orchestration@0.19.1

## 0.23.3

### Patch Changes

- Updated dependencies [f4f954b]
  - @cat-factory/kernel@0.25.0
  - @cat-factory/orchestration@0.19.0
  - @cat-factory/agents@0.14.3
  - @cat-factory/integrations@0.18.1
  - @cat-factory/spend@0.8.24

## 0.23.2

### Patch Changes

- Updated dependencies [ce81233]
  - @cat-factory/contracts@0.23.0
  - @cat-factory/kernel@0.24.0
  - @cat-factory/integrations@0.18.0
  - @cat-factory/agents@0.14.2
  - @cat-factory/orchestration@0.18.1
  - @cat-factory/prompt-fragments@0.7.20
  - @cat-factory/spend@0.8.23

## 0.23.1

### Patch Changes

- Updated dependencies [7346a4f]
  - @cat-factory/kernel@0.23.0
  - @cat-factory/orchestration@0.18.0
  - @cat-factory/agents@0.14.1
  - @cat-factory/integrations@0.17.1
  - @cat-factory/spend@0.8.22

## 0.23.0

### Minor Changes

- 6ff1f10: Link Confluence/Notion/GitHub documents as **living** best-practice fragments.

  A team can now link an external document (a Confluence page, a Notion page, or a
  GitHub file — any connected Document source) as a prompt-fragment whose guidance is
  **re-resolved from the source at the moment an agent run uses it**, rather than a
  one-time snapshot. Edit the upstream doc and the next agent run follows the new
  version — no re-import. The body is cached on the fragment as a last-resolved
  snapshot and refreshed on a short TTL (default 5 min); if the source is unreachable
  the run falls back to the cached body, so resolution never blocks a run. Available
  at both the account and workspace tiers; an account-tier link fetches through a
  chosen workspace's connection — recorded on the fragment so every consuming
  workspace re-resolves through that same connection at run time, not its own.

  New surface: `POST /:scope/document-fragments` (link a document as a fragment) and
  `POST /:scope/prompt-fragments/:id/refresh` (force an immediate re-resolve), a
  "Documents" tab in the fragment-library manager with a "Live · <source>" badge, and
  a `documentRef`/`resolvedAt` provenance block on `PromptFragment`.

  As part of this, run-time fragment-id resolution now goes through the merged tenant
  catalog (built-in ∪ account ∪ workspace) instead of only the built-in static pool,
  so **managed (DB-authored) fragments also reach a run** — previously only built-in
  ids resolved at run time. Behaviour is unchanged when the prompt-fragment library is
  not configured.

  Persistence: `prompt_fragments` gains `doc_source` / `doc_external_id` /
  `doc_via_workspace_id` / `resolved_at` columns on both runtimes (a D1 migration and
  a Drizzle migration); stale pre-existing rows simply carry nulls.

### Patch Changes

- Updated dependencies [6ff1f10]
  - @cat-factory/contracts@0.22.0
  - @cat-factory/kernel@0.22.0
  - @cat-factory/agents@0.14.0
  - @cat-factory/integrations@0.17.0
  - @cat-factory/orchestration@0.17.0
  - @cat-factory/prompt-fragments@0.7.19
  - @cat-factory/spend@0.8.21

## 0.22.0

### Minor Changes

- 04befe8: Business-only specs + an explicit `technical` task label.

  **Business-only spec-writer + "no new specs" outcome.** The spec-writer now captures
  ONLY business requirements. For a purely technical task (a refactor / non-functional /
  internal change with no externally-observable behaviour) "no new specs" is a valid
  outcome: the writer returns `{"noBusinessSpecs": true}`, the baseline spec is left
  untouched (`specPostOp` commits nothing), and the new `AgentRunResult.noBusinessSpecs`
  channel carries the determination. The spec-companion corroborates or disputes it via a
  new optional `technicalCorroborated` verdict on `companionAssessmentSchema` (a disputed
  "no specs" claim loops the writer back as before). The spec-writer prompts are updated
  accordingly (no version bump — they are not under prompt-version control).

  **Explicit `technical` label on a task.** Blocks gain an optional `technical` field
  (`true`/`false`/unset), persisted on both runtimes (D1 column ⇄ Drizzle column + generated
  migration; shared block mapper). A human sets it at creation (a "Technical task" checkbox)
  or via a tri-state inspector toggle (unset / technical / business). An explicit `false`
  (business) is forwarded to the spec-writer, which is then required to produce specs (it is
  told not to claim "no business specs"); `true` tells it the empty outcome is expected.
  Left unset, the engine infers the label from the settled spec phase — `noBusinessSpecs`
  (writer) combined with `technicalCorroborated` (companion) — both when the spec-companion
  converges automatically AND when a human proceeds past its iteration cap. Once a concrete
  label is recorded it is authoritative and not re-inferred (whether set by a human or a
  prior inference); a human re-opens it to inference by clearing it to "unset". When a task
  is technical the implementer treats the task definition / incorporated requirements as the
  primary source of truth and the committed specs as a regression-spotting reference; the
  `build` prompt is bumped to v3 and carries the per-task signal (only the implementer — not
  the architect/reviewer — acts on it).

  Breaking: none for existing data (the new columns default to "not determined").

### Patch Changes

- Updated dependencies [04befe8]
  - @cat-factory/contracts@0.21.0
  - @cat-factory/kernel@0.21.0
  - @cat-factory/agents@0.13.0
  - @cat-factory/orchestration@0.16.0
  - @cat-factory/integrations@0.16.1
  - @cat-factory/prompt-fragments@0.7.18
  - @cat-factory/spend@0.8.20

## 0.21.0

### Minor Changes

- be182e8: Hybrid linked-context delivery to agents, and deterministic reference resolution.

  Linked documents and tracker issues now reach a container agent as a cheap in-prompt
  summary index plus their full bodies materialised into a `.cat-context/` directory in the
  checkout (kept out of the agent's commits via a local git exclude), so the agent reads only
  what it needs on demand — replacing the previous 280-char document excerpt. Inline (no-
  checkout) agent kinds instead get the budgeted full body injected into the prompt.

  The engine also resolves references named explicitly in a block's description or its
  incorporated requirements (Jira keys like `PROJ-123`, fully-qualified GitHub `owner/repo#123`,
  and URLs) against the already-imported corpus, folding those high-confidence items into the
  context set. Each reference is resolved by a **point lookup** (a keyed `get`, or a new
  `getByUrl` repository method) rather than scanning the whole workspace corpus per step. Bare
  `#123` refs are intentionally not resolved: a workspace can hold many repos, so a bare number
  is ambiguous — name the issue as `owner/repo#123` (or by URL) to pull it in. There is no
  speculative relationship graph and no live fetching: everything is prepared backend-side,
  which is required because the container harness cannot reach Jira/Confluence/GitHub itself.

  Documents gain a `content_hash` column (D1 + Drizzle) so a re-import whose body AND title/url
  are unchanged is a no-op, preserving the existing projection and block link; a renamed/moved
  page still re-projects.

  Breaking (pre-1.0): `AgentRunContext.block.contextDocs` items now carry `summary` + `body`,
  `contextTasks` items carry `summary`, and `DocumentRecord` carries `contentHash`. The
  `DocumentRepository`/`TaskRepository` ports gain a `getByUrl` method (implemented on both the
  D1 and Drizzle stores). The executor-harness image gains an optional `contextFiles` job field;
  bump the runner image tag.

### Patch Changes

- Updated dependencies [be182e8]
  - @cat-factory/kernel@0.20.0
  - @cat-factory/agents@0.12.0
  - @cat-factory/integrations@0.16.0
  - @cat-factory/orchestration@0.15.0
  - @cat-factory/spend@0.8.19

## 0.20.0

### Minor Changes

- 2c24da8: Add a **human-testing gate** (`human-test`) pipeline step. When reached it spins up an
  ephemeral environment and PARKS for a person to validate the change in the live URL before
  the run continues. From the dedicated window the human can confirm (tear the env down +
  advance), submit findings to dispatch the Tester's `fixer` (then the env rebuilds for
  re-testing), pull latest main into the PR branch + redeploy (a clean merge rebuilds the env; a
  conflict dispatches the `conflict-resolver`), or recreate / destroy the env on demand. Falls
  back to a degraded manual mode (no live env, still parks for confirmation) when no
  ephemeral-environment provider is wired.

  New opt-in pipeline `pl_human_review` (`coder → reviewer → human-test → conflicts → ci →
merger`) and a palette block; existing default pipelines are unchanged.

  Adds a `GitHubClient.mergeBranch` (the repo Merges API) and a `BranchUpdater` port behind the
  "pull main" action, wired from the GitHub client on every facade (Worker / Node / local), plus
  a `human_test_ready` notification type (in-app + Slack-routable). Both runtimes wire the gate
  identically and the cross-runtime conformance suite asserts the park → request-fix → confirm
  flow.

### Patch Changes

- Updated dependencies [2c24da8]
  - @cat-factory/contracts@0.20.0
  - @cat-factory/kernel@0.19.0
  - @cat-factory/orchestration@0.14.0
  - @cat-factory/integrations@0.15.0
  - @cat-factory/agents@0.11.16
  - @cat-factory/prompt-fragments@0.7.17
  - @cat-factory/spend@0.8.18

## 0.19.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [4120ac5]
  - @cat-factory/contracts@0.19.0
  - @cat-factory/kernel@0.18.0
  - @cat-factory/orchestration@0.13.0
  - @cat-factory/integrations@0.14.0
  - @cat-factory/agents@0.11.15
  - @cat-factory/prompt-fragments@0.7.16
  - @cat-factory/spend@0.8.17

## 0.18.0

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
  - @cat-factory/integrations@0.13.0
  - @cat-factory/orchestration@0.12.0
  - @cat-factory/agents@0.11.14
  - @cat-factory/prompt-fragments@0.7.15
  - @cat-factory/spend@0.8.16

## 0.17.2

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
  - @cat-factory/integrations@0.12.4
  - @cat-factory/prompt-fragments@0.7.14
  - @cat-factory/spend@0.8.15

## 0.17.1

### Patch Changes

- aa06003: Service-level default test environment. A service frame now carries a
  `defaultTestEnvironment` (docker-compose **local** vs **ephemeral**) that a task is
  spawned with; each task can still override it per-task via its `tester.environment`
  agent config. The engine resolves the effective environment at run time (task pin →
  service default → built-in `ephemeral`) and materialises it onto the run context, so
  the Tester job body, the prompt and the start-time infra gate all agree. Set the
  default in the service inspector's Test infrastructure panel; the task inspector shows
  the inherited value and labels it "inherited from service" until overridden.

  The cloud-provider and instance-size controls are now explained as **hints for
  ephemeral-environment provisioning** and tucked into a collapsed-by-default section.

  Persisted on both runtimes (D1 migration `0009_default_test_environment` ⇄ Drizzle
  `default_test_environment` column); the cross-runtime conformance suite asserts the
  inheritance + per-task override on each.

- Updated dependencies [aa06003]
  - @cat-factory/contracts@0.17.0
  - @cat-factory/orchestration@0.11.0
  - @cat-factory/kernel@0.16.1
  - @cat-factory/agents@0.11.12
  - @cat-factory/integrations@0.12.3
  - @cat-factory/prompt-fragments@0.7.13
  - @cat-factory/spend@0.8.14

## 0.17.0

### Minor Changes

- 208c933: Pre-flight write access before a repo bootstrap. Bootstrapping ends in a force-push,
  but a public target the GitHub App can _read_ (not in the App's selected-repos list,
  or the App lacking `contents:write`) passes the existing existence/emptiness checks
  and only fails deep inside the container with a `403` on `git push`. The bootstrapper
  now verifies the installation actually has push access up front (new
  `GitHubClient.canPush`, reading the token's effective `permissions.push`) and fails
  fast with an actionable error — "grant the App write access to this repository, or use
  a GitHub PAT" — before any board frame is created.

### Patch Changes

- Updated dependencies [208c933]
  - @cat-factory/kernel@0.16.0
  - @cat-factory/agents@0.11.11
  - @cat-factory/integrations@0.12.2
  - @cat-factory/orchestration@0.10.9
  - @cat-factory/spend@0.8.13

## 0.16.1

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
  - @cat-factory/kernel@0.15.1
  - @cat-factory/integrations@0.12.1
  - @cat-factory/agents@0.11.10
  - @cat-factory/orchestration@0.10.8
  - @cat-factory/spend@0.8.12

## 0.16.0

### Minor Changes

- 0ac64b8: Add a "Create task from issue" button on service frames, and scope issue search to
  the service's repo.

  A service frame header now carries a ticket button (shown when a tracker is offered)
  that opens the tracker-issue modal pinned to that service: the new task is created in
  that frame, and the issue search is scoped to the service's linked GitHub repository
  instead of the whole installation. The same repo scoping applies to the
  attach-an-issue-as-context picker in the add-task form.

  Within a scoped GitHub search:

  - a pasted issue URL (or `owner/repo#n` / `owner/repo/issues/n`) resolves to that exact
    issue and is offered first instead of being fuzzy-matched — but only within the
    searching workspace's own GitHub App installation, so a URL naming another account is
    never fetched across tenants;
  - a bare issue number (`11`) resolves against the service's repo and is offered first;
  - free-text hits are restricted to the service's repo (`repo:owner/name`).

  A service is always created from (or with) a repo, so a GitHub search scoped to a block
  now REQUIRES that link: if the service isn't linked to a repo the search is refused with
  a clear error rather than silently widening to the whole installation. The
  block→service→repo resolver (`resolveRepoTarget`) is surfaced on the request container in
  both runtime facades so the shared task-search controller can resolve the scope.

### Patch Changes

- Updated dependencies [0ac64b8]
  - @cat-factory/kernel@0.15.0
  - @cat-factory/contracts@0.16.0
  - @cat-factory/integrations@0.12.0
  - @cat-factory/agents@0.11.9
  - @cat-factory/orchestration@0.10.7
  - @cat-factory/spend@0.8.11
  - @cat-factory/prompt-fragments@0.7.12

## 0.15.1

### Patch Changes

- 7d1f829: Migrate the `tester` built-in agent onto the generic, manifest-driven `agent` harness kind,
  continuing the Task-5 strangler (after the read-only kinds, the merger/on-call/fixers, the
  coder, blueprints, and spec-writer).

  `ContainerAgentExecutor` now routes `tester` through `buildMigratedBuiltInBody` →
  `buildRegisteredAgentBody` as a read-only `mode: 'explore'` structured agent that clones the PR
  head branch (it makes NO commits) instead of the bespoke `/test` body. The agent returns ONLY
  its structured JSON report; `toRunResult` coerces that `custom` result into the `testReport`
  channel the engine's `TesterController` greenlights-or-loops the fixer on. The conservative
  coercion the harness `/test` handler used to apply — defaulting every field safely and honouring
  a greenlight ONLY when no blocking (high/critical) concern is open — now runs backend-side in
  `coerceTestReport` (and the engine re-applies it defensively). The role prompt and the
  run-mode / ephemeral-URL guidance come from the standard `roleSystemPrompt` + `userPromptFor`,
  which already carry them, so the harness adds none.

  The tester needs its docker-compose dependencies stood up for the run, so the generic
  `agent` explore flow grows an optional `infra` spec (`{ environment, noInfraDependencies?,
composePath?, environmentUrl? }`): `handleAgent`'s explore mode stands the local
  docker-compose infra up before the agent runs and tears it down afterward (lifted from the
  bespoke tester handler), folding a stand-up-failure note into the prompt so a missing Docker
  daemon is non-fatal. An `ephemeral` run manages no infra (the env is already deployed and its
  URL reaches the agent through its prompt). This is a harness `src/**` change, so the
  executor-harness image is bumped (1.13.0; deploy tag + `wrangler.toml`).

  Two regressions the migration introduced are fixed here. (1) The report's `environment` (which
  env the suite ran in, echoed to the UI) was authoritatively set from the task config by the old
  `/test` handler; the migrated `coerceTestReport` only read it from the model's JSON, so it was
  near-always dropped. The harness now stamps `environment` onto the structured result from the
  job's `infra` spec (the authoritative source), so it's deterministic again regardless of what the
  model emits. (2) A `local` service with no infra dependencies lost the precise "nothing was stood
  up — run the suite directly" guidance and was told its infra had been stood up on localhost;
  `testerEnvironmentSection` now restores the no-dependencies run-mode line for those services.

  The dead `/test` harness handler (and the other migrated kinds' handlers) is removed in the
  later harness-cleanup sweep. The cross-runtime conformance suite already covers the generic
  `agent` explore + structured-result path on both runtimes.

- Updated dependencies [7d1f829]
  - @cat-factory/agents@0.11.8
  - @cat-factory/orchestration@0.10.6

## 0.15.0

### Minor Changes

- fde0437: Add a first-class **Issue tracker** settings panel (Workspace settings → Issue tracker,
  also linked from the Integrations hub) plus a **live "Check setup" diagnostic** so a
  workspace can both configure issue tracking in one place and see _why_ a source isn't
  working.

  **Panel (frontend).** One discoverable home that gathers what used to be scattered:

  - **Filing tracker** — select where the tech-debt recurring pipeline files its ticket
    (GitHub Issues / Jira / none). Previously only reachable buried inside the tech-debt
    recurring-pipeline modal, so a workspace had no obvious way to designate GitHub Issues.
  - **Linking sources** — the per-workspace on/off toggle for each task source, making
    explicit that filing and linking are independent.
  - **Writeback** — the comment-on-PR-open / close-on-merge toggles, folded in from the old
    standalone "Issue writeback" tab (`IssueTrackerWritebackPanel` is removed).

  **Live "Check setup" (backend, all runtimes).** A new
  `POST /workspaces/:ws/task-sources/:source/diagnostics` endpoint actually authenticates
  against the source and reads a slice of its issues API, returning a classified verdict —
  `ready` / `not_installed` / `not_connected` / `auth_failed` / `forbidden` / `unreachable` /
  `error` — with an actionable message. For GitHub Issues it escalates three probes
  (validate the App credentials → mint the installation token + list repos → read issues on a
  repo) so a 403 pinpoints the most common misconfiguration: the GitHub App lacks the
  **Issues** permission. For Jira it probes `/myself` and distinguishes a rejected token (401)
  from a forbidden account (403). The panel also now surfaces the previously-swallowed probe
  error (e.g. "503 — integration disabled / ENCRYPTION_KEY not set", "500 — backend not
  migrated") instead of a blanket "install integration first".

  Adds an optional `diagnose` capability to the `TaskSourceProvider` port (kernel), implemented
  by the GitHub and Jira providers and orchestrated by `TaskConnectionService.diagnose`
  (integrations), the `taskSourceDiagnosticSchema` wire contract (contracts), and the
  controller endpoint (server). Runtime-neutral — wired through the existing `tasks` module on
  Cloudflare, Node, and local — with a cross-runtime conformance assertion (gate-on-connection
  then delegate-to-provider). A provider without `diagnose` falls back to a static verdict
  from availability.

### Patch Changes

- Updated dependencies [fde0437]
  - @cat-factory/contracts@0.15.0
  - @cat-factory/kernel@0.14.0
  - @cat-factory/integrations@0.11.0
  - @cat-factory/agents@0.11.7
  - @cat-factory/orchestration@0.10.5
  - @cat-factory/prompt-fragments@0.7.11
  - @cat-factory/spend@0.8.10

## 0.14.1

### Patch Changes

- 77b7d31: Migrate the `spec-writer` built-in agent onto the generic, manifest-driven `agent` harness
  kind, continuing the Task-5 strangler (after the read-only kinds, the merger/on-call/fixers,
  the coder, and blueprints).

  `ContainerAgentExecutor` now routes `spec-writer` through `buildMigratedBuiltInBody` →
  `buildRegisteredAgentBody` as a read-only `mode: 'explore'` structured agent that clones the
  per-block WORK branch (`cat-factory/<blockId>` — the coder's branch, created from base when
  absent; the spec-writer runs BEFORE the coder, so it seeds that branch) instead of the
  bespoke `/spec` body. The agent now READS the baseline spec from its own checkout under
  `spec/` (the harness no longer pre-injects it) and returns ONLY the complete spec doc as JSON;
  `toRunResult` coerces that `custom` result into the `spec` channel (via `coerceSpecDoc`) the
  engine already strict-validates + ingests. The `SPEC_WRITER_SYSTEM_PROMPT` is updated to point
  the agent at `spec/overview.md` + the `spec/modules/**` shards, and a new `specWriterUserPrompt`
  carries the task increment + the read-the-baseline / reuse-the-taxonomy guidance the harness
  `buildUserPrompt`/`renderTaxonomyInventory` used to inject.

  The deterministic SHARD + commit of the in-repo `spec/` artifact that used to live in the
  executor-harness `/spec` handler now runs as a BACKEND built-in post-op (`specPostOp`,
  `@cat-factory/agents`), over the checkout-free `RepoFiles` port. It is keyed by the engine's
  own built-in op map in `ExecutionService` — deliberately NOT the agent-kind registry, so the
  built-ins never leak into `customAgentKinds` / the SPA palette. It reproduces the harness
  reconcile exactly: the canonical `service.json` / `overview.md` / `modules/<m>/<g>.{json,md}`
  shards are always rewritten and a removed module/group's shards are PRUNED (the deletion
  channel); the Gherkin `features/<m>/<g>.feature` files are SEEDED-ONCE (committed only when
  absent, never clobbering a polished one); and the pre-sharding monolithic artifacts
  (`spec/spec.json` / `rules.md` / `version.json`) + old flat `features/*.feature` files are
  dropped on sight. Idempotent: the spec has no `version.json` manifest, so the post-op
  byte-compares each rendered shard to the branch and makes NO commit when everything matches
  and there is nothing to seed or prune (durable-driver replay re-commits nothing).

  Because the spec doc is handed onward to be sharded + committed, the migrated kind opts into
  a new `output.failOnUnusableFinal` flag (kernel `AgentOutputSpec`) so the generic explore
  handler FAILS the run LOUDLY when the agent's final answer is cut off at the output ceiling
  (or empty) — restoring the bespoke `/spec` handler's `unusableFinalAnswerCause` gate, which
  the generic `handleAgent` path lacked, so a truncated reply can no longer be laundered into a
  half-baked spec by the structured repair. This is a harness change, so the executor-harness
  image is bumped to `1.12.0` (the `deploy/backend` `image:publish` tag + `wrangler.toml` are
  bumped to match). The dead `/spec` handler is removed in a later sweep step.

  Cross-runtime conformance asserts the post-op shards + commits the `spec/` artifact onto the
  work branch via `RepoFiles` on both runtimes.

  Also fixes a facade-parity gap in the self-hosted runner-pool result coercion
  (`HttpRunnerPoolProvider.coerceRunnerResult`): the generic `agent`-kind structured channel
  `custom` was missing from the pass-through allow-list, so a migrated kind's doc
  (blueprints / spec-writer / merger / on-call) was silently dropped on a runner-pool backend
  while the Cloudflare/local transports — which return the harness view verbatim — kept it.
  `custom` now passes through, and a regression test covers it.

- Updated dependencies [77b7d31]
  - @cat-factory/agents@0.11.6
  - @cat-factory/orchestration@0.10.4
  - @cat-factory/kernel@0.13.4
  - @cat-factory/integrations@0.10.4
  - @cat-factory/spend@0.8.9

## 0.14.0

### Minor Changes

- 82d771e: Add a "View Requirements" button to a selected service in the inspector that opens a
  structured navigation window over the service's prescriptive spec tree (modules → feature
  groups → requirements + Given/When/Then acceptance criteria + domain rules). When the spec
  is present on the service repo's default branch, a toggle switches to the rendered Gherkin
  scenarios.

  A new read-only endpoint `GET /workspaces/:ws/blocks/:blockId/spec` reassembles the sharded
  `spec/` artifact off the repo default branch via the existing checkout-free `RepoFiles`
  resolver (`resolveRunRepoContext`), now surfaced on the `ServerContainer` and wired
  symmetrically on both runtime facades. It returns `{ present: false }` when GitHub is not
  connected or no spec exists yet, so the window shows an empty state rather than erroring.

### Patch Changes

- Updated dependencies [82d771e]
  - @cat-factory/contracts@0.14.0
  - @cat-factory/agents@0.11.5
  - @cat-factory/integrations@0.10.3
  - @cat-factory/kernel@0.13.3
  - @cat-factory/orchestration@0.10.3
  - @cat-factory/prompt-fragments@0.7.10
  - @cat-factory/spend@0.8.8

## 0.13.2

### Patch Changes

- ce27690: Migrate the `blueprints` built-in agent onto the generic, manifest-driven `agent` harness
  kind, and add a checkout-free file-DELETION channel the migration needs.

  `ContainerAgentExecutor` now routes `blueprints` through `buildMigratedBuiltInBody` →
  `buildRegisteredAgentBody` as a read-only `mode: 'explore'` structured agent (cloning the PR
  branch when one is open, else the default branch — exactly its old `prBranch ?? baseBranch`
  clone) instead of the bespoke `/blueprint` body. The agent now returns ONLY the service →
  modules tree as JSON; `toRunResult` coerces that `custom` result into the `blueprintService`
  channel (via `coerceBlueprintService`) the engine already reconciles onto the board.

  The deterministic render + commit of the in-repo `blueprints/` artifact that used to live in
  the executor-harness `/blueprint` handler now runs as a BACKEND built-in post-op
  (`blueprintPostOp`, `@cat-factory/agents`), over the checkout-free `RepoFiles` port. It is
  keyed by the engine's own built-in op map in `ExecutionService` — deliberately NOT the
  agent-kind registry, so the built-ins never leak into `customAgentKinds` / the SPA palette.
  The post-op is idempotent (the `version.json` content hash short-circuits an unchanged tree,
  so a durable-driver replay re-commits nothing) and prunes a removed module's stale deep-dive
  file — the checkout-free analogue of the harness wiping `blueprints/` before writing.

  To support that prune, `commitFilesSchema` / `CommitFilesInput` (and the `RepoFiles` /
  `GitHubClient` `commitFiles` impl in `FetchGitHubClient`) gain an optional `deletions:
string[]`: paths removed in the same commit, built into the Git Data tree as `sha: null`
  entries against the base tree. Additive and non-breaking (absent ⇒ a pure add/update commit).

  The already-shipped executor-harness image serves this via its generic `handleAgent`
  explore-structured handler, so **no image bump is required**. One intentional, low-risk delta:
  the blueprint explore body now carries the shared web-tools fields like every other explore
  agent (gated by `webSearchProxyEnabled`), and the agent reads any existing blueprint from its
  own checkout rather than the harness pre-injecting the baseline tree into the prompt.

  The now-dead `/blueprint` harness handler is removed in a later step of the sweep (which
  bumps the executor image), once parity is confirmed on CI. The cross-runtime conformance
  suite gains an assertion that a `blueprints` step's post-op renders + commits the
  `blueprints/` artifact via `RepoFiles`, identically on both runtimes.

- Updated dependencies [ce27690]
  - @cat-factory/contracts@0.13.1
  - @cat-factory/kernel@0.13.2
  - @cat-factory/agents@0.11.4
  - @cat-factory/orchestration@0.10.2
  - @cat-factory/integrations@0.10.2
  - @cat-factory/prompt-fragments@0.7.9
  - @cat-factory/spend@0.8.7

## 0.13.1

### Patch Changes

- c8bd144: Migrate the next batch of built-in agents — `coder`, `ci-fixer`, `fixer`, `merger` and
  `on-call` — onto the generic, manifest-driven `agent` harness kind, continuing the
  strangler started with the read-only kinds.

  `ContainerAgentExecutor` now routes these through `buildMigratedBuiltInBody` →
  `buildRegisteredAgentBody` (which gained an optional `userPrompt` override) instead of their
  bespoke per-kind bodies:

  - `coder` dispatches `kind: 'agent'` in `mode: 'coding'` (clone the work branch, push it,
    open a PR). `runCodingAgent` already does branch-resume + checkpointing, so this is
    behaviour-equivalent to the old `/run` body.
  - `ci-fixer` / `fixer` dispatch `mode: 'coding'` against the PR branch with
    `noChangesIsError: false` (in-place fixers — a no-op is a clean non-event), matching the
    old `/ci-fix` / `/fix-tests` bodies.
  - `merger` / `on-call` dispatch `mode: 'explore'` with structured output (full clone). The
    conservative JSON coercion that used to live in the harness `/merge` and `/on-call`
    handlers now runs backend-side: `toRunResult` is kind-aware and maps the agent's `custom`
    result into `mergeAssessment` / `onCallAssessment` via `coerceMergeAssessment` /
    `coerceOnCallAssessment`, so the engine's merge resolver and post-release-health gate see
    exactly the same assessment shape as before.

  The already-shipped executor-harness image serves all of these via its generic `handleAgent`
  handler (explore-structured + coding-on-PR/coding-with-PR), so no image bump is required.
  Two intentional, low-risk deltas: the merger/on-call explore bodies now carry the shared
  web-tools fields like every other explore agent (gated by `webSearchProxyEnabled`), and the
  merger's container-side `diffExaminable` guard is replaced by the backend coercion's
  conservative-on-garbage defaults (documented in `coerceMergeAssessment`).

  The now-dead `/run`, `/ci-fix`, `/fix-tests`, `/merge` and `/on-call` harness handlers are
  removed in a later step of the sweep (which bumps the executor image), once parity is
  confirmed on CI.

  Three correctness fixes to the kind-aware mapping itself:

  - The poll site (`ExecutionService.pollAgentJob`) now threads `step.agentKind` into the
    `pollJob` handle. `toRunResult`'s kind-aware coercion keys off `handle.agentKind`, which
    the engine previously never supplied at poll time — so the merger/on-call coercion was
    dead code and `mergeAssessment` / `onCallAssessment` were never set, leaving the merge
    gate and post-release-health gate with no assessment.
  - `clamp01` no longer coerces `null` / `''` / `false` / `[]` to a finite `0` (via `Number()`):
    those now fall back to the conservative default (`1` for the merger → routes to human
    review), so a garbage/null score can't silently read as "trivial/safe" and auto-merge.
  - The coerced `rationale` falls back to a stable `"No rationale provided."` when both the
    agent rationale and the run summary are empty, instead of an empty string.

- Updated dependencies [c8bd144]
  - @cat-factory/orchestration@0.10.1
  - @cat-factory/kernel@0.13.1
  - @cat-factory/agents@0.11.3
  - @cat-factory/integrations@0.10.1
  - @cat-factory/spend@0.8.6

## 0.13.0

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
  - @cat-factory/integrations@0.10.0
  - @cat-factory/orchestration@0.10.0
  - @cat-factory/agents@0.11.2
  - @cat-factory/prompt-fragments@0.7.8
  - @cat-factory/spend@0.8.5

## 0.12.1

### Patch Changes

- 22d7fff: Migrate the read-only built-in agents (`architect`, `analysis`, `bug-investigator`) onto
  the generic, manifest-driven `agent` harness kind — the first step of the strangler that
  converts every built-in to the custom-agent model.

  `ContainerAgentExecutor` now dispatches the read-only kinds through `buildRegisteredAgentBody`
  with a synthesized `container-explore` step, so they ride `kind: 'agent'` in `mode: 'explore'`
  (the SAME path a deployment's registered `container-explore` kind takes) instead of the
  bespoke `explore` dispatch kind. The job body is byte-identical to the old `/explore` body
  (same branch resolution, prompts and web-tools) bar the harness-internal temp-dir label, and
  the prose result maps to `output` exactly as before — a behaviour-preserving reroute, not a
  behaviour change. The already-shipped executor-harness image serves this via its generic
  `handleAgent` handler, so no image bump is required.

  The now-dead `/explore` harness handler (`handleExplore` / `parseExploreJob` / the `explore`
  dispatch kind) is removed in a follow-up once parity is confirmed on CI.

- Updated dependencies [22d7fff]
  - @cat-factory/agents@0.11.1
  - @cat-factory/orchestration@0.9.1

## 0.12.0

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

- 4de2f5f: Declutter settings/navbar and make post-release health a pluggable observability integration.

  **Frontend**

  - Workspace settings is now a single tabbed window: **Merge thresholds**, **Issue writeback**
    and **Default service best practices** moved from standalone modals into tabs (their navbar/
    command-bar entries now deep-link to the tab). Fixed the **Mode** select clipping its options.
  - Removed the **Add a block** button and **all** "Add &lt;type&gt; block" command-bar commands
    (services come from Bootstrap / Add-from-repo, tasks from the add-task flow); dropped the
    unsupported `external` / `environment` block types.
  - The new-task form now shows **Context documents** and **Context issues** sections (inspector-
    style) **ungated** — the _Attach_ button is disabled with a tooltip until the relevant
    integration is connected. (`ContextPicker.vue` removed.)
  - Post-release health is no longer a Datadog-named window: the **connection** is an
    **Observability** entry in the Integrations hub (`ObservabilityConnectionPanel`, provider
    picker — Datadog today), and the per-service **monitor/SLO mapping** moved into the **service
    inspector** (`ServiceReleaseHealthConfig`, keyed by the selected frame — no manual block-id
    entry, disabled with a hint until a connection exists).

  **Backend — pluggable observability (Datadog = one adapter)**

  - The `ReleaseHealthProvider` is now served by `RegistryReleaseHealthProvider`, a registry of
    per-vendor adapters; the Datadog logic became `DatadogObservabilityAdapter`. Adding a second
    provider is a new registry entry — the gate, service, routes and persistence are vendor-neutral.

  **Breaking (acceptable per pre-1.0 policy — no migration):**

  - Persistence: the `datadog_connections` table is **dropped** and replaced by
    `observability_connections` (`provider` discriminator + a single sealed `credentials` JSON blob
    - a non-secret `summary`), mirrored D1 ⇄ Drizzle. Existing connections must be re-entered.
  - Kernel: `DatadogConnectionRecord`/`DatadogConnectionRepository` →
    `ObservabilityConnectionRecord`/`ObservabilityConnectionRepository` (+ `ObservabilityProviderKind`).
  - Contracts: `upsertDatadogConnectionSchema` / `datadogConnectionViewSchema` →
    `upsertObservabilityConnectionSchema` / `observabilityConnectionViewSchema` (now `{ provider,
credentials }` / `{ connected, provider, summary }`), plus `observabilityConnectionSummary`.
  - HTTP: `GET|PUT|DELETE /workspaces/:ws/datadog/connection` → `…/observability/connection`.
  - Config/env: `DATADOG_ENABLED` → `OBSERVABILITY_ENABLED`; `AppConfig.datadog` → `AppConfig.releaseHealth`
    (`DatadogConfig` → `ReleaseHealthConfig`); the sealed-secret domain tag `cat-factory:datadog` →
    `cat-factory:observability`.

  Note: the cross-runtime conformance suite does not yet cover the observability connection CRUD
  (it never covered the Datadog connection either); both facades wire the same repos/cipher/provider
  and ship mirrored D1 + Drizzle migrations.

### Patch Changes

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
- Updated dependencies [4de2f5f]
  - @cat-factory/kernel@0.12.0
  - @cat-factory/agents@0.11.0
  - @cat-factory/contracts@0.12.0
  - @cat-factory/orchestration@0.9.0
  - @cat-factory/integrations@0.9.0
  - @cat-factory/spend@0.8.4
  - @cat-factory/prompt-fragments@0.7.7

## 0.11.1

### Patch Changes

- f8a24e0: Refresh dependencies to latest. Notable major bumps: TypeScript 5→6 (tooling
  packages), vitest 3→4, pino 9→10, `@hono/node-server` 1→2, `@hono/valibot-validator`
  0.5→0.6, happy-dom 15→20, and `@types/node` →26. Patch/minor refreshes for `ai`,
  `hono`, `wrangler`, `pg-boss`, `ws`, `@ai-sdk/*`, `oxlint`, and the Cloudflare
  workers tooling.
- Updated dependencies [f8a24e0]
  - @cat-factory/agents@0.10.1
  - @cat-factory/integrations@0.8.3
  - @cat-factory/kernel@0.11.1
  - @cat-factory/orchestration@0.8.1
  - @cat-factory/spend@0.8.3

## 0.11.0

### Minor Changes

- 1e31cbc: Replace per-agent-kind model defaults with named **model presets**.

  A workspace now keeps a library of model presets instead of a single per-agent-kind
  default map. A preset is one `baseModelId` applied to every agent kind plus optional
  per-kind `overrides`, so "everything Kimi K2.7" is a base with no overrides. Two
  built-ins are seeded for every workspace: **Kimi K2.7** (the default — every agent runs
  on Kimi K2.7) and **GLM-5.2**. A task selects a preset via the new `Block.modelPresetId`
  (the inspector's "Model preset" picker + the new-task form); changing it affects only
  steps that haven't started yet. Resolution precedence is unchanged in spirit: a block's
  pinned model wins, else the task's selected/default preset's mapping for the kind, else
  the env routing.

  - `@cat-factory/contracts`: new `model-presets.ts` (`ModelPreset`, create/update schemas);
    `Block.modelPresetId`; `addTask`/`updateBlock` accept `modelPresetId`; the snapshot
    carries `modelPresets` instead of `modelDefaults`. The `model-defaults` contract is removed.
  - `@cat-factory/kernel`: new `ModelPresetRepository` port (replaces `ModelDefaultsRepository`),
    `DEFAULT_MODEL_PRESETS` seed + `modelForKindFromPreset` helper; `resolveWorkspaceModelDefault`
    resolvers gain an optional `modelPresetId` argument throughout.
  - `@cat-factory/orchestration`: `ModelPresetService` (CRUD + lazy seeding, replaces
    `ModelDefaultsService`) and `resolvePresetModelForKind`; the execution engine threads the
    block's preset into model resolution, the personal-credential gate and the start guard.
  - `@cat-factory/agents`: `StepModelInputs.modelPresetId` + the resolver signature.
  - `@cat-factory/server`: `ModelPresetController` (`GET|POST|PATCH|DELETE
/workspaces/:ws/model-presets`, replaces the model-defaults controller); the block mappers
    persist `model_preset_id`; the snapshot lists `modelPresets`.
  - `@cat-factory/worker` / `@cat-factory/node-server`: the `model_presets` table (D1 migration
    `0006` ⇄ Drizzle) + `blocks.model_preset_id`, replacing `workspace_model_defaults`.

  BREAKING (pre-1.0, no migration): the `workspace_model_defaults` table, the
  `/model-defaults` endpoint, and the snapshot's `modelDefaults` field are removed. Existing
  per-agent-kind default maps are dropped; workspaces fall back to the seeded built-in presets.

### Patch Changes

- Updated dependencies [1e31cbc]
  - @cat-factory/contracts@0.11.0
  - @cat-factory/kernel@0.11.0
  - @cat-factory/orchestration@0.8.0
  - @cat-factory/agents@0.10.0
  - @cat-factory/integrations@0.8.2
  - @cat-factory/prompt-fragments@0.7.6
  - @cat-factory/spend@0.8.2

## 0.10.0

### Minor Changes

- d0081e1: Shard the in-repo `spec/` artifact by a module → feature taxonomy to kill merge churn.

  The spec-writer no longer commits a single monolithic `spec/spec.json` (+ `overview.md`
  / `rules.md` / `version.json`); every spec run rewrote those whole files, so two task
  branches that both touched the spec conflicted hard on merge. The spec is now SHARDED:
  a tiny `spec/service.json`, an `spec/overview.md` index, and one canonical
  `spec/modules/<module>/<group>.json` (+ a human `<group>.md`) per feature group, with
  the Gherkin `spec/features/<module>/<group>.feature` files nested to match. A group's
  file bytes depend only on that group, so concurrent branches editing different
  features never touch the same file.

  **Breaking (acceptable per pre-1.0 policy — no migration):**

  - `@cat-factory/contracts`: `SpecDoc` gains a two-level taxonomy — `modules: SpecModule[]`
    where each module holds `groups`, and each group carries BOTH its `requirements` and the
    domain `rules` scoped to it. The top-level `SpecDoc.groups`/`SpecDoc.rules`,
    the `SpecVersion`/`version.json` manifest, and the `SPEC_JSON_PATH`/`SPEC_RULES_PATH`/
    `SPEC_VERSION_PATH` path constants are removed; `SPEC_SERVICE_PATH`/`SPEC_MODULES_DIR`
    are added. `renderSpecForReview` walks the new shape. An existing repo's monolithic
    `spec.json` / `rules.md` / `version.json` (and any old flat `features/*.feature` files)
    are DELETED on the next spec run — the sharded layout is written fresh; no migration.
  - `@cat-factory/executor-harness`: sharded deterministic render + on-disk reassembly
    read-back + orphan-shard pruning (a removed/renamed module or group is deleted, not
    resurrected) + a one-time prune of the pre-sharding monolithic/flat artifacts;
    `version.json` dropped (no-op detection is now per-file via the commit).
    Content-derived (not positional) rule ids keep a group file byte-stable. The spec-writer
    prompt + reassembled-baseline now carry an EXISTING-taxonomy inventory and steer the
    agent to slot new requirements/rules into the closest existing module + feature (reusing
    exact names) rather than spawning near-duplicate domains/groups. Ships in the **1.9.0**
    runner image already pinned in `deploy/backend` (no further tag move needed).
  - `@cat-factory/agents`: the runtime-neutral `repo-ops/render.ts` mirror is reworked to
    the same sharded layout (`renderSpecVersionFile`/`nextSpecVersion`/`canonicalSpecJson`/
    `hashSpec` for the spec removed); `SPEC_AWARE_GUIDANCE` points readers at
    `spec/modules/<module>/<feature>.{md,json}`.
  - `@cat-factory/server`: `SPEC_WRITER_SYSTEM_PROMPT` describes the module → feature →
    {requirements, rules} structure, the no-catch-all rule, and the taxonomy-reuse rule.

### Patch Changes

- Updated dependencies [d0081e1]
  - @cat-factory/contracts@0.10.0
  - @cat-factory/agents@0.9.0
  - @cat-factory/integrations@0.8.1
  - @cat-factory/kernel@0.10.1
  - @cat-factory/orchestration@0.7.7
  - @cat-factory/prompt-fragments@0.7.5
  - @cat-factory/spend@0.8.1

## 0.9.0

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
  - @cat-factory/spend@0.8.0
  - @cat-factory/integrations@0.8.0
  - @cat-factory/agents@0.8.2
  - @cat-factory/orchestration@0.7.6
  - @cat-factory/prompt-fragments@0.7.4

## 0.8.0

### Minor Changes

- 5c20968: Add the generic, manifest-driven `agent` harness kind + its backend dispatch.

  - `@cat-factory/executor-harness`: a single generic `agent` job kind (`parseAgentJob` +
    `handleAgent`) that runs an LLM over an optional checkout in one of two modes —
    `explore` (read-only; returns prose, or a parsed `custom` JSON object) or `coding`
    (clone/edit/commit/push, optionally open a PR), built on the existing
    `runAgentInWorkspace`/`runCodingAgent`/`resolveStructuredOutput` primitives. It holds no
    per-agent-kind logic; the bespoke kinds remain during migration. **Image bump** (the
    deploy tag moves to `1.9.0` so the new kind rolls out).
  - `@cat-factory/kernel`: `RunnerDispatchKind` gains `'agent'`; `RunnerJobResult` and
    `AgentRunResult` gain a generic `custom` channel for a structured agent's output. The
    `GitHubClient` port gains `branchHeadSha` — an exact single-ref head lookup that stays
    correct on repos with more branches than one `listBranches` page (the create-vs-commit
    signal `RepoFiles.headSha` relies on).
  - `@cat-factory/server`: `ContainerAgentExecutor` dispatches any registered kind that
    declares an `agent` step through the generic `agent` kind (`buildRegisteredAgentBody`)
    and maps `custom` results; built-in kinds are unchanged. New `RepoFiles` implementation
    (`makeRepoFiles`/`makeResolveRepoFiles`, a checkout-free facade over the `GitHubClient`
    Git Data API) + a `runRepoOps` helper — the substrate the pre/post-op engine wiring will
    use next.

### Patch Changes

- Updated dependencies [5c20968]
  - @cat-factory/kernel@0.9.0
  - @cat-factory/agents@0.8.1
  - @cat-factory/integrations@0.7.5
  - @cat-factory/orchestration@0.7.5
  - @cat-factory/spend@0.7.5

## 0.7.4

### Patch Changes

- Updated dependencies [c70df09]
  - @cat-factory/agents@0.8.0
  - @cat-factory/contracts@0.8.0
  - @cat-factory/kernel@0.8.0
  - @cat-factory/orchestration@0.7.4
  - @cat-factory/integrations@0.7.4
  - @cat-factory/prompt-fragments@0.7.3
  - @cat-factory/spend@0.7.4

## 0.7.3

### Patch Changes

- Updated dependencies [a0a1bcc]
  - @cat-factory/kernel@0.7.3
  - @cat-factory/spend@0.7.3
  - @cat-factory/agents@0.7.3
  - @cat-factory/integrations@0.7.3
  - @cat-factory/orchestration@0.7.3

## 0.7.2

### Patch Changes

- 4fa5ed9: Re-release all publishable packages. The previous release bumped these on `main` but never reached npm (the publish job was never triggered), so npm is a release behind. This changeset re-triggers the release so every package publishes.
- Updated dependencies [4fa5ed9]
  - @cat-factory/agents@0.7.2
  - @cat-factory/contracts@0.7.2
  - @cat-factory/integrations@0.7.2
  - @cat-factory/kernel@0.7.2
  - @cat-factory/orchestration@0.7.2
  - @cat-factory/prompt-fragments@0.7.2
  - @cat-factory/spend@0.7.2

## 0.7.1

### Patch Changes

- 7463cf2: Add `repository` metadata (url + monorepo `directory`) to every published package.json. npm provenance attestation rejected the previous release because `repository.url` was empty and could not be matched against the source repo; declaring it lets the publish (and provenance) succeed, and re-triggers publishing of all packages from the failed release.
- Updated dependencies [7463cf2]
  - @cat-factory/agents@0.7.1
  - @cat-factory/contracts@0.7.1
  - @cat-factory/integrations@0.7.1
  - @cat-factory/kernel@0.7.1
  - @cat-factory/orchestration@0.7.1
  - @cat-factory/prompt-fragments@0.7.1
  - @cat-factory/spend@0.7.1

## 0.7.0

### Minor Changes

- e0e89a7: Document- and task-source integrations are now **always on** instead of opt-in, and
  credential encryption is consolidated onto a single shared key.

  The `DOCUMENTS_ENABLED` / `TASKS_ENABLED` flags are gone — tenants connect their own
  Notion/Confluence/Jira sources interactively through the task-creation modal, so there
  is no service-level toggle to forget. A missing encryption key now **fails loudly at
  config load** rather than silently dropping the feature from the UI.

  **Breaking — single encryption key.** The per-integration `DOCUMENTS_ENCRYPTION_KEY`,
  `TASKS_ENCRYPTION_KEY`, `ENVIRONMENTS_ENCRYPTION_KEY` and `RUNNERS_ENCRYPTION_KEY` env
  vars are **removed**. One shared **`ENCRYPTION_KEY`** now backs all four integrations
  (the cipher already domain-separates per integration via its HKDF `info` tag, so a
  single master key is safe). Deployments must set `ENCRYPTION_KEY`; the always-on
  document/task sources refuse to boot without it, and the opt-in environment/runner
  integrations read it too. The Node facade serves task sources only (it ships no
  document providers yet), so it requires `ENCRYPTION_KEY` but no document-source wiring.

- 3d9a9d8: Requirements incorporation + re-review now run asynchronously instead of freezing the
  review window.

  Previously, clicking "Incorporate answers" fired two sequential LLM calls (fold the answers,
  then re-review) inside the HTTP request, locking the user in the modal until the round
  resolved. Now the request records the human's intent on the parked run, signals the durable
  driver, and returns at once with the review in a new transient `incorporating` status. The
  fold + re-review run in the same durable driver the rest of the pipeline uses (where the
  initial reviewer pass already runs), so the user goes straight back to the board. They are
  summoned again — via the existing `requirement_review` notification — only when the
  re-review raises new findings (`ready`) or hits the iteration cap (`exceeded`); a converged
  re-review (`incorporated`) just advances the pipeline with no interruption.

  - **Engine.** The `requirements-review` gate is now re-entrant: a parked gate carrying a
    `pendingIncorporation` marker re-evaluates on wake, runs `incorporate()` + `reReview()`,
    then advances or re-parks. New `ExecutionService.incorporateRequirements` validates the
    findings are settled, flags the review `incorporating`, and signals the driver. An
    off-path inspector review with no parked run still incorporates inline (there is no driver
    to offload to).
  - **Live event.** New optional `ExecutionEventPublisher.requirementReviewChanged` +
    `{ type: 'requirements' }` `WorkspaceEvent`, so an open window/inspector tracks the status
    transitions live (Cloudflare pushes via the DO hub; Node reconciles on poll, as today).
  - **API.** Incorporation moves to the block-scoped `POST
/blocks/:blockId/requirement-review/incorporate` (was the reviewId-scoped
    `/requirement-reviews/:reviewId/incorporate`) and returns the `incorporating` review
    rather than `{ review }`.
  - **Conformance.** A new cross-runtime assertion proves the async-incorporate route is
    mounted on every facade and refuses incorporation while a finding is unanswered.

  Breaking (pre-1.0, no migration): the new `incorporating` review status, the `requirements`
  event variant, the transient `pendingIncorporation` field on a pipeline step, and the moved
  incorporate endpoint are new wire shapes. Old clients and any in-flight review rows on the
  old endpoint shape simply break; stale state is acceptable per the no-backwards-compat
  policy.

- 3bc8c79: Capture the model's reasoning / "thinking" trace in LLM observability. A reasoning
  model (e.g. `@cf/moonshotai/kimi-k2.7-code`) can spend its whole output budget in a
  separate reasoning channel and return an empty completion — previously those output
  tokens were unaccounted for (`response_text` empty, no trace), which made an empty
  spec-writer/blueprint failure undiagnosable. The LLM proxy now records `reasoningText`
  alongside `responseText`: the Workers AI in-process path reads it from the AI SDK
  (`generateText`'s `reasoningText`), and the OpenAI-compatible buffered + streamed paths
  read `reasoning_content` / `reasoning`. Stored in the new `reasoning_text` column
  (`llm_call_metrics`, D1 migration `0002_llm_reasoning_text` ⇄ Drizzle), surfaced in the
  metrics export and the Observability panel, and used as the Langfuse trace output when
  the response text is empty.

  Breaking: the `llm_call_metrics` table gains a non-null `reasoning_text` column (old
  rows default to `''`).

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

- 8065fed: Make the CI / conflicts gates observable. The gate window now shows the run id
  (copyable, with a jump into observability), a per-attempt history of every
  ci-fixer / conflict-resolver run (what each tried and how it ended), and — for
  the conflicts gate — the resolver's own account of which files it left
  conflicting (GitHub's API exposes mergeability as a single bit, so this comes
  from the resolver, plus a link to inspect the PR on GitHub). Failing CI checks
  now link straight to their GitHub run logs.

  Mechanically: `GateStepState` gains an append-only `attemptLog`; the engine
  records each gate-helper attempt when its job finishes (previously discarded the
  moment the gate re-probed) and sets the conflicts gate's `lastFailureSummary`
  from the resolver's output. `CiCheck` / `gateFailingCheckSchema` /
  `githubCheckRunSchema` carry the check run's `html_url` so the UI can link to it
  (populated on the live check-runs read; not persisted to the projection). The
  conflict-resolver result mapping now surfaces the still-conflicting file list
  (its `error`) instead of dropping it.

  Also tightens the conflict-resolver prompt: lockfiles (`package-lock.json`,
  `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, …) must be regenerated via the package
  manager rather than hand-merged — large generated files are what exhausted the
  resolver's context window and left big conflict sets unresolved.

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

- 0972696: Surface external context sources in the add-task popup, with search + a new GitHub
  repo-doc source.

  The task-creation popup gains a `ContextPicker`: pick a connected source
  (Confluence, Notion, GitHub repo docs, Jira, GitHub issues), then **search its
  catalogue by title/content**, paste a page/issue URL, or pick something already
  imported — chosen items are imported and linked to the new task as agent context
  when it's created. Previously the popup could only tick already-imported items and
  there was no in-UI way to reach the catalogue.

  - **Search** is a new optional capability on the document/task source providers
    (`search?(credentials, query)`), exposed as `POST
/workspaces/:ws/{document,task}-sources/:source/search`. Implemented for
    Confluence (CQL), Notion (`/v1/search`), Jira (JQL), GitHub issues
    (`/search/issues`) and GitHub docs (`/search/code`). The `GitHubClient` port
    gains `searchIssues` / `searchCode`. Descriptors advertise `searchable` so the UI
    knows when to offer a search box.
  - **GitHub repo docs** are a new `github` document source: link a Markdown/text
    file from a repo (README, RFC, architecture note) by URL or `owner/repo:path`, or
    by code-search. Like GitHub issues it reuses the workspace's installed GitHub App
    (no credentials of its own) and is wired only when the GitHub integration is on.

- e9b9356: Create board tasks directly from imported GitHub issues or Jira tickets.

  Previously an imported issue could only be attached to an _existing_ task block as
  agent context. The task-source integration now also materialises an issue as a
  brand-new board task: `TaskLinkService.createTaskFromIssue` seeds a leaf block
  (title `KEY: summary`, description = a source-reference line + the issue body)
  inside a chosen service frame or module via `BoardService.addTask`, then links the
  issue to the new task so every agent step still sees the full issue (description,
  comments, metadata) as context. The issue stays the source of truth — re-importing
  refreshes it. Backed by `POST /workspaces/:ws/tasks/create-block`
  (`{ source, externalId, containerId }` → `{ block, task }`). In the UI, the
  task-source import modal gains a "create tasks in" container picker and a per-issue
  "Create task" action.

  The new task carries `createdBy` (the signed-in user, threaded through the widened
  `BoardWritePort.addTask`) for notification routing, the container is resolved in the
  request workspace so the workspace-scoped issue link always resolves at execution
  time, and creating a second task from an already-linked issue is refused (`409`)
  rather than silently re-pointing the single issue→block link. The shared
  cross-runtime conformance suite now asserts the whole create-task-from-issue flow
  (seeded over a deterministic task source) against BOTH the Cloudflare/D1 and the
  Node/Postgres facades.

  Also closes two cross-runtime parity gaps in the task-source layer so the feature
  works identically on both facades:

  - **GitHub issues as a task source now work on the Node runtime.** The
    runtime-neutral `GitHubIssuesProvider` (it depends only on the `GitHubClient` /
    `GitHubInstallationRepository` ports) moved from the Cloudflare package into the
    shared `@cat-factory/integrations`, the Node facade wires it whenever a GitHub
    client is available (the App is configured) — mirroring the Worker's
    `config.github.enabled` gate — AND `github` was added to the Node facade's
    task-source allow-list (it had been omitted, so the provider could never register).
    Previously only the Worker offered GitHub issues.
  - **Jira search now works on the Node runtime.** The duplicated per-runtime
    `JiraProvider` was hoisted into the shared `@cat-factory/integrations` (it is a thin
    runtime-neutral `fetch` shell, like `GitHubIssuesProvider`), so both facades now
    compose the SAME class — including `search()`, which the legacy Node copy had
    silently dropped.

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

- 084bf43: Widen the env-provisioning + runner-pool surface so an external orchestration adapter
  (e.g. an in-house PR-environment platform) can be written on top of our ports and wired
  into a stock facade build, without forking the facades.

  - `EnvironmentProvider` provision requests now carry a typed `provisionContext`
    (branch / PR number+url / repo owner+name, derived from the block's PR ref) and the same
    values are flattened into `{{input.*}}` for the manifest path. The deployer step supplies
    it. A PR-environment provider needs the git ref + repo to target the right environment.
  - New `UrlSafetyPolicy` (kernel) + `resolveUrlSafetyPolicy` (server): the env + runner-pool
    URL/host guard is now policy-driven. The default stays strict (https-only, no
    private/internal hosts); a TRUSTED operator can widen it per facade to reach an internal
    platform on a private/VPN host. The two integrations are scoped **independently** — each
    resolves its own policy from its own config slice, so widening one (`ENVIRONMENTS_*`) does
    not widen the other's (`RUNNERS_*`) SSRF guard. Config: `ENVIRONMENTS_ALLOW_URL_HOSTS` /
    `ENVIRONMENTS_ALLOW_HTTP_URLS` and `RUNNERS_ALLOW_URL_HOSTS` / `RUNNERS_ALLOW_HTTP_URLS`
    (Node env vars + the matching Worker `[vars]`).
  - The Node facade's `buildNodeContainer` gains a documented `environmentProvider` seam (the
    Worker injects via `buildContainer`'s `overrides`); a custom adapter replaces the default
    manifest-driven `HttpEnvironmentProvider` while the env repos + secret cipher still wire
    from config. The local facade inherits the seam through `buildNodeContainer`.

  No backwards-incompatible changes: every addition is optional and defaults to today's
  behaviour.

- 8eed38c: Make the GitHub controllers runtime-neutral and move them into `@cat-factory/server`.
  The workspace-scoped GitHub controller and the public webhook/setup-callback
  controller now delegate their out-of-band work to two new gateways —
  `GitHubBackfillScheduler` (full-installation backfill) and `GitHubWebhookIngest`
  (webhook + incremental repo resync) — and read the install-state HMAC secret from
  config. `StateSigner` moves to the shared package. The Worker supplies
  `WorkflowsBackfillScheduler` (Cloudflare Workflows) and `CfGitHubWebhookIngest`
  (the sync Queue), each falling back to inline handling when its binding is absent.
  Behaviour on the Worker is unchanged.
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

- 57d70fa: Issue-tracker writeback: comment on a task's linked tracker issue when its PR
  opens, and comment + close the issue as resolved when the PR merges.

  Two independent toggles configured at the **workspace** level (on the existing
  tracker settings) and overridable **per task** in the inspector
  (`commentOnPrOpen`, `resolveOnMerge`; each task override is `inherit`/`on`/`off`).
  The linked issue(s) come from the existing task projection (`linkedBlockId`), so
  writeback targets whatever GitHub/Jira issue is attached to the task. All writeback
  is best-effort — a tracker outage never fails a run.

  GitHub issues close natively (`state_reason: completed`); Jira issues transition to
  the first status in their standard **Done** category (no manual status mapping). The
  new `IssueWritebackService` mirrors `TicketTrackerService`'s per-facade seams and is
  wired on both the Cloudflare and Node runtimes; the `GitHubClient` port gains a
  `closeIssue` method.

  **Breaking (pre-1.0, no migration):** the `tracker_settings` table gains
  `writeback_comment_on_pr_open` / `writeback_resolve_on_merge` columns and `blocks`
  gains `tracker_comment_on_pr_open` / `tracker_resolve_on_merge` (D1 migration `0005`
  ⇄ a generated Drizzle migration). Both default to off/inherit, so existing data is
  unaffected.

- 918764f: Extend the Langfuse observability with **tool spans**: each container agent's tool
  calls now surface as spans under its run's trace, alongside that run's LLM generations
  (both are children of the one run trace, keyed by the execution id).

  The harness buffers a compact, metadata-only `ToolSpan` (`{tool, startedAt, endedAt,
ok}` — never tool args/results) per completed Pi tool call and returns the batch on its
  existing `GET /jobs/{id}` poll with **drain-on-read** semantics (each poll returns the
  spans since the last poll and clears the buffer). No new network from the container, no
  hot-path work — only in-memory accumulation bounded to one poll interval, so OOM risk is
  nil. `ContainerAgentExecutor.pollJob` forwards each drained batch to the trace sink as
  spans under the run trace (`jobId === executionId`, the same trace id the LLM
  generations use). Best-effort and fully isolated — a sink failure never affects the job
  lifecycle.

  Bumps the `@cat-factory/executor-harness` image tag (1.2.0 → 1.3.0); a deploy is needed
  to roll out the harness change. The self-hosted runner-pool path (arbitrary,
  manifest-driven APIs) gracefully yields no tool spans; the Cloudflare-container and
  local-Docker paths carry them through automatically.

- 918764f: Add optional, opt-in **Langfuse** LLM observability. A new fetch-based
  `@cat-factory/observability-langfuse` package implements a runtime-neutral
  `LlmTraceSink` (new kernel port) against Langfuse's ingestion API — no Node SDK or
  OpenTelemetry, so it runs unchanged on BOTH the Cloudflare Worker (workerd) and Node
  facades.

  Proxied container-agent calls and inline (non-proxied) calls — requirements
  review/rework, document planner, fragment selector, the inline agent — flow through the
  SAME sink path: the orchestration `LlmObservabilityService` fans every recorded proxied
  call out as a generation, and an `InstrumentedModelProvider` wraps every resolved model
  so inline `generateText` calls surface the identical `LlmGenerationEvent`. Calls are
  grouped under one trace per run (`executionId`); inline single-shot calls become their
  own standalone trace.

  Off unless `LANGFUSE_ENABLED=true` and both keys are set; wired symmetrically in both
  runtime containers. Honours the existing `LLM_RECORD_PROMPTS` switch (prompt/response
  bodies are omitted from Langfuse too when disabled). The sink never throws into the LLM
  path — failures are swallowed and logged. The existing local metric store, spend gating
  and board rollups are unchanged; Langfuse is an additive external sink, not a
  replacement.

- fe0b7f8: Live model-activity: push per-call LLM activity over the workspace event stream.

  The "Model activity" panel fetched once when it opened and never updated, so a running
  step's calls only appeared on a manual reopen — and when a durable driver was evicted
  mid-run the board badge (which rides the poll loop) froze too, making a stalled driver
  look identical to a wedged agent. But the proxy records every call the moment it
  returns, independent of the execution driver, so the data was live the whole time;
  only the read side was stale.

  The proxy now emits a compact `llmCall` event per model call, sourced where the metric
  is already recorded:

  - New `LlmCallActivity` contract + `llmCall` `WorkspaceEvent` variant — the per-call
    summary (id, run, agent kind, provider/model, tokens, finish reason, ok/status, the
    latency split) WITHOUT the prompt/response bodies, so the stream payload stays small.
  - `ExecutionEventPublisher` gains an optional `llmCallObserved`; the proxy mints the
    call id (so the live row and the persisted metric share it) and pushes through the
    same realtime publisher execution events use. `DurableObjectEventPublisher` fans it
    to the `WorkspaceEventsHub` on Cloudflare; `FanOutEventPublisher` forwards it; Node's
    no-op publisher leaves it inert until Node gains a real-time transport. The emit is
    best-effort and fires even when the persistence sink is off.
  - SPA: `useWorkspaceStream` folds the event into the observability store, so an open
    panel updates in real time and keeps updating during a driver eviction. Live-appended
    rows carry no bodies; the panel lazy-loads those (by id) from the persisted metrics
    endpoint when a row is expanded.

  Both runtimes' real Hono apps are covered by a proxy-emit integration test asserting
  the identical compact activity event (each over its own app), so the shared controller's
  emit can't silently work on one runtime and not the other. The Cloudflare-specific
  publish leg — `DurableObjectEventPublisher.llmCallObserved` fanning the event to a live
  socket as an `llmCall` `WorkspaceEvent` — has its own dedicated hub spec.

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

- db336b1: LLM observability for container-based agent execution.

  Every container agent talks to models only through the runtime-neutral LLM proxy, so
  that single chokepoint now records one rich metric per call — the full prompt and
  response, token usage, how close the call ran to its output-token limit (truncation),
  and the latency split between transport/proxy overhead and actual model execution —
  plus errors and warnings (non-2xx, in-process failures, spend-gate refusals,
  `finish_reason: length`/`content_filter`).

  - New `LlmCallMetricRepository` kernel port + `LlmObservabilityService`
    (orchestration), composed only when a metric repository is wired (default-off, so
    tests and unconfigured facades are unaffected). Persisted on both runtimes: a new
    D1 table (`llm_call_metrics`, migration 0026) and a Drizzle/Postgres table, kept in
    lock-step by a cross-runtime conformance repository-parity suite.
  - The proxy is instrumented across the buffered, streaming, and in-process (Workers
    AI) paths; recording is scheduled off the response path so it never adds latency.
  - The execution engine rolls the per-run, per-agent-kind aggregates onto each
    pipeline step (`step.metrics`) and ships them over the existing execution event, so
    the board shows tokens, an output-limit headroom bar, a transport-vs-execution split
    and error/warning badges live — on the step cards, the pipeline timeline and the
    step-detail overlay. A new drill-down panel (`GET …/executions/:id/llm-metrics`)
    lists every call with its full prompt + response, and an LLM-friendly JSON export
    (`…/llm-metrics/export`) bundles totals + per-agent insights + every call (with
    derived ratios) for handing a run straight to a model to analyse.
  - The full request/response bodies make the table heavy, so it is pruned aggressively
    by the retention cron — default 3 days (`LLM_CALL_METRICS_RETENTION_DAYS`).

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

- a691853: Monorepo support: select a subset of a repo's services and pin each to a subdirectory.

  A linked GitHub repository can now be flagged a **monorepo** (`github_repos.is_monorepo`,
  D1 migration `0044` ⇄ Drizzle), which lets it back **more than one** board service —
  each pinned to its own subdirectory (`services.directory`). The "Add service from repo"
  modal gains a monorepo toggle and a **directory browser** (`GET
/workspaces/:ws/github/repos/:id/tree`, served from GitHub's contents API via
  `GitHubSyncService.listRepoDirectory`) so you can explore the repo and pick the
  directory of the service you want — and add several (a subset of the repo's services).
  `PATCH /workspaces/:ws/github/repos/:id` sets the monorepo flag.

  The chosen subdirectory is **fed to the agents that build the service** when the repo is
  a monorepo: `buildResolveRepoTarget` resolves a frame's service (so multiple frames can
  target one repo) and returns its `serviceDirectory`, which flows through the container
  job body into the harness. The implementation agents — **coder, mocker and ci-fixer**
  (everything routed through `runCodingAgent`) — run with their working directory set to
  that subtree and are told, in their AGENTS.md context, that they're in a monorepo and to
  scope their work (and build/test commands) to it. The cross-cutting agents keep operating
  at the repo root by design: the **conflict-resolver** and **merger** act on the whole
  merge / diff, and the **blueprint** and **requirements** agents write repo-root artifacts.
  Non-monorepo repos keep the historical whole-repo behaviour.

  Known limitation: the in-repo blueprint (`blueprints/`) and requirements (`requirements/`)
  artifacts are still written at the repo root, so two services backed by the same monorepo
  share — and would overwrite — those files. Per-service artifact paths are a follow-up.

- c664fe6: Run container agent steps on the Node service via a self-hosted runner pool, so the
  Node facade no longer silently degrades repo-operating kinds (coder, mocker,
  playwright, blueprints, ci-fixer, conflict-resolver, merger) to useless one-shot LLM
  calls.

  The container-execution machinery is now shared, not Worker-only:

  - `@cat-factory/server` hosts the runtime-neutral `CompositeAgentExecutor`,
    `ContainerAgentExecutor` and `RunnerJobClient`, plus the Web-Crypto
    `WebCryptoSecretCipher` and GitHub-App auth (`GitHubAppAuth` / `GitHubAppRegistry`).
  - `@cat-factory/integrations` hosts the manifest-driven runner-pool transport
    (`HttpRunnerPoolProvider` / `RunnerPoolTransport`).
  - `@cat-factory/server` also hosts the runtime-neutral `buildResolveRepoTarget` (the
    security-sensitive block→service→repo ancestry walk, with its no-"first-repo"-fallback
    policy), so the Worker and Node service single-source it instead of keeping two
    hand-copied resolvers that could drift. Each facade just binds its own repositories.
  - `@cat-factory/worker` keeps thin re-export shims at the old paths (no API change).

  `@cat-factory/node-server` wires a `CompositeAgentExecutor` (inline + container) whose
  container executor dispatches to a workspace's registered runner pool
  (`RunnerPoolTransport`), resolving the run's repo + minting a short-lived GitHub
  installation token exactly as the Worker does. New Postgres tables
  (`runner_pool_connections`, `github_installations`, `github_repos`) mirror the D1
  schema. It activates when `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`, `PUBLIC_URL`,
  `AUTH_SESSION_SECRET` and `ENCRYPTION_KEY` are configured; otherwise inline
  kinds still work and container kinds fail loudly rather than faking success.

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

- 4a08935: Add **OpenRouter** and **LiteLLM** as model providers. Both are OpenAI-compatible, so
  they reuse the existing inlined `openAiCompatibleResolver` path (no new dependency, no
  dedicated package) and work for both inline engine calls and container coding agents via
  the LLM proxy. Keys are onboarded per workspace/user through the UI key pool like the
  other direct vendors; their base URLs are deployment config — OpenRouter defaults to the
  public gateway (`OPENROUTER_BASE_URL` override optional), while LiteLLM is operator-hosted
  so `LITELLM_BASE_URL` is required to enable it. Ships curated, direct-only catalog entries
  (OpenRouter: Claude Opus, Gemini 3 Pro, GPT-5.5, DeepSeek, Llama 3.3; LiteLLM: a generic
  gateway-default entry) with approximate pricing/context, overridable via
  `SPEND_MODEL_PRICES`.

  Catalog selectability now also gates on a **resolvable base URL**: an OpenAI-compatible
  provider (everything but `openai`/`anthropic`) is only offered once its base URL resolves,
  so a LiteLLM model stays unselectable — and a pipeline using it is blocked at start —
  until `LITELLM_BASE_URL` is set, instead of passing the guard and throwing "No base URL
  configured" mid-run. Wired symmetrically into both facades' capability resolution.

  **Wire change:** `apiKeyProviderSchema` is widened with `'openrouter'` and `'litellm'`.

- 2796a42: Make recording of complete prompts in LLM observability optional, governed by a new
  `LLM_RECORD_PROMPTS` environment variable.

  The LLM observability sink keeps the full prompt sent to the model with each metric.
  That prompt text can contain sensitive content (source, secrets), so some deployments
  must not retain it. `LlmObservabilityService` now takes a `recordPrompts` flag (default
  true, preserving current behaviour); when it is false the numeric telemetry (tokens,
  timing, finish reason, message/tool counts) is still recorded but the prompt body is
  stored empty and the delta-chain read is skipped entirely.

  - New `ObservabilityConfig.recordPrompts` on the shared `AppConfig` contract, threaded
    through `CoreDependencies.recordLlmPrompts` into the service.
  - Both runtime facades read `LLM_RECORD_PROMPTS` (any value other than `false` keeps
    recording on): the Cloudflare Worker via a new `loadObservabilityConfig`, the Node
    service via `loadNodeConfig`. Documented in `deploy/backend/wrangler.toml` and
    `deploy/node/.env.example`.

- 70e8ef0: Real-time fan-out for shared services.

  A shared service can appear on several workspaces' boards, but the engine pushes a live
  change (run progress, bootstrap, notification) to only the workspace it addresses — so the
  other boards saw the update only on reload. `FanOutEventPublisher` (a decorator over the
  per-workspace publisher) resolves the changed block's service and re-publishes the event to
  **every** workspace that mounts it, so all boards update live.

  - `WorkspaceMountRepository.listWorkspaceIdsMountingBlock(workspaceId, blockId)` (D1 + Drizzle)
    resolves the fan-out's target workspaces — the service owning the block and the boards that
    mount it — in a single join.
  - The Cloudflare facade wraps its `DurableObjectEventPublisher` with `FanOutEventPublisher`.
    Best-effort and self-isolating (the persisted row stays the source of truth); a block with
    no service, or a coarse block-less `boardChanged`, falls back to the originating workspace.

- 70e8ef0: Frontend for in-org shared services.

  The board can now mount org services, shows which frames are shared, and lays them out
  per-board.

  - The workspace snapshot carries `mounts` (the services this board mounts, with the
    per-board frame layout) and `serviceCatalog` (the org's services it can mount from, each
    annotated with `mountCount`). `Service` gains a derived `mountCount`.
  - SPA: a `services` Pinia store (mounts + catalog + mount/unmount/updateLayout), hydrated from
    the snapshot; an **"Add service"** menu on the board toolbar that mounts an org service; a
    **"Shared"** badge on a frame mounted on more than one board; and a frame drag now writes
    the **per-board mount layout** (so moving a shared frame doesn't move it on other boards).

- 70e8ef0: Make in-org shared boards fully interactive, and tighten the shared-service model.

  A workspace that MOUNTS a service from another workspace can now edit it like its own: a
  shared service's blocks live in one home workspace, and board mutations resolve them there
  (authorized by the mount) instead of 404ing on the workspace-scoped lookup.

  - `BlockRepository.findById` (D1 + Drizzle) resolves a block by id across the org; `BoardService`
    uses it so `updateBlock`, `moveBlock`, `addTask`, `addModule`, `removeBlock`,
    `toggleDependency` and `reparent` act on the shared copy at its home workspace. A frame move
    writes the requesting board's mount layout (per-workspace), leaving the shared block untouched.
  - Cross-service `reparent` across two services homed in **different** workspaces moves the
    subtree's block rows (and any executions on them) to the destination service's home, re-stamped
    with the destination service — preserving the "a service's blocks live in its home" invariant.
  - **Every** top-level frame now registers as an account-owned service via the shared
    `registerServiceForFrame` helper — including **seeded demo boards** and **repo bootstrap**, which
    previously created unshareable, unbadged frames.
  - Executions and bootstrap runs now stamp `service_id` from their block at write time (D1 +
    Drizzle), so a shared service's **live** runs surface on every board that mounts it — not just
    pre-migration rows. `BootstrapJobRepository.listByService` + `BootstrapService.listJobs` compose
    a mounted service's in-flight bootstrap into the snapshot.
  - Real-time `boardChanged` now carries the affected block, so `FanOutEventPublisher` fans
    structural changes (module materialised, run cancelled, bootstrap finished) out to every
    mounting board live, not just on reload.
  - `services.frame_block_id` is now UNIQUE (D1 + Drizzle), enforcing the 1:1 frame↔service mapping.
  - Removed N+1s on the snapshot hot path (`composeBoard`) and the GitHub sync fan-out
    (`linkedWorkspaces`).

  The Node facade wires the service repos into the engine but, lacking a real-time transport,
  does not yet decorate its publisher with `FanOutEventPublisher` (noted in its container).

- 70e8ef0: Batch the shared-service read paths (remove N+1 queries) + fan-out and mount-UI polish.

  Composing a board from the services it mounts fired one query **per mounted service** on
  several hot paths. They now issue a single chunked `IN (…)` query instead:

  - New batched repository ports `ExecutionRepository.listByServices`,
    `BootstrapJobRepository.listByServices`, `PipelineScheduleRepository.listByServices`
    (D1 + Drizzle), mirroring the existing `BlockRepository.listByServices`. Used by the
    workspace snapshot (executions), `BootstrapService.listJobs`, and
    `RecurringPipelineService.list`.
  - Frame deletion now clears a doomed service's mounts off every board and deletes the
    services in two batched queries (`WorkspaceMountRepository.removeByServices` +
    `ServiceRepository.deleteMany`) instead of a `listByService` + per-mount/per-service loop.
  - The real-time fan-out resolves its target workspaces in a **single join**
    (`WorkspaceMountRepository.listWorkspaceIdsMountingBlock`) rather than a `serviceIdOf`
    followed by a `listByService` on every event; `FanOutEventPublisher` no longer needs a
    block repository.
  - Mounting a service from the toolbar now surfaces failures (e.g. cross-org) as a toast
    instead of silently swallowing the error, and new mounts lay out on a 5-wide grid instead
    of stacking on the diagonal.
  - Every dynamically-built `IN (…)` D1 query now chunks through a single grounded constant
    (`D1_MAX_IN_PARAMS` / `chunkForIn`). Cloudflare D1 rejects a statement with more than 100
    bound parameters, so the previous 500-wide chunks were over the real ceiling, and the
    workspace snapshot's `countByServiceIds` (the org catalog's mount counts) didn't chunk at
    all — it threw `D1_ERROR: too many SQL variables` once an account owned enough services.

- 70e8ef0: In-org shared services: schema + domain foundation.

  Introduce the account-owned **service** as the canonical board unit and the
  **workspace mount** that places it onto a workspace's board, so the same service
  can appear on several workspaces in one org without duplicating its subtree, state
  or sync. This is the first (additive) increment:

  - New wire types `Service` + `WorkspaceMount` (`@cat-factory/contracts`) and the
    `ServiceRepository` / `WorkspaceMountRepository` ports (`@cat-factory/kernel`).
  - New `services` + `workspace_services` tables on both runtimes (D1 migration
    `0030`; Drizzle migration for Postgres), with an idempotent backfill that turns
    every existing top-level frame into an account-owned service mounted into its
    current workspace at its current board position.
  - D1 + Drizzle implementations of the two repositories.
  - A `service_id` column denormalised onto `blocks` + `agent_runs` (D1 migration
    `0031`; Drizzle migration), backfilled via a recursive CTE from each block's
    top-level frame, in preparation for re-keying the board's physical scope.
  - A **mount API**: every newly created service frame is registered as an
    account-owned service and mounted onto its workspace; `GET /workspaces/:ws/services`
    (mounts), `GET /workspaces/:ws/services/catalog` (the org's services),
    `POST|DELETE /workspaces/:ws/services/:serviceId` (mount/unmount — within the same
    org only), `PATCH …/layout` (per-workspace frame layout). Backed by the new
    `ServiceMountService` (orchestration `services` module) wired into both runtimes.

  - **Board composition**: a workspace's board snapshot is now composed from the
    services it mounts — its own blocks plus the full subtree of any service mounted
    from another workspace in the same org, so a shared service renders identically on
    every board (one physical copy ⇒ one shared task list + state). Each externally
    mounted frame is positioned by this workspace's mount (the per-workspace layout
    override), while a locally homed frame keeps its own movable position. Block inserts
    stamp `service_id` (the frame's service for a frame; the enclosing frame's service
    for tasks/modules) so the subtree is `listByService`-discoverable everywhere.

  Sync deduplication, real-time fan-out to all mounting workspaces, and the frontend
  land in follow-up increments.

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

- f49fa30: Give container agents (coder, ci-fixer, mocker, blueprints, analysis, …) `web_search` /
  `web_fetch` via the `@juicesharp/rpiv-web-tools` Pi extension installed in the
  executor-harness image — without putting a search-provider key in the sandbox.

  The backend hosts a SearXNG-compatible **web-search proxy** at `${proxyBaseUrl}/web-search`
  (`webSearchProxyController`, mounted under the LLM proxy's public `/v1`). A container
  authenticates with the SAME short-lived, model-locked session token it uses for the LLM
  proxy; the facade verifies it and runs the search server-side through the `webSearch`
  runtime gateway, under the deployment's own provider key. Two upstreams ship: Brave
  (`WEB_SEARCH_BRAVE_API_KEY`, the recommended one-key path, what Claude Code uses) and a
  reverse proxy to a self-hosted SearXNG (`WEB_SEARCH_SEARXNG_URL` [+ `_API_KEY`]). Both
  runtime facades wire it from env, so it works on Cloudflare (where per-run container env
  vars can't be injected) and on the Node self-hosted runner pool alike — no provider
  secret ever enters the container, matching the LLM-proxy posture.

  When the proxy is configured, `ContainerAgentExecutor` sets `webSearch: true` on the
  coding/ci-fixer job body; the harness then points rpiv-web-tools' SearXNG provider at the
  proxy (the token as its bearer) and surfaces a kind-aware usage nudge (via
  `@cat-factory/agents`' `webResearchGuidanceFor`). Self-hosted runner pools may still
  configure a provider key directly in the container env (auto-detected as before); an
  explicit `WEB_SEARCH_PROVIDER` pin now requires that provider's credential to be present
  so the agent is never told about a tool that would error. The two web tools count as
  read-only exploration for the no-edit guard, but a dedicated cap
  (`JOB_MAX_CONSECUTIVE_WEB_CALLS`, default 25) stops a search rabbit-hole.

  Changes the image, so the harness version (its GHCR image tag) bumps.

- b156b4b: Pipeline-builder + default-models UI polish.

  Pipeline builder: saved pipelines no longer render every agent-kind icon inline
  (which overflowed the narrow panel) — each is a collapsed row showing its name and
  step count that expands to the full ordered step list on click. Draft steps now
  truncate their label so the per-step controls (gate / reorder / remove) always stay
  reachable, and a "Configure models" button opens the default-models settings panel
  straight from the builder. The left-nav action buttons are unified on the
  primary-soft style of "Build a pipeline".

  Default-models panel: restyled from a light modal into the dark full-screen window
  used by the agent-output review overlay (readable regardless of the OS colour-mode
  preference), with a filter box that narrows every kind's model picker. A kind left
  on its deployment default now names the model that default actually resolves to
  ("Model · Provider (default)") instead of the opaque "Deployment default".

  To support that, the workspace snapshot now carries `deploymentModelDefaults` — the
  deployment's env-routing defaults as `provider:model` refs (`default` plus the
  per-kind `byKind` overrides) — derived in the shared workspace controller from
  `config.agents.routing`, so it is identical across the Worker and Node facades. A
  cross-runtime conformance assertion guards that both surface it.

- 7cf2a2d: Improve the pipeline builder experience:

  - **Grouped, collapsible agent palette** — archetypes are now organized into
    meaningful categories (Review & triage, Design & research, Implementation,
    Testing, Documentation, Gates & observability) that collapse/expand, with the
    collapsed state remembered across builder opens.
  - **Pipeline labels + archive/unarchive** — pipelines (built-in and custom) carry
    free-form labels and an archived flag for organizing the library: filter by
    label, hide archived behind a toggle, and archive without deleting. Exposed via
    a new `PATCH /workspaces/:ws/pipelines/:id/organize` endpoint (the only mutation
    a read-only built-in accepts). New `pipelines.labels` / `pipelines.archived`
    columns mirror across D1 and Drizzle/Postgres.
  - **Dependent companions are now gated toggles on their producer** — the three
    companions (reviewer→coder, architect-companion→architect, spec-companion→
    spec-writer) leave the free palette and are attached to their producer step in
    the builder. Each can be optionally **gated on the task estimate** (run only when
    complexity/risk/impact ≥ a threshold, OR across axes) via a new per-step
    `gating` array; a gated step is transparently skipped at runtime when the
    estimate falls below the bar. A pipeline with any enabled gating **requires a
    `task-estimator` earlier in the chain** or it refuses to save/start. Gating is
    additionally restricted to **companion steps** (skipping a producer would starve
    its downstream steps) and **requires at least one axis threshold** (an enabled gate
    with none would always skip); both are enforced by the shared `validatePipelineShape`
    at save, clone, and run start. A companion must now run **immediately after** an
    enabled producer it can review — `validatePipelineShape` enforces strict adjacency
    (over the enabled subset) on every facade, matching the builder, which surfaces
    companions as toggles attached to their producer. A pipeline that slips another step
    between a producer and its companion is rejected at save / clone / run start.

  **Breaking (pre-1.0, no migration):** the `Pipeline` wire shape gains optional
  `gating`, `labels`, and `archived` fields, and `PipelineStep` gains `gating` /
  `skipped`. The built-in pipelines are unchanged in behaviour.

- 2d66d34: Pipeline builder: clone pipelines, edit custom ones, and disable steps without
  removing them.

  - **Clone any pipeline** (built-in or custom) into a new, editable copy:
    `POST /workspaces/:ws/pipelines/:id/clone` (`PipelineService.clone`). The copy is
    never `builtin`, so this is how a read-only default template is "made editable".
    The builder shows a Clone action on every saved pipeline.
  - **Edit a custom pipeline in place**: `PATCH /workspaces/:ws/pipelines/:id`
    (`PipelineService.update`, new `PipelineRepository.update` on both stores). The
    builder loads a custom pipeline into the draft and saves changes back to the same id
    (preserving its catalog position). Built-in catalog pipelines are **read-only** —
    the API rejects both editing and deleting them (422) and the UI offers Clone
    instead (no edit/delete affordance on a built-in); pipelines now carry a `builtin`
    flag (true for the `seedPipelines()` catalog) to drive this.
  - **Disable a step without removing it**: a new per-step `enabled[]` array (parallel
    to `agentKinds`, like `gates`/`thresholds`). A step flagged `enabled[i] === false`
    is kept in the saved pipeline (and can be toggled back on) but skipped at run start —
    `ExecutionService` builds the run only from the enabled steps, reading gates/
    thresholds by each kind's original index so they stay aligned. A pipeline must keep
    at least one step enabled, and an enabled companion must still have an enabled
    producer to grade (disabling a producer while leaving its companion on is rejected).
    The builder adds an enable/disable toggle and dims disabled steps.

  Persistence: new `enabled` + `builtin` columns on the `pipelines` table, mirrored on
  both runtimes — folded into the squashed baselines (D1 `0001_init.sql` ⇄ the Drizzle
  schema + a regenerated migration) rather than a standalone migration. Cross-runtime
  conformance asserts a disabled step is skipped at run on every facade.

- 1a0686f: Close a runtime-parity gap: the privileged GitHub App tier (ADR 0005 — repo
  provisioning / create-repo) now works on the Node and local facades, not just the
  Cloudflare Worker. Previously `loadNodeConfig` never parsed `github.privilegedApp`
  and the Node container never built the privileged registry entry or wired
  `repoProvisioningClient`, so a Node deployment with a privileged App configured
  silently fell back to the manual repo-creation flow.

  `FetchGitHubProvisioningClient` moves into the runtime-neutral `@cat-factory/server`
  package (next to `FetchGitHubClient`, which already lived there); the Worker keeps a
  thin re-export at its old path. The Node config loader now reads
  `GITHUB_PRIVILEGED_APP_ID` + `GITHUB_PRIVILEGED_APP_PRIVATE_KEY`, and the Node
  container builds the privileged App auth + the provisioning client under the same
  condition the Worker does.

  **Breaking:** a privileged App is wired on Node only when BOTH
  `GITHUB_PRIVILEGED_APP_ID` and `GITHUB_PRIVILEGED_APP_PRIVATE_KEY` are set; a half-set
  env leaves the tier unconfigured (parity with the Worker).

- 3a12f15: Add prompt caching for container-agent model calls, plus the observability to prove
  it works, and unify how both AI-call paths treat a provider's cache.

  - **Shared cache policy** (`@cat-factory/agents`): `providerCachePolicy` is the single
    source of truth for how each provider caches (`auto-prefix` for OpenAI/DeepSeek/Qwen,
    `explicit-anthropic`, or `none`). Both the in-container proxy path and the inline
    AI-SDK path consult it instead of hard-coding provider ids.
  - **Proxy** (`@cat-factory/server`): routes a run's calls to the same cached prefix via
    `prompt_cache_key` (keyed on the execution id) on providers that support it — the big
    win, since a container agent re-sends its whole growing prefix every turn. It also
    fixes the misleading `requestMaxTokens` metric to record the EFFECTIVE output ceiling
    (it previously logged the client's value before the Workers-AI floor override, so it
    read as `null`).
  - **Measure the hit rate**: `LlmCallMetric` gains `cachedPromptTokens` (read across the
    `prompt_tokens_details.cached_tokens` / `prompt_cache_hit_tokens` field names), so the
    dashboard shows cached vs total prompt tokens per call. D1 migration `0028` + a Drizzle
    migration add the column.

  Note: the inline path's calls are single-shot (no growing prefix), so caching there is
  marginal; full inline-call observability (recording inline LLM calls through the same
  sink) is a follow-up.

- 8eed38c: Introduce the runtime "gateway" seam (`container.gateways`) and use it to make the
  real-time event-stream controller runtime-neutral. `EventsController` moves into
  `@cat-factory/server` and delegates the WebSocket upgrade to a `RealtimeGateway`
  the facade supplies — on the Worker, `DoRealtimeGateway` forwards to the
  per-workspace `WorkspaceEventsHub` Durable Object. This lets a non-Worker facade
  provide its own real-time transport (e.g. a WebSocket hub) without touching the
  controller. Behaviour on the Worker is unchanged.
- 37baa7f: Scheduled recurring pipelines on services.

  A service (a `frame` block) can now carry **recurring pipelines** that re-run a
  pipeline on a cadence — primarily **Dependency updates** and **Tech debt**. A
  schedule runs every `intervalHours`, optionally constrained to an allowed window
  (weekdays + an hour-of-day range, in a chosen IANA timezone), and owns one reused
  on-board task block inside the service that each fire runs the pipeline against
  (skipping any fire while a run is still in flight). Run history is kept ~1 week and
  surfaced in the inspector.

  - **Tech-debt pipeline** adds two agent kinds: a read-only `analysis` container
    agent that audits the repo, then a special non-LLM `tracker` step that files a
    **GitHub issue or Jira ticket** from the analysis before implementation. The
    tracker is a per-workspace selection (`GET|PUT /workspaces/:ws/tracker-settings`);
    `GitHubClient` gains `createIssue`. The runtime-neutral `TicketTrackerService`
    resolves each **tenant's own** connected integration (it is injected with a
    `fileGitHubIssue` filer + a `resolveJiraConnection` resolver, never shared/env
    credentials): on Cloudflare it files GitHub issues through the workspace's GitHub
    App installation against the service's repo, and Jira tickets (markdown→ADF) using
    the workspace's encrypted `task_connections`. Two new seed pipelines:
    `pl_dep_update`, `pl_tech_debt`.
  - **Per-tenant tracker on the Node facade**: both trackers now work on Node, each
    resolving the **workspace's own** integration. Jira: the task-source integration is
    wired on Node (always on; requires the shared `ENCRYPTION_KEY`) — a Drizzle
    `task_connections`/`tasks` store + the runtime-neutral Jira provider — so each tenant
    connects its own Jira through the existing UI (credentials encrypted at rest). GitHub:
    the filer mints a short-lived token from that workspace's own GitHub App installation
    (reusing the per-tenant App infra) and resolves the service's repo from the
    `github_repos` projection — no shared/env credentials.
  - **Persistence + scheduling are symmetric across runtimes**: D1 migration
    `0029_recurring_pipelines.sql` ⇄ Drizzle schema + generated migration; the
    Cloudflare `scheduled` cron fires due schedules (and prunes run history) ⇄ a Node
    `setInterval` sweeper does the same. New ports `PipelineScheduleRepository` /
    `TrackerSettingsRepository` with D1 + Drizzle implementations; the cross-runtime
    conformance suite covers schedule CRUD, `runDue`, and the tracker setting.
  - **UI**: an "Add recurring pipeline" button on the service frame (mirroring "Add
    task") opens a per-frame modal (pipeline + cadence editor; the tracker choice is
    surfaced inline for the tech-debt pipeline). The schedule's block shows a recurring
    badge on the board; selecting it reveals the cadence, run-now/pause, and run
    history in the inspector.

- 553a67d: Remove the standalone "scan repository" command — repository decomposition is now
  only the `blueprints` pipeline agent.

  The manual scan was a separate, UI-exposed operation backed by a synchronous
  Cloudflare-Container-only `RepoScanner` (which had no live harness route) plus a
  `repo_blueprints` persistence store. It duplicated what the `blueprints` agent kind
  already does — decompose a repo into the canonical service → modules tree and
  reconcile it onto the board — except the agent runs through the shared
  `RunnerTransport`, so it already works identically on Cloudflare Containers and on a
  self-hosted runner pool. Keeping the standalone command was the last
  Cloudflare-vs-pool parity gap (and dead code on Cloudflare). Removing it closes the
  gap by deletion.

  Removed:

  - **Ports:** `RepoScanner` (+ `ScanRepoRequest` / `ScannedBlueprint`) and
    `RepoBlueprintRepository` (+ `RepoBlueprintRecord`).
  - **Contracts:** `scanRepoSchema` / `ScanRepoInput`, `scanRepoResultSchema` /
    `ScanRepoResult`, and `repoBlueprintSchema` / `RepoBlueprint`. The blueprint **tree**
    schemas (`BlueprintService` / `BlueprintModule` / `blueprintSource`), the in-repo
    `blueprints/` artifact constants, `parseBlueprintService`, and `BoardScanSpawnResult`
    stay — the `blueprints` pipeline uses them.
  - **HTTP:** the entire `BoardScanController` — `POST /board-scan/scans` and the
    `GET|DELETE /board-scan/blueprints[/:id]` read endpoints.
  - **Service:** `BoardScanService` is now purely the engine's `BlueprintReconciler`
    (`reconcileBlueprint` + its spawn fallback); `scan` / `canScan` / the blueprint
    CRUD / the persisted-blueprint deps are gone. It is wired unconditionally (it needs
    only the board service + block repository).
  - **Persistence:** the `repo_blueprints` table (D1 `0001_init` + Drizzle schema, with
    a generated Postgres drop migration), `D1RepoBlueprintRepository`,
    `DrizzleRepoBlueprintRepository`, and `ContainerRepoScanner`.

  No data migration is provided (pre-1.0; backwards compatibility is a non-goal): an
  existing `repo_blueprints` table is simply orphaned/dropped. The executor harness is
  unchanged — its self-contained blueprint coercion stays — so the runner image is not
  affected.

- 4026793: Requirements review: react to findings + a rework agent that feeds downstream steps.

  The requirements-review flow is now wired into the UI and reworks the requirements
  instead of overwriting the block description:

  - **New review window** (`RequirementsReviewWindow.vue`) modelled on the polished
    prose review window: a human reacts to the reviewer's structured findings —
    answering the relevant ones, dismissing the irrelevant — then runs the
    **requirements-rework** agent. Triggered from the inspector's "Review
    requirements" button (open-finding count badge). The old dormant
    `RequirementReviewModal` is removed.
  - **Rework, not overwrite.** `incorporate()` no longer rewrites
    `block.description`. It folds the answers into ONE standard-format requirements
    document (new versioned `REWORK_SYSTEM_PROMPT`: SHALL statements + MoSCoW +
    Given/When/Then acceptance + domain rules) stored on the review, and returns
    `{ review }`. It runs even with **zero findings**, so every task can carry a
    clean, writer-ready spec.
  - **Downstream consumption.** When a block has an incorporated review,
    `ExecutionService` feeds that reworked document to **every** agent step in place
    of the original description and drops the (already-folded-in) linked docs/tasks;
    the requirements-writer aggregates the reworked text per task instead of the raw
    description. The rework call rejects a length-truncated document instead of
    persisting a silently-incomplete spec.
  - **Both runtimes, enforced.** The requirements feature is wired on the Node facade
    too — a `requirement_reviews` Postgres table (Drizzle schema + migration) and
    `DrizzleRequirementReviewRepository`, plus the review/model deps in the Node
    container — so the review/rework API and the agent-context substitution behave
    identically on Cloudflare and Node. The cross-runtime conformance suite asserts the
    substitution against both stores so the parity can't silently drift.
  - **Frozen description.** Once a task's requirements are reworked, the inspector
    freezes its raw description (read-only, tucked behind an expander) and puts the
    standardized requirements in focus — the description is no longer what agents read.

- 36018cb: Restart a pipeline run from a chosen step.

  Both the run's step-detail overlay (`AgentStepDetail`) and each step on the pipeline
  timeline (`PipelineProgress`, a hover-revealed side button) now offer **"Restart from
  here"**: re-run the pipeline from that step onward — even on a finished run — resetting
  the chosen step plus every later step's iteration counters (companion attempts,
  gate/test attempts, eviction recoveries) and re-driving a fresh run. The steps
  BEFORE the chosen one are preserved verbatim, so their outputs (and resolved
  decisions) still reach the restarted step as its `priorOutputs` handoff context.

  Unlike retry (which resumes at the first FAILURE), restart rewinds to an arbitrary
  human-picked step, so it can re-run steps that already completed. A block's
  incorporated requirements are deliberately NOT touched — they live on the
  requirement-review record, not the run — so a restarted `spec-writer`/`coder`
  still receives the incorporated requirements document (or the base description when
  none was generated). Restarting AT the `requirements-review` gate itself re-runs the
  reviewer, which mints a fresh iteration-1 review (its `review()` replaces the prior
  one) — exactly the "reset the iterations counter from this step" semantics.

  Backed by `POST /workspaces/:ws/executions/:executionId/restart` (`{ fromStepIndex }`,
  `restartFromStepSchema`) → `ExecutionService.restartFromStep`, which tears down any
  still-live driver/container for the run it replaces (so restarting a RUNNING run
  never orphans a container or a parked Workflows/pg-boss driver), then mints a new run
  id and re-drives like a retry. Like start/retry, an individual-usage (Claude/GLM/
  Codex) block needs the initiator's personal password (prompted, then retried, on a
  428). Runtime-neutral (shared `@cat-factory/server` + orchestration), so both facades
  get it; a cross-runtime conformance assertion pins the restart + the requirements
  handoff on every runtime.

- d65c979: Unify the approval gate into the conclusions reader, with GitHub-style review.

  The dedicated approval modal is gone. A pending gate now opens the same polished
  step-detail reader (ToC side nav, rendered markdown), in a new **approval mode**:
  the reviewer can comment on individual blocks of the agent's output (click a block —
  the rendered markdown carries `data-src-start/end` source ranges so the comment
  quotes that block's verbatim raw markdown), leave overall freeform feedback, then
  **Approve** (advance), **Request changes** or **Reject**.

  - **Request changes** re-runs the step with both the freeform feedback and the
    per-block comments folded into the agent's prompt (`AgentRunContext.revision`
    gains `comments`; `requestStepChangesSchema` now takes `feedback?` + `comments?`,
    requiring at least one).
  - **Reject** stops the run entirely — a terminal `rejected` failure
    (`agentFailureKindSchema`), so the board's shared failure banner + retry surfaces
    it (block → `blocked`). New `POST /executions/:id/steps/:approvalId/reject`
    (`ExecutionService.rejectStep`).
  - `stepApprovalSchema` gains the `rejected` status and a persisted `comments` array
    (`stepReviewCommentSchema`). No migration: approvals live in the execution
    `detail` JSON.

  - **Approve with corrections** opens an inline editor over the conclusions; the
    human's edits become the approved proposal carried forward (the existing
    `approveStep` proposal override — no backend change). Manual edits are a distinct
    mode and can't be combined with per-block comments / request-changes — they only
    happen _together with_ approving.

  The review surface is responsive — a right-side rail on wide screens, a bottom
  sheet below `lg` — so a pending gate is always actionable. Reject uses a two-step
  inline confirm (no native dialog). `requestStepChanges`/`rejectStep` reject a stale
  gate id whose step is already being re-run (`changes_requested`) so a double-submit
  can't dispatch duplicate work.

  Cross-runtime conformance gains assertions for reject and comment-driven re-runs.

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

- 8eed38c: Move the "Login with GitHub" OAuth flow into `@cat-factory/server`. `AuthController`
  and its fetch-based `GitHubOAuth` client are runtime-neutral, so they now live in
  the shared package and are mounted via `registerCoreControllers`. The Worker keeps a
  thin re-export shim for backward-compatible imports. Behaviour is unchanged.
- 8eed38c: Harden the Node facade and de-duplicate the auth gate (review follow-ups):

  - Extract the default-deny session gate + per-workspace authorization into
    `mountAuthGate(app)` in `@cat-factory/server`, so the security-critical middleware
    has ONE implementation instead of being copy-pasted into each runtime facade (the
    Worker and the Node service now both call it). Behaviour is unchanged.
  - Node durable execution now actually recovers from crashes: the pg-boss advance job
    carries an `expireInSeconds` sized above a full poll budget plus `retryLimit`, and a
    stale-run sweeper re-enqueues runs left `running` in storage (the analogue of the
    Worker's cron `sweepStuckRuns`). Re-enqueues use the run's `singletonKey`, so a run
    still being driven is never double-driven.
  - `start()` shuts down cleanly on SIGTERM/SIGINT: it closes the HTTP server, stops the
    sweeper + pg-boss, releases the pool, then exits (previously the process could hang
    until SIGKILL).
  - `TokenUsageRepository.totalsSince` sums into `bigint` instead of `int4`, fixing an
    overflow past ~2.1B tokens and matching the 64-bit totals the D1 store returns.
  - `migrate()` runs its `CREATE … IF NOT EXISTS` bootstrap under a transaction-scoped
    advisory lock, so concurrent replica boots can't race on DDL.

- 8eed38c: Move the runtime-neutral HTTP controllers into `@cat-factory/server`. The 18
  controllers that only use the DI container + request helpers (board, execution,
  pipelines, workspaces, accounts, documents, tasks, environments, runners,
  bootstrap, agent-runs, board-scan, requirements, notifications, merge presets,
  models, prompt-fragments, fragment-library) now live in the shared package and are
  mounted by a facade via `registerCoreControllers(app)`. The shared request context
  (`ServerContainer`, `AppEnv`) and the auth middleware (`requireAuth`,
  `verifySession`, `bearerToken`) move there too.

  The Cloudflare Worker keeps only its runtime-coupled controllers — the LLM proxy
  (Workers AI binding), the WebSocket event stream (Durable Object), the GitHub
  webhook (Queue) and connect (Workflow), and the OAuth login flow — and mounts the
  shared controllers. `createApp`/`buildContainer` keep their signatures; all 326
  worker integration tests pass unchanged.

- 8eed38c: Make the container LLM proxy runtime-neutral and move it into `@cat-factory/server`,
  completing the migration of every HTTP controller into the shared package. The
  controller keeps session verification, the spend gate, request hardening, the
  OpenAI-compatible HTTP forward and streaming metering; the runtime-specific bits —
  resolving an OpenAI-compatible upstream and the in-process Workers AI binding path —
  move behind a new `LlmUpstream` gateway. The Worker supplies `WorkersAiLlmUpstream`
  (env-keyed upstreams + the `AI` binding, with the OpenAI⇄AI-SDK translation), and
  `ContainerSessionService` moves to the shared package. The Worker `app.ts` now mounts
  only the shared controllers; behaviour is unchanged.
- 8eed38c: Move the application configuration type contract (`AppConfig` and every
  sub-config interface) into `@cat-factory/server`. The config SHAPE is now shared
  by every facade, while each runtime keeps its own loader that produces it (the
  Worker's env-driven `loadConfig` is unchanged). This lets the shared HTTP layer
  type `container.config` without depending on any runtime. Behaviour is unchanged.
- 8eed38c: Move the runtime-neutral crypto/auth primitives into `@cat-factory/server`: the
  base64url/PEM encoding helpers and the Web Crypto `HmacSigner` (with the token
  audiences and session payload types) that mint and verify the session, OAuth
  state, container-proxy and WebSocket-ticket tokens. These are pure Web Crypto, so
  both the Cloudflare Worker and the upcoming Node service share one implementation.
  The Worker re-exports them from their previous paths; behaviour is unchanged.
- 8eed38c: Introduce `@cat-factory/server`, the runtime-neutral HTTP layer shared by every
  deployment facade. This first slice moves the cross-cutting HTTP primitives out of
  the Cloudflare Worker — structured logging, the path-param helper, the valibot
  request-body validation envelope, the domain→HTTP error mapping, and the CORS
  origin policy — so they can be reused by a non-Worker (Node) facade. The Worker
  re-exports them from their previous paths, so behaviour is unchanged.
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

- f647733: Run the spec-writer before the architect, and give every agent in a pipeline one
  shared work branch created up front.

  - **Pipeline order**: in `pl_full` and `pl_fullstack` the `spec-writer` now runs
    _before_ the `architect` (in `pl_fullstack`, the `spec-writer`/`spec-companion`
    pair moves ahead of `architect`/`architect-companion`). The architect is
    spec-aware, so it now designs against the just-written in-repo `spec/` instead of
    writing the spec only after the design is settled. Human gates are unchanged
    (requirements review, spec, architecture).

  - **Shared work branch**: the per-task work branch (`cat-factory/<blockId>`) is now
    ensured before the container agents run, via a new optional `ensureWorkBranch`
    dependency on `ContainerAgentExecutor` (wired in both the Cloudflare and Node facades
    through `ensureWorkBranchViaRest`). Every agent — including the read-only design agents
    (architect, analysis) — operates on that one branch, so the architect reads what the
    spec-writer committed. The helper probes first (an existing branch is reported ready in
    a single call), and only _writers_ create the branch from base when absent — read-only
    agents probe only, so a code-less pipeline never orphans an empty ref. It is idempotent
    (a 422 race is success) and best-effort, but now logs a warning on every failure path so
    a fallback to the base branch is observable rather than silent; ref names with slashes
    are encoded per path segment. When GitHub is not wired (tests), read-only agents fall
    back to the base branch as before.

- a54ada2: Spec-writer now applies ONE task's requirements as an increment, not a service-wide aggregate.

  The spec-writer used to receive `serviceTasks` — every task under the block's service
  frame, merged or not — and fold them all into one document. So a run for a single task
  ("add CRUD for office tables") produced a spec covering five unrelated sibling resources,
  and the spec-reviewer correctly read it as scope contamination. That violates the
  branched-work model: a task's baseline is what's already merged, plus its own increment;
  an unmerged sibling task does not exist for it.

  The spec-writer now reads the spec already committed on its work branch (the baseline)
  and applies ONLY the current task's clarified/reworked requirements as an increment —
  adding what the task introduces and adjusting existing requirements only where the task
  changes their behaviour. It translates the given requirements and does not invent or fill
  gaps (that is the requirements step's job). The in-repo `spec.json` stays the complete
  service spec; only the writer's editing scope narrows.

  - Engine: removed `gatherServiceTasks` and the `serviceTasks` field from
    `AgentRunContext`. The dispatch feeds the single task (the block, whose description is
    already the reworked requirements).
  - Reviewer: the `spec-companion` now judges fidelity to the requirements it was given and
    no longer penalises the writer for requirements it was never handed.
  - Harness (`SpecJob.tasks` → `SpecJob.task`): the prompt is reframed as "baseline plus
    this task's increment". Image retagged 1.6.0 → 1.7.0 (deploy/backend `image:publish` +
    wrangler.toml) so the new digest rolls out.

  Breaking: the `/spec` harness job shape changes (`tasks: []` → `task: {}`) and
  `AgentRunContext.serviceTasks` is gone. No migration — stale in-flight jobs simply break.

- 2dd7e56: Step observability + a discoverable iteration-cap decision.

  - Every pipeline step now carries the `runId` of the run it belongs to, surfaced on
    the step-detail panel (copyable) so a lone step in a log line or view names its run.
    It is a read-time projection (always equals the enclosing run's id), stamped on read
    and on emit; not persisted independently.
  - A step's duration now stops counting once it is terminal OR parked on a human. The
    engine records `pausedAt` when a step parks on an approval / decision / iteration-cap
    gate and clears it when the step resumes or finishes, so elapsed time no longer
    accrues while the run waits for input (the symmetric counterpart of the terminal
    freeze). A step finished directly out of a parked approval is billed to the pause
    instant, not the later human decision.
  - An iterative gate that spends its automatic budget (a quality companion at its rework
    cap, or the requirements reviewer at its iteration cap) now raises a
    `decision_required` notification. Previously the three-choice decision was reachable
    only by drilling into the parked step, so the run looked silently stuck; the inbox
    item now opens that step's decision surface (companion → step detail with the
    iteration-cap prompt; requirements → the review window).

  No DB migration: the step fields ride in the existing execution `detail` JSON, and the
  notification `type` column is free text in both runtimes.

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

- 0090313: Surface a step's model the moment it starts, not only once its work finishes.

  A pipeline step's `model` was recorded on the step only after the work returned: a
  container step got its model from the job handle once `startJob` (which blocks for
  the whole cold-boot dispatch) returned, and an inline step from the result once the
  LLM query was over. But the model is fixed the instant its ref resolves (block pin >
  workspace per-kind default > env routing) — well before the container is up or the
  query runs — so the board showed "Spinning up container…" / a working step with no
  model for that whole window.

  The executor port gains an optional, side-effect-free `resolveModel(context)` that
  previews the `provider:model` without dispatching (implemented by the inline
  `AiAgentExecutor` and the `ContainerAgentExecutor`, forwarded by
  `CompositeAgentExecutor`). The execution engine calls it up front and sets
  `step.model` before the first "spinning up container" emit (container steps) and
  before the blocking LLM call (inline steps), so the model rides the same emit that
  shows the step starting. The job handle / result still re-assert the same value, and
  the preview is best-effort (an executor that can't preview, or a resolution failure,
  simply falls back to the old timing). No wire-contract change — the SPA already
  renders `step.model` whenever present, so it now appears immediately. A cross-runtime
  conformance assertion pins that `step.model` is set on the booting/querying emit.

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

- 43f2443: Add a unified, persisted requirements structure stored in each service's GitHub
  repo. A new `requirements-writer` container agent runs before the coder in
  `pl_full` (and standalone via the new `pl_requirements` pipeline): it aggregates
  the clarified requirements of every task under the service frame into one
  PRESCRIPTIVE document, committed to the implementation branch
  (`cat-factory/<blockId>`, created from base when absent) so the spec is present
  before any code is written.

  The harness deterministically renders the document into `requirements/`: the
  canonical `requirements.json` (a `RequirementsDoc`), `overview.md`, `rules.md`
  (cross-cutting domain rules / invariants), a `version.json` staleness manifest,
  and Gherkin `features/*.feature` files (one `Scenario` per acceptance criterion).
  Gherkin is generated two-pass — mechanical render in the harness, then the
  `acceptance` agent polishes the `.feature` files and `playwright` turns each
  scenario into a runnable test. Every container agent reads the requirements via a
  new `REQUIREMENTS_GUIDANCE` block in its global `AGENTS.md`. The in-repo files are
  the source of truth; the engine strictly validates the returned doc
  (`parseRequirementsDoc`) at ingest. Mirrors the blueprint pattern; covered by the
  cross-runtime conformance suite.

- 48d2f0d: Add per-workspace, per-agent-kind default model selection. A workspace can choose
  which model each agent kind defaults to (e.g. point `architect` at a strong model
  and `tester` at a cheap one), overriding the env-driven `AGENT_routing` for that
  workspace at run time. New `GET|PUT /workspaces/:workspaceId/model-defaults`
  endpoints (returning/replacing `{ defaults: Record<agentKind, modelId> }`) and the
  selection surfaced on the workspace snapshot as `modelDefaults`. Persisted in
  `workspace_model_defaults` on both runtimes (D1 migration 0028 / a new Postgres
  migration).

  The defaults are applied uniformly through one shared resolver
  (`resolveStepModelRef` in `@cat-factory/agents`) used by **every** executor — the
  inline LLM executor, the container executor and the requirements reviewer, on both
  the Worker and the Node service — so a step's model resolves as block-pinned >
  workspace per-kind default > env routing for the kind > env default for every agent
  kind, not just the container kinds. A stale/unresolvable block pin now falls
  through to the workspace default instead of skipping it. Request keys (agent kinds)
  and values (model ids) are validated as trimmed, non-empty strings.

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

- 8eed38c: Address review findings on the runtime-facades work:

  - **Node durable execution: fix pg-boss dedup.** The advance queue is now created with
    the `exclusive` policy. `singletonKey` alone does NOT deduplicate under pg-boss's
    default `standard` policy (the singleton unique indexes are policy-gated, and the
    policy-independent one needs `singletonSeconds`), so duplicate `signalDecision`/sweeper
    sends could double-drive a healthy run. `exclusive` makes at most one advance job per
    run id live at a time, restoring the documented no-op semantics.
  - **Node decision timeout.** A run parked on a human decision now arms a delayed
    `execution.decision-timeout` job; `ExecutionService.expireDecision` fails it
    `decision_timeout` only if still parked on that exact decision (idempotent, no driving),
    matching the Cloudflare driver's `waitForEvent` timeout instead of waiting forever.
  - **Node Postgres pool** attaches an `'error'` handler so a transient idle-client drop
    (Postgres restart/failover) no longer crashes the process.
  - **Provider registration parity.** The Worker now registers `openai`/`anthropic` only
    when their key is set (like the Node facade), so an unconfigured provider throws a clear
    "Unsupported model provider" error instead of failing deep in the vendor SDK.
  - **Node config fail-fast**: a too-short `AUTH_SESSION_SECRET` with OAuth configured (and
    no dev-open) now refuses to boot with a clear message rather than silently 503-ing.
  - **`BEDROCK_MODELS=""`** (set-but-blank) is treated as "allow all" rather than rejecting
    every model.
  - **LLM proxy** trims the bearer token, matching the auth middleware.
  - The Node `driveExecution` gate handling drains gate→gate transitions (e.g. a CI step
    dispatching a `ci-fixer`) in-iteration rather than relying on the next advance.

- 28d3c28: Blueprinter: decompose repos into DDD domain modules, not technical layers.

  The Blueprinter (and the manual board-scan scanner) system prompt now applies
  Domain-Driven Design vocabulary: every module must be a **business domain** (a
  bounded context / aggregate / subdomain) named after a business concept, not a
  technical layer. Technical shapes like `api`, `routes`, `controllers`, `utils`,
  `config`, `types` and `db` are explicitly NOT domains, and the genuinely
  non-business, cross-cutting plumbing is collapsed into a single `infrastructure`
  module instead of being scattered across many technical modules.

- a48c620: LLM proxy: cap a workers-ai call's `max_tokens` to the model's context window.

  The proxy floors every workers-ai container call's output request to 32K
  (`PI_MIN_OUTPUT_TOKENS`), assuming Workers AI clamps a too-large request to the
  model's real max. It does not — a model whose TOTAL context window is also 32K
  (e.g. `@cf/qwen/qwen3-30b-a3b-fp8`) rejects the WHOLE request (error 8007 →
  HTTP 502) because the 32K output floor alone fills the window, leaving no room for
  the prompt. Every blueprint/default-model step on that model 502'd on its first
  call and the run failed with "the blueprint agent did not return a usable service
  tree" (an empty completion).

  The catalog already declares each model's window (`contextTokens`); the proxy now
  consults it. New `contextWindowFor(ref)` in `@cat-factory/kernel` looks the window
  up by provider + model, and the proxy caps the floored `max_tokens` so estimated
  input (serialized prompt + tool definitions) plus output fits the window. The cap
  only ever narrows the floor; a large-window model (kimi/glm at 256K) or one with no
  declared window keeps the full 32K. No model change — small-window models now work
  through the proxy instead of hard-failing.

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

- ad9ba9e: Quality companions (Spec Reviewer, coder's Reviewer, Architect Companion) no longer
  get stuck when they spend their automatic rework budget — they park for a human, the
  same way the requirements reviewer does at its iteration cap.

  Previously a companion that stayed below its quality bar after `maxAttempts` automatic
  reworks failed the run (`companion_rejected`), leaving the task stuck with no path
  forward. Now it parks on a shared iteration-cap gate offering the same three choices as
  the requirements reviewer:

  - extra-round — raise the budget by one and loop the producer back for one more pass;
  - proceed — advance the pipeline accepting the producer's current output;
  - stop-reset — cancel the run and return the task to phase zero (editable), the
    producer's latest output preserved on its branch.

  The two gates now share one mechanism rather than duplicating it: the choice contract
  (`iterationCapChoiceSchema` / `resolveIterationCapSchema`), the parking
  (`parkStepOnDecision`), the gate-resume advance (`advancePastResolvedGate`, also used by
  the generic approval gate), the three-way dispatch (`dispatchIterationCap`, where
  stop-reset is uniformly `cancel()`), and the guard that stops the generic
  approve/request-changes/reject resolvers from short-circuiting an iterative gate
  (`assertNotIterativeGate`). The frontend renders both with one `IterationCapPrompt`
  component.

  `companion_rejected` now means only a genuinely unparseable companion verdict (truncated
  / malformed even after a repair retry) — exhausting the rework budget is no longer a
  failure. New `companion.exceeded` flag marks a parked companion gate;
  `POST /executions/:executionId/steps/:approvalId/resolve-exceeded` resolves it. No new
  persistence — the gate reuses the existing execution row + durable decision-wait, so both
  runtime facades get it; the cross-runtime conformance suite asserts the parking and all
  three resolutions against both.

- 3e7ab89: Make the conflict-resolver actually see the conflict, and stop it churning to 10 attempts.

  Telemetry on a failed run showed the `conflict-resolver` was handed `userPromptFor(context)`
  — the full task brief plus every prior agent's output (~53 KB) — with no mention of which
  files conflicted or that there were conflicts at all. The model drifted onto the original
  feature task (it returned a "test report is ready" answer) and never touched the markers,
  so the gate re-dispatched 10 times with the PR head SHA never moving, then failed the run.

  - Harness: when the base merge surfaces conflicts, build a conflict-focused prompt that
    leads with the exact conflicted files and their `git diff` hunks (new `conflictDiff`
    helper), keeping the task only as a trailing reference. Clean merges and no-op
    "already up to date" cases are now logged distinctly so the "GitHub says conflicting but
    the local merge is clean" loop is diagnosable. Bumps the harness image (1.7.1 -> 1.7.2).
  - Server: the conflict-resolver job body no longer renders `userPromptFor(context)`; it
    sends only a compact task reference (title + description). The harness supplies the
    actual conflict material.
  - Orchestration: the conflicts gate now caps escalations at 3 (was CI's default of 10) via
    its own `attemptBudget` — a conflict retry re-merges the same base with no new signal, so
    it fails fast to a manual-resolution notification instead of burning containers.

- 4ee8a4b: Tame `ContainerAgentExecutor.buildJobBody` (Phase 3). The ~416-line method had eight
  copy-adjust `agentKind` branches, each rebuilding the same `jobId`/`model`/auth/
  `ghToken`/`repo`/`githubApiBase` fields. Extracted two collaborators with no behaviour
  change:

  - A `ModelRouter` that owns the model-routing policy (the canonical step precedence —
    block pin > workspace per-kind default > env routing — plus the "subscriptions always
    win" override for pooled and individual-usage vendors), decoupling routing from job
    dispatch. `resolveModel`/`isQuotaBased`/`buildJobBody` now delegate to it.
  - A shared `common` job-body (built once) + a `resolveAuth` helper (Pi proxy session
    token vs. a leased subscription credential) + a per-kind `buildKindBody` table that
    contributes only each kind's delta. The eight inline bodies collapse to one shared
    base plus small per-kind deltas.

  Pure refactor: the dispatched body shape per kind, the `startJob`/`pollJob` and
  `RunnerTransport` seam, and all public surface are unchanged. Guarded by a new
  per-kind body characterization snapshot test and `ModelRouter` unit tests.

- 8eed38c: The Node runtime now persists to Postgres via Drizzle (the latest 1.0 RC) — the
  single persistence used in dev, test and prod (no test-only in-memory store). It
  implements every core kernel repository port (workspaces, accounts, memberships,
  blocks, pipelines, executions-on-agent_runs, token usage, agent-runs) over a
  node-postgres pool, reusing the SAME row<->domain mappers the Cloudflare D1 repos
  use — which moved into `@cat-factory/server` so both stores share one mapping (the
  Worker re-exports them from their old path). The schema mirrors the D1 tables
  column-for-column; `migrate()` bootstraps it idempotently on boot. `DATABASE_URL`
  selects the database; the in-memory repositories are removed.
- 8eed38c: Author relative imports with explicit `.js` extensions across the shared backend
  packages so their emitted `dist` is directly resolvable by Node's ESM loader (no
  bundler required). This lets the Node runtime run the built output on plain Node
  (`node dist/main.js`) — no tsx, no esbuild bundle — and is inert for the Cloudflare
  Worker (wrangler bundles regardless). `handlebars/runtime` is imported as
  `handlebars/runtime.js` for the same reason (its type is sourced from the full
  package, type-only). No behaviour or public-API change.
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

- 7a9cabf: Local mode now warns when no GitHub PAT is configured — in the UI, not just the
  console. At boot, `startLocal()` still logs a warning, but the local facade also tags
  its `AppConfig` with a `localMode` block carrying a GitHub "new personal access token
  (classic)" URL (scopes pre-selected: `repo`, `workflow`) when `GITHUB_PAT` is unset.
  The shared `/auth/config` endpoint surfaces that block, and the SPA renders a
  dismissible banner with a one-click link straight to the token-creation page, so the
  prompt isn't lost in a dev terminal. Exposed as `githubPatCreationUrl()` from the local
  facade and `LocalModeConfig` from `@cat-factory/server`.
- b156b4b: Personal-password prompt: per-user dual-mode resolution + accurate model context sizes.

  The individual-usage credential gate now prompts for a personal password exactly when
  dispatch will actually lease one, per user:

  - A subscription-only individual model (Claude / Codex) always needs the personal
    credential (no fallback).
  - A DUAL-MODE individual model (GLM, which also has a Cloudflare base) is per-user: a user
    who has connected their own GLM subscription runs on it (gated on their password), while
    a user without one falls back to Cloudflare GLM with no prompt. Dispatch
    (`ContainerAgentExecutor.resolveEffectiveRef`) and the gate now share this decision via a
    new `hasPersonalSubscription(userId, vendor)` seam wired in both runtime facades, so the
    two can't drift. Previously GLM-on-Cloudflare always prompted (the gate keyed off "the
    model has an individual subscription flavour" rather than "this user will use it").
  - A block pinned to any non-subscription model (Cloudflare / Bedrock / direct) is never
    gated just because a workspace per-kind default happens to be an individual model — a
    resolvable block pin wins for every step, mirroring `resolveStepModelRef`.

  The precedence is a pure, unit-tested `resolveIndividualVendors` +
  `personalCredentialVendorForModelId`.

  Frontend: cancelling the personal-password modal now reverts the task's optimistic
  "Starting…" state instead of leaving it stuck until reload. `withCredential` awaits the
  prompt and reports whether the action ran or was cancelled.

  Model catalog context windows corrected from each provider's own docs (the field is now
  documented as the per-flavour served window, which can be larger or smaller per provider):
  Llama 3.1 7,968; Qwen3-30B 32,768; Kimi K2.6 / K2.7 256K on Cloudflare; DeepSeek R1 distill
  80K on Cloudflare; DeepSeek V4 Pro 131,072; GLM-5.2 256K on Cloudflare and the full 1M via a
  Z.ai subscription. The "cut NNK on Cloudflare" wording in the Kimi/GLM/DeepSeek descriptions
  was inaccurate and is rewritten.

  Also: the board shows an empty-state invite (bootstrap a repo / add from an existing repo)
  when it has no service frames.

- 861d363: Raise the workers-ai proxy output floor `PI_MIN_OUTPUT_TOKENS` 16k → 32k — the actual
  fix for spec-writer truncation.

  The LLM proxy floors every `workers-ai` call to `max_tokens = max(asked, floor)` and
  records/applies that. Production telemetry showed all 362 workers-ai calls recording
  exactly 16384, never 32768: Pi does not forward its model-entry `maxTokens` (the
  harness `PI_MAX_OUTPUT_TOKENS`) as the request `max_tokens`, so `asked` is always at or
  below the floor and the floor is the effective ceiling. Bumping the harness ceiling to
  32k (and rebuilding the image) therefore had no effect on the applied limit. The proxy
  floor is the lever, and it's a worker-side change — no image rebuild needed.

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

- f16ae62: Board cleanup, resizable service frames, and an explicit container start-up phase.

  - **No more sample services + no "reset to sample board".** New boards start
    empty: workspace creation no longer seeds the sample architecture blocks (the
    SPA passes `seed: false`), and the toolbar's "Reset board to sample" button (and
    the `workspace.reset()` action behind it) is gone. The built-in **pipeline
    catalog is still always provisioned** — it is product config, not sample data —
    so an empty board can still run pipelines. The `seed` flag (now sample _blocks_
    only, default true) remains for demo boards and the test fixtures.

  - **Resizable service frames (Miro-style).** A frame can be resized by dragging
    its right / bottom edges or the bottom-right corner. `Block` gains an optional
    `size` (`{ w, h }`); when set it is the user's dragged size, used as a floor over
    the frame's content extent so a frame grows but is never dragged smaller than its
    tasks/modules. The size is persisted (new `width`/`height` columns on `blocks` —
    D1 migration `0027`, Drizzle migration for Postgres) and updated via the existing
    `PATCH /blocks/:id` (which now accepts `size`).

  - **Explicit "Spinning up container…" phase.** Container-backed steps (`coder`,
    `mocker`, `playwright`, `blueprints`, `merger`, …) now surface an explicit
    cold-boot phase instead of a blank "working" state. `PipelineStep` gains
    `startingContainer`, set the moment the job is dispatched (the dispatch blocks
    until the per-run container is up and has accepted the job, so it covers the whole
    boot window) and cleared on the first successful poll, when the container is
    provably up. The board shows "Spinning up container…" during that window — an
    accurate signal that does not rely on the absence of subtasks. Steps persist as
    JSON, so this needs no migration.

- 861d363: Raise the container LLM-proxy session-token TTL from 30 to 90 minutes so a long but
  healthy agent step can't 401 mid-run.

  The harness job watchdog lets a step run up to `JOB_MAX_DURATION_MS` (default 60 min),
  but the per-run session token (`DEFAULT_SESSION_TTL_MS`) expired at 30 min. The token
  is minted at dispatch, before the container boots and Pi starts, so its clock leads
  the job's by the boot/dispatch latency. A spec-writer run on a slow Workers AI model
  (`kimi-k2.7-code`, with repeated 4-minute upstream timeouts) ran ~34 min and died with
  `401 Invalid or expired session token` while the watchdog still considered it alive.

  90 min clears the 60-min watchdog ceiling plus the boot lead with margin. The token
  stays tightly scoped (audience `llm-proxy`, one workspace, one execution, locked
  provider+model), so the longer life is a small risk increase: a leak can only spend
  that run's metered budget on that one model. The token is minted with no `ttlMs`
  override in `ContainerAgentExecutor`, so both runtimes pick up the new default.

- 86a5843: Require final-answer agents to emit the answer in the reply, not the reasoning channel.

  A spec-writer run, then a blueprinter run, on `@cf/moonshotai/kimi-k2.7-code` failed
  with "the agent did not return a usable ...: its final turn produced no text (an empty
  completion)" even though the model produced a complete, valid document. The whole
  answer landed in the model's reasoning channel and the visible reply came back empty
  (telemetry: `finish_reason='stop'`, thousands of completion tokens, ~31k chars of
  `reasoning_text`, zero visible content). The harness reads the deliverable from the
  visible content only, so the no-empty-outcome gate (`unusableFinalAnswerCause`)
  correctly failed the run.

  This is universal to any agent whose deliverable IS its final reply. Added a shared
  `FINAL_ANSWER_IN_REPLY` fragment (`@cat-factory/agents`, `prompts/shared.ts`) that
  names the channel, and applied it to every final-answer agent: the four container
  constants in `ContainerAgentExecutor.ts` (spec-writer, blueprint, merger, on-call), the
  design/review/test standard phases, the tester report, the business-reviewer, the
  companions, the requirements reviewer + rework, and the generic report roles
  (researcher, analysis, bug-investigator, documenter, integrator, task-estimator,
  merger). It is deliberately NOT applied to side-effect agents whose product is a pushed
  commit (coder, ci-fixer, conflict-resolver, mocker, playwright, business-documenter):
  they legitimately end with no final text. The spec-writer prompt also now states it has
  no repository write access, removing the "maybe it just wants me to push the file"
  reading. Bumped the `requirement-review`, `requirement-rework`, and `review` versioned
  prompts. The no-empty-outcome gate stays as the safety net.

- Updated dependencies [fe53445]
- Updated dependencies [8eed38c]
- Updated dependencies [d94e75c]
- Updated dependencies [6406c8c]
- Updated dependencies [3d9a9d8]
- Updated dependencies [db77061]
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
- Updated dependencies [e50e78a]
- Updated dependencies [0972696]
- Updated dependencies [b48c455]
- Updated dependencies [e9b9356]
- Updated dependencies [e8005ba]
- Updated dependencies [3a12f15]
- Updated dependencies [3a12f15]
- Updated dependencies [b40da13]
- Updated dependencies [3a12f15]
- Updated dependencies [ec0c416]
- Updated dependencies [8eed38c]
- Updated dependencies [084bf43]
- Updated dependencies [14840ec]
- Updated dependencies [4030da2]
- Updated dependencies [268c15d]
- Updated dependencies [c9d3f49]
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
- Updated dependencies [9be11e1]
- Updated dependencies [5ec0d25]
- Updated dependencies [197264e]
- Updated dependencies [a691853]
- Updated dependencies [f066c59]
- Updated dependencies [c664fe6]
- Updated dependencies [7d5e060]
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
- Updated dependencies [5c8ca33]
- Updated dependencies [b156b4b]
- Updated dependencies [7cf2a2d]
- Updated dependencies [2d66d34]
- Updated dependencies [197264e]
- Updated dependencies [56ee67d]
- Updated dependencies [3a12f15]
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
- Updated dependencies [2ab06b5]
- Updated dependencies [21ca647]
- Updated dependencies [c4ef995]
- Updated dependencies [8eed95b]
- Updated dependencies [0b38aa6]
- Updated dependencies [a97e485]
- Updated dependencies [de5a9d7]
- Updated dependencies [f647733]
- Updated dependencies [d5e9141]
- Updated dependencies [2dd7e56]
- Updated dependencies [2d66d34]
- Updated dependencies [86a5843]
- Updated dependencies [a54ada2]
- Updated dependencies [6406c8c]
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
  - @cat-factory/integrations@0.7.0
  - @cat-factory/orchestration@0.7.0
  - @cat-factory/kernel@0.7.0
  - @cat-factory/agents@0.7.0
  - @cat-factory/prompt-fragments@0.7.0
  - @cat-factory/spend@0.7.0
