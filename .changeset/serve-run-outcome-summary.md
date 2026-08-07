---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/agents': patch
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
---

Serve the run outcome summary over `/api/v1`, and compose it from the same code as the PR
verification report.

`GET /api/v1/runs/:runId/outcome` answers the summary the app's outcome card renders: what the run
changed and what backs that up, for a reader who will not open a diff. It is the report's sibling on
the evidence surface, not a projection of it.

Serving it moved `composeRunOutcome` out of the SPA into `@cat-factory/contracts`, and moved the
rules it shares with the verification report (which tester steps count, the spec join, the
regression rule, the tallies) into `contracts/src/run-evidence.ts`, where both reductions call them.

**Behaviour change, and the reason for the whole change.** The two reductions had drifted. The
report unions every tester step's verdicts and counts coverage over the service's in-repo `spec/`;
the outcome summary read only the last tester that reported and counted over the verdicts that
tester happened to return. One run produced different `met` / `not covered` / `total` numbers
depending on whether you read the pull request or the app. The summary now follows the report's
semantics on both axes, so a requirement nobody looked at is reported as unchecked instead of being
invisible.

**Second behaviour change: the app's outcome card now joins against the spec on the RUN's branch.**
It fetched the enclosing service's spec from the repo's default branch, so while a pull request was
open every verdict naming a requirement the run itself added joined against a spec that does not
carry it yet and rendered as "not checked", and the card's counts then contradicted the endpoint,
which reads the run's branch. `GET /workspaces/:ws/executions/:executionId/spec` serves the card the
same read, through the same loader and the same branch rule.

Additive on the public surface (OpenAPI `1.22.0`): the new endpoint, plus
`requirements.unmatchedVerdicts` on the verification report, which counts tester verdicts against
ids the spec does not carry. Those used to be dropped silently, which made the section report fewer
rulings than the tester made with nothing to explain the gap. The report now RENDERS that count in
its prose rather than only carrying it in the JSON, and a spec that declares no requirements while
the tester did return verdicts is reported (0 requirements, every verdict unmatched) instead of
being called an absence, on both documents: it is a spec that moved under the run, and calling it
"nothing to rule on" discarded every ruling the tester made.

The outcome payload also gains `truncations`, in the verification report's own vocabulary. Served
over `/api/v1` it is scrubbed with `redactSecrets` and bounded, which the report has always done for
the same tester text on its way onto a pull request; unbounded, its size was set by how much a model
chose to write. The counts are computed before any cap, so a bounded response still reports the true
totals. The SPA composes the same reduction locally and caps nothing, so `truncations` is empty
there.

Internally: `TESTER_AGENT_KIND` and `isTesterKind` are now defined in `@cat-factory/contracts` and
re-exported by `@cat-factory/agents` and the engine (the SPA had a hand-written copy with the slugs
as literals), and the block + `spec/` reads both documents need are shared through a new
`RunEvidenceLoader`. The outcome summary's `spec` join vocabulary loses `unmatched` (a joined
section now carries every spec requirement, so a titleless row inside one cannot occur) and gains a
`no_requirements` gap.
