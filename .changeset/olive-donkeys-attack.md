---
'@cat-factory/kernel': minor
'@cat-factory/spend': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
---

Price the three input token classes at their own rates and surface the resulting cost on the run
and debug surfaces.

`ModelPrice` gains `cacheReadPerMillion` / `cacheWritePerMillion`, derived from the base input
rate where an entry names neither. This fixes a spend-gate defect as well as adding a display:
the ledger previously metered every input token at the fresh rate, so a cache-read-dominated run
was priced at roughly ten times its real cost and could exhaust a budget it had barely touched.

The telemetry stores now aggregate one grain finer (`agentKind, phase, provider, model`) so a
run's rollup can be priced while the model is still attached, and `priceRollupCells` folds the
model away again, returning the `(agentKind, phase)` cells every consumer already read, now
carrying `costEstimate`. That collapsed cell is its own type (`LlmRollupCell`), so a reader
cannot ask it which model it was: after the fold there is no single answer. An unpriceable slice
reports `null` rather than `0`, and a total containing one propagates that null instead of
reporting a partial sum as complete.

Public API (`/api/v1`), additive, `info.version` 1.1.0 → 1.2.0: the debug run overview's LLM
rollups carry `costEstimate` and the block carries `costCurrency`. The four SDK clients are
regenerated; the Python and Java manifests are bumped so the new models publish.

The run's LLM-metrics export now states whether it is `truncated`. It is capped at the newest
1000 calls, and a cost folded from that slice would be a smaller number that still reads as the
run's total, so a truncated bundle reports null costs rather than pricing the part it holds.
