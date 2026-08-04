# @cat-factory/caching

## 0.14.8

### Patch Changes

- Updated dependencies [e7e4404]
  - @cat-factory/kernel@0.231.0

## 0.14.7

### Patch Changes

- Updated dependencies [10e0341]
- Updated dependencies [10e0341]
  - @cat-factory/kernel@0.230.0

## 0.14.6

### Patch Changes

- Updated dependencies [fccb1df]
  - @cat-factory/kernel@0.229.0

## 0.14.5

### Patch Changes

- @cat-factory/kernel@0.228.1

## 0.14.4

### Patch Changes

- Updated dependencies [43fd5c0]
  - @cat-factory/kernel@0.228.0

## 0.14.3

### Patch Changes

- Updated dependencies [0456066]
  - @cat-factory/kernel@0.227.0

## 0.14.2

### Patch Changes

- Updated dependencies [f1a6cb3]
- Updated dependencies [cc17221]
- Updated dependencies [889a497]
- Updated dependencies [3605630]
  - @cat-factory/kernel@0.226.0

## 0.14.1

### Patch Changes

- Updated dependencies [36b1853]
  - @cat-factory/kernel@0.225.0

## 0.14.0

### Minor Changes

- 413095f: Let a model preset choose the ORDER a model's routes are preferred in, instead of one order compiled into the resolver.

  Which route a model takes was a deployment-wide constant, so a workspace could not have both a compliance preset pinned to a residency-guaranteed route (AWS Bedrock, whose selectability landed in the previous slice) and an everyday preset riding a flat-rate subscription. It is a per-WORKLOAD choice, so the knob is the preset row (`ModelPreset.providerPreference`) rather than a new env var, and it needs no migration of behaviour: a preset stating nothing resolves exactly as before.

  **A preference REORDERS, it never filters.** Routes a preset omits are appended in default order and tried last, so naming three routes cannot make a model whose only route is the fourth unresolvable. That is structural rather than a rule to remember: `orderedModelFlavorPreference` returns a total order over every route, which is also why the editor offers no way to REMOVE one. The write boundary refuses a repeated route (an order cannot say two things about one route) but accepts a partial list.

  **The order rides `ProviderCapabilities`, and it reaches a run by two paths because a capability set is resolved at two different times.** The START GUARD resolves one per run, so it now resolves under the block's own preset and walks each model's routes in the order the dispatch will. A DISPATCH has no capability set of its own — the facade's `resolveBlockModel` closes over the boot-time one — so the order arrives on `AgentRunContext.providerPreference`, resolved ONCE by the engine exactly like the prompt override and the output budget, and the facade folds it onto its captured capabilities per call. Folding rather than replacing is the point: which routes EXIST is a deployment fact (keys, the Bedrock allow-list, the Workers AI binding) and only the ORDER is per preset. Both ends read one preset row, so the guard, the container path, the inline path and the consensus panel cannot disagree about which provider a step ran on.

  **Eight inline callers each carried a byte-identical copy of the step precedence**, which is how a fact like this gets forgotten in seven places. The judge, the fork-decision chat, the iterative reviewers (with their brainstorm and clarity subclasses), the doc and initiative interviewers, the tester QC companion, the bug-hunt assessor and the Kaizen grader now share one `resolveInlineBlockModelRef`, and it takes the model and the route order as ONE dependency rather than two wired side by side. Kaizen is why: it resolved through a seam with no route-order parameter, so it would have taken the model half and silently ignored the other — a compliance preset getting its route for every inline call on a block except its grading.

  **The preset row is read on every dispatch, every inline call and every start guard, so it goes through the app cache seam.** `AppCaches.modelPreset` is the merge preset's `riskPolicy` slice one table over: same key shape (`picked:<id>` / `default`), same wrapped null so an unseeded workspace caches as a value, same invalidate-the-workspace-group on every `ModelPresetService` write, same pass-through on the Worker's isolate-safe profile. The model id and the route order are resolved from ONE read of that row (`resolvePresetRouting`), where asking two collaborators for them read it twice.

  **"Equals the default order" is stored as ABSENT, not as a copy of it.** Reordering back to the default clears the preference, so a preset keeps tracking the shipped order as the product changes it instead of pinning today's wording of it — which matters because that order is itself scheduled to change. For the same reason the default order now lives in ONE place, `DEFAULT_MODEL_FLAVOR_ORDER` in contracts: the preset editor renders the same fold the resolver walks, and a copy in the SPA would let the picker display an order the run does not take.

  Compatibility break to expect: none for existing rows (`provider_preference` is nullable and NULL means the default order), but a stored route the build no longer knows is DROPPED at the read boundary rather than named. That is the opposite disposition from a retired binary modality, and deliberate: the value names a route, so once the route is gone there is no current member a human could re-pick it as, and the surviving entries keep their relative order.

  One limit worth stating plainly: "subscriptions always win" is still applied ON TOP of this order, so on a workspace holding a subscription token a preset promoting AWS Bedrock is overruled for every dual-mode model. Folding that override into the order is the next slice; until then the preset editor warns rather than letting the copy promise a route a connected plan takes back.

### Patch Changes

- Updated dependencies [413095f]
  - @cat-factory/kernel@0.224.0

## 0.13.9

### Patch Changes

- Updated dependencies [04e44f8]
  - @cat-factory/kernel@0.223.0

## 0.13.8

### Patch Changes

- Updated dependencies [c8ba2cd]
- Updated dependencies [807e442]
- Updated dependencies [175f78f]
- Updated dependencies [807e442]
  - @cat-factory/kernel@0.222.0

## 0.13.7

### Patch Changes

- Updated dependencies [1106c93]
  - @cat-factory/kernel@0.221.1

## 0.13.6

### Patch Changes

- Updated dependencies [3b88f66]
  - @cat-factory/kernel@0.221.0

## 0.13.5

### Patch Changes

- Updated dependencies [7f86f07]
  - @cat-factory/kernel@0.220.0

## 0.13.4

### Patch Changes

- Updated dependencies [87161e8]
  - @cat-factory/kernel@0.219.0

## 0.13.3

### Patch Changes

- Updated dependencies [96ad850]
- Updated dependencies [96ad850]
  - @cat-factory/kernel@0.218.0

## 0.13.2

### Patch Changes

- Updated dependencies [4c26c01]
  - @cat-factory/kernel@0.217.0

## 0.13.1

### Patch Changes

- Updated dependencies [924c6f9]
  - @cat-factory/kernel@0.216.0

## 0.13.0

### Minor Changes

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
  - @cat-factory/kernel@0.215.0

## 0.12.12

### Patch Changes

- @cat-factory/kernel@0.214.1

## 0.12.11

### Patch Changes

- Updated dependencies [3435bd1]
  - @cat-factory/kernel@0.214.0

## 0.12.10

### Patch Changes

- Updated dependencies [70b4339]
  - @cat-factory/kernel@0.213.0

## 0.12.9

### Patch Changes

- 4ac6960: Bump both runner images and take the dependency majors that are actually safe.

  **Runner images** (`@cat-factory/executor-harness` 1.85.0, `@cat-factory/deploy-harness` 0.2.9, with the three pinned tags synced):

  - Executor: Pi `0.82.1 → 0.83.0`, Codex `0.145.0 → 0.146.0`, and the two lockstep Pi extensions `rpiv-todo`/`rpiv-web-tools` `2.1.0 → 2.3.1`. Claude Code stays at `2.1.220` — already the latest.
  - Deploy: `kubectl v1.36.2 → v1.36.3`, `helm v4.2.2 → v4.2.3` (`kustomize v5.8.1` is already the latest). `backend/docs/local-kubernetes-setup-windows.md` mirrors these pins and moves with them.
  - Both: the `node:26-trixie-slim` base re-pinned to the current multi-arch index digest, plus the in-range `@types/node`/`hono` refresh the harnesses sat out of the previous sweep. With the executor harness now bumped, `hono` moves to `^4.12.33` across the whole workspace rather than being held back by the single-version constraint.

  **Dependency majors** — taken: `markdown-it@14 → 15` (it now ships its own types, so `@types/markdown-it` is dropped; the instance type is a separate export from the constructor, which is the one call site that changed), `ioredis@5 → 6` (the optional multi-node Redis propagator + cache-invalidation bus), and `layered-loader@14 → 16`.

  The layered-loader bump also **retires the deep-import workaround**. Keeping `ioredis` out of the Worker's module graph used to require importing `layered-loader/dist/lib/*.js` directly, because the package root eagerly re-exported its Redis surface; 15 then added an `exports` map that closed that hatch without offering a replacement. 16 states the boundary itself, so `@cat-factory/caching` imports the Redis-free `layered-loader/core` and only the Node facade's `REDIS_URL`-gated dynamic import reaches `layered-loader/redis`. **Never import the package root from `@cat-factory/caching` — it still carries both halves.** 16 also demotes `ioredis` to an optional peer (`^6`, pairing with the bump above) resolved lazily and only when a caller passes connection options instead of a client, which we never do.

  Not taken: `typescript@6 → 7` for the frontend, because `vue-tsc` still loads `typescript/lib/tsc`, which the TS 7 Go port no longer exports — the frontend stays on 6 until vue-tsc supports it.

- 4ac6960: Refresh the dependency tree — direct and transitive — to the latest versions that satisfy the `minimumReleaseAge` supply-chain gate, staying within each dependency's compatible major.

  - **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.37 → ^7.0.47`, `@ai-sdk/anthropic`/`@ai-sdk/openai@^4.0.2x → ^4.0.27`, `@ai-sdk/openai-compatible@^3.0.14 → ^3.0.20`, `@ai-sdk/provider@^4.0.3 → ^4.0.4`, `@ai-sdk/amazon-bedrock@^5.0.32 → ^5.0.40`.
  - **Runtime deps**: `pg-boss@^12.26.3 → ^12.26.4`, `@aws-sdk/client-s3@^3.1095.0 → ^3.1101.0`, `@nuxtjs/i18n@^10.5.0 → ^10.6.0`, `@vueuse/core@^14.3.0 → ^14.4.0`.
  - **Tooling**: `wrangler@^4.114.0 → ^4.118.0`, `@cloudflare/workers-types@^5.20260726.1 → ^5.20260801.1`, `oxlint@^1.75.0 → ^1.76.0`, `oxfmt@^0.60.0 → ^0.61.0`, `knip@^6.29.0 → ^6.31.0`, `turbo@^2.10.7 → ^2.10.8`, `vue-tsc@^3.3.8 → ^3.3.9`, `@playwright/test@^1.62.0 → ^1.62.1`, `@types/node@^26.1.1 → ^26.1.2`, `@types/pg@^8.20.0 → ^8.20.3`.

  No `minimumReleaseAgeExclude` entries were added: every bump above already satisfies the gate. The `@cat-factory/executor-harness` and `@cat-factory/deploy-harness` deps are deliberately untouched, since they feed the published runner images and bumping them is a separate image-bumping change. `hono`'s declared range therefore stays at `^4.12.32` (sherif requires one version workspace-wide, and the harness declares it) while the lockfile still resolves 4.12.33 within that range.

- Updated dependencies [f31c644]
- Updated dependencies [4ac6960]
  - @cat-factory/kernel@0.212.0

## 0.12.8

### Patch Changes

- Updated dependencies [769a3d9]
  - @cat-factory/kernel@0.211.0

## 0.12.7

### Patch Changes

- Updated dependencies [73708cf]
- Updated dependencies [876ee2d]
  - @cat-factory/kernel@0.210.0

## 0.12.6

### Patch Changes

- Updated dependencies [0a1170e]
  - @cat-factory/kernel@0.209.0

## 0.12.5

### Patch Changes

- Updated dependencies [d320539]
  - @cat-factory/kernel@0.208.0

## 0.12.4

### Patch Changes

- Updated dependencies [9e5f785]
  - @cat-factory/kernel@0.207.0

## 0.12.3

### Patch Changes

- Updated dependencies [8fbc0b5]
  - @cat-factory/kernel@0.206.0

## 0.12.2

### Patch Changes

- Updated dependencies [5511cdc]
  - @cat-factory/kernel@0.205.0

## 0.12.1

### Patch Changes

- Updated dependencies [1441041]
  - @cat-factory/kernel@0.204.0

## 0.12.0

### Minor Changes

- 0b52df7: Add foundational services: a tiered (account ⊕ workspace) catalog of the shared capabilities an
  organisation already runs — file storage, notifications, audit — each with a description and its
  API contracts (OpenAPI 3.x, `@toad-contracts/core` or `@lokalise/api-contract`), supplied either by
  direct upload or by linking files/folders in a git repo that is cached and auto-refreshed on both
  runtimes.

  The Architect is folded the catalog (identity, capability tags and indexed operation names — never a
  document body) and must declare the service ids its design consumes; the Researcher and Coder are
  then handed the full API contracts of exactly those services, plus an explicit statement of anything
  the design named that the catalog does not contain.

### Patch Changes

- Updated dependencies [0b52df7]
  - @cat-factory/kernel@0.203.0

## 0.11.32

### Patch Changes

- Updated dependencies [9c6ce7a]
  - @cat-factory/kernel@0.202.0

## 0.11.31

### Patch Changes

- Updated dependencies [54e6a45]
- Updated dependencies [08e9bcc]
- Updated dependencies [a7aae8a]
  - @cat-factory/kernel@0.201.1

## 0.11.30

### Patch Changes

- Updated dependencies [8c40f33]
  - @cat-factory/kernel@0.201.0

## 0.11.29

### Patch Changes

- Updated dependencies [9d303f0]
  - @cat-factory/kernel@0.200.0

## 0.11.28

### Patch Changes

- Updated dependencies [0bffe55]
- Updated dependencies [1cd9d73]
  - @cat-factory/kernel@0.199.0

## 0.11.27

### Patch Changes

- Updated dependencies [d9789f9]
  - @cat-factory/kernel@0.198.0

## 0.11.26

### Patch Changes

- Updated dependencies [123ac6f]
  - @cat-factory/kernel@0.197.0

## 0.11.25

### Patch Changes

- Updated dependencies [99412e2]
  - @cat-factory/kernel@0.196.0

## 0.11.24

### Patch Changes

- Updated dependencies [1904eb8]
  - @cat-factory/kernel@0.195.0

## 0.11.23

### Patch Changes

- Updated dependencies [f9db6a6]
  - @cat-factory/kernel@0.194.0

## 0.11.22

### Patch Changes

- Updated dependencies [be7fe66]
  - @cat-factory/kernel@0.193.0

## 0.11.21

### Patch Changes

- Updated dependencies [83fd037]
  - @cat-factory/kernel@0.192.0

## 0.11.20

### Patch Changes

- Updated dependencies [7248b72]
  - @cat-factory/kernel@0.191.0

## 0.11.19

### Patch Changes

- Updated dependencies [4ecb25c]
  - @cat-factory/kernel@0.190.0

## 0.11.18

### Patch Changes

- Updated dependencies [7ed2bc0]
  - @cat-factory/kernel@0.189.0

## 0.11.17

### Patch Changes

- Updated dependencies [85efc27]
- Updated dependencies [9794c19]
  - @cat-factory/kernel@0.188.0

## 0.11.16

### Patch Changes

- Updated dependencies [57e1195]
- Updated dependencies [5b19dab]
  - @cat-factory/kernel@0.187.0

## 0.11.15

### Patch Changes

- Updated dependencies [e087b40]
  - @cat-factory/kernel@0.186.0

## 0.11.14

### Patch Changes

- @cat-factory/kernel@0.185.1

## 0.11.13

### Patch Changes

- Updated dependencies [1fa8ef7]
  - @cat-factory/kernel@0.185.0

## 0.11.12

### Patch Changes

- Updated dependencies [f0be8a7]
  - @cat-factory/kernel@0.184.0

## 0.11.11

### Patch Changes

- Updated dependencies [a8cc6b2]
  - @cat-factory/kernel@0.183.0

## 0.11.10

### Patch Changes

- Updated dependencies [ac832b9]
  - @cat-factory/kernel@0.182.0

## 0.11.9

### Patch Changes

- Updated dependencies [22d82ac]
  - @cat-factory/kernel@0.181.0

## 0.11.8

### Patch Changes

- Updated dependencies [e18cfa2]
- Updated dependencies [01d4b6c]
  - @cat-factory/kernel@0.180.0

## 0.11.7

### Patch Changes

- Updated dependencies [b75a08a]
  - @cat-factory/kernel@0.179.0

## 0.11.6

### Patch Changes

- Updated dependencies [9d965c9]
  - @cat-factory/kernel@0.178.0

## 0.11.5

### Patch Changes

- Updated dependencies [58e06a2]
  - @cat-factory/kernel@0.177.0

## 0.11.4

### Patch Changes

- Updated dependencies [65b87c1]
- Updated dependencies [df48cb0]
  - @cat-factory/kernel@0.176.0

## 0.11.3

### Patch Changes

- Updated dependencies [b30cc6e]
  - @cat-factory/kernel@0.175.0

## 0.11.2

### Patch Changes

- Updated dependencies [c47eb66]
- Updated dependencies [5abcb9e]
  - @cat-factory/kernel@0.174.0

## 0.11.1

### Patch Changes

- Updated dependencies [bead6df]
  - @cat-factory/kernel@0.173.0

## 0.11.0

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

## 0.10.56

### Patch Changes

- Updated dependencies [9d8fe9b]
  - @cat-factory/kernel@0.171.0

## 0.10.55

### Patch Changes

- Updated dependencies [cf2779a]
  - @cat-factory/kernel@0.170.0

## 0.10.54

### Patch Changes

- Updated dependencies [1947062]
  - @cat-factory/kernel@0.169.0

## 0.10.53

### Patch Changes

- Updated dependencies [1c12289]
  - @cat-factory/kernel@0.168.0

## 0.10.52

### Patch Changes

- @cat-factory/kernel@0.167.1

## 0.10.51

### Patch Changes

- Updated dependencies [cab85c5]
  - @cat-factory/kernel@0.167.0

## 0.10.50

### Patch Changes

- Updated dependencies [8afa4ae]
  - @cat-factory/kernel@0.166.0

## 0.10.49

### Patch Changes

- Updated dependencies [200fb4d]
  - @cat-factory/kernel@0.165.1

## 0.10.48

### Patch Changes

- Updated dependencies [f0e9bab]
  - @cat-factory/kernel@0.165.0

## 0.10.47

### Patch Changes

- Updated dependencies [640cadd]
  - @cat-factory/kernel@0.164.0

## 0.10.46

### Patch Changes

- @cat-factory/kernel@0.163.1

## 0.10.45

### Patch Changes

- Updated dependencies [829a905]
- Updated dependencies [829a905]
  - @cat-factory/kernel@0.163.0

## 0.10.44

### Patch Changes

- Updated dependencies [c95600b]
  - @cat-factory/kernel@0.162.0

## 0.10.43

### Patch Changes

- Updated dependencies [df9ca7d]
  - @cat-factory/kernel@0.161.0

## 0.10.42

### Patch Changes

- Updated dependencies [600a8ad]
  - @cat-factory/kernel@0.160.0

## 0.10.41

### Patch Changes

- @cat-factory/kernel@0.159.1

## 0.10.40

### Patch Changes

- Updated dependencies [1f8ca48]
  - @cat-factory/kernel@0.159.0

## 0.10.39

### Patch Changes

- Updated dependencies [5a58b9d]
  - @cat-factory/kernel@0.158.0

## 0.10.38

### Patch Changes

- Updated dependencies [55e0a85]
  - @cat-factory/kernel@0.157.0

## 0.10.37

### Patch Changes

- Updated dependencies [ecd68c5]
  - @cat-factory/kernel@0.156.0

## 0.10.36

### Patch Changes

- Updated dependencies [7c6bd77]
  - @cat-factory/kernel@0.155.0

## 0.10.35

### Patch Changes

- Updated dependencies [0e2799e]
  - @cat-factory/kernel@0.154.2

## 0.10.34

### Patch Changes

- Updated dependencies [770f926]
  - @cat-factory/kernel@0.154.1

## 0.10.33

### Patch Changes

- Updated dependencies [93496b0]
  - @cat-factory/kernel@0.154.0

## 0.10.32

### Patch Changes

- Updated dependencies [15249df]
  - @cat-factory/kernel@0.153.0

## 0.10.31

### Patch Changes

- Updated dependencies [2323df1]
  - @cat-factory/kernel@0.152.0

## 0.10.30

### Patch Changes

- Updated dependencies [71bd63f]
  - @cat-factory/kernel@0.151.0

## 0.10.29

### Patch Changes

- Updated dependencies [3c7d62b]
  - @cat-factory/kernel@0.150.0

## 0.10.28

### Patch Changes

- Updated dependencies [916278b]
  - @cat-factory/kernel@0.149.0

## 0.10.27

### Patch Changes

- Updated dependencies [1bcb223]
  - @cat-factory/kernel@0.148.5

## 0.10.26

### Patch Changes

- Updated dependencies [91ea6b7]
  - @cat-factory/kernel@0.148.4

## 0.10.25

### Patch Changes

- Updated dependencies [3999941]
  - @cat-factory/kernel@0.148.3

## 0.10.24

### Patch Changes

- Updated dependencies [021f2a0]
- Updated dependencies [021f2a0]
  - @cat-factory/kernel@0.148.2

## 0.10.23

### Patch Changes

- @cat-factory/kernel@0.148.1

## 0.10.22

### Patch Changes

- Updated dependencies [8053837]
  - @cat-factory/kernel@0.148.0

## 0.10.21

### Patch Changes

- Updated dependencies [511076d]
  - @cat-factory/kernel@0.147.3

## 0.10.20

### Patch Changes

- Updated dependencies [7f54858]
  - @cat-factory/kernel@0.147.2

## 0.10.19

### Patch Changes

- Updated dependencies [492d0a2]
  - @cat-factory/kernel@0.147.1

## 0.10.18

### Patch Changes

- Updated dependencies [a10bfdf]
  - @cat-factory/kernel@0.147.0

## 0.10.17

### Patch Changes

- Updated dependencies [f2b25ba]
  - @cat-factory/kernel@0.146.0

## 0.10.16

### Patch Changes

- @cat-factory/kernel@0.145.1

## 0.10.15

### Patch Changes

- Updated dependencies [9450415]
  - @cat-factory/kernel@0.145.0

## 0.10.14

### Patch Changes

- Updated dependencies [54c44bb]
  - @cat-factory/kernel@0.144.0

## 0.10.13

### Patch Changes

- Updated dependencies [0abcf31]
- Updated dependencies [6709dc4]
- Updated dependencies [a53bbf7]
  - @cat-factory/kernel@0.143.0

## 0.10.12

### Patch Changes

- Updated dependencies [5771e05]
  - @cat-factory/kernel@0.142.0

## 0.10.11

### Patch Changes

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0

## 0.10.10

### Patch Changes

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1

## 0.10.9

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0

## 0.10.8

### Patch Changes

- Updated dependencies [efa3345]
  - @cat-factory/kernel@0.139.3

## 0.10.7

### Patch Changes

- @cat-factory/kernel@0.139.2

## 0.10.6

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/kernel@0.139.1

## 0.10.5

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/kernel@0.139.0

## 0.10.4

### Patch Changes

- @cat-factory/kernel@0.138.1

## 0.10.3

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/kernel@0.138.0

## 0.10.2

### Patch Changes

- @cat-factory/kernel@0.137.1

## 0.10.1

### Patch Changes

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0

## 0.10.0

### Minor Changes

- 576f2e0: Workspace RBAC (slice 4): cache the effective-access resolution behind the app cache seam.

  The shared auth gate resolves a caller's effective workspace access on every
  `/workspaces/:ws/*` request (three reads: the board access row, the caller's account roles,
  their member row). This adds a `workspaceAccess` slice to the kernel `AppCaches` port
  (`@cat-factory/caching`) so `loadWorkspaceAccess` reads through it — grouped by workspace id,
  keyed by user id, with both a denial and a missing board cached as values (negative caching).
  A cache hit costs zero repository reads.

  Coherence is invalidation-driven, after each write commits: a board delete drops the
  workspace group (`WorkspaceService.delete`), and account-tier membership writes
  (`AccountService.addMember` / `setMemberRoles`, `InvitationService.accept`) drop everything
  (`invalidateAll` — the deliberate coarse fallback for a rare management action, since a new
  membership can change access to many boards). The roster + access-mode write paths added by
  the member-management API (a later slice) invalidate the same workspace group on their own
  writes.

  The slice follows the established seam rules: the `DEFAULT_APP_CACHES_PROFILE` enables it with
  a short 60s TTL (a freshness backstop; invalidation is the real coherence story), while the
  Worker's `ISOLATE_SAFE_APP_CACHES_PROFILE` keeps it **pass-through** — the resolution reads our
  own mutable D1 state and a Worker isolate has no cross-isolate invalidation bus, so a TTL'd
  entry could keep granting access after a peer isolate revoked a member. Cross-runtime
  conformance asserts an account-membership grant is visible on the immediately following request
  (the cached denial is dropped) on both D1 and Postgres.

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/kernel@0.136.0

## 0.9.5

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0

## 0.9.4

### Patch Changes

- @cat-factory/kernel@0.134.1

## 0.9.3

### Patch Changes

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/kernel@0.134.0

## 0.9.2

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0

## 0.9.1

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/kernel@0.132.0

## 0.9.0

### Minor Changes

- 5b1cbbf: feat: repo-sourced Claude Skills library — data + sync core (slice 1)

  Land the persistence + sync foundation for the repo-sourced Claude Skills
  initiative (docs/initiatives/repo-skills.md):

  - New account-tier tables `skill_sources` + `account_skills` (D1 migration 0052
    ⇄ Drizzle schema + migration), with matching kernel ports
    (`SkillSourceRepository`, `AccountSkillRepository`) and both D1 and Drizzle
    repositories, asserted by a new cross-runtime conformance suite.
  - A shared `repo-source-sync` helper extracted from the fragment library's sync
    mechanics (commit-pin-before-read, id-keyed tombstone sweep, invalidate-only-on-
    change, the status probe) plus a shared frontmatter parser; `FragmentSourceService`
    is refactored onto it, and the new `SkillSourceService` reuses it for the
    directory-per-skill (`<skill>/SKILL.md` + resources) sync unit.
  - `SkillCatalogService` (the account skill-catalog read) backed by a new
    `AppCaches.skillCatalog` cache slice (pass-through on the Worker, like
    `fragmentCatalog`).
  - Contracts + an account-scoped `SkillLibraryController` (list skills; link / list /
    sync / status / unlink sources), wired into all runtime facades. Opt-in behind the
    existing prompt-library flag.

  `RepoContentEntry` gains an optional `size` (populated from the GitHub contents API)
  so the skill resource manifest can record file sizes.

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/kernel@0.131.0

## 0.8.8

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/kernel@0.130.0

## 0.8.7

### Patch Changes

- @cat-factory/kernel@0.129.2

## 0.8.6

### Patch Changes

- 6108525: perf(engine): resolve the agent-context service frame once, and cache the merge-preset read

  - `AgentContextBuilder` walks a block's ancestry to its owning service frame a SINGLE time
    per dispatch (threaded into the environment / service-config / frontend / fragment
    resolvers) and fans the mutually-independent context resolutions out in one `Promise.all`
    wave, instead of re-walking frame→module→task once per resolver and awaiting each in turn
    (performance initiative item 13).
  - `resolveRiskPolicy` reads a task's merge-threshold preset through a new `riskPolicy`
    AppCaches slice — the slow-moving admin config was re-read on every gate evaluation.
    `RiskPolicyService` invalidates the workspace group on every preset write (create / update /
    remove / reseed / first-use seed); pass-through on the Worker's isolate-safe profile
    (performance initiative item 23).

- Updated dependencies [6108525]
  - @cat-factory/kernel@0.129.1

## 0.8.5

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/kernel@0.129.0

## 0.8.4

### Patch Changes

- @cat-factory/kernel@0.128.1

## 0.8.3

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0

## 0.8.2

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/kernel@0.127.0

## 0.8.1

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/kernel@0.126.0

## 0.8.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [f7e7139]
- Updated dependencies [5fa0a8e]
  - @cat-factory/kernel@0.125.0

## 0.7.0

### Minor Changes

- e5cd022: Speed up the "add service from an existing repo" picker's typeahead, which stalled for
  ~17s per keystroke when a broad personal access token (PAT) backed the results.

  The personal-repo branch re-walked the viewer's entire `GET /user/repos` set — up to ten
  sequential GitHub pages — on every keystroke and only applied the query as an in-memory
  filter afterwards, with nothing cached. Three changes:

  - **Cache the enumeration.** New `AppCaches.viewerRepos` slice (grouped/keyed by user id):
    the picker's typeahead now filters a cached complete set in memory instead of forcing a
    fresh full walk per keystroke. Invalidated when the user's stored `github_pat` changes;
    a short (60s) TTL backstops repos created straight on GitHub. Pass-through on the Worker's
    isolate-safe profile (external state, not self-verifying), so it caches on Node/local
    where the PAT picker is the primary flow.
  - **Parallelize the cold walk.** `FetchGitHubClient.listReposForToken` reads page 1, learns
    the page count from its `Link: rel="last"` header, and fetches the remaining pages
    concurrently — turning ~10 serial round-trips into ~2.
  - The blank browse-all path (and its fail-closed access-projection refresh) is unchanged and
    stays uncached.

  No repos are dropped: a literal GitHub `/search/repositories` call was deliberately avoided
  because it can't reproduce the enumeration's `owner,collaborator,organization_member`
  affiliation scope and would bury a low-star private repo in global results.

### Patch Changes

- Updated dependencies [e5cd022]
  - @cat-factory/kernel@0.124.0

## 0.6.46

### Patch Changes

- Updated dependencies [6c4bcef]
  - @cat-factory/kernel@0.123.3

## 0.6.45

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/kernel@0.123.2

## 0.6.44

### Patch Changes

- Updated dependencies [2c7ca2e]
  - @cat-factory/kernel@0.123.1

## 0.6.43

### Patch Changes

- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0

## 0.6.42

### Patch Changes

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/kernel@0.122.0

## 0.6.41

### Patch Changes

- 2a13ece: Route `AccountSettingsService.resolve` through the app cache seam (performance initiative item 8).
  The service's legacy homebrew 30s `{ value, expiresAt }` `Map` — the anti-pattern CLAUDE.md names
  explicitly — is replaced by a new `accountSettings` `AppCaches` slice (grouped and keyed by account
  id, holding the decrypted `ResolvedAccountSettings`). `resolve` now reads through it and `write`
  invalidates the account's entry after the upsert commits, so an integration-credential change is
  coherent across replicas (the invalidation bus carries only keys, never the decrypted secrets, so
  plaintext still never leaves the process). `ResolvedAccountSettings` moved to the kernel
  account-settings port (the caching port now names it) and is re-exported from
  `@cat-factory/integrations`, so its consumers are unchanged. Pass-through on the Worker's
  isolate-safe profile (our own mutable D1 state, no cross-isolate bus); both facades wire the slice.
- Updated dependencies [2a13ece]
  - @cat-factory/kernel@0.121.8

## 0.6.40

### Patch Changes

- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7

## 0.6.39

### Patch Changes

- 67dccb6: perf(caching): route workspace-settings and spend budget reads through the app cache seam (perf-tracker items 7 & 9)

  Replaces `SpendService`'s three homebrew `{ value, expiresAt }` TTL `Map`s (pricing /
  account limit / user limit) and the uncached `WorkspaceSettingsService.get` with three new
  `AppCaches` slices — `workspaceSettings`, `accountBudgetLimit`, `userBudgetLimit` — so these
  slow-moving reads are coherent across a horizontally-scaled Node deployment (a budget/settings
  edit invalidates every replica via the notification bus instead of leaving peers stale for the
  TTL). The workspace-settings row is now read through a single shared slice by
  `WorkspaceSettingsService`, `SpendService`'s pricing overlay, and
  `LlmObservabilityService.bodiesEnabled`, so one invalidation on `WorkspaceSettingsService.update`
  covers them all. The slices are pass-through on the Worker's isolate-safe profile (our own
  mutable D1 state, no cross-isolate bus).

- Updated dependencies [67dccb6]
  - @cat-factory/kernel@0.121.6

## 0.6.38

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

## 0.6.37

### Patch Changes

- Updated dependencies [4810353]
  - @cat-factory/kernel@0.121.4

## 0.6.36

### Patch Changes

- Updated dependencies [edad6e6]
  - @cat-factory/kernel@0.121.3

## 0.6.35

### Patch Changes

- @cat-factory/kernel@0.121.2

## 0.6.34

### Patch Changes

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1

## 0.6.33

### Patch Changes

- Updated dependencies [f4482c7]
  - @cat-factory/kernel@0.121.0

## 0.6.32

### Patch Changes

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0

## 0.6.31

### Patch Changes

- Updated dependencies [a5dcf7d]
  - @cat-factory/kernel@0.119.0

## 0.6.30

### Patch Changes

- @cat-factory/kernel@0.118.1

## 0.6.29

### Patch Changes

- Updated dependencies [4f936de]
  - @cat-factory/kernel@0.118.0

## 0.6.28

### Patch Changes

- Updated dependencies [127fe3e]
  - @cat-factory/kernel@0.117.6

## 0.6.27

### Patch Changes

- Updated dependencies [774908c]
  - @cat-factory/kernel@0.117.5

## 0.6.26

### Patch Changes

- Updated dependencies [08a7da2]
  - @cat-factory/kernel@0.117.4

## 0.6.25

### Patch Changes

- Updated dependencies [6b968bb]
  - @cat-factory/kernel@0.117.3

## 0.6.24

### Patch Changes

- Updated dependencies [eeadc97]
  - @cat-factory/kernel@0.117.2

## 0.6.23

### Patch Changes

- Updated dependencies [cb7fd14]
  - @cat-factory/kernel@0.117.1

## 0.6.22

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0

## 0.6.21

### Patch Changes

- Updated dependencies [51869b8]
  - @cat-factory/kernel@0.116.0

## 0.6.20

### Patch Changes

- Updated dependencies [a51a498]
  - @cat-factory/kernel@0.115.1

## 0.6.19

### Patch Changes

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/kernel@0.115.0

## 0.6.18

### Patch Changes

- Updated dependencies [0f3c88b]
  - @cat-factory/kernel@0.114.0

## 0.6.17

### Patch Changes

- Updated dependencies [ed77be6]
  - @cat-factory/kernel@0.113.0

## 0.6.16

### Patch Changes

- Updated dependencies [7ee2530]
  - @cat-factory/kernel@0.112.1

## 0.6.15

### Patch Changes

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0

## 0.6.14

### Patch Changes

- @cat-factory/kernel@0.111.1

## 0.6.13

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/kernel@0.111.0

## 0.6.12

### Patch Changes

- Updated dependencies [bcc843d]
  - @cat-factory/kernel@0.110.1

## 0.6.11

### Patch Changes

- Updated dependencies [a2db337]
  - @cat-factory/kernel@0.110.0

## 0.6.10

### Patch Changes

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1

## 0.6.9

### Patch Changes

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
  - @cat-factory/kernel@0.109.0

## 0.6.8

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/kernel@0.108.0

## 0.6.7

### Patch Changes

- Updated dependencies [44fafa4]
  - @cat-factory/kernel@0.107.0

## 0.6.6

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/kernel@0.106.0

## 0.6.5

### Patch Changes

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/kernel@0.105.0

## 0.6.4

### Patch Changes

- @cat-factory/kernel@0.104.4

## 0.6.3

### Patch Changes

- @cat-factory/kernel@0.104.3

## 0.6.2

### Patch Changes

- Updated dependencies [bc77f89]
  - @cat-factory/kernel@0.104.2

## 0.6.1

### Patch Changes

- @cat-factory/kernel@0.104.1

## 0.6.0

### Minor Changes

- 37d1517: Cache the checkout-free `RepoFiles` reads an agent's pre/post-ops run against a run's
  branch (caching-layer initiative, slice 4). A new `AppCaches.repoFiles` group cache serves
  the `getFile`/`listDirectory` idempotency byte-compares the `blueprints`/`spec-writer`
  post-ops issue every run and durable-driver replay, replacing a live GitHub contents-API
  round-trip per file. It is wired only on the `makeResolveRunRepoContext` (pre/post-op) path;
  the environments repo-validation and doc-quality reads stay live.

  - Grouped per `(installation, owner, repo, branch)` via the new kernel `repoFilesCacheGroup`
    helper and keyed per path (`f:`/`d:` prefixes), so one branch's reads drop together.
  - Self-verifying: each entry remembers the branch head sha it reflects, so an entry entering
    its refresh window re-validates with a single cheap `branchHeadSha` compare (bump on an
    unmoved branch, background reload otherwise) instead of re-fetching every file. A sha-pinned
    read is immutable (no probe). The head sha a cold batch stamps is read once per branch
    (memoised), so caching N files costs one extra head read, not N.
  - Coherence: the owning `commitFiles` self-invalidates the branch group after it commits, and
    the `push` webhook drops a branch it saw move out-of-band (an agent container's git push or a
    human PR-branch edit). Stays enabled on the Worker's isolate-safe profile (like the
    document-body cache, the head-sha probe re-validates without a cross-isolate bus) and in local
    mode (single-node, so `commitFiles` self-invalidation is already fully coherent).

### Patch Changes

- Updated dependencies [37d1517]
  - @cat-factory/kernel@0.104.0

## 0.5.0

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
  - @cat-factory/kernel@0.103.0

## 0.4.22

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/kernel@0.102.0

## 0.4.21

### Patch Changes

- @cat-factory/kernel@0.101.2

## 0.4.20

### Patch Changes

- Updated dependencies [10787c4]
  - @cat-factory/kernel@0.101.1

## 0.4.19

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/kernel@0.101.0

## 0.4.18

### Patch Changes

- Updated dependencies [9ea1e77]
  - @cat-factory/kernel@0.100.0

## 0.4.17

### Patch Changes

- @cat-factory/kernel@0.99.1

## 0.4.16

### Patch Changes

- Updated dependencies [1afa003]
  - @cat-factory/kernel@0.99.0

## 0.4.15

### Patch Changes

- Updated dependencies [bf31df7]
  - @cat-factory/kernel@0.98.0

## 0.4.14

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/kernel@0.97.0

## 0.4.13

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [dd6df12]
  - @cat-factory/kernel@0.96.0

## 0.4.12

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/kernel@0.95.0

## 0.4.11

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/kernel@0.94.0

## 0.4.10

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

## 0.4.9

### Patch Changes

- Updated dependencies [029a689]
  - @cat-factory/kernel@0.92.0

## 0.4.8

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/kernel@0.91.0

## 0.4.7

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/kernel@0.90.0

## 0.4.6

### Patch Changes

- @cat-factory/kernel@0.89.1

## 0.4.5

### Patch Changes

- Updated dependencies [cfcb6c7]
  - @cat-factory/kernel@0.89.0

## 0.4.4

### Patch Changes

- Updated dependencies [f4c321e]
  - @cat-factory/kernel@0.88.0

## 0.4.3

### Patch Changes

- Updated dependencies [13a284f]
  - @cat-factory/kernel@0.87.0

## 0.4.2

### Patch Changes

- @cat-factory/kernel@0.86.1

## 0.4.1

### Patch Changes

- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/kernel@0.86.0

## 0.4.0

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

## 0.3.0

### Minor Changes

- e5ddaa4: Cache document-backed prompt-fragment bodies through the app caching seam
  (caching-layer initiative, slice 2). A new `AppCaches.fragmentDocumentBody`
  group cache serves a living fragment's external Confluence/Notion/GitHub/Figma/
  Zeplin/Linear body, replacing the hand-rolled `DEFAULT_DOCUMENT_FRAGMENT_TTL_MS`
  in `FragmentLibraryService`: a run reads the cached body instead of blocking on a
  live page fetch, and an entry entering its refresh window runs the source's cheap
  version probe — keeping the cached body when the page hasn't moved, reloading in
  the background when it has.

  To support the probe, `DocumentContent` now carries an opaque `version` token and
  `DocumentSourceProvider`/`DocumentContentResolver` gain a `probeVersion` method
  (metadata-only, strictly cheaper than a full fetch), implemented across all
  document providers. The self-verifying cache stays enabled on the Cloudflare
  Worker (bounded staleness via the probe), unlike the mutable-state fragment
  catalog.

  Behavior change (pre-1.0, no back-compat): the durable `prompt_fragments.body` is
  now the offline fallback + management-view content, refreshed only by an explicit
  create/refresh; the live run-time body flows through the cache. Without a cache
  wired, a run serves the persisted body and does not re-resolve live.

### Patch Changes

- Updated dependencies [e5ddaa4]
  - @cat-factory/kernel@0.84.0

## 0.2.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [9bac054]
  - @cat-factory/kernel@0.83.0
