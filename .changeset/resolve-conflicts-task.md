---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/gates': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/gitlab': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': minor
'@cat-factory/sdk': patch
'@cat-factory/mcp-server': patch
'@cat-factory/gatekeeper-bindings': patch
'@cat-factory/app': minor
---

A new built-in `resolve-conflicts` task type points the conflict resolver at an existing open pull request the platform did not open (surface version 1.79.0). The task names it with `fields.prNumber` or `fields.prUrl`, and creation records it as the block's own `pullRequest`, refusing one the run could not push onto with a `422` and an `attached_pr_*` reason: not found, another repository, closed or merged, from a fork, targeting a branch other than the repository's base, or unreadable. When the repository provider fails to answer, creation is refused with a retryable `503` and reason `attached_pr_provider_unreachable` instead of a `500`.

The task is pinned to the new `pl_resolve_conflicts` pipeline, the `conflicts` gate alone, under a new `maintenance` pipeline purpose that only this task type is offered. It parks nowhere, so a `write` key starts it with an empty body. A clean pull request finishes `done` with nothing pushed; one the resolver cannot clear fails the run with a message saying the conflicts could not be resolved automatically and carrying the resolver's last account. A run of a task that attached its pull request finishes `done` without a confirm-and-merge card, and the pre-dispatch input gate does not judge its description. Run admission refuses a pipeline with a merge step for such a task, and a fields patch cannot move its attachment to another pull request while its run is working.

`OpenedPullRequest` gains an optional `crossRepository`, filled by the GitHub and GitLab clients, and `AgentRunContext.block` gains `taskType`, which the container executor reads to skip creating the per-task work branch for an attached pull request. The conflicts gate's give-up message now includes the last resolver attempt's summary.
