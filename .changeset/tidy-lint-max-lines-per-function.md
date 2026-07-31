---
'@cat-factory/executor-harness': minor
---

Split the work-branch push machinery and the claude-code no-progress guard out of
`runCodingAgent` / `runClaudeCode` into their own factories. Behaviour-neutral, but it is a
change to the runner image's sources, so the harness version and its three pinned tags move
together.
