# Code quality, observability & extensibility review: July 2026

A deep-dive assessment of the cat-factory codebase, run as four parallel
evidence-gathering sweeps: backend code quality (`backend/packages/*`, `backend/runtimes/*`,
`backend/internal/*`), the observability stack, the extensibility seams, and testing/CI +
the frontend. Every claim below was verified in the source at the time of this audit
(original sweep at commit `efa3345`). The audit originally spanned ten axes; the
2026-07-24 revision added an eleventh (**usability**) so the scorecard now estimates
across eleven.

> **Revised 2026-07-20 (HEAD `c220e87`).** The original audit surfaced improvements that have
> since landed; that revision re-verified the affected axes against the then-current tree.
> The material movers at that point: the domain composition root split via a `ModuleRegistry`
> (candidate #6), the 11k-line conformance monolith split into parallel group files, the
> built-in-agent registry strangler resuming (initiative / blueprints / spec-writer kinds
> migrated onto `registerAgentKind`), and modular-vue slices 3–5 landing. Two axes were
> raised: **Complexity 2.5 → 3.5** and **Extensibility 4 → 4.5**.

> **Revised 2026-07-24 (HEAD `0c08604`).** A second re-verification of every axis against the
> current tree, plus a new **Usability** axis added to the estimation. The material movers
> since `c220e87`:
>
> - **Observability**: ADR 0026/0027 landed in full (honest dispatch-failure classification,
>   parallel-subagent progress, cold-start watchdog, the key-drift boot fingerprint); call
>   telemetry now **streams live** and survives a mid-run container death; the harness
>   liveness heartbeat surfaces as "active Ns ago"; per-agent effort self-assessments +
>   per-fragment best-practice adherence reports ship in every result window.
> - **Complexity**: every previously-named god-file shrank again, `contracts/src/entities.ts`
>   was split, the oxlint ratchets tightened twice (`max-lines-per-function` 1000 → 632 → 400,
>   cyclomatic `complexity` 60 → 40 → 30), and the file-size guard now runs in CI.
> - **Extensibility**: the frontend-extension-mechanism initiative landed slices A/B/D
>   (dogfooded consumer module + authoring guide, custom task types, consumer top-level
>   overlays), and a `SlackNotificationChannel` now rides the composite.
>
> Two axes are raised: **Complexity 3.5 → 4** and **Observability 3.5 → 4**; the new
> **Usability** axis enters at **4**. Sections and file:line references touched by this
> revision are current as of `0c08604`; untouched references remain as of the earlier passes.

Companion documents this review builds on (rather than re-deriving):
[`refactoring-candidates.md`](./refactoring-candidates.md) (the god-file backlog),
[`race-condition-audit-2026-07.md`](./race-condition-audit-2026-07.md),
[ADR 0028](../../backend/docs/adr/0028-registry-di.md) (which the `registry-di-migration`
tracker became),
[`initiatives/platform-operator-observability.md`](../initiatives/platform-operator-observability.md),
and [`initiatives/system-audit-improvements.md`](../initiatives/system-audit-improvements.md).

**Repo size as of `0c08604`:** ~261,500 lines of non-test TypeScript + ~96,900 lines of
backend test TypeScript, ~51,700 lines of Vue across 198 components (+ ~25,000 lines of
frontend TS), spread over 22 backend packages, 3 runtime facades, 7 internal packages, and
the Nuxt layer; 655 spec/test files (~4,900 backend test cases); 27 ADRs; 52 initiative
trackers.

---

## Scorecard

Scale: 5 = exemplary, 4 = strong, 3 = adequate, 2 = weak, 1 = poor.

| #   | Axis                            | Score   | One-line verdict                                                                                                                                                                        |
| --- | ------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Architecture & layering         | **5**   | Textbook-clean hexagonal boundaries; zero runtime-specific imports leak into shared packages                                                                                            |
| 2   | Language & typing discipline    | **5**   | Universal strict mode; effectively zero `any`/`@ts-ignore` in production code                                                                                                           |
| 3   | Error handling                  | **4.5** | Typed domain-error hierarchy, single mapping layer, disciplined best-effort swallows                                                                                                    |
| 4   | Complexity & code-size hygiene  | **4**   | The trend has fully reversed: every god-file shrinking under a three-level ratchet (file budget in CI, 400-line functions, complexity 30); two DI roots remain the known follow-on      |
| 5   | Testing                         | **4**   | Outstanding cross-runtime conformance suite on real infra; but near-zero coverage measurement                                                                                           |
| 6   | CI & repo guardrails            | **4**   | Rich bespoke drift guards and supply-chain gating; no dependency/SAST scanning, no coverage gate                                                                                        |
| 7   | Observability                   | **4**   | Excellent single-run drill-down (now streaming, heartbeat-aware, and honest about container death) plus self-reported effort/adherence; platform tracing and metrics surface still thin |
| 8   | Extensibility                   | **4.5** | Genuine plugin-registry culture, thin deployments, and now a dogfooded consumer frontend-extension mechanism; a GitHub-shaped god-interface and unwired email channel remain            |
| 9   | Frontend quality                | **3.5** | Shared wire contracts, guarded stores, ~94% i18n adoption; five god-components (one regressed, one new), thin a11y, no error reporting                                                  |
| 10  | Documentation & self-governance | **4.5** | Exceptional self-awareness (ADRs, trackers, self-audits); a few materially stale claims                                                                                                 |
| 11  | Usability                       | **4**   | Best-in-class actionable error feedback, visible degraded states, polished CLI onboarding, discoverable+retryable failures; a11y unautomated, mobile design-only                        |

**Overall: a high-quality, unusually principled codebase.** It largely lives up to its own
written rules; the strongest signal being that most weaknesses found here are _already
documented by the project itself_ in trackers and candidate lists, and that the ones each
sweep names keep getting closed (all three axes raised across the two revisions are
"the project fixed what it already knew about"). The genuine gaps now cluster in two places:
platform-level (as opposed to per-run) observability, and verification tooling (coverage,
security scanning; the latter now the single largest untouched recommendation). Engine-file
complexity (the original sweep's headline soft spot) is in steady managed decline under a
three-level ratchet, leaving the two runtime DI roots as the last bounded, known follow-on.

---

## 1. Architecture & layering: 5/5

The hexagonal architecture is not aspirational; it holds under grep (re-verified at `0c08604`).

- **Boundary purity is verified clean.** No `@cloudflare/*` import exists outside
  `backend/runtimes/cloudflare`; no `drizzle-orm`/`pg`/`pg-boss` import exists outside
  `backend/runtimes/node`. The only "hits" elsewhere are prose in comments and scaffolder
  template text in `@cat-factory/cli`. Layering is strictly `contracts → kernel →
{agents, integrations, orchestration, server} → runtimes → deploy`; kernel imports
  nothing but contracts.
- **Ports are genuinely segregated.** 107 port modules under
  `backend/packages/kernel/src/ports/` with a ~50-line median. The one god-interface is
  `github-client.ts` (now 773 lines, ~62 methods: it has _grown_ since the sweep): see §8.
- **Deployments are as thin as claimed**: `deploy/backend/src/index.ts` (22 lines),
  `deploy/node/src/main.ts` (21), `deploy/local/src/main.ts` (19),
  `deploy/frontend/nuxt.config.ts` (17). Standing up a deployment is configuration, not code.
- **Runtime symmetry** is enforced by convention + the conformance suite rather than by
  structure: the cost of that shows up in §4 (duplicated container roots and repository
  pairs), and `refactoring-candidates.md` #7/#8 already name the structural fix.

## 2. Language & typing discipline: 5/5

- `backend/tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`; every
  package extends it and none weakens it.
- Production code contains **zero real `as any`/`: any` casts** (re-verified at `0c08604`:
  every grep hit is prose in doc comments), **zero `@ts-ignore`/`@ts-expect-error`**, and a
  single `@ts-nocheck` in a generated file that is lint-excluded. Residual `as any` lives
  only in test doubles (~10 sites).
- The convention now has partial tooling behind it: beyond the `correctness` category,
  `.oxlintrc.json` enforces size/complexity limits (`max-lines-per-function` 400,
  `complexity` 30, `max-depth` 4, `max-params` 6, `max-statements` 50; see §4), though
  `no-explicit-any` itself is still not enforced (§6).

## 3. Error handling: 4.5/5

- **Typed domain errors**: `kernel/src/domain/errors.ts` defines `DomainError` with a
  discriminated `code` union and subclasses (`NotFoundError`, `ValidationError`,
  `ConflictError` carrying a machine-readable `ConflictReason`, `CredentialRequiredError`,
  `ForbiddenError`). The SPA maps those codes to i18n keys, no prose is parsed off the wire.
- **One mapping layer**: `server/src/http/errorHandler.ts` maps `code → status` through a
  total record, formats Valibot issues, and funnels unknowns to a logged 500 that never
  leaks internals. Controllers do not hand-map.
- **Swallows are disciplined**: zero empty `catch {}` blocks in non-test source; the
  best-effort swallows are confined to observability/telemetry/notification paths and each
  is documented ("observability never breaks a dispatch"). The pattern is still repeated by
  hand rather than through a shared `runBestEffort(fn, logger)` helper, and today nothing
  counts the drops (see §7).
- Nice touch: `RunContendedError` is deliberately _not_ a `DomainError` so an
  optimistic-concurrency retry signal can never be serialized to a status code
  (re-verified; still `extends Error`).
- New since the sweep: `SecretCipher.decrypt` now throws a typed `SecretDecryptError` with a
  `reason: 'key-mismatch' | 'corrupt'` discriminator, feeding the key-drift diagnostics in §7.

## 4. Complexity & code-size hygiene: 4/5 (was 3.5, originally 2.5)

The trend the last revision reported ("reversed from accretion to reduction") has held and
compounded: **every file the previous table named is smaller again**, two whole god-files
were dissolved, and the guard rails tightened twice. Largest non-test source files as of
`0c08604` (prior revision's counts in parentheses):

| Lines | File                                                              | Note                                                                                                                               |
| ----- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 2,752 | `orchestration/src/modules/execution/ExecutionService.ts`         | down from 2,802 (originally 3,707)                                                                                                 |
| 2,432 | `orchestration/src/modules/execution/RunDispatcher.ts`            | **down from 3,147** (originally 4,217): step-handler/interceptor/resolver registries extracted to `dispatcher-registries.ts` (683) |
| 2,345 | `runtimes/cloudflare/src/infrastructure/container.ts`             | down from 2,710; candidate #8 (shared container builder) still open                                                                |
| 2,288 | `runtimes/node/src/db/schema.ts`                                  | flat schema declarations: large but not complex                                                                                    |
| 2,259 | `conformance/src/suites/core.ts`                                  | largest slice of the further-split conformance suite (now 17 files: see §5)                                                        |
| 2,247 | `runtimes/node/src/container.ts`                                  | **down from 3,085** (`container-executor-deps.ts` extracted)                                                                       |
| 2,234 | `integrations/src/modules/environments/provision-detect.logic.ts` | the test-infrastructure autodetection engine (#1320)                                                                               |
| 1,822 | `orchestration/src/container.ts`                                  | down from 1,934 (originally 3,081) via the typed `ModuleRegistry`                                                                  |
| 1,592 | `server/src/agents/ContainerAgentExecutor.ts`                     | down from 1,687                                                                                                                    |

- **`contracts/src/entities.ts` is no longer a god-file**: 2,306 → **928**, with the
  run/execution shapes split to `contracts/src/execution.ts` (1,449) and the environment
  shapes to `contracts/src/environments.ts` (1,294). Its file-size allowance was removed
  (it now fits the default budget): the ratchet moving DOWN, exactly as intended.
- **The execution module is now genuinely modular**: `orchestration/src/modules/execution/`
  holds 54 non-test files (~19,000 lines); the doc-named extractions
  (`DeployerStepController`, `RunRepoOpsController`, `PrReviewResolutionController`,
  `FollowUpGateController`, `RunAdmission`, `review-kinds.ts`) plus newer ones
  (`dispatcher-registries.ts` 683, `RunStateMachine.ts` 705, `HumanTestController.ts` 714,
  `ReviewGateController.ts` 672, and ~20 smaller controllers/logic files).
- **The ratchets tightened twice since the last revision** and now operate at three levels:
  `scripts/check-file-size.mjs` (default budget 1,500 lines; 14 ratcheted legacy allowances,
  all current, no stale entries) **now runs in CI's `repo-guards` job**; oxlint
  `max-lines-per-function` went 1000 → 632 → **400** (with the six-then-eight functions above
  each bar split rather than the number raised); and cyclomatic `complexity` went
  60 → 40 → **30** (ten functions split). A `lint-limits-report.mjs` floor-finder supports
  the ratchet initiative (`initiatives/lint-complexity-size-ratchet.md`).
- **Watch item**: several files sit within tens of lines of their allowance
  (`db/schema.ts` 12 under, `FetchGitHubClient.ts` 20 under, `orchestration/container.ts` 28
  under, `RunDispatcher.ts` 85 under); the next feature touching them forces the next split,
  which is the design, but expect that friction.
- What keeps this at 4 rather than higher: the two runtime DI roots (~2,300 lines each)
  remain the enforcement surface of "keep the runtimes symmetric" and are hard to diff;
  `refactoring-candidates.md` #8 (shared container builder) is still the highest-impact open
  structural fix, and `ExecutionService`/`RunDispatcher`, though shrinking, still mix
  responsibilities at ~2,400–2,800 lines.

**Counterweight:** TODO debt is near-zero: 6 TODO/FIXME markers in non-test source, all of
them _content_ (prompt strings, marker-detection patterns), none deferred work. The knip
dead-code baseline is unchanged: the 8 post-extraction `runtimes/cloudflare` files it
ignores are **still on disk** and can now simply be deleted.

## 5. Testing: 4/5

**Strengths: the conformance suite is the repo's standout asset:**

- The cross-runtime conformance suite has been split **again** since the five-group revision:
  now **17 files under `suites/`** (11,954 lines, 252 `it()` blocks, e.g. `core.ts` 2,259,
  `execution-review.ts` 1,204, `execution-tester.ts` 1,168, `integration-environments.ts`
  1,165, with `execution.ts`/`integration.ts` reduced to thin aggregators) plus ~40 focused
  sibling suites. It runs **identically against all three facades** on real infrastructure:
  real D1 inside workerd (Cloudflare), real Postgres (Node and local); the Postgres runtimes
  parallelise each group as its own spec file. This is the mechanism that makes runtime
  symmetry testable rather than aspirational.
- One canonical deterministic `FakeAgentExecutor` (now 788 lines) is shared by conformance
  and e2e, no per-suite fake drift.
- The Playwright e2e suite (now 27 specs, up from 24) covers the assembled product against a
  real Node backend with `failOnFlakyTests: true`: flakes report red by design.
- Sampled "suspiciously critical" flows are in fact tested: retention pruning,
  subscription-activation crypto, sweepers, the spend safeguard.

**Weaknesses:**

- **Coverage measurement is nearly absent.** Exactly one package (`kernel`) configures
  vitest coverage, with a deliberately-low ratchet floor (statements 16%); CI has no
  coverage reporting or gate at all. With 655 spec/test files there is no _data_ on what
  they actually cover.
- **`@cat-factory/contracts` coverage is growing but still thin**: the Valibot wire source
  of truth imported by 133 frontend files and every backend. The backfill initiative
  (`initiatives/contracts-test-backfill.md`) has progressed from one slice to **5 spec files
  / 65 test cases** (`entities`, `primitives`, `reviewFriction` added since the last
  revision), but most of the package is still untested. `provider-cloudflare` and
  `provider-s3` are also untested (and the publish-integrity guard's own comments record
  that provider-s3 once shipped as an empty shell). Thin single-test packages carrying real
  logic: `spend`, `consensus`, `caching`.
- The Redis propagator spec still uses a fake in-memory bus (its own comments say so): the
  real `ioredis` wire path that multi-node production coherence rides on is never exercised.
- e2e is deliberately non-blocking in CI (`test-gate.needs` = worker/units/db/k8s only),
  which means 27 well-built specs currently cannot block a regression.

## 6. CI & repo guardrails: 4/5

**Strengths:** a 17-job pipeline with real infra (sharded workerd + D1, sharded Postgres 18,
conditional k3d), a fail-closed `test-gate` aggregator, and an unusually rich set of bespoke
drift guards: OpenAPI diff, package-catalog completeness, publish integrity (empty-shell +
publint + attw over the packed tarball), runner-image-tag lockstep, changeset presence,
i18n missing-key + locale-parity, `zizmor`/`actionlint` on workflows, pinned action SHAs,
`persist-credentials: false`, the `minimumReleaseAge` supply-chain gate; **and, new since
the last revision, the file-size budget guard** (`check-file-size.mjs` in `repo-guards`),
which closes the "nothing guards code-quality regression" half of the earlier gap list.

**Gaps:**

- **No dependency-vulnerability or SAST scanning of application code.** Unchanged, and now
  the longest-standing untouched recommendation: the only security tooling still scans
  _workflow files_. No `pnpm audit`/OSV, no CodeQL/Semgrep, no secret scanning (e.g.
  gitleaks): notable for a product that handles GitHub tokens, personal subscriptions, and
  sealed credentials.
- **No coverage gate** (see §5).

**Dependency hygiene itself is exemplary** (arguably 5/5 in isolation), and has improved:
the release-age exclude list is now **owned-namespace-only with zero third-party entries**
(the time-boxed nuxt exception the previous revision flagged has aged out and been pruned,
resolving that watch item); load-bearing singleton `overrides` each carry a written
rationale; `allowBuilds` allow-lists instead of blanket trust; and the Vercel AI SDK family
moved to the `ai@7` + `workers-ai-provider@4` pairing as a coordinated sweep. Remaining
watch item: `typescript: 7.0.2` (native tsc) is bleeding-edge for a two-dialect build
graph; worth a deliberate pin-audit per bump.

## 7. Observability: 4/5 (was 3.5)

The story is still **richest at the single-run level**, but that level has moved from
"excellent drill-down" to near-exemplary since the last revision, while the platform-level
gaps (tracing, metrics surface, client error reporting) re-verify as unchanged. The
project's own diagnosis in `initiatives/platform-operator-observability.md` has landed
rollups, an operator dashboard, threshold alerting, and OTLP gauge export; still open there:
per-step/gate attempt stats (needs a queryable gate-attempt projection), the per-deployment
threshold settings UI, and the optional daily rollup table for trends past the telemetry
retention window.

**Strong:**

- **Logging**: one shared workerd-safe pino instance (`server/src/observability/logger.ts`)
  used by every facade; no raw `console.*` in production paths; consistent
  `logger.child({...})` correlation with `workspaceId`/`executionId`/`jobId`.
- **Call telemetry now streams: it survives a dying container.** The harness hands each
  LLM call over as its CLI yields it (`RunnerJobView.callMetrics`, drain-on-read), with the
  terminal result repeating the full list; both channels mint the same idempotent
  `<jobId>-hc-<seq>` row id (`ON CONFLICT(id) DO NOTHING` on both runtimes, deliberately not
  `INSERT OR IGNORE`), so a run whose container is OOM-killed or evicted mid-flight no
  longer reports zero calls: previously exactly the run worth inspecting was the blind one.
  When a container dies mid-run, the poll captures a secret-scrubbed post-mortem, and the
  FIRST death's detail is retained (`step.firstEvictionDetail`) and folded into the final
  failure beside the last one: the recovery no longer destroys the cause of death.
- **Liveness heartbeat**: `RunnerJobView.heartbeatAt` flows through
  `ContainerAgentExecutor.pollJob` onto a throttled `step.lastActivityAt`
  (`ACTIVITY_PERSIST_THROTTLE_MS` = 20s, well under the sweeper lease), so a
  quiet-but-alive job is distinguishable from a wedged one; surfaced in the UI as
  "active Ns ago" (`StepRunMeta.vue`), distinct from the elapsed clock.
- **PR-review observability (ADRs 0026 + 0027, fully landed).** Born from a real 518-file
  review run that looked hung then died with a misleading "container failed to start":
  dispatch failures are now classified against run history (a container lost after N minutes
  of work reports as `evicted after N minutes`, not a start failure); per-slice progress is
  derived from the parent stream + a subagent-transcript watcher (with ADR 0027's three
  defects (wrong watch directory, a gated-off progress fallback, renamed CLI tool events)
  found by a second instrumented run and fixed, every matcher degrading to "no signal"
  rather than throwing); a cold-start watchdog records a structured diagnostic without
  killing the run.
- **Key-drift boot check (ADR 0026 D6.1–D6.3)**: a non-secret HKDF fingerprint of the
  master key is persisted and recompared every boot (Node) / daily (Worker cron), with a
  typed `SecretDecryptError` distinguishing key-mismatch from corruption, a
  `SealedSecretInventory` port, and a per-workspace `key_drift` notification; a
  rotated-key deployment now fails loudly at boot instead of via scattered decrypt errors.
  (Inventory coverage is intentionally partial (~2 of ~15 sealed-secret domains) and the
  ADR documents the surfaced count as a floor.)
- **Agent self-reporting**: every result window now carries the agent's effort
  self-assessment (`PipelineStep.effortReport`: difficulty, obstacles, reduced-effectiveness
  flags; lifted from a harness sentinel file and rendered by the shared
  `ResultWindowShell`), and review steps report per-fragment best-practice adherence
  (`PipelineStep.fragmentAdherence`: a 1–10 rating + assessment per prompt fragment,
  localized in all 10 locales).
- **Telemetry persistence**: symmetric retention pruning on both runtimes; LLM call bodies
  scrubbed **up front** by `redactSecrets` before storage, delta-chaining, or Langfuse
  fan-out; agent-context snapshots stored via a structural field allow-list, double-gated
  (deployment `LLM_RECORD_PROMPTS` + per-workspace `storeAgentContext`), size-budgeted;
  with both prompts, every fragment body, and every injected file's content re-scrubbed
  through `redactSecrets`, the `extras` bag deep-scrubbed, and secret-shaped filenames
  (`.env`/`*.pem`/SSH keys/…) dropped wholesale (`isSecretShapedFilename`). Re-verified
  intact at `0c08604`. The residual best-effort caveat (a novel token shape in an
  ordinarily-named body) stands by design.
- **Health/readiness**: `/health` on both facades, `/ready` on Node (DB ping + pg-boss +
  SIGTERM drain); a misconfigured-boot fallback app; genuinely excellent migration
  failure diagnostics (`migrate.ts` maps pg codes to human causes + recovery commands and
  detects ledger↔schema drift before applying); and now the key-fingerprint boot check above.
- **Per-run UX**: `ObservabilityPanel.vue` gives per-call prompt/response/tokens/timing,
  the full provided context, and LLM-friendly JSON export.

**Weak (all three re-verified unchanged at `0c08604`):**

- **Tracing**: the Langfuse + OTel sinks cover LLM generations and container tool spans
  _only_, and as **sibling spans keyed by `executionId`**; there is still no HTTP
  server-span instrumentation on the Hono app and no W3C `traceparent` propagation across
  the container boundary, so no true end-to-end trace exists.
- **Metrics**: push-only OTLP gauges of per-account run aggregates. No `/metrics` scrape
  endpoint, no pg-boss queue-depth/job-latency instruments, no cache hit/miss counters in
  `@cat-factory/caching`, no HTTP request rate/latency/error metrics.
- **Silent best-effort paths are uncounted**: dropped telemetry batches, failed
  notification deliveries, and oversized snapshots vanish with at most a `warn`; no metric
  counts them, so telemetry completeness is itself unmonitored. Per-run "stuck > 30 min"
  detection remains a known, deliberate gap in the platform-health sweep.
- **Frontend**: no client-side error reporting whatsoever, no global Nuxt error handler,
  no Sentry-style sink; client JS exceptions are invisible to operators.

## 8. Extensibility: 4.5/5

**Strong:**

- A genuine, consistent plugin-registry culture: agent kinds, gates, pipelines, VCS
  providers, step resolvers, task types, runner backends, environment backends,
  observability adapters, notification channels, model providers, prompt fragments,
  frontend app modules. The worked example (`backend/internal/example-custom-agent`) proves
  a repo-writing agent + custom gate + pipelines ship through public seams with zero harness
  changes, and the harness serves a **single manifest-driven kind**: the "zero
  `switch(agentKind)` in the container" principle is actually achieved.
- **The consumer frontend-extension mechanism is now real and dogfooded**
  (`initiatives/frontend-extension-mechanism.md`, new since the last revision: slices A, B,
  and D landed): a worked consumer module ships inside `deploy/frontend`
  (`acme-security.ts` + three components) with an authoring guide
  (`frontend/app/app/docs/consumer-extensions.md`) and an e2e spec; consumers can now
  contribute **custom task types** (a kernel `TaskTypeRegistry` + the `taskTypes` slot) and
  **top-level overlays** (the `appOverlays` slot + `AppOverlayHost`) alongside the earlier
  nav items, result views, wizard journeys, and inspector panels. Custom prompt fragments
  can register as per-task-type defaults (#1307), and test-infrastructure providers gained
  an autodetection API (#1320). Slices C/E/F/G remain.
- Model-provider composition (`CompositeModelProvider` + opt-in `provider-*` packages) is
  the reference pattern; runner transports are fully port-driven and symmetric across all
  three facades.
- The registry-DI migration is **nearly complete** per its own tracker: every module-global
  registry is app-owned DI (`PipelineRegistry`, `VcsProviderRegistry`, `ProviderRegistry`,
  traits folded onto `AgentKindRegistry`, gates + step resolvers earlier). The only
  remainder is cosmetic: the observability-adapter record
  (`integrations/src/modules/observability/registry.ts`) is app-owned in shape but not yet a
  `*Registry` class. The tracker is conversion-ready for its ADR.
- The notification composite now carries a second real channel: `SlackNotificationChannel`
  landed beside the in-app channel, proving the `CompositeNotificationChannel` seam with an
  actual external delivery path.

**Gaps:**

- **The built-in-agent strangler has since FINISHED** (recorded here rather than rewritten,
  since this document is a point-in-time review): the seven orchestration-id built-ins in
  `buildMigratedBuiltInBody`'s switch (`ci-fixer`/`fixer`/`conflict-resolver`/`merger`/
  `on-call`/`tester`/`ui-tester`) are registrations, as are the read-only and producer kinds
  that used to fall through it, and the `toRunResult` coercion chain is one registry lookup.
  What remains from this gap is the merger resolver, still built inline rather than via
  `registerStepResolver`. As reviewed, two parallel prompt/result
  mechanisms coexisted (matched `refactoring-candidates.md` #5). (The bespoke _harness_
  handlers were already gone: every built-in synthesizes an `AgentStepSpec` through the one
  generic body path; the remaining work is folding the two backend switches into registry
  lookups.)
- **`github-client.ts` is a 773-line god-interface (up from 724)** (~62 methods) that
  every VCS provider is adapted _into_ (GitLab implements the neutral `VcsClient` and is
  then re-shaped through `vcsBackedGitHubClient`). It is growing, not shrinking; a third
  provider inherits the GitHub-shaped impedance mismatch. Splitting it into cohesive
  sub-ports remains the highest-leverage move for true VCS neutrality.
- **Email is still a seam, not a channel**: `EmailSender` + SendGrid/Resend adapters exist
  and serve invitations/password reset, but no `EmailNotificationChannel` rides the
  composite (tracker status: "planned, no slices landed"). The Slack channel landing makes
  this the one notification path that exists as infrastructure but not as a channel.

## 9. Frontend quality: 3.5/5

- **Wire-type safety is the right architecture**: 133 files import from
  `@cat-factory/contracts` (plus 71 via the `types/domain` re-export); `app/types/domain.ts`
  re-exports contracts and adds only genuinely frontend-only types. (Undercut by contracts
  itself being thinly tested, §5.)
- **Stores are healthy**: 72 store modules under `app/stores` (the earlier revision's "29"
  materially undercounted the current tree), no god-store, 22 store specs; the monotonic
  `refreshSeq` guard in `stores/workspace.ts` (the fix for the documented live-push clobber
  class of bugs) is real and pinned by unit tests.
- **i18n adoption holds at ~94%**: 187/198 components reference `useI18n`, 10 locales, a
  5,284-line `en.json`, and four tiers of drift guards wired into blocking CI.
- **God-components regressed**: now **five** exceed 1,000 lines, not four;
  `AddTaskModal.vue` grew 1,191 → **1,442** (absorbing the custom-task-type form work) and
  `FragmentLibraryManager.vue` crossed the line at 1,015, alongside
  `RequirementsReviewWindow.vue` (1,175), `PipelineBuilder.vue` (1,150), and
  `ServiceTestConfig.vue` (1,080). (`InspectorPanel.vue` remains the counter-example at 576
  after its slice-4 panel-group conversion: the pattern the five should follow.) Unlike the
  backend (§4), no ratchet stops a Vue component regrowing.
- **Accessibility is thin, though primitives are emerging**: ~23% of components carry any
  aria/role/tabindex (the proportion _fell_ as the component count grew); `aria-live` ×3;
  no axe/a11y assertions in the e2e suite. On the plus side: focus containment is handled
  at the shell level (`ResultWindowShell`, `AppOverlayHost`, `ConfirmDialog`; 11 files with
  focus-trap patterns), shared a11y-conscious primitives landed (`IconButton`, `EmptyState`,
  `SecretInput`), and `prefers-reduced-motion` is honored.
- **No client-side error reporting** (§7): the WebSocket-disconnect half of the earlier
  recommendation is now resolved (see §11), but client exceptions remain invisible.

## 10. Documentation & self-governance: 4.5/5

This repo's most unusual trait: it audits itself, and honestly.

- 27 ADRs (0026/0027 added since the last revision), 52 initiative trackers with per-slice
  checklists, per-package `AGENTS.md` orientation maps, a glossary, an
  execution-state-machine reference, prior race-condition and system audits with
  confirmed/addressed statuses, and a candid `refactoring-candidates.md`. Most findings in
  this review were _already known_ to the project: the meta-signal is strongly positive.
- **Staleness debits** (the flip side of carrying this much documentation; one from the
  previous revision is fixed, the rest re-verify):
  - `backend/docs/custom-agents.md`'s registration sample is **fixed** (it now shows the
    injected-registry `agentKindRegistry.register({...})` API), but its **Status section is
    still stale**; it claims built-in rendering "still lives in the executor-harness",
    which `jobBody.ts` disproves (every built-in synthesizes an `AgentStepSpec` through the
    generic body path).
  - `CLAUDE.md`'s i18n claim ("most components still hold inline strings") still materially
    understates reality (~94% adoption).
  - `refactoring-candidates.md`'s line counts have drifted **further**: it lists
    `jobBody.ts` at 440 (actual 950), `containerAgentResult.ts` at 285 (actual 372),
    `ContainerAgentExecutor.ts` at 975 (actual 1,592). The drift is evidence for that doc's
    thesis, and item #15 already asks for the refresh.
  - 52 open initiative trackers is a lot of in-flight state (up from 46). The two most
    conversion-ready per the repo's own tracker→ADR rule: **modular-vue adoption** (slices
    0–5 all landed) and **registry-DI migration** (every registry migrated; only the
    cosmetic observability-record normalisation remains, and the tracker itself says to
    convert when it lands).

## 11. Usability: 4/5 (new axis, added 2026-07-24)

How usable is the product itself: for the end user driving the board, and for the
operator standing it up? The verdict: **unusually strong on feedback and error recovery,
deliberately invested (five active UX initiative trackers), with accessibility and mobile
as the two structural gaps.**

**Strong:**

- **Actionable error feedback is best-in-class.** The backend tags every conflict with a
  machine-readable `ConflictReason`; `usePipelineErrorToast.ts` maps each to a localized
  title + description through an **exhaustive `Record` over the union** (a new backend
  reason fails typecheck until mapped), and the high-value reasons carry a one-click
  "jump to the panel that fixes it" deep-link (Configure AI, Connect GitHub, Choose model,
  Configure infrastructure) rendered as a sticky toast so the remedy doesn't auto-dismiss.
  Raw backend prose is only a last-resort fallback, never client-translated. The
  `error-message-coverage` initiative drove this across all locales.
- **Degraded states are visible, not silent.** `useWorkspaceStream` tracks
  connected/failed states with exponential-backoff reconnect + resync, and
  `ConnectionStatusBanner.vue` renders an amber "reconnecting" (debounced 1.5s to ride out
  flaps) and a rose "offline" state, both `role="status" aria-live="polite"`. This resolves
  the "silent WebSocket close" gap the previous revision listed as an open recommendation.
- **Failures are discoverable and recoverable.** The shared `AgentFailureCard` gives any
  failed agent run (bootstrap or execution) a uniform banner with the backend's actionable
  message, a doc link, a configure deep-link where relevant, and a one-click retry (with an
  in-flight guard, permission-gated): surfaced on the board card, the inspector, and the
  run view alike, with failure history alongside. The notifications inbox carries typed
  actions (merge / confirm / retry / reveal-the-window) rather than dead-end alerts.
- **Long-running agent work reads as alive.** Live-pushed subtask progress bars, the
  "active Ns ago" heartbeat label (distinct from elapsed time, §7), and per-agent effort
  reports in every result window give the human real signal during multi-minute runs:
  the exact surface ADR 0026 hardened after a run that _looked_ hung.
- **Operator onboarding is genuinely polished.** `cat-factory init` generates all three
  crypto secrets in their exact required formats, opens the browser at the provider's
  token-creation page with **scopes pre-selected** (GitHub `repo,workflow` / GitLab `api`),
  writes populated `.env` files for backend + frontend, and creates/merges `.gitignore` so
  secrets can't be committed: with execution-mode tradeoffs printed and optional settings
  left as commented hints. The docs form a coherent getting-started path (user-facing root
  README → `cat-factory init` → per-target `deploy/*` guides).
- **Loading/empty states are the norm, not the exception**: 118 components handle
  loading/pending and 107 carry empty-state copy; the board's empty state explicitly
  invites the first action ("an empty board reads as broken"), and a shared `EmptyState`
  primitive exists. Sustained investment is visible in the trackers: `ux-papercuts` (the
  undo/confirmation, clipboard, async-state, and a11y clusters all landed), `ux-qol-pass`,
  `global-search-and-deep-links`.

**Weak:**

- **Accessibility is the biggest usability debt** (shared with §9): ~23% of components
  carry any a11y attributes, `aria-live` ×3 on a canvas-heavy UI, keyboard handling
  concentrated in 13 files, and (critically) **zero automated a11y verification** (no axe
  assertions in e2e), so regressions are invisible. The a11y work that landed (primitives,
  focus traps, reduced-motion) lives inside `ux-papercuts` rather than a dedicated tracked
  surface.
- **Mobile is design-only**: `initiatives/mobile-friendly-frontend.md` analyzes the
  monitor-and-decide loop on phones, but nothing is implemented; the spatial board is
  desktop-only today.
- Smaller nits: the `EmptyState` primitive is adopted in only 5 places so far; in-app
  first-run guidance is limited to the board empty state (no tour; fine for a developer
  tool, but the gap between the polished CLI onboarding and the in-app first-run is
  noticeable); the notifications inbox's "empty" state is a hidden bell rather than an
  explicit "all caught up".

---

## Main areas for improvement (prioritized)

Ordered by leverage (impact relative to effort). Items marked ↗ already have a tracker or
candidate entry: the recommendation is to prioritize them, not to re-plan them.

| #   | Area            | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Impact | Effort  |
| --- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------- |
| 1   | Security/CI     | Add dependency-vulnerability + SAST + secret scanning to CI (`pnpm audit`/OSV, CodeQL or Semgrep, gitleaks). Today only workflow files are scanned. **Unchanged through two revisions: now the longest-standing untouched recommendation in this review.**                                                                                                                                                                                                                                                                                                 | High   | Low     |
| 2   | Observability   | ✅ **Done**: `AgentContextObservabilityService.record` runs `redactSecrets` over both prompts + `fragments[].body` + `contextFiles[].content`, and drops secret-shaped file bodies (`isSecretShapedFilename`). Re-verified intact at `0c08604`.                                                                                                                                                                                                                                                                                                            | High   | Low     |
| 3   | Testing         | Enable vitest coverage reporting in the CI test lanes and ratchet-floor the high-value packages (`orchestration`, `server`, `contracts`, `spend`); 🟡 **in progress**: `contracts` is up to 5 spec files / 65 cases (entities, primitives, review-friction added); continue the `contracts-test-backfill` initiative. The CI coverage gate itself has not moved.                                                                                                                                                                                           | High   | Low–Med |
| 4   | Observability   | Add an operational metrics surface: pg-boss queue depth + job latency, `AppCaches` hit/miss counters, HTTP request rate/latency, and a counter for dropped telemetry/notification batches. Either a `/metrics` scrape endpoint or documented OTLP-only. Also finish the platform-observability remainders: per-step/gate attempt stats, the threshold settings UI, the optional daily rollup table.                                                                                                                                                        | High   | Medium  |
| 5   | Complexity ↗    | ✅ **Done and compounding**: beyond the engine/composition-root/conformance splits, this revision adds: `entities.ts` dissolved (2,306 → 928 + two focused modules), `RunDispatcher` 3,147 → 2,432 (`dispatcher-registries.ts`), node container 3,085 → 2,247, `max-lines-per-function` ratcheted to 400 and `complexity` to 30 (functions split, never numbers raised), and `check-file-size.mjs` wired into CI. Remaining open: candidate #8 (shared container builder for the two runtime DI roots); delete the 8 dead knip-baselined cloudflare files. | High   | Medium  |
| 6   | Extensibility ↗ | ✅ **Done**: every module-global registry is app-owned DI; only the cosmetic observability-adapter record normalisation remains. The tracker is now [ADR 0028](../../backend/docs/adr/0028-registry-di.md).                                                                                                                                                                                                                                                                                                                                                | High   | Medium  |
| 7   | Code quality    | ✅ **Done**: `TaskRepository.listByRefs` (chunked-`IN` batch read, D1 ⇄ Drizzle + conformance assertion) replaced the N+1 in `AgentContextBuilder`.                                                                                                                                                                                                                                                                                                                                                                                                        | Medium | Low     |
| 8   | Observability   | Distributed tracing: HTTP server spans on the shared Hono app + `traceparent` propagation into the container job body. Partly closed since: a settled run now emits a root span plus per-agent-kind step spans, so generations and tool spans hang under their step rather than sitting as siblings, and the HTTP boundary reads an inbound `traceparent` onto its log lines. The two items named here are re-verified still absent.                                                                                                                       | Medium | Medium  |
| 9   | Frontend        | 🟡 **Half done**: the WebSocket degraded-state indicator landed (`ConnectionStatusBanner`: reconnecting/offline states, backoff + resync). Still open: a global Nuxt error handler reporting client exceptions to a backend sink; client JS errors remain invisible to operators.                                                                                                                                                                                                                                                                          | Medium | Low     |
| 10  | Extensibility ↗ | ✅ **Done**: every built-in container kind is a `registerAgentKind` entry, so `buildMigratedBuiltInBody`'s switch and the `toRunResult` coercion chain are both deleted (one registry lookup each), and the hard-coded `CONTAINER_AGENT_KINDS` / multi-repo fan-out Sets are gone with them. The blocker was the seam: a kind's `userPrompt` now receives an `AgentDispatchContext` (base/work branch, multi-repo), which is what let the branch-naming prompts move. Still open: move the inline merger resolver to `registerStepResolver`.               | Medium | Medium  |
| 11  | Extensibility   | Split the `github-client.ts` god-interface (now 773 lines / ~62 methods: it grew) into cohesive sub-ports (repos, PRs, issues, CI, git-data) so VCS providers implement neutral slices instead of adapting into the GitHub shape.                                                                                                                                                                                                                                                                                                                          | Medium | High    |
| 12  | Usability       | Automate accessibility: axe assertions in a couple of e2e specs + a keyboard-nav pass on board/modals, and broaden `EmptyState`/`IconButton` primitive adoption. The manual a11y wins (focus traps, reduced-motion, labeled icon buttons) need a regression guard to stick.                                                                                                                                                                                                                                                                                | Medium | Low–Med |
| 13  | Testing         | Exercise the real Redis path for `RedisWebSocketPropagator` (a Redis service container in the `test-db` lane); promote e2e (now 27 specs) into `test-gate.needs` once flake-trust is earned.                                                                                                                                                                                                                                                                                                                                                               | Medium | Low–Med |
| 14  | Frontend        | Decompose the five >1,000-line components (`AddTaskModal`: now 1,442 and growing, `RequirementsReviewWindow`, `PipelineBuilder`, `ServiceTestConfig`, and newcomer `FragmentLibraryManager`) following the slice-4 `InspectorPanel` precedent, and consider a frontend file-size ratchet, since nothing currently stops a Vue component regrowing the way `check-file-size.mjs` stops backend files.                                                                                                                                                       | Medium | Medium  |
| 15  | Lint            | Enable oxlint `suspicious` (and selectively `restriction`: `no-explicit-any`, `no-non-null-assertion`) at least as warn; the size/complexity ratchets landed, but the `any` discipline itself is still convention-only.                                                                                                                                                                                                                                                                                                                                    | Medium | Low     |
| 16  | Docs            | Staleness sweep: fix `custom-agents.md`'s Status section (the sample itself is fixed now), the `CLAUDE.md` i18n claim, and `refactoring-candidates.md`'s line counts (drifted further; `jobBody.ts` 440 → actual 950); convert the modular-vue and registry-DI trackers to ADRs (52 open trackers and counting).                                                                                                                                                                                                                                           | Low    | Low     |
| 17  | Extensibility ↗ | Land the `EmailNotificationChannel` (port + adapters + composite already exist, and the Slack channel just proved the seam; only the glue and per-user prefs are missing).                                                                                                                                                                                                                                                                                                                                                                                 | Low    | Low     |

### What NOT to change

Worth stating explicitly, because these are deliberate choices that a naive audit might
flag: the best-effort telemetry swallows (observability must never break the product; the
fix is _counting_ drops, not throwing), the D1 ⇄ Drizzle repository duplication (inherent
to two dialects; the mitigation is the conformance suite + the planned shared base
repositories, not premature abstraction), the Worker's lack of `/ready` (stateless
isolates), the non-`DomainError` `RunContendedError`, the e2e suite's
fail-on-flaky-but-non-blocking posture while it earns trust, the throttled (not per-poll)
heartbeat persistence, and the intentionally-partial sealed-secret inventory (a documented
floor, not a bug).
