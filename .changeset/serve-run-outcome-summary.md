---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/agents': patch
'@cat-factory/app': minor
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

Additive on the public surface (OpenAPI `1.22.0`): the new endpoint, plus
`requirements.unmatchedVerdicts` on the verification report, which counts tester verdicts against
ids the spec does not carry. Those used to be dropped silently, which made the section report fewer
rulings than the tester made with nothing to explain the gap.

Internally: `TESTER_AGENT_KIND` and `isTesterKind` are now defined in `@cat-factory/contracts` and
re-exported by `@cat-factory/agents` and the engine (the SPA had a hand-written copy with the slugs
as literals), and the block + `spec/` reads both documents need are shared through a new
`RunEvidenceLoader`. The outcome summary's `spec` join vocabulary loses `unmatched` (a joined
section now carries every spec requirement, so a titleless row inside one cannot occur) and gains a
`no_requirements` gap.
