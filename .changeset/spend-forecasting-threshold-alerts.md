---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/spend': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/conformance': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Warn about spend BEFORE the safeguard starts pausing runs. The budget gate was purely reactive:
`isOverBudget` paused a run at the ceiling and a `budget_paused` card appeared, so the first
signal a team got that their budget was running out was a pipeline stopping halfway through. The
new forecast layer measures a trailing-window burn rate, projects the period total, and raises a
`budget_threshold` notification once metered spend crosses 80% of the workspace or account budget,
or is projected to overrun it before the period ends. Gating is untouched: the forecast is
advisory, so a projection bug can cost a wrong card and never a paused or unpaused run.

The burn rate divides by the span the ledger was actually OBSERVED over, not the nominal window.
Without that, a workspace that started spending two hours ago is divided by seven days and reads
as 1/84th of its real pace, which is exactly the runaway the alert exists to catch. Below six
hours of history the projection is withheld rather than published as a number nobody should act
on, and `insufficient-history` is reported as its own state rather than rendered as a calm zero.

The card notifies once per crossing per period and re-arms at the period rollover. Its persisted
state IS the card row, read back through a new `listLatestByType` that ignores card status
deliberately: a crossed threshold stays crossed for the rest of the month, so reading only OPEN
cards would re-alert every fifteen minutes the moment somebody tidied their inbox. Its title and
body therefore name only stable facts (the threshold, the limit), never the live spend or burn
rate, which would re-toast the inbox on every sweep. The sweep runs on both facades from the same
shared driver and cadence; it is not behind an opt-in flag, because having configured a budget is
the opt-in. The USER budget tier is deliberately not alerted on: a personal budget is not a fact a
workspace-visible card may state, and there is no per-user inbox to raise it in.

`budget_threshold` is Slack-routable (unlike `budget_paused`, which arrives too late to act on).

Also adds two TCO axes to the Reports spend rollup: `repo` and `ticket`, grouping spend by the
run's linked repository and by the tracker issue linked to the run's block. Both are one grouped
query rather than a hand-written join against the database. A block legitimately linked to several
tickets is attributed to one deterministically (the lowest `source:externalId` ref) rather than
fanned out, which would have multiplied that block's cost by the number of tickets pointing at it
and left the breakdown disagreeing with the window totals.

The public API's notification-type enum gains `budget_threshold` (an additive change; OpenAPI
`info.version` 1.3.0 → 1.4.0, SDK clients regenerated). It is NOT in
`DEFAULT_NOTIFICATION_WEBHOOK_TYPES`: like the other operator-concern cards it ships only to
webhooks that name it in their `types` filter.
