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
---

Price the three input token classes at their own rates and surface the resulting cost on the run
and debug surfaces.

`ModelPrice` gains `cacheReadPerMillion` / `cacheWritePerMillion`, derived from the base input
rate where an entry names neither. This fixes a spend-gate defect as well as adding a display:
the ledger previously metered every input token at the fresh rate, so a cache-read-dominated run
was priced at roughly ten times its real cost and could exhaust a budget it had barely touched.

The telemetry stores now aggregate one grain finer (`agentKind, phase, provider, model`) so a
run's rollup can be priced while the model is still attached, and `priceRollupCells` folds the
model away again — every consumer reads the same `(agentKind, phase)` shape it did before, now
carrying `costEstimate`. An unpriceable slice reports `null` rather than `0`, and a total
containing one propagates that null instead of reporting a partial sum as complete.
