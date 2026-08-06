# @cat-factory/observability-langfuse

## 0.10.15

### Patch Changes

- Updated dependencies [e7e27ee]
  - @cat-factory/kernel@0.248.0

## 0.10.14

### Patch Changes

- Updated dependencies [53cd697]
  - @cat-factory/kernel@0.247.0

## 0.10.13

### Patch Changes

- Updated dependencies [6d3f784]
  - @cat-factory/kernel@0.246.0

## 0.10.12

### Patch Changes

- Updated dependencies [0937581]
- Updated dependencies [250b7dc]
  - @cat-factory/kernel@0.245.0

## 0.10.11

### Patch Changes

- Updated dependencies [ec96387]
- Updated dependencies [7f5ed08]
- Updated dependencies [4e4d1b4]
  - @cat-factory/kernel@0.244.0

## 0.10.10

### Patch Changes

- @cat-factory/kernel@0.243.1

## 0.10.9

### Patch Changes

- Updated dependencies [d69115d]
  - @cat-factory/kernel@0.243.0

## 0.10.8

### Patch Changes

- Updated dependencies [f775c1d]
- Updated dependencies [3857ea4]
  - @cat-factory/kernel@0.242.0

## 0.10.7

### Patch Changes

- 7cf3e70: Refresh the dependency tree and re-roll both runner images.

  **Registry deps** (direct ranges plus a full lockfile re-resolution, so transitives move to the newest
  release each declared range already admits):

  - **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.47 → ^7.0.51`,
    `@ai-sdk/anthropic`/`@ai-sdk/openai@^4.0.27 → ^4.0.29`, `@ai-sdk/openai-compatible@^3.0.20 → ^3.0.22`,
    `@ai-sdk/provider@^4.0.4 → ^4.0.5`, `@ai-sdk/amazon-bedrock@^5.0.40 → ^5.0.42`.
  - **Runtime deps**: `hono@^4.12.33 → ^4.13.0`, `@hono/node-server@^2.0.12 → ^2.1.0`,
    `pg-boss@^12.26.4 → ^12.27.0`, `undici@^8.9.0 → ^8.10.0`, `ws@^8.21.1 → ^8.21.2`,
    `@aws-sdk/client-s3@^3.1101.0 → ^3.1102.0`, `nuxt@^4.5.0 → ^4.5.1`.
  - **Tooling**: `oxlint@^1.76.0 → ^1.77.0`, `oxfmt@^0.61.0 → ^0.62.0`, `publint@^0.3.22 → ^0.3.23`,
    `vitest@^4.1.8 → ^4.1.10`, `@cloudflare/workers-types@^5.20260801.1 → ^5.20260804.1`.

  **Runner images** (`@cat-factory/executor-harness` 1.92.1, `@cat-factory/deploy-harness` 0.2.10, with
  all six pinned tags synced):

  - Executor: Claude Code `2.1.220 → 2.1.221`, and the two lockstep Pi extensions
    `rpiv-todo`/`rpiv-web-tools` `2.3.1 → 2.4.0`. Pi stays at `0.83.0` and Codex at `0.146.0`, both
    already the latest. Claude Code `2.1.222` exists but was published inside the release-age window, so
    `2.1.221` is the newest version the supply-chain rule admits.
  - Deploy: `kubectl v1.36.3`, `helm v4.2.3` and `kustomize v5.8.1` are all already the latest, so the
    image moves only for the base re-pin below.
  - Both: the `node:26-trixie-slim` base re-pinned to the current multi-arch index digest.

  No `minimumReleaseAgeExclude` entries were added: every version above already satisfies the gate.

  **Majors**: none were available this sweep except `typescript@6 → 7` for the frontend, which stays on 6
  for the same reason as last time. `vue-tsc@3.3.9` still resolves its compiler through
  `require.resolve('typescript/lib/tsc')`, and TypeScript 7's `exports` map publishes no such entry, so
  the frontend typecheck would fail to resolve at all.

- Updated dependencies [7cf3e70]
  - @cat-factory/kernel@0.241.1

## 0.10.6

### Patch Changes

- Updated dependencies [e7867db]
  - @cat-factory/kernel@0.241.0

## 0.10.5

### Patch Changes

- Updated dependencies [c5a1a16]
  - @cat-factory/kernel@0.240.0

## 0.10.4

### Patch Changes

- Updated dependencies [289b3de]
- Updated dependencies [dd90c1e]
- Updated dependencies [dd90c1e]
  - @cat-factory/kernel@0.239.0

## 0.10.3

### Patch Changes

- Updated dependencies [4e5640d]
- Updated dependencies [a675c63]
  - @cat-factory/kernel@0.238.0

## 0.10.2

### Patch Changes

- Updated dependencies [2c7d17d]
- Updated dependencies [aa62acf]
  - @cat-factory/kernel@0.237.0

## 0.10.1

### Patch Changes

- @cat-factory/kernel@0.236.1

## 0.10.0

### Minor Changes

- c9c1dd3: Persist an agent's tool calls as a first-class trajectory: one row per invocation, in the order it
  made them, carrying the tool's arguments and result. The evidence standard for a merged PR is
  "how, not just the diff", and until now the tool loop survived a run only as metadata spans a
  trace sink had to be wired to see, so reconstructing what an agent actually did meant diffing
  consecutive prompt bodies against each other.

  The fourth telemetry sink (`agent_tool_calls`), beside the per-call cost rows and the dispatch
  context snapshots, in the same store and on the same retention window: D1 on Cloudflare, the
  `telemetry` Postgres schema on Node, `node:sqlite` on a mothership-mode node, with the same
  cross-runtime conformance assertions and the same local-first routing as its siblings. Readable
  through a new `GET /api/v1/debug/runs/:runId/tool-calls` (additive; the spec's `info.version`
  takes a minor and the four SDK clients plus the MCP facade gain the operation), and exported on
  the OTel and Langfuse tool spans alongside the dispatch and ordinal a trajectory orders by.

  The endpoint serves two orders, because the order is the product and a client cannot derive it
  from the rows: `recent` is the newest-first keyset every sibling debug list shares, and
  `order=trajectory` is the run's calls oldest-first as the agents made them, a bounded prefix that
  issues no cursor (pairing one with it is refused rather than quietly served in the other order).
  Both narrow to a single dispatch with `jobId`. The server orders by when each call STARTED, with
  `seq` separating the calls that share a millisecond: sorting by the job id instead would order a
  run's dispatches by agent-kind spelling and its re-runs `-10` before `-2`.

  Both harnesses produce it: the Pi runner pairs each `tool_execution_start` with its end, and the
  claude-code runner pairs each `tool_use` block with the `tool_result` that answers it — the CLI's
  own stream being the only place a subscription run's tool loop is visible at all. Bodies are
  capped and secret-scrubbed at capture, and ride the same `LLM_RECORD_PROMPTS` +
  `storeAgentContext` double gate as every other captured body; a withheld body is recorded AS
  withheld, so an opted-out workspace's trajectory never reads as a run whose every tool took no
  arguments.

  Breaks nothing, retains nothing new by default beyond a run's tool metadata, and requires the
  `1.91.0` runner image (an older image's calls still reach the trace sinks; their trajectory is
  skipped rather than persisted under colliding ids, and the skip is logged).

### Patch Changes

- Updated dependencies [c9c1dd3]
  - @cat-factory/kernel@0.236.0

## 0.9.68

### Patch Changes

- Updated dependencies [6b9f696]
  - @cat-factory/kernel@0.235.1

## 0.9.67

### Patch Changes

- Updated dependencies [cec0c3e]
  - @cat-factory/kernel@0.235.0

## 0.9.66

### Patch Changes

- @cat-factory/kernel@0.234.2

## 0.9.65

### Patch Changes

- @cat-factory/kernel@0.234.1

## 0.9.64

### Patch Changes

- Updated dependencies [937d4af]
  - @cat-factory/kernel@0.234.0

## 0.9.63

### Patch Changes

- Updated dependencies [2580fee]
- Updated dependencies [eb4ca17]
  - @cat-factory/kernel@0.233.0

## 0.9.62

### Patch Changes

- Updated dependencies [1f14793]
- Updated dependencies [2619d79]
  - @cat-factory/kernel@0.232.0

## 0.9.61

### Patch Changes

- Updated dependencies [e7e4404]
  - @cat-factory/kernel@0.231.0

## 0.9.60

### Patch Changes

- Updated dependencies [10e0341]
- Updated dependencies [10e0341]
  - @cat-factory/kernel@0.230.0

## 0.9.59

### Patch Changes

- Updated dependencies [fccb1df]
  - @cat-factory/kernel@0.229.0

## 0.9.58

### Patch Changes

- @cat-factory/kernel@0.228.1

## 0.9.57

### Patch Changes

- Updated dependencies [43fd5c0]
  - @cat-factory/kernel@0.228.0

## 0.9.56

### Patch Changes

- Updated dependencies [0456066]
  - @cat-factory/kernel@0.227.0

## 0.9.55

### Patch Changes

- Updated dependencies [f1a6cb3]
- Updated dependencies [cc17221]
- Updated dependencies [889a497]
- Updated dependencies [3605630]
  - @cat-factory/kernel@0.226.0

## 0.9.54

### Patch Changes

- Updated dependencies [36b1853]
  - @cat-factory/kernel@0.225.0

## 0.9.53

### Patch Changes

- Updated dependencies [413095f]
  - @cat-factory/kernel@0.224.0

## 0.9.52

### Patch Changes

- Updated dependencies [04e44f8]
  - @cat-factory/kernel@0.223.0

## 0.9.51

### Patch Changes

- Updated dependencies [c8ba2cd]
- Updated dependencies [807e442]
- Updated dependencies [175f78f]
- Updated dependencies [807e442]
  - @cat-factory/kernel@0.222.0

## 0.9.50

### Patch Changes

- Updated dependencies [1106c93]
  - @cat-factory/kernel@0.221.1

## 0.9.49

### Patch Changes

- Updated dependencies [3b88f66]
  - @cat-factory/kernel@0.221.0

## 0.9.48

### Patch Changes

- Updated dependencies [7f86f07]
  - @cat-factory/kernel@0.220.0

## 0.9.47

### Patch Changes

- Updated dependencies [87161e8]
  - @cat-factory/kernel@0.219.0

## 0.9.46

### Patch Changes

- Updated dependencies [96ad850]
- Updated dependencies [96ad850]
  - @cat-factory/kernel@0.218.0

## 0.9.45

### Patch Changes

- Updated dependencies [4c26c01]
  - @cat-factory/kernel@0.217.0

## 0.9.44

### Patch Changes

- Updated dependencies [924c6f9]
  - @cat-factory/kernel@0.216.0

## 0.9.43

### Patch Changes

- Updated dependencies [233e279]
- Updated dependencies [54d531d]
  - @cat-factory/kernel@0.215.0

## 0.9.42

### Patch Changes

- @cat-factory/kernel@0.214.1

## 0.9.41

### Patch Changes

- Updated dependencies [3435bd1]
  - @cat-factory/kernel@0.214.0

## 0.9.40

### Patch Changes

- Updated dependencies [70b4339]
  - @cat-factory/kernel@0.213.0

## 0.9.39

### Patch Changes

- Updated dependencies [f31c644]
- Updated dependencies [4ac6960]
  - @cat-factory/kernel@0.212.0

## 0.9.38

### Patch Changes

- Updated dependencies [769a3d9]
  - @cat-factory/kernel@0.211.0

## 0.9.37

### Patch Changes

- Updated dependencies [73708cf]
- Updated dependencies [876ee2d]
  - @cat-factory/kernel@0.210.0

## 0.9.36

### Patch Changes

- Updated dependencies [0a1170e]
  - @cat-factory/kernel@0.209.0

## 0.9.35

### Patch Changes

- Updated dependencies [d320539]
  - @cat-factory/kernel@0.208.0

## 0.9.34

### Patch Changes

- Updated dependencies [9e5f785]
  - @cat-factory/kernel@0.207.0

## 0.9.33

### Patch Changes

- Updated dependencies [8fbc0b5]
  - @cat-factory/kernel@0.206.0

## 0.9.32

### Patch Changes

- Updated dependencies [5511cdc]
  - @cat-factory/kernel@0.205.0

## 0.9.31

### Patch Changes

- Updated dependencies [1441041]
  - @cat-factory/kernel@0.204.0

## 0.9.30

### Patch Changes

- Updated dependencies [0b52df7]
  - @cat-factory/kernel@0.203.0

## 0.9.29

### Patch Changes

- Updated dependencies [9c6ce7a]
  - @cat-factory/kernel@0.202.0

## 0.9.28

### Patch Changes

- Updated dependencies [54e6a45]
- Updated dependencies [08e9bcc]
- Updated dependencies [a7aae8a]
  - @cat-factory/kernel@0.201.1

## 0.9.27

### Patch Changes

- Updated dependencies [8c40f33]
  - @cat-factory/kernel@0.201.0

## 0.9.26

### Patch Changes

- Updated dependencies [9d303f0]
  - @cat-factory/kernel@0.200.0

## 0.9.25

### Patch Changes

- Updated dependencies [0bffe55]
- Updated dependencies [1cd9d73]
  - @cat-factory/kernel@0.199.0

## 0.9.24

### Patch Changes

- Updated dependencies [d9789f9]
  - @cat-factory/kernel@0.198.0

## 0.9.23

### Patch Changes

- Updated dependencies [123ac6f]
  - @cat-factory/kernel@0.197.0

## 0.9.22

### Patch Changes

- Updated dependencies [99412e2]
  - @cat-factory/kernel@0.196.0

## 0.9.21

### Patch Changes

- Updated dependencies [1904eb8]
  - @cat-factory/kernel@0.195.0

## 0.9.20

### Patch Changes

- Updated dependencies [f9db6a6]
  - @cat-factory/kernel@0.194.0

## 0.9.19

### Patch Changes

- Updated dependencies [be7fe66]
  - @cat-factory/kernel@0.193.0

## 0.9.18

### Patch Changes

- Updated dependencies [83fd037]
  - @cat-factory/kernel@0.192.0

## 0.9.17

### Patch Changes

- Updated dependencies [7248b72]
  - @cat-factory/kernel@0.191.0

## 0.9.16

### Patch Changes

- Updated dependencies [4ecb25c]
  - @cat-factory/kernel@0.190.0

## 0.9.15

### Patch Changes

- Updated dependencies [7ed2bc0]
  - @cat-factory/kernel@0.189.0

## 0.9.14

### Patch Changes

- Updated dependencies [85efc27]
- Updated dependencies [9794c19]
  - @cat-factory/kernel@0.188.0

## 0.9.13

### Patch Changes

- Updated dependencies [57e1195]
- Updated dependencies [5b19dab]
  - @cat-factory/kernel@0.187.0

## 0.9.12

### Patch Changes

- Updated dependencies [e087b40]
  - @cat-factory/kernel@0.186.0

## 0.9.11

### Patch Changes

- @cat-factory/kernel@0.185.1

## 0.9.10

### Patch Changes

- Updated dependencies [1fa8ef7]
  - @cat-factory/kernel@0.185.0

## 0.9.9

### Patch Changes

- Updated dependencies [f0be8a7]
  - @cat-factory/kernel@0.184.0

## 0.9.8

### Patch Changes

- Updated dependencies [a8cc6b2]
  - @cat-factory/kernel@0.183.0

## 0.9.7

### Patch Changes

- Updated dependencies [ac832b9]
  - @cat-factory/kernel@0.182.0

## 0.9.6

### Patch Changes

- Updated dependencies [22d82ac]
  - @cat-factory/kernel@0.181.0

## 0.9.5

### Patch Changes

- Updated dependencies [e18cfa2]
- Updated dependencies [01d4b6c]
  - @cat-factory/kernel@0.180.0

## 0.9.4

### Patch Changes

- Updated dependencies [b75a08a]
  - @cat-factory/kernel@0.179.0

## 0.9.3

### Patch Changes

- Updated dependencies [9d965c9]
  - @cat-factory/kernel@0.178.0

## 0.9.2

### Patch Changes

- Updated dependencies [58e06a2]
  - @cat-factory/kernel@0.177.0

## 0.9.1

### Patch Changes

- Updated dependencies [65b87c1]
- Updated dependencies [df48cb0]
  - @cat-factory/kernel@0.176.0

## 0.9.0

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
  - @cat-factory/kernel@0.175.0

## 0.8.2

### Patch Changes

- Updated dependencies [c47eb66]
- Updated dependencies [5abcb9e]
  - @cat-factory/kernel@0.174.0

## 0.8.1

### Patch Changes

- Updated dependencies [bead6df]
  - @cat-factory/kernel@0.173.0

## 0.8.0

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

- Updated dependencies [68f0edd]
- Updated dependencies [71ea4ec]
- Updated dependencies [6dbd864]
  - @cat-factory/kernel@0.172.0

## 0.7.274

### Patch Changes

- Updated dependencies [9d8fe9b]
  - @cat-factory/kernel@0.171.0

## 0.7.273

### Patch Changes

- Updated dependencies [cf2779a]
  - @cat-factory/kernel@0.170.0

## 0.7.272

### Patch Changes

- Updated dependencies [1947062]
  - @cat-factory/kernel@0.169.0

## 0.7.271

### Patch Changes

- Updated dependencies [1c12289]
  - @cat-factory/kernel@0.168.0

## 0.7.270

### Patch Changes

- @cat-factory/kernel@0.167.1

## 0.7.269

### Patch Changes

- Updated dependencies [cab85c5]
  - @cat-factory/kernel@0.167.0

## 0.7.268

### Patch Changes

- Updated dependencies [8afa4ae]
  - @cat-factory/kernel@0.166.0

## 0.7.267

### Patch Changes

- Updated dependencies [200fb4d]
  - @cat-factory/kernel@0.165.1

## 0.7.266

### Patch Changes

- Updated dependencies [f0e9bab]
  - @cat-factory/kernel@0.165.0

## 0.7.265

### Patch Changes

- Updated dependencies [640cadd]
  - @cat-factory/kernel@0.164.0

## 0.7.264

### Patch Changes

- @cat-factory/kernel@0.163.1

## 0.7.263

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

- Updated dependencies [829a905]
- Updated dependencies [829a905]
  - @cat-factory/kernel@0.163.0

## 0.7.262

### Patch Changes

- Updated dependencies [c95600b]
  - @cat-factory/kernel@0.162.0

## 0.7.261

### Patch Changes

- Updated dependencies [df9ca7d]
  - @cat-factory/kernel@0.161.0

## 0.7.260

### Patch Changes

- Updated dependencies [600a8ad]
  - @cat-factory/kernel@0.160.0

## 0.7.259

### Patch Changes

- @cat-factory/kernel@0.159.1

## 0.7.258

### Patch Changes

- Updated dependencies [1f8ca48]
  - @cat-factory/kernel@0.159.0

## 0.7.257

### Patch Changes

- Updated dependencies [5a58b9d]
  - @cat-factory/kernel@0.158.0

## 0.7.256

### Patch Changes

- Updated dependencies [55e0a85]
  - @cat-factory/kernel@0.157.0

## 0.7.255

### Patch Changes

- Updated dependencies [ecd68c5]
  - @cat-factory/kernel@0.156.0

## 0.7.254

### Patch Changes

- Updated dependencies [7c6bd77]
  - @cat-factory/kernel@0.155.0

## 0.7.253

### Patch Changes

- Updated dependencies [0e2799e]
  - @cat-factory/kernel@0.154.2

## 0.7.252

### Patch Changes

- 770f926: Upgrade the Vercel AI SDK family to v7 (paired with `workers-ai-provider@4`) and refresh the rest of the dependency tree within the supply-chain release-age gate.

  - **AI SDK v7 / Cloudflare Workers AI**: `ai@^6 → ^7`, `@ai-sdk/openai`/`@ai-sdk/anthropic`/`@ai-sdk/provider` `^3/^4 → ^4`, `@ai-sdk/openai-compatible@^2 → ^3`, `@ai-sdk/amazon-bedrock@^4 → ^5`, and `workers-ai-provider@^3 → ^4`. This is now possible because `workers-ai-provider@4` accepts `ai@^7` peers, lifting the pin that previously held the family at v6. The only code change required is reading the AI SDK v7 usage shape (`usage.inputTokenDetails.cacheReadTokens` in place of the removed `usage.cachedInputTokens`).
  - **Dependency sweep**: within-range refresh of the tree plus targeted bumps of `@cloudflare/workers-types@^4 → ^5` (aligns with the `wrangler@4` peer), `@opentelemetry/exporter-*-otlp-http@^0.220 → ^0.221` (lockstep with the `@opentelemetry/*@2.10` SDKs), and `oxfmt`, `undici`, `pg-boss`, `@nuxtjs/i18n`, `happy-dom`, `vue-tsc`, `wrangler` and others to their latest release-age-compliant versions. The `@cat-factory/executor-harness` runner-image deps are deliberately untouched.

- Updated dependencies [770f926]
  - @cat-factory/kernel@0.154.1

## 0.7.251

### Patch Changes

- Updated dependencies [93496b0]
  - @cat-factory/kernel@0.154.0

## 0.7.250

### Patch Changes

- Updated dependencies [15249df]
  - @cat-factory/kernel@0.153.0

## 0.7.249

### Patch Changes

- Updated dependencies [2323df1]
  - @cat-factory/kernel@0.152.0

## 0.7.248

### Patch Changes

- Updated dependencies [71bd63f]
  - @cat-factory/kernel@0.151.0

## 0.7.247

### Patch Changes

- Updated dependencies [3c7d62b]
  - @cat-factory/kernel@0.150.0

## 0.7.246

### Patch Changes

- Updated dependencies [916278b]
  - @cat-factory/kernel@0.149.0

## 0.7.245

### Patch Changes

- Updated dependencies [1bcb223]
  - @cat-factory/kernel@0.148.5

## 0.7.244

### Patch Changes

- Updated dependencies [91ea6b7]
  - @cat-factory/kernel@0.148.4

## 0.7.243

### Patch Changes

- Updated dependencies [3999941]
  - @cat-factory/kernel@0.148.3

## 0.7.242

### Patch Changes

- Updated dependencies [021f2a0]
- Updated dependencies [021f2a0]
  - @cat-factory/kernel@0.148.2

## 0.7.241

### Patch Changes

- @cat-factory/kernel@0.148.1

## 0.7.240

### Patch Changes

- Updated dependencies [8053837]
  - @cat-factory/kernel@0.148.0

## 0.7.239

### Patch Changes

- Updated dependencies [511076d]
  - @cat-factory/kernel@0.147.3

## 0.7.238

### Patch Changes

- Updated dependencies [7f54858]
  - @cat-factory/kernel@0.147.2

## 0.7.237

### Patch Changes

- Updated dependencies [492d0a2]
  - @cat-factory/kernel@0.147.1

## 0.7.236

### Patch Changes

- Updated dependencies [a10bfdf]
  - @cat-factory/kernel@0.147.0

## 0.7.235

### Patch Changes

- Updated dependencies [f2b25ba]
  - @cat-factory/kernel@0.146.0

## 0.7.234

### Patch Changes

- @cat-factory/kernel@0.145.1

## 0.7.233

### Patch Changes

- Updated dependencies [9450415]
  - @cat-factory/kernel@0.145.0

## 0.7.232

### Patch Changes

- Updated dependencies [54c44bb]
  - @cat-factory/kernel@0.144.0

## 0.7.231

### Patch Changes

- Updated dependencies [0abcf31]
- Updated dependencies [6709dc4]
- Updated dependencies [a53bbf7]
  - @cat-factory/kernel@0.143.0

## 0.7.230

### Patch Changes

- Updated dependencies [5771e05]
  - @cat-factory/kernel@0.142.0

## 0.7.229

### Patch Changes

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0

## 0.7.228

### Patch Changes

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1

## 0.7.227

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0

## 0.7.226

### Patch Changes

- Updated dependencies [efa3345]
  - @cat-factory/kernel@0.139.3

## 0.7.225

### Patch Changes

- @cat-factory/kernel@0.139.2

## 0.7.224

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/kernel@0.139.1

## 0.7.223

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/kernel@0.139.0

## 0.7.222

### Patch Changes

- @cat-factory/kernel@0.138.1

## 0.7.221

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/kernel@0.138.0

## 0.7.220

### Patch Changes

- @cat-factory/kernel@0.137.1

## 0.7.219

### Patch Changes

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0

## 0.7.218

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/kernel@0.136.0

## 0.7.217

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0

## 0.7.216

### Patch Changes

- @cat-factory/kernel@0.134.1

## 0.7.215

### Patch Changes

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/kernel@0.134.0

## 0.7.214

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0

## 0.7.213

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/kernel@0.132.0

## 0.7.212

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/kernel@0.131.0

## 0.7.211

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/kernel@0.130.0

## 0.7.210

### Patch Changes

- @cat-factory/kernel@0.129.2

## 0.7.209

### Patch Changes

- Updated dependencies [6108525]
  - @cat-factory/kernel@0.129.1

## 0.7.208

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/kernel@0.129.0

## 0.7.207

### Patch Changes

- @cat-factory/kernel@0.128.1

## 0.7.206

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0

## 0.7.205

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/kernel@0.127.0

## 0.7.204

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/kernel@0.126.0

## 0.7.203

### Patch Changes

- Updated dependencies [f7e7139]
- Updated dependencies [5fa0a8e]
  - @cat-factory/kernel@0.125.0

## 0.7.202

### Patch Changes

- Updated dependencies [e5cd022]
  - @cat-factory/kernel@0.124.0

## 0.7.201

### Patch Changes

- Updated dependencies [6c4bcef]
  - @cat-factory/kernel@0.123.3

## 0.7.200

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/kernel@0.123.2

## 0.7.199

### Patch Changes

- Updated dependencies [2c7ca2e]
  - @cat-factory/kernel@0.123.1

## 0.7.198

### Patch Changes

- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0

## 0.7.197

### Patch Changes

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/kernel@0.122.0

## 0.7.196

### Patch Changes

- Updated dependencies [2a13ece]
  - @cat-factory/kernel@0.121.8

## 0.7.195

### Patch Changes

- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7

## 0.7.194

### Patch Changes

- Updated dependencies [67dccb6]
  - @cat-factory/kernel@0.121.6

## 0.7.193

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
  - @cat-factory/kernel@0.121.5

## 0.7.192

### Patch Changes

- Updated dependencies [4810353]
  - @cat-factory/kernel@0.121.4

## 0.7.191

### Patch Changes

- Updated dependencies [edad6e6]
  - @cat-factory/kernel@0.121.3

## 0.7.190

### Patch Changes

- @cat-factory/kernel@0.121.2

## 0.7.189

### Patch Changes

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1

## 0.7.188

### Patch Changes

- Updated dependencies [f4482c7]
  - @cat-factory/kernel@0.121.0

## 0.7.187

### Patch Changes

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0

## 0.7.186

### Patch Changes

- Updated dependencies [a5dcf7d]
  - @cat-factory/kernel@0.119.0

## 0.7.185

### Patch Changes

- @cat-factory/kernel@0.118.1

## 0.7.184

### Patch Changes

- Updated dependencies [4f936de]
  - @cat-factory/kernel@0.118.0

## 0.7.183

### Patch Changes

- Updated dependencies [127fe3e]
  - @cat-factory/kernel@0.117.6

## 0.7.182

### Patch Changes

- Updated dependencies [774908c]
  - @cat-factory/kernel@0.117.5

## 0.7.181

### Patch Changes

- Updated dependencies [08a7da2]
  - @cat-factory/kernel@0.117.4

## 0.7.180

### Patch Changes

- Updated dependencies [6b968bb]
  - @cat-factory/kernel@0.117.3

## 0.7.179

### Patch Changes

- Updated dependencies [eeadc97]
  - @cat-factory/kernel@0.117.2

## 0.7.178

### Patch Changes

- Updated dependencies [cb7fd14]
  - @cat-factory/kernel@0.117.1

## 0.7.177

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0

## 0.7.176

### Patch Changes

- Updated dependencies [51869b8]
  - @cat-factory/kernel@0.116.0

## 0.7.175

### Patch Changes

- Updated dependencies [a51a498]
  - @cat-factory/kernel@0.115.1

## 0.7.174

### Patch Changes

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/kernel@0.115.0

## 0.7.173

### Patch Changes

- Updated dependencies [0f3c88b]
  - @cat-factory/kernel@0.114.0

## 0.7.172

### Patch Changes

- Updated dependencies [ed77be6]
  - @cat-factory/kernel@0.113.0

## 0.7.171

### Patch Changes

- Updated dependencies [7ee2530]
  - @cat-factory/kernel@0.112.1

## 0.7.170

### Patch Changes

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0

## 0.7.169

### Patch Changes

- @cat-factory/kernel@0.111.1

## 0.7.168

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/kernel@0.111.0

## 0.7.167

### Patch Changes

- Updated dependencies [bcc843d]
  - @cat-factory/kernel@0.110.1

## 0.7.166

### Patch Changes

- Updated dependencies [a2db337]
  - @cat-factory/kernel@0.110.0

## 0.7.165

### Patch Changes

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1

## 0.7.164

### Patch Changes

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
  - @cat-factory/kernel@0.109.0

## 0.7.163

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/kernel@0.108.0

## 0.7.162

### Patch Changes

- Updated dependencies [44fafa4]
  - @cat-factory/kernel@0.107.0

## 0.7.161

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/kernel@0.106.0

## 0.7.160

### Patch Changes

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/kernel@0.105.0

## 0.7.159

### Patch Changes

- @cat-factory/kernel@0.104.4

## 0.7.158

### Patch Changes

- @cat-factory/kernel@0.104.3

## 0.7.157

### Patch Changes

- Updated dependencies [bc77f89]
  - @cat-factory/kernel@0.104.2

## 0.7.156

### Patch Changes

- @cat-factory/kernel@0.104.1

## 0.7.155

### Patch Changes

- Updated dependencies [37d1517]
  - @cat-factory/kernel@0.104.0

## 0.7.154

### Patch Changes

- Updated dependencies [14eac27]
  - @cat-factory/kernel@0.103.0

## 0.7.153

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/kernel@0.102.0

## 0.7.152

### Patch Changes

- @cat-factory/kernel@0.101.2

## 0.7.151

### Patch Changes

- Updated dependencies [10787c4]
  - @cat-factory/kernel@0.101.1

## 0.7.150

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/kernel@0.101.0

## 0.7.149

### Patch Changes

- Updated dependencies [9ea1e77]
  - @cat-factory/kernel@0.100.0

## 0.7.148

### Patch Changes

- @cat-factory/kernel@0.99.1

## 0.7.147

### Patch Changes

- Updated dependencies [1afa003]
  - @cat-factory/kernel@0.99.0

## 0.7.146

### Patch Changes

- Updated dependencies [bf31df7]
  - @cat-factory/kernel@0.98.0

## 0.7.145

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/kernel@0.97.0

## 0.7.144

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [dd6df12]
  - @cat-factory/kernel@0.96.0

## 0.7.143

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/kernel@0.95.0

## 0.7.142

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/kernel@0.94.0

## 0.7.141

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
  - @cat-factory/kernel@0.93.0

## 0.7.140

### Patch Changes

- Updated dependencies [029a689]
  - @cat-factory/kernel@0.92.0

## 0.7.139

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/kernel@0.91.0

## 0.7.138

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/kernel@0.90.0

## 0.7.137

### Patch Changes

- @cat-factory/kernel@0.89.1

## 0.7.136

### Patch Changes

- Updated dependencies [cfcb6c7]
  - @cat-factory/kernel@0.89.0

## 0.7.135

### Patch Changes

- Updated dependencies [f4c321e]
  - @cat-factory/kernel@0.88.0

## 0.7.134

### Patch Changes

- Updated dependencies [13a284f]
  - @cat-factory/kernel@0.87.0

## 0.7.133

### Patch Changes

- @cat-factory/kernel@0.86.1

## 0.7.132

### Patch Changes

- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/kernel@0.86.0

## 0.7.131

### Patch Changes

- Updated dependencies [1f6d9fc]
  - @cat-factory/kernel@0.85.0

## 0.7.130

### Patch Changes

- Updated dependencies [e5ddaa4]
  - @cat-factory/kernel@0.84.0

## 0.7.129

### Patch Changes

- Updated dependencies [9bac054]
  - @cat-factory/kernel@0.83.0

## 0.7.128

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/kernel@0.82.0

## 0.7.127

### Patch Changes

- Updated dependencies [6edcce0]
  - @cat-factory/kernel@0.81.0

## 0.7.126

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/kernel@0.80.0

## 0.7.125

### Patch Changes

- @cat-factory/kernel@0.79.1

## 0.7.124

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/kernel@0.79.0

## 0.7.123

### Patch Changes

- Updated dependencies [b928904]
  - @cat-factory/kernel@0.78.0

## 0.7.122

### Patch Changes

- Updated dependencies [7fa7578]
  - @cat-factory/kernel@0.77.0

## 0.7.121

### Patch Changes

- Updated dependencies [55661f4]
  - @cat-factory/kernel@0.76.0

## 0.7.120

### Patch Changes

- Updated dependencies [ca5c3e8]
  - @cat-factory/kernel@0.75.0

## 0.7.119

### Patch Changes

- Updated dependencies [b216fdc]
  - @cat-factory/kernel@0.74.0

## 0.7.118

### Patch Changes

- Updated dependencies [7fd6a19]
  - @cat-factory/kernel@0.73.0

## 0.7.117

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/kernel@0.72.0

## 0.7.116

### Patch Changes

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
  - @cat-factory/kernel@0.71.0

## 0.7.115

### Patch Changes

- Updated dependencies [e0aab3f]
  - @cat-factory/kernel@0.70.2

## 0.7.114

### Patch Changes

- Updated dependencies [0d51638]
  - @cat-factory/kernel@0.70.1

## 0.7.113

### Patch Changes

- Updated dependencies [eb67d40]
  - @cat-factory/kernel@0.70.0

## 0.7.112

### Patch Changes

- @cat-factory/kernel@0.69.8

## 0.7.111

### Patch Changes

- Updated dependencies [7f9d215]
  - @cat-factory/kernel@0.69.7

## 0.7.110

### Patch Changes

- @cat-factory/kernel@0.69.6

## 0.7.109

### Patch Changes

- @cat-factory/kernel@0.69.5

## 0.7.108

### Patch Changes

- @cat-factory/kernel@0.69.4

## 0.7.107

### Patch Changes

- @cat-factory/kernel@0.69.3

## 0.7.106

### Patch Changes

- Updated dependencies [d7f6e1c]
- Updated dependencies [63cf6de]
  - @cat-factory/kernel@0.69.2

## 0.7.105

### Patch Changes

- Updated dependencies [120de05]
  - @cat-factory/kernel@0.69.1

## 0.7.104

### Patch Changes

- Updated dependencies [dcc8b32]
  - @cat-factory/kernel@0.69.0

## 0.7.103

### Patch Changes

- Updated dependencies [16ee6cc]
  - @cat-factory/kernel@0.68.1

## 0.7.102

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/kernel@0.68.0

## 0.7.101

### Patch Changes

- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [6c51e31]
  - @cat-factory/kernel@0.67.0

## 0.7.100

### Patch Changes

- @cat-factory/kernel@0.66.1

## 0.7.99

### Patch Changes

- Updated dependencies [fb53662]
  - @cat-factory/kernel@0.66.0

## 0.7.98

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/kernel@0.65.0

## 0.7.97

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/kernel@0.64.0

## 0.7.96

### Patch Changes

- @cat-factory/kernel@0.63.4

## 0.7.95

### Patch Changes

- @cat-factory/kernel@0.63.3

## 0.7.94

### Patch Changes

- Updated dependencies [2e1354f]
  - @cat-factory/kernel@0.63.2

## 0.7.93

### Patch Changes

- @cat-factory/kernel@0.63.1

## 0.7.92

### Patch Changes

- Updated dependencies [f568a8c]
  - @cat-factory/kernel@0.63.0

## 0.7.91

### Patch Changes

- @cat-factory/kernel@0.62.4

## 0.7.90

### Patch Changes

- @cat-factory/kernel@0.62.3

## 0.7.89

### Patch Changes

- @cat-factory/kernel@0.62.2

## 0.7.88

### Patch Changes

- @cat-factory/kernel@0.62.1

## 0.7.87

### Patch Changes

- Updated dependencies [858799e]
  - @cat-factory/kernel@0.62.0

## 0.7.86

### Patch Changes

- @cat-factory/kernel@0.61.1

## 0.7.85

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/kernel@0.61.0

## 0.7.84

### Patch Changes

- Updated dependencies [f383515]
  - @cat-factory/kernel@0.60.0

## 0.7.83

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/kernel@0.59.0

## 0.7.82

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/kernel@0.58.0

## 0.7.81

### Patch Changes

- Updated dependencies [6009266]
  - @cat-factory/kernel@0.57.1

## 0.7.80

### Patch Changes

- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/kernel@0.57.0

## 0.7.79

### Patch Changes

- @cat-factory/kernel@0.56.1

## 0.7.78

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/kernel@0.56.0

## 0.7.77

### Patch Changes

- Updated dependencies [fdeb466]
  - @cat-factory/kernel@0.55.4

## 0.7.76

### Patch Changes

- @cat-factory/kernel@0.55.3

## 0.7.75

### Patch Changes

- @cat-factory/kernel@0.55.2

## 0.7.74

### Patch Changes

- @cat-factory/kernel@0.55.1

## 0.7.73

### Patch Changes

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/kernel@0.55.0

## 0.7.72

### Patch Changes

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/kernel@0.54.0

## 0.7.71

### Patch Changes

- @cat-factory/kernel@0.53.1

## 0.7.70

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/kernel@0.53.0

## 0.7.69

### Patch Changes

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0

## 0.7.68

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/kernel@0.51.0

## 0.7.67

### Patch Changes

- Updated dependencies [e0f1149]
  - @cat-factory/kernel@0.50.0

## 0.7.66

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/kernel@0.49.0

## 0.7.65

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/kernel@0.48.0

## 0.7.64

### Patch Changes

- @cat-factory/kernel@0.47.2

## 0.7.63

### Patch Changes

- @cat-factory/kernel@0.47.1

## 0.7.62

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0

## 0.7.61

### Patch Changes

- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/kernel@0.46.0

## 0.7.60

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
  - @cat-factory/kernel@0.45.5

## 0.7.59

### Patch Changes

- @cat-factory/kernel@0.45.4

## 0.7.58

### Patch Changes

- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3

## 0.7.57

### Patch Changes

- c11a0cc: Add a `prepublishOnly` build hook so each package is compiled to `dist/` before it is
  packed, regardless of how publish is invoked. `dist/` is gitignored and was only built by
  the canonical `pnpm ci:publish` flow, so a bare `pnpm publish` could ship an empty shell
  (this is what happened to `@cat-factory/gitlab` and `@cat-factory/provider-s3`). The hook
  removes that footgun for every publishable library.
- Updated dependencies [c11a0cc]
  - @cat-factory/kernel@0.45.2

## 0.7.56

### Patch Changes

- Updated dependencies [5363166]
  - @cat-factory/kernel@0.45.1

## 0.7.55

### Patch Changes

- Updated dependencies [eab73b8]
  - @cat-factory/kernel@0.45.0

## 0.7.54

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/kernel@0.44.0

## 0.7.53

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/kernel@0.43.0

## 0.7.52

### Patch Changes

- @cat-factory/kernel@0.42.2

## 0.7.51

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/kernel@0.42.1

## 0.7.50

### Patch Changes

- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
  - @cat-factory/kernel@0.42.0

## 0.7.49

### Patch Changes

- Updated dependencies [b5231b0]
  - @cat-factory/kernel@0.41.0

## 0.7.48

### Patch Changes

- Updated dependencies [6d829bb]
  - @cat-factory/kernel@0.40.0

## 0.7.47

### Patch Changes

- Updated dependencies [714b7c9]
  - @cat-factory/kernel@0.39.0

## 0.7.46

### Patch Changes

- @cat-factory/kernel@0.38.1

## 0.7.45

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/kernel@0.38.0

## 0.7.44

### Patch Changes

- Updated dependencies [76543fa]
  - @cat-factory/kernel@0.37.0

## 0.7.43

### Patch Changes

- Updated dependencies [17adf4c]
  - @cat-factory/kernel@0.36.0

## 0.7.42

### Patch Changes

- Updated dependencies [eb48652]
  - @cat-factory/kernel@0.35.0

## 0.7.41

### Patch Changes

- Updated dependencies [9f7ee39]
- Updated dependencies [81b60d4]
  - @cat-factory/kernel@0.34.0

## 0.7.40

### Patch Changes

- Updated dependencies [ea59e91]
  - @cat-factory/kernel@0.33.0

## 0.7.39

### Patch Changes

- Updated dependencies [b82304e]
  - @cat-factory/kernel@0.32.0

## 0.7.38

### Patch Changes

- Updated dependencies [765cc42]
  - @cat-factory/kernel@0.31.0

## 0.7.37

### Patch Changes

- Updated dependencies [52d886a]
  - @cat-factory/kernel@0.30.0

## 0.7.36

### Patch Changes

- Updated dependencies [a639189]
  - @cat-factory/kernel@0.29.0

## 0.7.35

### Patch Changes

- @cat-factory/kernel@0.28.1

## 0.7.34

### Patch Changes

- Updated dependencies [69d2270]
  - @cat-factory/kernel@0.28.0

## 0.7.33

### Patch Changes

- Updated dependencies [3546e3d]
  - @cat-factory/kernel@0.27.0

## 0.7.32

### Patch Changes

- Updated dependencies [a62044d]
  - @cat-factory/kernel@0.26.1

## 0.7.31

### Patch Changes

- Updated dependencies [2aae8bc]
  - @cat-factory/kernel@0.26.0

## 0.7.30

### Patch Changes

- Updated dependencies [f4f954b]
  - @cat-factory/kernel@0.25.0

## 0.7.29

### Patch Changes

- Updated dependencies [ce81233]
  - @cat-factory/kernel@0.24.0

## 0.7.28

### Patch Changes

- Updated dependencies [7346a4f]
  - @cat-factory/kernel@0.23.0

## 0.7.27

### Patch Changes

- Updated dependencies [6ff1f10]
  - @cat-factory/kernel@0.22.0

## 0.7.26

### Patch Changes

- Updated dependencies [04befe8]
  - @cat-factory/kernel@0.21.0

## 0.7.25

### Patch Changes

- Updated dependencies [be182e8]
  - @cat-factory/kernel@0.20.0

## 0.7.24

### Patch Changes

- Updated dependencies [2c24da8]
  - @cat-factory/kernel@0.19.0

## 0.7.23

### Patch Changes

- Updated dependencies [4120ac5]
  - @cat-factory/kernel@0.18.0

## 0.7.22

### Patch Changes

- Updated dependencies [25efe48]
  - @cat-factory/kernel@0.17.0

## 0.7.21

### Patch Changes

- Updated dependencies [c7b8012]
  - @cat-factory/kernel@0.16.2

## 0.7.20

### Patch Changes

- Updated dependencies [aa06003]
  - @cat-factory/kernel@0.16.1

## 0.7.19

### Patch Changes

- Updated dependencies [208c933]
  - @cat-factory/kernel@0.16.0

## 0.7.18

### Patch Changes

- Updated dependencies [494fb34]
  - @cat-factory/kernel@0.15.1

## 0.7.17

### Patch Changes

- Updated dependencies [0ac64b8]
  - @cat-factory/kernel@0.15.0

## 0.7.16

### Patch Changes

- Updated dependencies [fde0437]
  - @cat-factory/kernel@0.14.0

## 0.7.15

### Patch Changes

- Updated dependencies [77b7d31]
  - @cat-factory/kernel@0.13.4

## 0.7.14

### Patch Changes

- @cat-factory/kernel@0.13.3

## 0.7.13

### Patch Changes

- Updated dependencies [ce27690]
  - @cat-factory/kernel@0.13.2

## 0.7.12

### Patch Changes

- Updated dependencies [c8bd144]
  - @cat-factory/kernel@0.13.1

## 0.7.11

### Patch Changes

- Updated dependencies [5c915fd]
  - @cat-factory/kernel@0.13.0

## 0.7.10

### Patch Changes

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
  - @cat-factory/kernel@0.12.0

## 0.7.9

### Patch Changes

- f8a24e0: Refresh dependencies to latest. Notable major bumps: TypeScript 5→6 (tooling
  packages), vitest 3→4, pino 9→10, `@hono/node-server` 1→2, `@hono/valibot-validator`
  0.5→0.6, happy-dom 15→20, and `@types/node` →26. Patch/minor refreshes for `ai`,
  `hono`, `wrangler`, `pg-boss`, `ws`, `@ai-sdk/*`, `oxlint`, and the Cloudflare
  workers tooling.
- Updated dependencies [f8a24e0]
  - @cat-factory/kernel@0.11.1

## 0.7.8

### Patch Changes

- Updated dependencies [1e31cbc]
  - @cat-factory/kernel@0.11.0

## 0.7.7

### Patch Changes

- @cat-factory/kernel@0.10.1

## 0.7.6

### Patch Changes

- Updated dependencies [ae29687]
  - @cat-factory/kernel@0.10.0

## 0.7.5

### Patch Changes

- Updated dependencies [5c20968]
  - @cat-factory/kernel@0.9.0

## 0.7.4

### Patch Changes

- Updated dependencies [c70df09]
  - @cat-factory/kernel@0.8.0

## 0.7.3

### Patch Changes

- Updated dependencies [a0a1bcc]
  - @cat-factory/kernel@0.7.3

## 0.7.2

### Patch Changes

- 4fa5ed9: Re-release all publishable packages. The previous release bumped these on `main` but never reached npm (the publish job was never triggered), so npm is a release behind. This changeset re-triggers the release so every package publishes.
- Updated dependencies [4fa5ed9]
  - @cat-factory/kernel@0.7.2

## 0.7.1

### Patch Changes

- 7463cf2: Add `repository` metadata (url + monorepo `directory`) to every published package.json. npm provenance attestation rejected the previous release because `repository.url` was empty and could not be matched against the source repo; declaring it lets the publish (and provenance) succeed, and re-triggers publishing of all packages from the failed release.
- Updated dependencies [7463cf2]
  - @cat-factory/kernel@0.7.1

## 0.7.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [d94e75c]
- Updated dependencies [6406c8c]
- Updated dependencies [3d9a9d8]
- Updated dependencies [db77061]
- Updated dependencies [a48c620]
- Updated dependencies [3bc8c79]
- Updated dependencies [9d3a956]
- Updated dependencies [8d11833]
- Updated dependencies [ad9ba9e]
- Updated dependencies [f83ffd7]
- Updated dependencies [8065fed]
- Updated dependencies [385bd93]
- Updated dependencies [e50e78a]
- Updated dependencies [0972696]
- Updated dependencies [b48c455]
- Updated dependencies [e9b9356]
- Updated dependencies [e8005ba]
- Updated dependencies [3a12f15]
- Updated dependencies [b40da13]
- Updated dependencies [3a12f15]
- Updated dependencies [8eed38c]
- Updated dependencies [084bf43]
- Updated dependencies [157cd02]
- Updated dependencies [7c37653]
- Updated dependencies [db77061]
- Updated dependencies [6406c8c]
- Updated dependencies [57d70fa]
- Updated dependencies [6406c8c]
- Updated dependencies [918764f]
- Updated dependencies [918764f]
- Updated dependencies [fe0b7f8]
- Updated dependencies [f73652c]
- Updated dependencies [db336b1]
- Updated dependencies [8807f5c]
- Updated dependencies [9be11e1]
- Updated dependencies [5ec0d25]
- Updated dependencies [a691853]
- Updated dependencies [4a08935]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [b287996]
- Updated dependencies [b156b4b]
- Updated dependencies [5c8ca33]
- Updated dependencies [7cf2a2d]
- Updated dependencies [2d66d34]
- Updated dependencies [197264e]
- Updated dependencies [3a12f15]
- Updated dependencies [37baa7f]
- Updated dependencies [c664fe6]
- Updated dependencies [553a67d]
- Updated dependencies [311a110]
- Updated dependencies [f16ae62]
- Updated dependencies [d65c979]
- Updated dependencies [75a0441]
- Updated dependencies [7157fd7]
- Updated dependencies [21ca647]
- Updated dependencies [8eed95b]
- Updated dependencies [a97e485]
- Updated dependencies [de5a9d7]
- Updated dependencies [f647733]
- Updated dependencies [d5e9141]
- Updated dependencies [2d66d34]
- Updated dependencies [a54ada2]
- Updated dependencies [5ca8086]
- Updated dependencies [d0697d1]
- Updated dependencies [0090313]
- Updated dependencies [7dc8e57]
- Updated dependencies [cc8d96a]
- Updated dependencies [43f2443]
- Updated dependencies [acac735]
- Updated dependencies [3841315]
- Updated dependencies [48d2f0d]
- Updated dependencies [3e6a844]
  - @cat-factory/kernel@0.7.0
