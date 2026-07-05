---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Record successful step outputs in the step-detail "execution history", not just failures.

A restart-from-step resets the chosen step and every later one, dropping their `output`;
previously that successful work was lost and the per-step history could only ever show
errors. The run now keeps an `outputHistory` — the positive complement of `failureHistory`
— capturing the successful outputs a restart superseded (attributed by step index, bounded
in count + per-entry size, riding the run's `detail` JSON with no schema migration). The
step-detail overlay renders a merged, newest-first timeline of these superseded outputs and
the failed attempts. A plain retry (which re-runs only unfinished steps) records nothing.
