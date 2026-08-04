---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Alert on a NAMED failure kind crossing its own rate, not just on one kind swamping the rest.

`platform_health` could already say "nearly every failure shares one cause" (`failure_kind_dominant`,
80% by default), which is a question about the shape of the distribution. It could not say "more
than 5% of failures are evictions", and no single ceiling can: 5% evictions is the container
substrate failing one run in twenty, while 40% `rejected` is the product working as designed. Which
kinds deserve their own ceiling, and where each sits, is a judgement about a particular deployment,
so it is configuration rather than a threshold the platform picks: `PLATFORM_ALERTS_FAILURE_KIND_RATES`
(`evicted=0.05:3,timeout=0.2`) sets the deployment's rules, and an account can replace them from the
platform-alert settings panel. Nothing fires until an operator names a kind, so a deployment that
configures none is byte-for-byte unchanged.

Two things about the new condition are worth reviewing carefully. Its reason code is SHARED by every
rule, so the firing KINDS now ride the `platform_health` card beside the reasons and are the other
half of the card's dedup identity: without them, evictions subsiding while timeouts crossed the same
rule is an unchanged firing set, and the card goes on naming the incident that ended. And each rule
carries its own `minCount` (default 1), because the shared `minRuns` sample stops protecting anything
at a low ceiling: five terminal runs with a single eviction is already 20%.

Additive on `/api/v1`: OpenAPI `info.version` 1.4.0, a `failure_kind_rate_high` member on the
notification payload's alert reasons, a `platformAlertFailureKinds` field beside it, and an optional
`kind` on the platform-health webhook's conditions (the delivery id names it, so several rules firing
at once no longer read as one code repeated). A stored rule names its kind as a plain string rather
than the closed failure-kind picklist, deliberately: a rule surviving a kind's retirement must still
parse, or one stale rule would take the account's whole settings row down with it and silently
discard the model policy beside it. The settings panel offers the current vocabulary and marks an
unrecognised stored kind as such rather than re-pointing it.
