---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/app': minor
---

Record which revision of a linked design a run actually built against.

The dispatch-time freshness check already computed the verdict and rendered it into the agent's
context, where it did its job and vanished with the container. So "did this run build from the
revision the designer is looking at" was answerable only while the run was live, and only by
re-probing the source, which by then answers about the revision it is at NOW. On a design under
active iteration that is exactly the wrong answer: a reviewer cannot tell an implementation that
MISREAD the design from one that faithfully implemented a revision the designer has since moved
past, and the two need opposite reactions.

Each dispatch now records the documents it put in front of its agent, with the verdict it reached
about each, on `step.contextDocuments`. The PR verification report gains a `Context sources`
section composed from those records, and the in-app run outcome card gains the matching "Built
from" list; both reduce the same records the same way, so the page a person reads and the report
a reviewer reads cannot disagree.

The write goes through the existing `StepObservations` seam rather than a call at each dispatch
site, which is what makes it correct: `buildContext` has two callers that resolve a full context
and start no job (the over-budget exemption probe, and a re-attach to a job a replayed dispatch
already started), so a source that recovered in between would otherwise overwrite the revision the
shipped job actually read with one it never saw.

A moved revision is DERIVED, not recorded. A row carries the last verdict, since that is the state
the run ended on, and that alone says the run ended current while saying nothing about the coder
step that finished before the edit landed. So both readers compute `movedDuringRun` from the
distinct revisions the run's own steps recorded and state it beside the revision rather than folded
into it.

Additive on the public surface: `PR_VERIFICATION_REPORT_VERSION` steps to 9, `RUN_OUTCOME_VERSION`
to 2, and the API to 1.25.0. `GET /api/v1/runs/:runId/outcome` grows a `sources` section beside the
existing ones and `GET /api/v1/runs/:runId/report` a `context` one; every section a consumer
already reads is byte-for-byte unchanged, and the four SDKs plus the MCP facade are regenerated
from the spec.
