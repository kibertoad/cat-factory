---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/kernel': minor
'@cat-factory/app': minor
---

Prove the test environment lifecycle on the pull request

The PR verification report already listed which ephemeral environments a run stood up, but it
could not show that anything was actually exercised against one, and its teardown verdict was
unreachable in practice: the per-step environment projection stops being refreshed when the run
settles, and the TTL sweep that reclaims the environment fires afterwards, so a report published
by the step hook said "still live" forever about environments the platform had destroyed on
schedule.

The section is now the three-leg proof a reviewer needs: the environment came UP at a recorded
time, evidence was CAPTURED from it while it was live, and it was TORN DOWN again. The dates come
from the provisioning event log (the only store that records them), the middle leg from the
tester's own report plus the screenshots it stored, and the verdict over the three is COMPUTED in
code with every missing or contradictory leg named, never read off an agent's claim that it tested
against a preview. The report links back to the captured evidence through a new `test-evidence`
run deep link.

Three distinctions are load-bearing. An empty timeline has four causes and they are not
interchangeable, so it carries a machine-readable `gap` naming which: no log wired, a read that
failed, a read too large to be complete, or a run that stood nothing up. Only the first is a
statement about how the deployment is configured. The teardown verdict is decided by environment
IDENTITY rather than by comparing a count of teardown rows to a count of ready frames, which is
the form that survives a run replacing an environment mid-flight (the superseded one's teardown
would otherwise balance the books while its replacement is still standing). And a tester that ran
against local dependencies is kept apart from one that did not say where it ran: its artifacts are
reported either way, but only a declared ephemeral run counts as evidence about the environment.

The teardown leg is closed out of band: `EnvironmentTeardownService` notifies a best-effort hook
from the one place that records a teardown attempt, wired to a new
`ExecutionService.refreshVerificationReport`, so reclaiming an environment republishes the report
that describes it. It fires on a FAILED attempt too, since a settled run has no step settlement
left and an environment the provider refuses to reclaim has to reach the PR as an operator's job.

Breaking: the report's JSON payload is version 4. `environments` gains `timeline`, `evidence`,
`proof` and `gaps`, and its `teardown` picklist gains `failed`. The rendered section is retitled
"Test environment lifecycle". External consumers pinned to version 3 must re-read the schema.
