# Code quality, observability & extensibility review — July 2026

A deep-dive assessment of the cat-factory codebase across ten axes, run as four parallel
evidence-gathering sweeps: backend code quality (`backend/packages/*`, `backend/runtimes/*`,
`backend/internal/*`), the observability stack, the extensibility seams, and testing/CI +
the frontend. Every claim below was verified in the source at the time of this audit
(original sweep at commit `efa3345`).

> **Revised 2026-07-20 (HEAD `c220e87`).** The original audit surfaced improvements that have
> since landed; this revision re-verifies the affected axes against the current tree and
> revises the ratings accordingly. The material movers since the sweep: the domain
> composition root split via a `ModuleRegistry` (candidate #6), the 11k-line conformance
> monolith split into parallel group files, the built-in-agent registry strangler resuming
> (initiative / blueprints / spec-writer kinds migrated onto `registerAgentKind`), and
> modular-vue slices 3–5 landing (inspector panels → subject-keyed panel group, all 18 result
> windows → one `ResultWindowShell`). Two axes are raised: **Complexity 2.5 → 3.5** and
> **Extensibility 4 → 4.5**. Sections and file:line references touched by the revision are
> current as of `c220e87`; untouched references remain as of `efa3345`.

Companion documents this review builds on (rather than re-deriving):
[`refactoring-candidates.md`](./refactoring-candidates.md) (the god-file backlog),
[`race-condition-audit-2026-07.md`](./race-condition-audit-2026-07.md),
[`initiatives/registry-di-migration.md`](./initiatives/registry-di-migration.md),
[`initiatives/platform-operator-observability.md`](./initiatives/platform-operator-observability.md),
and [`initiatives/system-audit-improvements.md`](./initiatives/system-audit-improvements.md).

**Repo size at audit time:** ~361,600 lines of TypeScript + ~49,500 lines of Vue across 23
backend packages, 3 runtime facades, 7 internal packages, and the Nuxt layer; ~730 spec
files (~4,470 backend + ~290 frontend test cases); 25 ADRs; 46 initiative trackers.

---

## Scorecard

Scale: 5 = exemplary, 4 = strong, 3 = adequate, 2 = weak, 1 = poor.

| #   | Axis                            | Score   | One-line verdict                                                                                                           |
| --- | ------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | Architecture & layering         | **5**   | Textbook-clean hexagonal boundaries; zero runtime-specific imports leak into shared packages                               |
| 2   | Language & typing discipline    | **5**   | Universal strict mode; effectively zero `any`/`@ts-ignore` in production code                                              |
| 3   | Error handling                  | **4.5** | Typed domain-error hierarchy, single mapping layer, disciplined best-effort swallows                                       |
| 4   | Complexity & code-size hygiene  | **3.5** | Still the softest axis, but materially improved: engine + composition-root + conformance splits landed and a CI file-size ratchet now blocks re-accretion |
| 5   | Testing                         | **4**   | Outstanding cross-runtime conformance suite on real infra; but near-zero coverage measurement                              |
| 6   | CI & repo guardrails            | **4**   | Rich bespoke drift guards and supply-chain gating; no dependency/SAST scanning, no coverage gate                           |
| 7   | Observability                   | **3.5** | Excellent single-run drill-down and redacted telemetry; weak platform tracing and metrics surface                          |
| 8   | Extensibility                   | **4.5** | Genuine plugin-registry culture and thin deployments; every registry is now app-owned DI and the built-in-agent strangler is actively landing; a GitHub-shaped god-interface and unwired email channel remain |
| 9   | Frontend quality                | **3.5** | Shared wire contracts, guarded stores, ~95% i18n adoption; four god-components, thin a11y, no error reporting              |
| 10  | Documentation & self-governance | **4.5** | Exceptional self-awareness (ADRs, trackers, self-audits); a few materially stale claims                                    |

**Overall: a high-quality, unusually principled codebase.** It largely lives up to its own
written rules — the strongest signal being that most weaknesses found here are _already
documented by the project itself_ in trackers and candidate lists, and that the ones the
original sweep named have been steadily closed (the two axes raised in this revision are both
"the project fixed what it already knew about"). The genuine gaps now cluster in two places:
platform-level (as opposed to per-run) observability, and verification tooling (coverage,
security scanning). Engine-file complexity — the original sweep's headline soft spot — is no
longer a runaway: the biggest god-files have been split and a CI ratchet now caps the
remainder, leaving RunDispatcher and the two DI roots as bounded, known follow-ons rather than
an unguarded regression surface.

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

## 4. Complexity & code-size hygiene — 3.5/5 (was 2.5)

Still the softest axis, but no longer the "one real soft spot" the original sweep called it:
the largest god-files have been split, the composition root de-monolithed, and a CI ratchet
now caps re-accretion. Largest non-test source files as of `c220e87` (the sweep's counts in
parentheses where they moved):

| Lines | File                                                      | Note                                                                                     |
| ----- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 3,147 | `orchestration/src/modules/execution/RunDispatcher.ts`    | still the biggest domain file, but down from 4,217; the engine split (#5) landed          |
| 3,119 | `conformance/src/suites/execution.ts`                     | the largest slice of the split conformance suite (was one 11,167-line `suite.ts`)         |
| 3,085 | `runtimes/node/src/container.ts`                          | DI root — unchanged (~3,090); candidate #8 (shared container builder) still open          |
| 2,802 | `orchestration/src/modules/execution/ExecutionService.ts` | down from 3,707 (`RunAdmission` + `review-kinds.ts` extracted)                            |
| 2,710 | `runtimes/cloudflare/src/infrastructure/container.ts`     | DI root — ~unchanged (2,665)                                                              |
| 2,471 | `conformance/src/suites/core.ts`                          | second-largest conformance slice                                                         |
| 2,306 | `contracts/src/entities.ts`                               | ~unchanged                                                                                |
| 1,934 | `orchestration/src/container.ts`                          | **down from 3,081** — split via a typed `ModuleRegistry` (candidate #6; #1230)            |
| 1,687 | `server/src/agents/ContainerAgentExecutor.ts`             | unchanged                                                                                 |

- **The 11,167-line conformance monolith is gone.** `suite.ts` is now a 45-line aggregator
  re-exporting five `defineXConformance` groups under `suites/` (core / agents / integration /
  execution / misc), one file each, so the Postgres runtimes parallelise each group as its own
  spec file. The maintenance load is spread, not concentrated (see §5).
- **The domain composition root split** (candidate #6, #1230): `orchestration/src/container.ts`
  routes every optional module through a typed `ModuleRegistry` and dropped 3,081 → 1,934, with
  the ~30 `createXModule` factories moved to `container/modules.ts` (1,304 lines). `Core` split
  into an always-present `CoreSpine` + registry-assembled `OptionalCoreModules`.
- `ExecutionService` (3,707 → 2,802) shed its `assert*` admission family to `RunAdmission` and
  its review-kind builders to `review-kinds.ts`; `RunDispatcher` (4,217 → 3,147) shed the
  deployer fan-out to `DeployerStepController` and the follow-up gate to `FollowUpGateController`
  (priorities item #5). Both remain large and mix responsibilities, but the trend has reversed
  from accretion to reduction.
- The two remaining ~3,000-line container roots (node + cloudflare — the orchestration root is
  no longer one) are wiring (less alarming per line), but they are the enforcement surface of
  the "keep the runtimes symmetric" rule and are hard to diff — `refactoring-candidates.md` #8
  (shared container builder) remains the highest-impact open structural fix in the repo.
- **Re-accretion is now guarded.** `scripts/check-file-size.mjs` enforces a soft max-lines
  budget (default 1,500) with ratcheted allowances for the remaining legacy oversized files,
  wired into CI's `repo-guards` job — so a file that regrows past its recorded allowance fails a
  PR instead of an audit. This is the specific mechanism that keeps the score from sliding back.

**Counterweight:** TODO debt is near-zero — only 7 TODO/FIXME markers in non-test source,
all of them _content_ (prompt strings, marker-detection patterns), none deferred work. Dead
code is a small, documented knip baseline (~8 post-extraction files in
`runtimes/cloudflare` that can now simply be deleted).

## 5. Testing — 4/5

**Strengths — the conformance suite is the repo's standout asset:**

- The cross-runtime conformance suite — now split from one 11,167-line `suite.ts` into five
  `defineXConformance` groups under `suites/` (core / agents / integration / execution / misc;
  ~11,300 lines total, 239 `it()` blocks) plus ~40 focused sibling suites (~380 additional
  assertions) — runs **identically against all three facades** on real infrastructure: real D1
  inside workerd (Cloudflare), real Postgres (Node and local). The Worker runs the aggregate as
  one file (one D1); the Postgres runtimes call the group functions from separate spec files so
  vitest parallelises them across workers. This is the mechanism that makes runtime symmetry
  testable rather than aspirational — and the split removed the "one file is itself a maintenance
  load" caveat the original sweep flagged.
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

## 8. Extensibility — 4.5/5 (was 4)

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

- ~~**Four registries remain module-global** (pipeline, VCS, provider-token, traits)~~ —
  **addressed**: all four have migrated to app-owned instances threaded through
  `CoreDependencies` (`PipelineRegistry`, `VcsProviderRegistry`, `ProviderRegistry`, and — for
  traits — the trait definitions/assignments folded onto the existing `AgentKindRegistry`). The
  `clear*()` test cruft and the phantom-`Map` hazard for external adapters (ADR 0018) are gone;
  see `initiatives/registry-di-migration.md`. The **gate** and **step-resolver** registries
  migrated earlier (the `registerBuiltinGates()` band-aid that re-registered built-ins after a
  `clear()` is gone — `registerBuiltinGates(gateRegistry)` installs into the injected instance).
  The only registry not yet a `*Registry` class is the observability-adapter record (already
  app-owned in shape — a record injected into `RegistryReleaseHealthProvider`, not a module `Map`).
- **The built-in-agent strangler is resuming** (was "built-ins bypass their own seams"; the
  score bump is partly this): `initiative-analyst`/`initiative-planner` (#1218) and
  `blueprints`/`spec-writer` (#1220) have migrated off the static `ROLES` map + the hard-coded
  `buildMigratedBuiltInBody` switch onto the public `registerAgentKind` seam — registered as
  `AgentStepSpec` container-explore kinds whose bodies render through the generic
  `registry.agentStep(...)` path, with prompts resolving through `systemPromptFor`/`userPromptFor`
  so the surface directives apply centrally. What still bypasses: the seven remaining
  orchestration-id built-ins in `buildMigratedBuiltInBody`'s switch
  (`ci-fixer`/`fixer`/`conflict-resolver`/`merger`/`on-call`/`tester`/`ui-tester`) plus the
  `toRunResult` coercion chain in `containerAgentResult.ts`; the merger resolver is still built
  inline rather than via `registerStepResolver`. Two parallel prompt/result mechanisms still
  coexist (matches `refactoring-candidates.md` #5), but the migration is now landing
  kind-by-kind rather than stalled. (Note: the bespoke _harness_ handlers are already gone —
  every built-in synthesizes an `AgentStepSpec` through the one generic body path; the remaining
  work is folding those two backend switches into registry lookups.)
- **`github-client.ts` is a 724-line god-interface** that every VCS provider is adapted
  _into_ (GitLab implements the neutral `VcsClient` and is then re-shaped through
  `vcsBackedGitHubClient`). A third provider inherits the GitHub-shaped impedance mismatch;
  splitting it into cohesive sub-ports is the highest-leverage move for true VCS neutrality.
- **Email is still a seam, not a channel**: `EmailSender` + SendGrid/Resend adapters exist
  and serve invitations/password reset, but no `EmailNotificationChannel` rides the
  composite (tracker exists, zero slices landed).
- **Frontend modularity has advanced from mid- to late-strangler** (slices 0–5 of modular-vue
  have now landed, up from 0–2): consumers can contribute nav items, result views, wizard
  journeys, **and inspector panels**. `InspectorPanel.vue`'s level/type `v-if` fan is now a
  subject-keyed panel group (slice 4, #1205 — the file dropped 631 → 576 lines and each body
  sub-panel is a `PanelEntry<Block>`), and all 18 agent-run result windows converted onto one
  shared `ResultWindowShell` (slice 5, #1229/#1237), collapsing the duplicated window chrome.
  `pages/index.vue` is down to 441 lines. What remains: the overlay/modal host itself (the
  slice-5 upstream "overlay host" spec is filed but not the modal registry), and consumer-owned
  modal contribution — the last hardcoded surface.

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
- **God-components**: four components still exceed 1,000 lines (`AddTaskModal.vue` 1,191;
  `RequirementsReviewWindow.vue` 1,175; `PipelineBuilder.vue` 1,150; `ServiceTestConfig.vue`
  1,079) despite 86 composables existing to extract into. (`InspectorPanel.vue`, flagged as a
  monolith in §8's original sweep, has since fallen to 576 lines via the slice-4 panel-group
  conversion — the pattern the remaining four should follow.)
- **Accessibility is thin**: ~36% of components carry any aria/role/keyboard handling;
  only 13 `@keydown` handlers across a canvas-heavy UI; `aria-live` ×3,
  `aria-expanded` ×1; no axe/a11y assertions in the e2e suite.
- **No client-side error reporting** (§7).

## 10. Documentation & self-governance — 4.5/5

This repo's most unusual trait: it audits itself, and honestly.

- 25 ADRs, 46 initiative trackers with per-slice checklists, per-package `AGENTS.md`
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
  - `refactoring-candidates.md`'s line counts still drift against the tree (they lag the
    post-split reductions this revision records in §4) — the drift itself is evidence for that
    doc's thesis, and item #15 already asks for the refresh.
  - 46 open initiative trackers is a lot of in-flight state (up from 43 at the sweep); several
    are now finished enough to convert to ADRs per the repo's own tracker→ADR rule — the
    modular-vue adoption tracker (slices 0–5 all landed) and the registry-DI migration (every
    registry migrated) are the two most conversion-ready.

---

## Main areas for improvement (prioritized)

Ordered by leverage (impact relative to effort). Items marked ↗ already have a tracker or
candidate entry — the recommendation is to prioritize them, not to re-plan them.

| #   | Area            | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                    | Impact | Effort  |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------- |
| 1   | Security/CI     | Add dependency-vulnerability + SAST + secret scanning to CI (`pnpm audit`/OSV, CodeQL or Semgrep, gitleaks). Today only workflow files are scanned.                                                                                                                                                                                                                                                                                               | High   | Low     |
| 2   | Observability   | ✅ **Done** — `AgentContextObservabilityService.record` runs `redactSecrets` over both prompts + `fragments[].body` + `contextFiles[].content`, and drops secret-shaped file bodies (`isSecretShapedFilename`: `.env`, `*.pem`, SSH keys, `.npmrc`, …).                                                                                                                                                                                           | High   | Low     |
| 3   | Testing         | Enable vitest coverage reporting in the CI test lanes and ratchet-floor the high-value packages (`orchestration`, `server`, `contracts`, `spend`); add tests for `contracts` (zero today).                                                                                                                                                                                                                                                        | High   | Low–Med |
| 4   | Observability   | Add an operational metrics surface: pg-boss queue depth + job latency, `AppCaches` hit/miss counters, HTTP request rate/latency, and a counter for dropped telemetry/notification batches. Either a `/metrics` scrape endpoint or documented OTLP-only.                                                                                                                                                                                           | High   | Medium  |
| 5   | Complexity ↗    | ✅ **Done** — the engine split resumed: `ExecutionService` 3,707 → 2,802 (`RunAdmission` + `review-kinds.ts`) and `RunDispatcher` 4,217 → 3,147 (`DeployerStepController` + `FollowUpGateController`); **plus** the composition root `orchestration/src/container.ts` 3,081 → 1,934 via a typed `ModuleRegistry` (candidate #6, #1230) and the 11,167-line conformance `suite.ts` split into five parallel `suites/` groups. `scripts/check-file-size.mjs` (CI `repo-guards`) now ratchets every oversized file so re-accretion fails a PR instead of an audit. Remaining open: candidate #8 (shared container builder for the node + cloudflare DI roots). | High   | Medium  |
| 6   | Extensibility ↗ | ✅ **Done** — every module-global registry is now app-owned DI: gate + step-resolver (earlier), then pipelines (`PipelineRegistry`), VCS (`VcsProviderRegistry`, a required `ServerContainer` field), provider tokens (`ProviderRegistry` → `GateContext`), and traits (folded onto `AgentKindRegistry`). Only the observability-adapter record (already non-`Map`) is unnormalised; see `initiatives/registry-di-migration.md`.                  | High   | Medium  |
| 7   | Code quality    | ✅ **Done** — `TaskRepository.listByRefs` (a chunked-`IN`-per-source batch read, D1 ⇄ Drizzle + a conformance assertion) replaces the `taskRepo.get`-in-`Promise.all` N+1 in `AgentContextBuilder`; the `'jira'`/`'github'` source literals are de-hardcoded into `extractReferences`' typed `taskRefs`.                                                                                                                                          | Medium | Low     |
| 8   | Observability   | Distributed tracing: HTTP server spans on the shared Hono app + `traceparent` propagation into the container job body so harness tool spans nest under the run's trace instead of being siblings.                                                                                                                                                                                                                                                 | Medium | Medium  |
| 9   | Frontend        | Add a global Nuxt error handler reporting client exceptions to a backend sink; surface WebSocket disconnects as a degraded-state indicator instead of a silent close.                                                                                                                                                                                                                                                                             | Medium | Low     |
| 10  | Extensibility ↗ | 🟡 **In progress** — migrate built-in agents onto their own custom-agent model (`ROLES` → `AgentKindDefinition`s, merger resolver → `registerStepResolver`, harness `structured-output.ts` → backend `postOps`), `refactoring-candidates.md` #5. Landed kind-by-kind: `initiative-analyst`/`initiative-planner` (#1218), `blueprints`/`spec-writer` (#1220). Still to go: the seven `buildMigratedBuiltInBody` switch cases (`ci-fixer`/`fixer`/`conflict-resolver`/`merger`/`on-call`/`tester`/`ui-tester`), folding the `toRunResult` coercion chain onto the definitions, and the inline merger resolver. Some need a `userPrompt(context)` seam extension to carry repo/`parts` context first.                                | Medium | Medium  |
| 11  | Extensibility   | Split the 724-line `github-client.ts` god-interface into cohesive sub-ports (repos, PRs, issues, CI, git-data) so VCS providers implement neutral slices instead of adapting into the GitHub shape.                                                                                                                                                                                                                                               | Medium | High    |
| 12  | Lint            | Enable oxlint `suspicious` (and selectively `restriction`: `no-explicit-any`, `no-non-null-assertion`) at least as warn — lock in the currently convention-only discipline; replace the 4 stale `eslint-disable` comments.                                                                                                                                                                                                                        | Medium | Low     |
| 13  | Testing         | Exercise the real Redis path for `RedisWebSocketPropagator` (a Redis service container in the `test-db` lane); promote e2e into `test-gate.needs` once flake-trust is earned.                                                                                                                                                                                                                                                                     | Medium | Low–Med |
| 14  | Frontend        | Decompose the four remaining >1,000-line components (`AddTaskModal`, `RequirementsReviewWindow`, `PipelineBuilder`, `ServiceTestConfig`) — following the slice-4 `InspectorPanel` panel-group precedent (631 → 576); systematize a11y (axe checks in a couple of e2e specs, a keyboard-nav pass on board/modals).                                                                                                                                    | Medium | Medium  |
| 15  | Docs            | Staleness sweep: fix the non-compiling `custom-agents.md` registration sample, update its Status section, refresh the i18n claim in `CLAUDE.md`, refresh `refactoring-candidates.md` line counts, and convert finished initiative trackers to ADRs.                                                                                                                                                                                               | Low    | Low     |
| 16  | Extensibility ↗ | Land the `EmailNotificationChannel` (port + adapters + composite already exist; only the glue and per-user prefs are missing).                                                                                                                                                                                                                                                                                                                    | Low    | Low     |

### What NOT to change

Worth stating explicitly, because these are deliberate choices that a naive audit might
flag: the best-effort telemetry swallows (observability must never break the product — the
fix is _counting_ drops, not throwing), the D1 ⇄ Drizzle repository duplication (inherent
to two dialects; the mitigation is the conformance suite + the planned shared base
repositories, not premature abstraction), the Worker's lack of `/ready` (stateless
isolates), the non-`DomainError` `RunContendedError`, and the e2e suite's
fail-on-flaky-but-non-blocking posture while it earns trust.
