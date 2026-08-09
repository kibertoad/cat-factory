---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Put a run's live environments on the outcome summary (spec 1.36.0, outcome `version` 3). Additive.

The outcome summary gains an `environments` section: one row per throwaway environment the run
stood up, carrying its URL, its state, the TTL instant when the platform recorded one, the service
frame it belongs to, the environment id an operator greps for, the producer's verbatim cause, and
whether the run's deployer declared that the environment outlives the run. The app's outcome card
renders it beside the captured views, and `GET /api/v1/runs/:runId/outcome` serves the same
reduction, so "click and look" no longer means opening the step that provisioned it.

`state` is the field that matters and `live` is the only one that offers a link. Every other row
(`provisioning`, `failed`, `reclaiming`, `reclaimed`, `expired`) still carries whatever URL it had,
because that is what names the environment, so a consumer rendering the URL without the state
beside it hands someone a link to something that is no longer there. Three producers know something
about the same environment and they are read in strict precedence: the disposer's terminal record
wins over the run's step projection (it is written after the run's polls stop refreshing it), and
the projection wins over the deployer's provision-time row. A reclaim that FAILED leaves the row
`live` with the provider's cause beside it: the environment is still standing and its URL still
works, and that it should not be is the verification report's teardown proof rather than this
section's question.

Absences stay three distinct facts: `no_environment_step` (the pipeline provisions nothing),
`not_provisioned` (something was meant to and nothing is recorded yet) and `infraless` (every frame
declares no environment of its own). `hasOutcomeToShow` counts a reported environment, so the "read
the result" affordance now appears on a run whose only product so far is something to look at.

The rules this shares with the PR verification report moved into contracts' `run-evidence.ts`
beside the tester rules: which step carries the per-frame outcomes, which carries the reclaims,
which recorded lifecycle states mean an environment is gone, and whether the deployer declared
retention. `DEPLOYER_AGENT_KIND` / `DISPOSER_AGENT_KIND` are defined there now and re-exported from
`pipeline-environment-lifecycle.ts` under the same names, so no importer moves.
