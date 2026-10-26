# @cat-factory/example-delegated-executor

## 0.1.26

### Patch Changes

- Updated dependencies [fa0ba67]
  - @cat-factory/kernel@0.363.1
  - @cat-factory/agents@0.172.9

## 0.1.25

### Patch Changes

- Updated dependencies [e9b24a1]
  - @cat-factory/kernel@0.363.0
  - @cat-factory/agents@0.172.8

## 0.1.24

### Patch Changes

- 5c17395: Dependency refresh, direct and transitive (the lockfile is re-resolved from scratch), held to the
  24h `minimumReleaseAge` window.
  
  Majors, each taken because its whole peer group could move together:
  
  - **Vitest 5** (`vitest`, `@vitest/coverage-v8`, `@vitest/browser`, `@vitest/browser-playwright`
    at `5.0.5`), now that `@cloudflare/vitest-plugin@1.4.4`, `@storybook/addon-vitest`,
    `@nuxt/test-utils` and `vitest-browser-vue` all accept `^5`. The Worker suite turns Vitest 5's
    new default `fsModuleCache` off: the Workers pool inlines every warm module into one WebSocket
    reply, and this suite's graph (~80MB) exceeds workerd's message limit (`1009 Message is too
    large`).
  - **msw 3**, for the component stories. `onUnhandledRequest` became `onUnhandledFrame`, which
    also receives WebSocket frames, and the bundled `mockServiceWorker.js` is regenerated.
  - **happy-dom 21** for the SPA's unit tests.
  
  The Workers test pool moves to `@cloudflare/vitest-plugin@1.4.4`, which pins `wrangler@4.151.1`, so
  the Cloudflare stack moves with it: workerd `1.20261012.1`, miniflare `5.20261012.1-beta`,
  `@cloudflare/workers-types` `5.20261012.1` (the resolved workerd's date) and esbuild `0.28.2`
  (the version wrangler and the plugin now pin, so the scoped esbuild overrides follow).
  
  Also the Vercel AI SDK family as one set (`ai@7.0.142`, `@ai-sdk/anthropic@4.0.81`,
  `@ai-sdk/openai@4.0.95`, `@ai-sdk/openai-compatible@3.0.70`, `@ai-sdk/amazon-bedrock@5.0.117`,
  `@ai-sdk/provider@4.0.28`), the Vue family at `3.5.44`, `@nuxt/ui@4.12.0`, `pinia@4.1.0`,
  `storybook@10.6.2`, `undici@8.12.2`, `pg-boss@12.38.0`, `@aws-sdk/client-s3@3.1152.0`,
  `@hono/node-server@2.1.5`, `@playwright/test@1.64.1`, and the root toolchain (`turbo@2.11.8`,
  `oxlint@1.88.0`, `oxfmt@0.73.0`, `knip@6.41.0`).
  
  Held: the frontend stays on TypeScript 6 (TypeScript 7 ships no classic compiler API for
  `vue-tsc`); `@nuxt/fonts` stays on 0.14 because `@nuxt/ui@4.12.0` depends on `^0.14.0`; Drizzle
  stays on `1.0.0-rc.4`, still its `rc` tag; `nuxt@4.6.2` is inside the window.
- Updated dependencies [5c17395]
- Updated dependencies [5c17395]
  - @cat-factory/kernel@0.362.0
  - @cat-factory/agents@0.172.7

## 0.1.23

### Patch Changes

- Updated dependencies [83f6b0c]
  - @cat-factory/kernel@0.361.0
  - @cat-factory/agents@0.172.6

## 0.1.22

### Patch Changes

- @cat-factory/agents@0.172.5
  - @cat-factory/kernel@0.360.4

## 0.1.21

### Patch Changes

- @cat-factory/agents@0.172.4
  - @cat-factory/kernel@0.360.3

## 0.1.20

### Patch Changes

- Updated dependencies [6f574e9]
  - @cat-factory/kernel@0.360.2
  - @cat-factory/agents@0.172.3

## 0.1.19

### Patch Changes

- @cat-factory/agents@0.172.2
  - @cat-factory/kernel@0.360.1

## 0.1.18

### Patch Changes

- Updated dependencies [58b57cc]
  - @cat-factory/kernel@0.360.0
  - @cat-factory/agents@0.172.1

## 0.1.17

### Patch Changes

- Updated dependencies [918e977]
  - @cat-factory/agents@0.172.0
  - @cat-factory/kernel@0.359.1

## 0.1.16

### Patch Changes

- Updated dependencies [04c1587]
- Updated dependencies [f1b6c9a]
- Updated dependencies [20d4f01]
  - @cat-factory/kernel@0.359.0
  - @cat-factory/agents@0.171.7

## 0.1.15

### Patch Changes

- @cat-factory/agents@0.171.6
  - @cat-factory/kernel@0.358.1

## 0.1.14

### Patch Changes

- Updated dependencies [22b6812]
  - @cat-factory/agents@0.171.5

## 0.1.13

### Patch Changes

- Updated dependencies [5ec1794]
  - @cat-factory/kernel@0.358.0
  - @cat-factory/agents@0.171.4

## 0.1.12

### Patch Changes

- Updated dependencies [1a42f34]
  - @cat-factory/kernel@0.357.1
  - @cat-factory/agents@0.171.3

## 0.1.11

### Patch Changes

- Updated dependencies [e3c4b3c]
  - @cat-factory/kernel@0.357.0
  - @cat-factory/agents@0.171.2

## 0.1.10

### Patch Changes

- Updated dependencies [ffe4356]
- Updated dependencies [ffe4356]
  - @cat-factory/kernel@0.356.0
  - @cat-factory/agents@0.171.1

## 0.1.9

### Patch Changes

- Updated dependencies [97175f8]
  - @cat-factory/kernel@0.355.0
  - @cat-factory/agents@0.171.0

## 0.1.8

### Patch Changes

- @cat-factory/agents@0.170.1
  - @cat-factory/kernel@0.354.2

## 0.1.7

### Patch Changes

- Updated dependencies [8766c3f]
  - @cat-factory/agents@0.170.0
  - @cat-factory/kernel@0.354.1

## 0.1.6

### Patch Changes

- Updated dependencies [0ea28b8]
- Updated dependencies [0ea28b8]
- Updated dependencies [0ea28b8]
- Updated dependencies [0ea28b8]
  - @cat-factory/kernel@0.354.0
  - @cat-factory/agents@0.169.0

## 0.1.5

### Patch Changes

- Updated dependencies [075ff13]
  - @cat-factory/kernel@0.353.0
  - @cat-factory/agents@0.168.4

## 0.1.4

### Patch Changes

- Updated dependencies [57d9db3]
  - @cat-factory/kernel@0.352.0
  - @cat-factory/agents@0.168.3

## 0.1.3

### Patch Changes

- Updated dependencies [e84b0d5]
- Updated dependencies [e84b0d5]
- Updated dependencies [e84b0d5]
  - @cat-factory/agents@0.168.2
  - @cat-factory/kernel@0.351.0

## 0.1.2

### Patch Changes

- Updated dependencies [c046707]
- Updated dependencies [c046707]
  - @cat-factory/kernel@0.350.0
  - @cat-factory/agents@0.168.1

## 0.1.1

### Patch Changes

- Updated dependencies [7760397]
  - @cat-factory/agents@0.168.0

## 0.1.0

### Minor Changes

- bc073ab: Delegated executors: a pipeline step can now run in a system the deployment already operates (its own GitHub-Actions loop, job runner or PR bot) while cat-factory keeps the intake, the standards, the CI gate, the merge policy and the notifications around it.
  
  A deployment registers a `DelegatedExecutorDefinition` on the new app-owned `DelegatedExecutorRegistry` and points an agent kind at it with `agent: { surface: 'delegated', executor }`. The executor is handed the same brief the container harness composes, so a workspace's prompt overrides and agreed standards reach both identically; its credentials resolve per call through the existing `ToolSecretResolver` port and never touch the brief.
  
  Each definition declares who creates the work branch its dispatches name. `workBranch: 'platform-creates'` has the engine create it at the base head just before `start`, idempotently, which is what an external CI runner needs: `actions/checkout` on a branch that is not there fails the job before any of the work begins, and a runner that quietly substitutes a branch of its own publishes to a ref the platform never recorded. `workBranch: 'executor-creates'` writes nothing, so a run whose external work never landed leaves no empty ref behind. Either way the branch is the one the rest of the run uses: a task's own apriori working branch when it declared one (probed, never created, exactly as the container dispatch treats it), else `cat-factory/<blockId>`.
  
  Two things the platform states rather than guesses. A delegated step's model calls never reach this deployment's proxy, so the step card says "usage not reported by <executor>" and the run rollups carry `llm.reporting.delegatedStepsWithoutUsage` instead of rendering a zero. And a run stopped while external work is still running records whether it actually stopped: an executor that declares no `cancel` leaves its run alive, and the record says so.
  
  Ships with `@cat-factory/delegation-github-actions` (a `DelegatedExecutor` over Actions: correlation by run name, since `workflow_dispatch` returns no run id) and a runnable example under `backend/internal/example-delegated-executor`. Its `workflow` is a location or a function of the dispatch, so one registration can dispatch against every repository a deployment onboards; the resolver sees only facts a brief and a handle both carry, because `poll` and `cancel` run hours later holding just the handle.
  
  A failure the executor calls `retryable` (a cancelled run, a runner-pool restart, a rate limit) buys one fresh dispatch on an engine-set budget, and everything else is terminal. Registered executors reach their own systems through a fetch the platform has already guarded: the deployment's outbound-URL policy on the first URL and on every redirect hop (the same guard the notification webhook sender uses), a deadline so a hung endpoint cannot hold a poll open indefinitely, and a running byte cap on what one response may return.
  
  Two declaration-time refusals, because neither has a reading under which it does something. A definition whose credentials resolve to the same injection name is refused at registration: the bag an executor is handed is keyed by the name it reads, so one name can carry only one value. And a delegated kind naming an executor this process does not register is refused by name at dispatch rather than falling through to the container harness, which is the mothership-mode case where nothing boot-validates the kinds a node resolves.
  
  Public API 1.75.0, both additive: `AgentFailureKind` gains `delegated_failed`, so an external system's verdict is classified as its own thing rather than as a container that was shut down, and the `llm` totals on the two debug run surfaces gain `reporting`, saying how many of a run's steps ran on an executor that files no usage.
  
  Internals: `AgentSurface` gains `delegated`, `AsyncAgentExecutor.reclaimRun` may return a `RunReclaimReport`, `AgentJobHandle` and `DelegationHandle` carry the run's block (so a poll and a cancel resolve credentials in the scope the dispatch used), and `PipelineStep` gains `delegated` plus `delegatedRetries`. Five new `error.details.reason` values, all additive: `delegated_executor_unwired` (409), `delegated_step_async_only` (409), `delegated_claim_missing` (409), `delegated_executor_failed` (503) and `delegated_work_branch_unprepared` (503, the platform's own VCS write rather than the executor's system).

### Patch Changes

- Updated dependencies [1fc4ff1]
- Updated dependencies [bc073ab]
- Updated dependencies [09bd94b]
  - @cat-factory/kernel@0.349.0
  - @cat-factory/agents@0.167.0
