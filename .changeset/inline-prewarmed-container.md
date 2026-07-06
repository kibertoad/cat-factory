---
'@cat-factory/executor-harness': minor
'@cat-factory/local-server': minor
'@cat-factory/node-server': minor
'@cat-factory/orchestration': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/consensus': minor
---

Inline subscription LLM steps can now run inside a prewarmed local container on a leased
subscription credential (initiative phase C2). The executor-harness gains a one-shot `inline`
job kind that runs `claude -p` / `codex exec` with no checkout and returns the completion text +
usage; the local `LocalContainerRunnerTransport` leases a warm pool member to serve it. The
local inline resolver now selects the developer's host CLI when its binary is present (ambient,
unmetered) and otherwise the container backend on a leased credential — personal per-run
activation for an individual vendor (Claude/Codex/GLM), a pooled token otherwise (Kimi/DeepSeek).
This lets a subscription-only preset run its inline reviewers/brainstorm/estimator even when the
host has no `claude`/`codex` binary and in mothership mode, and extends inline coverage to the
non-native claude-code vendors.

Mechanics: `ModelScope` gains an `executionId` run dimension and `resolveScopedModelProvider`
takes the full scope; the inline callers (the iterative reviewers, the doc/initiative
interviewers, the tester quality companion, Kaizen, and the AI/consensus agent executors) thread
the run's execution + initiator so the container backend can lease the right credential.
`buildNodeContainer`'s `wrapModelProviderResolver` seam now receives the subscription lease
closures. Bumps the executor-harness image tag (the harness `inline` kind is new image code).
