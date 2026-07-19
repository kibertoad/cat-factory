# Code quality, observability & extensibility review — July 2026

A deep-dive assessment of the cat-factory codebase across ten axes, run as four parallel
evidence-gathering sweeps: backend code quality (`backend/packages/*`, `backend/runtimes/*`,
`backend/internal/*`), the observability stack, the extensibility seams, and testing/CI +
the frontend. Every claim below was verified in the source at the time of this audit
(commit `efa3345`); file:line references are current as of that commit.

Companion documents this review builds on (rather than re-deriving):
[`refactoring-candidates.md`](./refactoring-candidates.md) (the god-file backlog),
[`race-condition-audit-2026-07.md`](./race-condition-audit-2026-07.md),
[`initiatives/registry-di-migration.md`](./initiatives/registry-di-migration.md),
[`initiatives/platform-operator-observability.md`](./initiatives/platform-operator-observability.md),
and [`initiatives/system-audit-improvements.md`](./initiatives/system-audit-improvements.md).

**Repo size at audit time:** ~361,600 lines of TypeScript + ~49,500 lines of Vue across 23
backend packages, 3 runtime facades, 7 internal packages, and the Nuxt layer; ~730 spec
files (~4,470 backend + ~290 frontend test cases); 24 ADRs; 43 initiative trackers.

---

## Scorecard

Scale: 5 = exemplary, 4 = strong, 3 = adequate, 2 = weak, 1 = poor.

| #   | Axis                            | Score   | One-line verdict                                                                                                           |
| --- | ------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | Architecture & layering         | **5**   | Textbook-clean hexagonal boundaries; zero runtime-specific imports leak into shared packages                               |
| 2   | Language & typing discipline    | **5**   | Universal strict mode; effectively zero `any`/`@ts-ignore` in production code                                              |
| 3   | Error handling                  | **4.5** | Typed domain-error hierarchy, single mapping layer, disciplined best-effort swallows                                       |
| 4   | Complexity & code-size hygiene  | **2.5** | The one real soft spot: 4,200/3,700-line engine god-classes and three ~3,000-line DI roots                                 |
| 5   | Testing                         | **4**   | Outstanding cross-runtime conformance suite on real infra; but near-zero coverage measurement                              |
| 6   | CI & repo guardrails            | **4**   | Rich bespoke drift guards and supply-chain gating; no dependency/SAST scanning, no coverage gate                           |
| 7   | Observability                   | **3.5** | Excellent single-run drill-down and redacted telemetry; weak platform tracing and metrics surface                          |
| 8   | Extensibility                   | **4**   | Genuine plugin-registry culture and thin deployments; six registries still module-global, built-ins bypass their own seams |
| 9   | Frontend quality                | **3.5** | Shared wire contracts, guarded stores, ~95% i18n adoption; four god-components, thin a11y, no error reporting              |
| 10  | Documentation & self-governance | **4.5** | Exceptional self-awareness (ADRs, trackers, self-audits); a few materially stale claims                                    |

**Overall: a high-quality, unusually principled codebase.** It largely lives up to its own
written rules — the strongest signal being that most weaknesses found here are _already
documented by the project itself_ in trackers and candidate lists. The genuine gaps are
concentrated in three places: engine-file complexity, platform-level (as opposed to
per-run) observability, and verification tooling (coverage, security scanning).

---

## 1. Architecture & layering — 5/5

The hexagonal architecture is not aspirational; it holds under grep.

- **Boundary purity is verified clean.** No `@cloudflare/*` import exists outside
  `backend/runtimes/cloudflare`; no `drizzle-orm`/`pg`/`pg-boss` import exists outside
  `backend/runtimes/node`. The only "hits" elsewhere are prose in comments and scaffolder
  template text in `@cat-factory/cli`. Layering is strictly `contracts → kernel →
{agents, integrations, orchestration, server} → runtimes → deploy`; kernel imports
  nothing but contracts.
- **Ports are genuinely segregated.** ~101 port modules under
  `backend/packages/kernel/src/ports/` with a ~50-line median. The one god-interface is
  `github-client.ts` (724 lines, ~50 methods) — see §8.
- **Deployments are as thin as claimed**: `deploy/backend/src/index.ts` (22 lines),
  `deploy/node/src/main.ts` (21), `deploy/local/src/main.ts` (19),
  `deploy/frontend/nuxt.config.ts` (17). Standing up a deployment is configuration, not code.
- **Runtime symmetry** is enforced by convention + the conformance suite rather than by
  structure — the cost of that shows up in §4 (duplicated container roots and repository
  pairs), and `refactoring-candidates.md` #7/#8 already name the structural fix.

## 2. Language & typing discipline — 5/5

- `backend/tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`; every
  package extends it and none weakens it.
- Production code contains **zero real `as any`/`: any` casts** (every grep hit is prose
  in doc comments), **zero `@ts-ignore`/`@ts-expect-error`**, and a single `@ts-nocheck`
  in a generated file that is lint-excluded. Residual `as any` lives only in test doubles
  (~10 sites).
- Caveat: this discipline is **convention, not tooling** — oxlint enables only the
  `correctness` category (`.oxlintrc.json`), so `no-explicit-any` is not enforced (§6).

## 3. Error handling — 4.5/5

- **Typed domain errors**: `kernel/src/domain/errors.ts` defines `DomainError` with a
  discriminated `code` union and subclasses (`NotFoundError`, `ValidationError`,
  `ConflictError` carrying a machine-readable `ConflictReason`, `CredentialRequiredError`,
  `ForbiddenError`). The SPA maps those codes to i18n keys — no prose is parsed off the wire.
- **One mapping layer**: `server/src/http/errorHandler.ts` maps `code → status` through a
  total record, formats Valibot issues, and funnels unknowns to a logged 500 that never
  leaks internals. Controllers do not hand-map.
- **Swallows are disciplined**: zero empty `catch {}` blocks in non-test source; the ~110
  best-effort swallows are confined to observability/telemetry/notification paths and each
  is documented ("observability never breaks a dispatch"). The pattern is repeated by hand
  ~a dozen times, though — a small shared `runBestEffort(fn, logger)` helper would make it
  uniform, and today nothing counts the drops (see §7).
- Nice touch: `RunContendedError` is deliberately _not_ a `DomainError` so an
  optimistic-concurrency retry signal can never be serialized to a status code.

## 4. Complexity & code-size hygiene — 2.5/5

The weakest axis, and the project knows it (`refactoring-candidates.md` tracks most of it).
Largest non-test source files at audit time:

| Lines  | File                                                      | Note                                                                        |
| ------ | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| 11,167 | `backend/internal/conformance/src/suite.ts`               | test infra, but a maintenance load itself                                   |
| 4,217  | `orchestration/src/modules/execution/RunDispatcher.ts`    | **83 methods**; grew past the 2,779 recorded in `refactoring-candidates.md` |
| 3,707  | `orchestration/src/modules/execution/ExecutionService.ts` | ~60 methods, ≥6 distinct responsibilities; regrew from the recorded ~2,549  |
| 3,090  | `runtimes/node/src/container.ts`                          | DI root                                                                     |
| 3,081  | `orchestration/src/container.ts`                          | DI root                                                                     |
| 2,665  | `runtimes/cloudflare/src/infrastructure/container.ts`     | DI root                                                                     |
| 2,293  | `contracts/src/entities.ts`                               |                                                                             |
| 1,687  | `server/src/agents/ContainerAgentExecutor.ts`             |                                                                             |

- `ExecutionService` mixes admission preflights (`assert*` family), run lifecycle,
  fork/follow-up handling, review-kind builders, merge finalization, and decision
  resolution. `RunDispatcher` — flagged as a "follow-on watch item" when it was 2,779
  lines — has since accreted ~1,400 more lines, confirming that watch item's fear.
- The three ~3,000-line container roots are wiring (less alarming per line), but they are
  the enforcement surface of the "keep the runtimes symmetric" rule and are hard to diff —
  `refactoring-candidates.md` #8 (shared container builder) remains the highest-impact
  structural fix in the repo.
- Nothing currently stops re-accretion: there is no `max-lines` /
  `max-lines-per-function` lint budget, and the recorded line counts in
  `refactoring-candidates.md` have already drifted stale
  (`system-audit-improvements.md` item 17 notes the same).

**Counterweight:** TODO debt is near-zero — only 7 TODO/FIXME markers in non-test source,
all of them _content_ (prompt strings, marker-detection patterns), none deferred work. Dead
code is a small, documented knip baseline (~8 post-extraction files in
`runtimes/cloudflare` that can now simply be deleted).

## 5. Testing — 4/5

**Strengths — the conformance suite is the repo's standout asset:**

- `backend/internal/conformance/src/suite.ts` (11,167 lines, 239 `it()` blocks in five
  aggregated sub-suites) plus ~40 focused sibling suites (~380 additional assertions) run
  **identically against all three facades** on real infrastructure: real D1 inside workerd
  (Cloudflare), real Postgres (Node and local). This is the mechanism that makes runtime
  symmetry testable rather than aspirational.
- One canonical deterministic `FakeAgentExecutor` (671 lines) is shared by conformance and
  e2e — no per-suite fake drift.
- The Playwright e2e suite (24 specs) covers the assembled product against a real Node
  backend with `failOnFlakyTests: true` — flakes report red by design.
- Sampled "suspiciously critical" flows are in fact tested: retention pruning,
  subscription-activation crypto, sweepers, the spend safeguard.

**Weaknesses:**

- **Coverage measurement is nearly absent.** Exactly one package (`kernel`) configures
  vitest coverage, with a deliberately-low ratchet floor (statements 16%); CI has no
  coverage reporting or gate at all. With ~730 spec files there is no _data_ on what they
  actually cover.
- **`@cat-factory/contracts` has zero tests** — the Valibot wire source of truth imported
  by 125 frontend files and every backend. `provider-cloudflare` and `provider-s3` are
  also untested (and the publish-integrity guard's own comments record that provider-s3
  once shipped as an empty shell). Thin single-test packages carrying real logic: `spend`,
  `consensus`, `caching`.
- The Redis propagator spec uses a fake in-memory bus — the real `ioredis` wire path that
  multi-node production coherence rides on is never exercised.
- e2e is deliberately non-blocking in CI (reasonable while earning trust), which means 24
  well-built specs currently cannot block a regression.

## 6. CI & repo guardrails — 4/5

**Strengths:** a 17-job pipeline with real infra (sharded workerd + D1, sharded Postgres 18,
conditional k3d), a fail-closed `test-gate` aggregator, and an unusually rich set of bespoke
drift guards: OpenAPI diff, package-catalog completeness, publish integrity (empty-shell +
publint + attw over the packed tarball), runner-image-tag lockstep, changeset presence,
i18n missing-key + locale-parity, `zizmor`/`actionlint` on workflows, pinned action SHAs,
`persist-credentials: false`, and the `minimumReleaseAge` supply-chain gate with a
tightly-governed exclude list.

**Gaps:**

- **No dependency-vulnerability or SAST scanning of application code.** The only security
  tooling scans _workflow files_. No `pnpm audit`/OSV, no CodeQL/Semgrep, no secret
  scanning (e.g. gitleaks) — notable for a product that handles GitHub tokens, personal
  subscriptions, and sealed credentials.
- **No coverage gate** (see §5).
- Guard scripts protect docs/publish/config drift comprehensively but nothing guards
  code-quality regression (file-size budgets, coverage ratchets).

**Dependency hygiene itself is exemplary** (arguably 5/5 in isolation): owned-namespace-only
release-age excludes with one documented, time-boxed exception; load-bearing singleton
`overrides` each carrying a written rationale; `allowBuilds` allow-listing instead of
blanket trust. Two watch items: nothing enforces pruning the time-boxed nuxt exception once
it ages out, and `typescript: 7.0.2` (native tsc) is bleeding-edge for a two-dialect build
graph — worth a deliberate pin-audit per bump.

## 7. Observability — 3.5/5

The story is **rich at the single-run level and thin at the platform level** — a diagnosis
the project itself reached in `initiatives/platform-operator-observability.md`, which has
since landed rollups, an operator dashboard, threshold alerting, and OTLP gauge export.
What remains:

**Strong:**

- **Logging**: one shared workerd-safe pino instance (`server/src/observability/logger.ts`)
  used by every facade; no raw `console.*` in production paths; consistent
  `logger.child({...})` correlation with `workspaceId`/`executionId`/`jobId`
  (e.g. `LlmProxyController.ts:145-153`).
- **Telemetry persistence**: symmetric retention pruning on both runtimes; LLM call bodies
  scrubbed **up front** by `redactSecrets` (including `errorMessage`) before storage,
  delta-chaining, or Langfuse fan-out; agent-context snapshots stored via a structural
  field allow-list, double-gated (deployment `LLM_RECORD_PROMPTS` + per-workspace
  `storeAgentContext`), size-budgeted.
- **Health/readiness**: `/health` on both facades, `/ready` on Node (DB ping + pg-boss +
  SIGTERM drain); a misconfigured-boot fallback app; and genuinely excellent migration
  failure diagnostics (`migrate.ts` maps pg codes to human causes + recovery commands and
  detects ledger↔schema drift before applying).
- **Per-run UX**: `ObservabilityPanel.vue` gives per-call prompt/response/tokens/timing,
  the full provided context, and LLM-friendly JSON export.

**Weak:**

- **Tracing**: the Langfuse + OTel sinks cover LLM generations and container tool spans
  _only_, and as **sibling spans keyed by `executionId`** — there is no HTTP server-span
  instrumentation on the Hono app and no W3C `traceparent` propagation across the
  container boundary, so no true end-to-end trace exists.
- **Metrics**: push-only OTLP gauges of per-account run aggregates. No `/metrics` scrape
  endpoint, no pg-boss queue-depth/job-latency instruments, no cache hit/miss counters in
  `@cat-factory/caching`, no HTTP request rate/latency/error metrics.
- **Redaction residuals**: `redactSecrets` is regex-shape best-effort (novel credential
  shapes pass through). ~~injected context-file bodies (`contextFiles[].content`) and
  fragment bodies in `AgentContextObservabilityService` are **not** run through
  `redactSecrets` at all~~ — **addressed**: `record` now scrubs both prompts, every fragment
  body and every injected file's content through `redactSecrets` before the size budget,
  deep-scrubs the free-text values in the `extras` bag (decisions/revision feedback) via
  `redactSecretsDeep`, and drops the whole body of a secret-shaped file (`.env`/`*.pem`/SSH
  key/…) via `isSecretShapedFilename` (priorities item #2). `redactSecrets` additionally
  matches PEM-armored private keys by header, so a pasted key is caught regardless of
  filename. The residual best-effort caveat (a novel token shape or a raw secret in an
  ordinarily-named body) stands by design.
- **Silent best-effort paths are uncounted**: dropped telemetry batches, failed
  notification deliveries, and oversized snapshots vanish with at most a `warn`; no metric
  counts them, so telemetry completeness is itself unmonitored. Per-run "stuck > 30 min"
  detection is a known, deliberate gap in the platform-health sweep.
- **Frontend**: no client-side error reporting whatsoever — no global Nuxt error handler,
  no Sentry-style sink; client JS exceptions are invisible to operators.

## 8. Extensibility — 4/5

**Strong:**

- A genuine, consistent plugin-registry culture: agent kinds, gates, pipelines, VCS
  providers, step resolvers, runner backends, environment backends, observability
  adapters, notification channels, model providers, prompt fragments, frontend app
  modules. The worked example (`backend/internal/example-custom-agent`) proves a
  repo-writing agent + custom gate + pipelines ship through public seams with zero harness
  changes, and the harness itself now serves a **single manifest-driven kind** — the "zero
  `switch(agentKind)` in the container" principle is actually achieved.
- Model-provider composition (`CompositeModelProvider` + opt-in `provider-*` packages) is
  the reference pattern; runner transports are fully port-driven and symmetric across all
  three facades.
- The registry-DI migration (ADR 0018) has landed for the highest-traffic registries
  (agent kinds, initiative presets, runner/environment backends, user-secret kinds).

**Gaps:**

- **Six registries remain module-global** (gate, step-resolver, pipeline, VCS,
  provider-token, traits), each still carrying `clear*()` test cruft and the
  phantom-`Map` hazard for external adapters that ADR 0018 documents.
  `registerBuiltinGates()` (`gates/src/index.ts:78`) is an explicit band-aid re-registering
  built-ins after a `clear()` — precisely the shared-state flaw the migration exists to
  eliminate.
- **Built-in agents bypass their own seams**: core kinds (coder, blueprints, spec-writer,
  merger, tester, requirements/clarity review) live in a static `ROLES` map rather than
  `AgentKindDefinition`s; the merger resolver is built inline rather than via
  `registerStepResolver`; built-in structured output renders in the harness
  (`structured-output.ts`) instead of backend `postOps`. Two parallel prompt/result
  mechanisms coexist (matches `refactoring-candidates.md` #5).
- **`github-client.ts` is a 724-line god-interface** that every VCS provider is adapted
  _into_ (GitLab implements the neutral `VcsClient` and is then re-shaped through
  `vcsBackedGitHubClient`). A third provider inherits the GitHub-shaped impedance mismatch;
  splitting it into cohesive sub-ports is the highest-leverage move for true VCS neutrality.
- **Email is still a seam, not a channel**: `EmailSender` + SendGrid/Resend adapters exist
  and serve invitations/password reset, but no `EmailNotificationChannel` rides the
  composite (tracker exists, zero slices landed).
- **Frontend modularity is mid-strangler** (slices 0–2 of modular-vue landed): consumers
  can contribute nav items and result views, but `InspectorPanel.vue` (631-line
  level-switched monolith), the ~50 hand-mounted modals in `pages/index.vue`, and the
  duplicated result-window chrome are still hardcoded.

## 9. Frontend quality — 3.5/5

- **Wire-type safety is the right architecture**: 125 files import from
  `@cat-factory/contracts`; `app/types/domain.ts` re-exports contracts and adds only
  genuinely frontend-only types. (Undercut by contracts itself being untested, §5.)
- **Stores are healthy**: 29 stores, no god-store, ~24 store specs; the monotonic
  `refreshSeq` guard in `stores/workspace.ts:316-332` (the fix for the documented
  live-push clobber class of bugs) is real and pinned by unit tests.
- **i18n is much further along than CLAUDE.md claims**: 176/186 components reference
  `useI18n` (~95% by file, vs. the doc's "most components still hold inline strings"),
  10 locales, a 5,100-line `en.json`, and four tiers of drift guards wired into blocking CI.
- **God-components**: four components exceed 1,000 lines (`RequirementsReviewWindow.vue`
  1,220; `AddTaskModal.vue` 1,123; `PipelineBuilder.vue` 1,088; `ServiceTestConfig.vue`
  1,079) despite 86 composables existing to extract into.
- **Accessibility is thin**: ~36% of components carry any aria/role/keyboard handling;
  only 13 `@keydown` handlers across a canvas-heavy UI; `aria-live` ×3,
  `aria-expanded` ×1; no axe/a11y assertions in the e2e suite.
- **No client-side error reporting** (§7).

## 10. Documentation & self-governance — 4.5/5

This repo's most unusual trait: it audits itself, and honestly.

- 24 ADRs, 43 initiative trackers with per-slice checklists, per-package `AGENTS.md`
  orientation maps, a glossary, an execution-state-machine reference, prior race-condition
  and system audits with confirmed/addressed statuses, and a candid
  `refactoring-candidates.md`. Most findings in this review were _already known_ to the
  project — the meta-signal is strongly positive.
- **Staleness debits** (the flip side of carrying this much documentation):
  - `backend/docs/custom-agents.md` shows the removed free-function `registerAgentKind`
    API (ADR 0018 replaced it with an injected registry — the sample no longer compiles)
    and overstates the harness gap (the per-kind harness handlers are already gone).
  - `CLAUDE.md`'s i18n claim ("most components still hold inline strings") materially
    understates reality (~95% adoption).
  - `refactoring-candidates.md`'s line counts have drifted (RunDispatcher 2,779 → 4,217;
    ExecutionService ~2,549 → 3,707) — the drift itself is evidence for that doc's thesis.
  - 43 open initiative trackers is a lot of in-flight state; several may be finished
    enough to convert to ADRs per the repo's own tracker→ADR rule.

---

## Main areas for improvement (prioritized)

Ordered by leverage (impact relative to effort). Items marked ↗ already have a tracker or
candidate entry — the recommendation is to prioritize them, not to re-plan them.

| #   | Area            | Recommendation                                                                                                                                                                                                                                                                                           | Impact | Effort  |
| --- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------- |
| 1   | Security/CI     | Add dependency-vulnerability + SAST + secret scanning to CI (`pnpm audit`/OSV, CodeQL or Semgrep, gitleaks). Today only workflow files are scanned.                                                                                                                                                      | High   | Low     |
| 2   | Observability   | ✅ **Done** — `AgentContextObservabilityService.record` runs `redactSecrets` over both prompts + `fragments[].body` + `contextFiles[].content`, and drops secret-shaped file bodies (`isSecretShapedFilename`: `.env`, `*.pem`, SSH keys, `.npmrc`, …).                                                  | High   | Low     |
| 3   | Testing         | Enable vitest coverage reporting in the CI test lanes and ratchet-floor the high-value packages (`orchestration`, `server`, `contracts`, `spend`); add tests for `contracts` (zero today).                                                                                                               | High   | Low–Med |
| 4   | Observability   | Add an operational metrics surface: pg-boss queue depth + job latency, `AppCaches` hit/miss counters, HTTP request rate/latency, and a counter for dropped telemetry/notification batches. Either a `/metrics` scrape endpoint or documented OTLP-only.                                                  | High   | Medium  |
| 5   | Complexity ↗    | Resume the engine split: `RunDispatcher` (4,217 lines — the recorded watch item has come true) and `ExecutionService` (extract the `assert*` admission family + review-kind builders). Add a soft `max-lines` lint budget to stop re-accretion.                                                          | High   | Medium  |
| 6   | Extensibility ↗ | Finish the registry-DI migration for the 6 module-global registries (gates, step resolvers, pipelines, VCS, provider tokens, traits); delete every `clear*()` and the `registerBuiltinGates()` band-aid.                                                                                                 | High   | Medium  |
| 7   | Code quality    | ✅ **Done** — `TaskRepository.listByRefs` (a chunked-`IN`-per-source batch read, D1 ⇄ Drizzle + a conformance assertion) replaces the `taskRepo.get`-in-`Promise.all` N+1 in `AgentContextBuilder`; the `'jira'`/`'github'` source literals are de-hardcoded into `extractReferences`' typed `taskRefs`. | Medium | Low     |
| 8   | Observability   | Distributed tracing: HTTP server spans on the shared Hono app + `traceparent` propagation into the container job body so harness tool spans nest under the run's trace instead of being siblings.                                                                                                        | Medium | Medium  |
| 9   | Frontend        | Add a global Nuxt error handler reporting client exceptions to a backend sink; surface WebSocket disconnects as a degraded-state indicator instead of a silent close.                                                                                                                                    | Medium | Low     |
| 10  | Extensibility ↗ | Migrate built-in agents onto their own custom-agent model (`ROLES` → `AgentKindDefinition`s, merger resolver → `registerStepResolver`, harness `structured-output.ts` → backend `postOps`) — `refactoring-candidates.md` #5.                                                                             | Medium | Medium  |
| 11  | Extensibility   | Split the 724-line `github-client.ts` god-interface into cohesive sub-ports (repos, PRs, issues, CI, git-data) so VCS providers implement neutral slices instead of adapting into the GitHub shape.                                                                                                      | Medium | High    |
| 12  | Lint            | Enable oxlint `suspicious` (and selectively `restriction`: `no-explicit-any`, `no-non-null-assertion`) at least as warn — lock in the currently convention-only discipline; replace the 4 stale `eslint-disable` comments.                                                                               | Medium | Low     |
| 13  | Testing         | Exercise the real Redis path for `RedisWebSocketPropagator` (a Redis service container in the `test-db` lane); promote e2e into `test-gate.needs` once flake-trust is earned.                                                                                                                            | Medium | Low–Med |
| 14  | Frontend        | Decompose the four >1,000-line components; systematize a11y (axe checks in a couple of e2e specs, a keyboard-nav pass on board/modals).                                                                                                                                                                  | Medium | Medium  |
| 15  | Docs            | Staleness sweep: fix the non-compiling `custom-agents.md` registration sample, update its Status section, refresh the i18n claim in `CLAUDE.md`, refresh `refactoring-candidates.md` line counts, and convert finished initiative trackers to ADRs.                                                      | Low    | Low     |
| 16  | Extensibility ↗ | Land the `EmailNotificationChannel` (port + adapters + composite already exist; only the glue and per-user prefs are missing).                                                                                                                                                                           | Low    | Low     |

### What NOT to change

Worth stating explicitly, because these are deliberate choices that a naive audit might
flag: the best-effort telemetry swallows (observability must never break the product — the
fix is _counting_ drops, not throwing), the D1 ⇄ Drizzle repository duplication (inherent
to two dialects; the mitigation is the conformance suite + the planned shared base
repositories, not premature abstraction), the Worker's lack of `/ready` (stateless
isolates), the non-`DomainError` `RunContendedError`, and the e2e suite's
fail-on-flaky-but-non-blocking posture while it earns trust.
