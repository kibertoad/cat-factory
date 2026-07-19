---
'@cat-factory/kernel': minor
'@cat-factory/orchestration': patch
---

Secret-scrub agent-context snapshots before they are persisted to telemetry.

`AgentContextObservabilityService.record` now runs every stored body — the composed
system/user prompts, the folded-in fragment bodies, and every injected context-file
content — through `redactSecrets`, and drops the whole body of a context file whose name
marks it as a raw credential store (`.env`, `*.pem`, an SSH key, `.npmrc`, …). Previously
only the dispatch-site allow-list guarded these bodies, so a token embedded in a task
description, a linked doc, or an injected `.env`-shaped file was stored verbatim when
`storeAgentContext` was on. Scrubbing happens before the size budget so truncation can
never split a secret across the cap.

Adds `isSecretShapedFilename` to `@cat-factory/kernel` (alongside `redactSecrets`) and the
first unit coverage for the previously-untested `redactSecrets` scrubber.
