---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Classify environment provisioning failures by cause, and repair the one class a checkout edit can
actually fix. A provision whose `{{placeholder}}` cannot be filled is now refused BEFORE the apply,
naming the connection field that fills it, rather than rendering an empty string and letting the
platform reject the result and blame the file. Adds a provider-neutral seam (`environmentFailure`,
`unresolvedPlaceholders`, `describeUnresolvedPlaceholders`) so a deployment-registered environment
backend participates in the same classification as the built-ins.

On a `manifest_invalid` failure the `deployer` step now escalates to a new `deploy-fixer` agent,
which pushes a fix onto the pull-request branch, and re-provisions against it (twice by default,
configurable per step via `stepOptions.deployFix`). Every other cause takes the previous terminal
path unchanged. When the budget is spent the run fails and raises a new `deploy_blocked`
notification whose act retries the run, the `ci_failed` shape.
