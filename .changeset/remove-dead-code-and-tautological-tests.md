---
'@cat-factory/acceptance-kit': patch
'@cat-factory/agents': patch
'@cat-factory/app': patch
'@cat-factory/cli': patch
'@cat-factory/consensus': patch
'@cat-factory/contracts': patch
'@cat-factory/deploy-harness': patch
'@cat-factory/gatekeeper-worker': patch
'@cat-factory/gitlab': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/local-server': patch
'@cat-factory/node-server': patch
'@cat-factory/observability-otel': patch
'@cat-factory/orchestration': patch
'@cat-factory/prompt-fragments': patch
'@cat-factory/sdk': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/workspaces': patch
---

Cleanup pass with no behaviour change: deletes exports nothing consumed (dead constants, parse
wrappers, alias schemas, pass-through re-exports and the Worker's compat-shim modules left over
from the `@cat-factory/server` extraction), drops the `export` keyword from module-local symbols,
folds duplicated private helpers onto one owner (base64, `scrub`, `sleep`, `withFlag`, the
per-row busy guard), and removes tests that asserted a constant against its own literal or
re-implemented the code under test. The SPA's unreachable palette drop handler goes with it.

Internal-surface break, flagged per the compatibility rules: the removed barrel exports
(`DEFAULT_CI_MAX_ATTEMPTS`, `STANDARD_PHASES`, `isTestingKind`, `isBugFishingPhaseId`,
`SEALED_SECRET_SOURCE_NAMES`, `TelemetryReadResults`, `LinearFetchLike`, `ENVIRONMENT_BLOCK_TYPE`,
the contracts `parse*`/`safeParse*` one-liners and the `initiativePreset*`/`taskTypeFieldOption`
schema aliases) had no consumer in this repository; a downstream import of one of them fails at
typecheck and should read the underlying helper directly.
