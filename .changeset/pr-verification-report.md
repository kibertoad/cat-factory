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

Provider-neutral: it publishes through the facade's ENGINE VCS client, so a GitLab deployment
gets the report on its merge-request description too. **Breaking for port implementors:**
`GitHubClient` and `VcsClient` gain a required `getPullRequestBody` method (the read half of the
read-splice-write upsert). Wiring is per facade (Worker ⇄ Node/local) alongside the existing
merge/mergeability providers; with no VCS client wired the engine behaves exactly as before.
The SPA gains a narrow boot-time deep-link replay (`?ws=…&block=…&run=…&view=observability`) so
the report's observability link resolves.
