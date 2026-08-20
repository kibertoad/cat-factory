---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
---

Inline use cases: a deployment declares non-container model work, and `/api/v1/use-cases` publishes and runs it.

A wrapper over the public API (an external content editor, a writing tool) can now generate through
this deployment rather than beside it. A deployment registers named units of model work on the new
app-owned `InlineUseCaseRegistry`, injected like every other registry
(`start({ inlineUseCaseRegistry })`, `startLocal(...)`, the Worker override). Each registration
NARROWS the models it may run on, declares the parameter form it accepts in the shared descriptor
vocabulary a reusable operation's brief already uses, and states the temperature / output bounds an
invocation may steer within.

Three additive endpoints, surface version 1.59.0: `GET /api/v1/use-cases` (the catalog, `read`),
`GET /api/v1/use-cases/{useCaseId}` (`read`), and
`POST /api/v1/use-cases/{useCaseId}/invocations` (`write`), which runs one SYNCHRONOUSLY and answers
with the text. There is no task, repository, pipeline, container or run behind it, and nothing is
persisted: the only durable trace is the `llm_call_metrics` row, tagged with the use case's id as
its agent kind, so an editor's spend is attributable per use case.

Two behaviours are choices worth knowing before building against it. A model outside the use case's
declared list, and a model this deployment cannot serve inline, are both REFUSED rather than swapped
for another, because a narrowed list that substitutes silently is not a narrowing and the caller
cannot see it happened; each published model carries whether it is servable and which of the two
causes it is not. And a reply with no usable text answers `503 use_case_empty_reply` rather than a
`200` carrying an empty string, which an editor would otherwise store as the model's answer.

An invocation answers to the workspace budget safeguard, for the same reason the bug hunt's ranking
does: it is a billable model call that no run start gates. Discovery does not: it answers on a
deployment with no model provider at all, with every model marked unavailable, because an empty
catalog and a missing surface are different facts.
