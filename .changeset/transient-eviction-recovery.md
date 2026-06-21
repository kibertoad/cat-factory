---
'@cat-factory/contracts': patch
'@cat-factory/orchestration': patch
'@cat-factory/worker': patch
---

Recover container evictions caused by a deploy rollout instead of failing the run.

A pipeline run whose per-run container was drained by a Cloudflare new-version
rollout (the runtime SIGTERMs the sandbox, exit 143, while a deploy rolls out) was
failing as `evicted`: a rollout can cycle the container two or more times in seconds,
which exhausted the single crash-eviction recovery budget and tripped the
"deterministic" path. This is transient infrastructure churn, not a sick run.

The execution engine now distinguishes a _transient_ eviction from a crash/OOM and
recovers it on a larger budget (`MAX_TRANSIENT_EVICTION_RECOVERIES`), tracked on its
own `PipelineStep.transientEvictionRecoveries` counter; recoveries are naturally
spaced by the job poll interval, so a bounded handful rides out a normal rollout
window. The engine stays runtime-neutral — it only knows "transient vs crash",
keyed on a generic `TRANSIENT_EVICTION_MARKER`. The Cloudflare facade owns the
mapping: `ExecutionContainer` detects the rollout signal (via `onError`/`onStop`,
persisted to DO storage) and the transport tags the eviction with the neutral marker
after asking the container whether it was just rolled out. The `evicted` failure hint
no longer over-points at memory/instance size, since a rollout is the common cause and
a plain retry succeeds once the deploy finishes.
