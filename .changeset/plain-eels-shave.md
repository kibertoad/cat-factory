---
'@cat-factory/server': patch
---

Stop the public API's `pipeline_requires_decide_scope` refusal advertising parks it cannot answer.
The message named all four parking kinds plus the approval gate and promised a `decide`-scope key
could answer them through `/api/v1/runs/:runId/decisions`, which is true only of a requirements
review — so an operator following the advice minted a wider-scoped key and got a run whose only exit
is `POST /api/v1/jobs/:id/cancel`. It is now built from the pipeline's actual park surfaces, naming
the unanswerable ones and their real recovery. What is admitted is unchanged.
