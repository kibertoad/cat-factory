---
'@cat-factory/server': patch
'@cat-factory/orchestration': patch
'@cat-factory/agents': patch
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
'@cat-factory/local-server': patch
'@cat-factory/executor-harness': patch
---

Internal refactor (lint complexity/size ratchet — `complexity` 60 → 40): extract cohesive helpers
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
