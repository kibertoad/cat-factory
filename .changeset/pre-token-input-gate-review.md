---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
---

Answer the pre-token input gate over the public API, and stop it judging blocks that carry no
authored task input.

The gate is the one park that turns on the shape of the TASK rather than the pipeline, so the
public surface's park enumeration (which reads the step chain) could not see it: a `write`-scope
key could start a title-only task on a pipeline that parks nowhere and get a run stopped before
its first dispatch, with `GET /api/v1/runs/:runId/decisions` reporting `parked: true`, nothing to
answer, and cancel as the only exit. The verdict is now a parked decision of its own, resolvable
at `POST /api/v1/runs/:runId/decisions/input-gate/resolve` with the same `recheck` / `proceed`
choices the app offers, and admission composes it in, so a key that cannot answer the park is
refused up front with a message naming it. Additive on `/api/v1`: OpenAPI `info.version` 1.2.0,
and the four SDK clients gain `decisions.resolveInputGate`.

`not_applicable` now covers any block whose description is not authored task input, which is the
block LEVEL plus the recurring task type rather than a task-type list alone. A run started against
a frame, module, epic or initiative ANCHOR reads the entity it stands for, not the caption on the
card, so judging that caption parked every initiative planning run on a field the flow never fills
in. A task the platform merely CREATED with a real brief (an initiative-spawned item, a ticket
import) is deliberately still judged.

Advisory findings are also visible at last: they were recorded on the run and reported over the
API while rendering nowhere, which left `advisory` mode with nothing to watch.
