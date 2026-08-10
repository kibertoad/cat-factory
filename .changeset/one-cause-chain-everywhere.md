---
'@cat-factory/kernel': patch
'@cat-factory/integrations': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/agents': patch
'@cat-factory/consensus': patch
'@cat-factory/gitlab': patch
'@cat-factory/workspaces': patch
'@cat-factory/cli': patch
'@cat-factory/observability-otel': patch
'@cat-factory/observability-langfuse': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/app': patch
---

Report the actual cause of a failure everywhere, not just on a "Test connection" button.

The previous slice taught the connection PROBES to read the cause chain, because on Node a transport
failure is `TypeError: fetch failed` and what happened hangs off `.cause`. It turned out the repo had
three describers of a thrown value and the other two stopped at `error.message`: `getErrorMessage`
(the string a human is shown, and what a persisted failure reason or a PR comment records) and
`describeError` (every log line). So a probe could name `connect ECONNREFUSED 127.0.0.1:6443` while
the log line and the toast for the same failure still said `fetch failed`, which is what made a
Kubernetes connect failure unexplainable even with the probe fixed.

All three now flatten through one kernel core (`shared/error-chain.logic.ts`): `.cause` plus each
`AggregateError` branch (so a dual-stack `localhost` reports what happened on each address), scrubbed
through `redactSecrets`, capped with a marker saying what it dropped, and bounded by link identity so
a cause cycle terminates. Roughly 90 hand-rolled `e instanceof Error ? e.message : String(e)` copies
across the backend now call `getErrorMessage`, and five local `errMessage`/`messageOf` wrappers are
deleted. Node's `/ready` is the one deliberate exception: it is public and unauthenticated, so it
keeps the outermost message rather than publishing the deployment's database address.

An error message may therefore now carry appended causes where it did not before. The opening phrase
is unchanged, which is what the downstream `/dispatch failed/i` and eviction-sentinel checks match on.

On the SPA, every failure toast goes through the one funnel that already existed for pipeline errors,
instead of 29 per-component copies of the same `notifyError(title, e)` and ~83 direct `toast.add`
calls rendering the raw message. Beyond the translated copy that funnel already resolved, a failure
toast now stays until dismissed instead of vanishing after about five seconds, its text is
selectable, and one click copies the whole report: the action that failed, the class of failure, the
backend's own account, and the `requestId` that is the only join between what the user saw and the
server log line explaining it.
