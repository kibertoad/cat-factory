---
'@cat-factory/kernel': minor
'@cat-factory/orchestration': patch
'@cat-factory/contracts': patch
---

Secret-scrub agent-context snapshots before they are persisted to telemetry.

`AgentContextObservabilityService.record` now runs every stored body — the composed
system/user prompts, the folded-in fragment bodies, and every injected context-file
content — through `redactSecrets`, deep-scrubs the free-text values in the `extras` bag
(the run's decisions and revision feedback), and drops the whole body of a context file
whose name marks it as a raw credential store (`.env`, `*.pem`, an SSH key, `.npmrc`,
`.git-credentials`, …). Previously only the dispatch-site allow-list guarded these bodies,
so a token embedded in a task description, a decision note, a linked doc, or an injected
`.env`-shaped file was stored verbatim when `storeAgentContext` was on. Scrubbing happens
before the size budget so truncation can never split a secret across the cap.

`redactSecrets` additionally matches PEM-armored private keys by their armor header, so a
key pasted into any prompt or ordinarily-named file is dropped regardless of filename.

Adds `isSecretShapedFilename` and `redactSecretsDeep` to `@cat-factory/kernel` (alongside
`redactSecrets`) and the first unit coverage for the previously-untested `redactSecrets`
scrubber.
