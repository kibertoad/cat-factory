---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Put a run's live environments on the outcome summary (spec 1.38.0, outcome `version` 3). Additive.

The outcome summary gains an `environments` section: one row per throwaway environment the run
stood up, carrying its URL, its state, the TTL instant when the platform recorded one, the service
frame it belongs to, the environment id an operator greps for, the producer's verbatim cause, and
whether the run's deployer declared that the environment outlives the run. The app's outcome card
renders it beside the captured views, and `GET /api/v1/runs/:runId/outcome` serves the same
reduction, so "click and look" no longer means opening the step that provisioned it.

`state` is the field that matters and `live` is the only one that offers a link. Every other row
(`provisioning`, `failed`, `reclaiming`, `reclaimed`, `expired`) still carries whatever URL it had,
because that is what names the environment, so a consumer rendering the URL without the state
beside it hands someone a link to something that is no longer there. A client with a clock owes the
other half of that: `expiresAt` is served as an instant rather than folded into `state` (the
reduction is clock-free so the app and the endpoint cannot disagree about one run), so a `live` row
whose TTL has passed is not a URL to hand anyone.

Several producers know something about the same environment, and they are reconciled BY IDENTITY
before they are ranked: the run's step projections and the `human-test` gate's own record fold into
one observation per environment id, above which the disposer's terminal record wins and below which
the deployer's provision-time row is the floor. An environment a LATER deploy of the same frame
replaced is reported as gone, derived rather than observed, since nothing refreshes its projection
again. A reclaim that FAILED leaves the row `live` with the provider's cause beside it: the
environment is still standing and its URL still works, and that it should not be is the verification
report's teardown proof rather than this section's question.

Absences stay three distinct facts: `no_environment_step` (the pipeline provisions nothing),
`not_provisioned` (something was meant to and nothing is recorded yet) and `infraless` (every frame
declares no environment of its own). `hasOutcomeToShow` counts a reported environment, so the "read
the result" affordance now appears on a run whose only product so far is something to look at.

The rules this shares with the PR verification report moved into contracts' `run-evidence.ts`
beside the tester rules: which frames the run's deploys settled, what it observed of each
environment, which recorded lifecycle states mean one is gone, and whether the deployer declared
retention. The disposer reclaims by the same fold, so the set of environments a run stood up has one
statement rather than three. `DEPLOYER_AGENT_KIND` / `DISPOSER_AGENT_KIND` are defined there now and
re-exported from `pipeline-environment-lifecycle.ts` under the same names, so no importer moves.

A `deployer` step now also records the environment id on a frame whose provision FAILED, where the
provision got far enough to have a record to fail against. Internal step state, so stale rows simply
lack it; what it buys is that the failed environment the run projected is nameable as the one that
frame broke on rather than surfacing as a second environment nothing accounts for.

The spec generator's per-version changelog moved to `backend/docs/public-api-versions.md`, a
document rather than a 250-line comment block in a script: it grows with every release and never
shrinks, and the file-size ratchet said so first. Nothing about how the number is set changed, and
the note that makes the next silent version collision arrive as a merge conflict travels with it.
