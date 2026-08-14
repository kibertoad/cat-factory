---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Classify environment provisioning failures by cause, and repair the one class a checkout edit can
actually fix. A provision whose `{{placeholder}}` cannot be filled by the environment CONNECTION is
now refused BEFORE the apply, naming the field that fills it, rather than rendering an empty string
and letting the platform reject the result and blame the file. A placeholder the RUN supplies keeps
the documented lenient substitution, so a template folding an optional value into its output is
unaffected. Adds a provider-neutral seam (`environmentFailure`, `unresolvedPlaceholders`,
`describeUnfilledConfigPlaceholders`, and `ProvisionedEnvironment.reason` for a provider that
reports a failure without throwing) so a deployment-registered environment backend participates in
the same classification as the built-ins.

On a `manifest_invalid` failure the `deployer` step now escalates to a new `deploy-fixer` agent,
which pushes a fix onto the pull-request branch, and re-provisions against it (twice by default,
configurable per step via `stepOptions.deployFix`). Every other cause takes the previous terminal
path unchanged. When the budget is spent the run fails and raises a new `deploy_blocked`
notification whose act retries the run, the `ci_failed` shape.

The public API gains one additive notification type (`deploy_blocked`), so the OpenAPI surface moves
to 1.55.0 and the four SDK clients regenerate. It is in the default webhook type set, and its act
takes the same individual-usage-credential refusal `ci_failed` and `test_failed` already take.
