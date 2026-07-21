# @cat-factory/observability-otel

## 0.2.29

### Patch Changes

- Updated dependencies [916278b]
  - @cat-factory/contracts@0.155.0
  - @cat-factory/kernel@0.149.0

## 0.2.28

### Patch Changes

- Updated dependencies [1bcb223]
  - @cat-factory/kernel@0.148.5

## 0.2.27

### Patch Changes

- Updated dependencies [91ea6b7]
  - @cat-factory/contracts@0.154.2
  - @cat-factory/kernel@0.148.4

## 0.2.26

### Patch Changes

- Updated dependencies [3999941]
  - @cat-factory/kernel@0.148.3

## 0.2.25

### Patch Changes

- Updated dependencies [021f2a0]
- Updated dependencies [021f2a0]
  - @cat-factory/contracts@0.154.1
  - @cat-factory/kernel@0.148.2

## 0.2.24

### Patch Changes

- Updated dependencies [a14fe03]
  - @cat-factory/contracts@0.154.0
  - @cat-factory/kernel@0.148.1

## 0.2.23

### Patch Changes

- Updated dependencies [8053837]
  - @cat-factory/contracts@0.153.0
  - @cat-factory/kernel@0.148.0

## 0.2.22

### Patch Changes

- Updated dependencies [511076d]
  - @cat-factory/kernel@0.147.3

## 0.2.21

### Patch Changes

- Updated dependencies [7f54858]
  - @cat-factory/contracts@0.152.2
  - @cat-factory/kernel@0.147.2

## 0.2.20

### Patch Changes

- 492d0a2: Lint ratchet: complete `max-depth` (5 → 4, its final target; no behavioural change).

  Refactored the 18 depth-5 sites down to ≤ 4 by hoisting the innermost loop bodies into
  helpers along cohesive seams:

  - Extract a shared `parseSubtasks` into `@cat-factory/kernel` (`domain/subtasks.logic.ts`)
    and replace the four duplicated row→domain copies in the D1 and Drizzle bootstrap /
    env-config-repair repositories (removing the 4× duplication as well as the depth).
  - Split the two Worker `ExecutionWorkflow` poll loops (`drivePollLoop` / `driveGatePollLoop`
    - a shared `pollOnce`), the benchmark harness's per-task fixture dispatch, the seed-dump
      child scan and the env-config bootstrap commit/PR path in `@cat-factory/integrations`, the
      Workers-AI assistant tool-call conversion, and the OTEL conformity metric fold into helpers.
  - Lower `max-depth` to `4` in `.oxlintrc.json`.

- Updated dependencies [492d0a2]
  - @cat-factory/kernel@0.147.1

## 0.2.19

### Patch Changes

- 2d97b16: First pass on the oxlint complexity/size ratchet (no behavioural change):

  - Tighten the free size ceilings now that the conformance god-file split dropped their floors:
    `max-lines` 3119 → 2802 and `max-lines-per-function` 3103 → 2453.
  - Complete `max-nested-callbacks` (6 → 4, its final target) by extracting the spec-id flatMap
    chain in `render.test.ts` into a helper.
  - Lower `max-depth` 6 → 5 by extracting the per-metric fold in the OTEL conformity test and the
    per-target recommendation application in `RequirementReviewService` (`applyRecommendationToTarget`)
    out of their deeply-nested loops.
  - Add `scripts/lint-limits-report.mjs`, a floor-finder that reports each ratcheted rule's live
    ceiling, actual floor, and top offenders to plan subsequent slices.

## 0.2.18

### Patch Changes

- Updated dependencies [a10bfdf]
  - @cat-factory/kernel@0.147.0

## 0.2.17

### Patch Changes

- Updated dependencies [f2b25ba]
  - @cat-factory/kernel@0.146.0
  - @cat-factory/contracts@0.152.1

## 0.2.16

### Patch Changes

- Updated dependencies [e679977]
  - @cat-factory/contracts@0.152.0
  - @cat-factory/kernel@0.145.1

## 0.2.15

### Patch Changes

- Updated dependencies [9450415]
  - @cat-factory/contracts@0.151.0
  - @cat-factory/kernel@0.145.0

## 0.2.14

### Patch Changes

- Updated dependencies [54c44bb]
  - @cat-factory/contracts@0.150.0
  - @cat-factory/kernel@0.144.0

## 0.2.13

### Patch Changes

- Updated dependencies [0abcf31]
- Updated dependencies [6709dc4]
- Updated dependencies [a53bbf7]
  - @cat-factory/contracts@0.149.0
  - @cat-factory/kernel@0.143.0

## 0.2.12

### Patch Changes

- Updated dependencies [5771e05]
  - @cat-factory/kernel@0.142.0

## 0.2.11

### Patch Changes

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0

## 0.2.10

### Patch Changes

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1

## 0.2.9

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0
  - @cat-factory/contracts@0.148.1

## 0.2.8

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
  - @cat-factory/kernel@0.139.3

## 0.2.7

### Patch Changes

- Updated dependencies [1f5f5bc]
  - @cat-factory/contracts@0.148.0
  - @cat-factory/kernel@0.139.2

## 0.2.6

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/contracts@0.147.1
  - @cat-factory/kernel@0.139.1

## 0.2.5

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/contracts@0.147.0
  - @cat-factory/kernel@0.139.0

## 0.2.4

### Patch Changes

- Updated dependencies [60c0a1e]
  - @cat-factory/contracts@0.146.0
  - @cat-factory/kernel@0.138.1

## 0.2.3

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/contracts@0.145.0
  - @cat-factory/kernel@0.138.0

## 0.2.2

### Patch Changes

- Updated dependencies [5924903]
  - @cat-factory/contracts@0.144.0
  - @cat-factory/kernel@0.137.1

## 0.2.1

### Patch Changes

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0

## 0.2.0

### Minor Changes

- 27f0ea2: Expose the deployment-level (platform-operator) observability aggregates via OpenTelemetry.

  A periodic, runtime-symmetric sweep (Worker `scheduled` cron ⇄ Node interval, like the
  retention sweeps) now pushes the same run-health projection the operator dashboard renders —
  run outcomes by status, the failure-kind taxonomy, live/parked depth, and the avg/min/max +
  p50/p90/p99 duration percentiles — to any OTLP/HTTP backend as OpenTelemetry **gauge**
  metrics (`cat_factory.platform.*`), per account (the bounded tenant scope) and stamped with
  the projection's `generatedAt`. The OTel backend builds trends from the gauge series, so the
  sweep exports the shortest trailing window (`1h` default).

  `@cat-factory/observability-otel` gains a fetch-based `PlatformMetricsOtelExporter`
  (`createPlatformMetricsOtelExporter`) — the workerd-safe transport used on BOTH runtimes
  (the platform push is a stateless snapshot POST, so it needs no SDK, mirroring the Langfuse
  sink's fetch-on-both shape). The runtime-neutral `sweepPlatformMetrics` driver + the
  `distinctAccountIds` account enumeration live in `@cat-factory/orchestration`.

  Opt-in on top of the base OTel exporter (it adds recurring DB rollup load): off unless
  `OTEL_ENABLED=true` + an endpoint AND `OTEL_PLATFORM_METRICS=true`. `OTEL_PLATFORM_METRICS_WINDOW`
  (`1h`/`24h`/`7d`) and, on Node, `OTEL_PLATFORM_METRICS_INTERVAL_MS` tune it. A deployment
  that hasn't opted in emits nothing and runs no sweep.

## 0.1.12

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/kernel@0.136.0

## 0.1.11

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0

## 0.1.10

### Patch Changes

- @cat-factory/kernel@0.134.1

## 0.1.9

### Patch Changes

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/kernel@0.134.0

## 0.1.8

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0

## 0.1.7

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/kernel@0.132.0

## 0.1.6

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/kernel@0.131.0

## 0.1.5

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/kernel@0.130.0

## 0.1.4

### Patch Changes

- @cat-factory/kernel@0.129.2

## 0.1.3

### Patch Changes

- Updated dependencies [6108525]
  - @cat-factory/kernel@0.129.1

## 0.1.2

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/kernel@0.129.0

## 0.1.1

### Patch Changes

- @cat-factory/kernel@0.128.1

## 0.1.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0
