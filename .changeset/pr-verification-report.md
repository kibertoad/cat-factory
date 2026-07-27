---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/gitlab': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': patch
'@cat-factory/app': minor
'@cat-factory/conformance': patch
---

PR verification report — the ENGINE now maintains a structured verification report on each
run's pull request, so a reviewer sees captured facts instead of the agent's own "tests pass"
prose. It carries the `ci` gate's aggregated verdict (per-check-run names/conclusions +
`ci-fixer` attempt count), the tester step's structured report, the `deployer` step's
ephemeral-environment lifecycle (per-frame outcomes + teardown state), the `merger`'s scored
assessment and the engine's resolved merge decision, run metadata (task, linked tracker issues,
repo/provider, pipeline, per-step agent kind + resolved model), and a deep link into the run's
observability panel — as human-readable markdown plus a fenced JSON block validated by the new
`prVerificationReportSchema`.

It is written as a marker-delimited region of the PR description and updated **idempotently in
place**, so a retry or re-run rewrites it instead of appending a second copy, and the agent's own
description is preserved. Composition happens as each step settles (an engine hook, not a new
pipeline step), so a run that fails or parks part-way still leaves its evidence on the PR, and a
section whose producing step didn't run says so explicitly rather than silently vanishing.

Everything the report interpolates is agent- or human-authored, and a pull-request description is
a PARSED, potentially PUBLIC surface, so the text boundary is explicit: every free-text field is
scrubbed with the same `redactSecrets` the telemetry store uses, and every interpolation
neutralises the host's auto-link triggers (`#123` / `@name` / `!123`, and a closing keyword in
front of an issue URL — which would otherwise CLOSE that issue when the PR merges), folds
newlines inside table cells, and balances any code fence the agent left open so the fenced JSON
block stays extractable. Lists are capped, and what was capped is named in the report's own
`truncations` log rather than silently shortened.

New per-workspace setting **`publishPrVerificationReport`** (default on, mirrored D1 ⇄ Drizzle
with a migration on both runtimes): a workspace that would rather keep its CI verdicts, test
outcomes and environment URLs off the pull request can decline. Turning it off stops future
writes; a report already on a PR is left as it is.

Provider-neutral: it publishes through the facade's ENGINE VCS client, so a GitLab deployment
gets the report on its merge-request description too. **Breaking for port implementors:**
`GitHubClient` and `VcsClient` gain a required `getPullRequestBody` method (the read half of the
read-splice-write upsert), and `PrVerificationReportPublisher` gains a required `resolveTarget`
(the engine states the repo/provider the ADAPTER resolved, never the run's last dispatch — which
on a multi-repo task is a peer repo, not the repo whose PR is being written to). Wiring is per facade (Worker ⇄ Node/local) alongside the existing
merge/mergeability providers; with no VCS client wired the engine behaves exactly as before.
The SPA gains a narrow boot-time deep-link replay (`?ws=…&block=…&run=…&view=observability`) so
the report's observability link resolves.
