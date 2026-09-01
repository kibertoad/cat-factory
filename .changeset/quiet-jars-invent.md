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

Diagnose an environment that never became usable, instead of ending the run at the tester

A provisioning failure that no edit in the checkout could fix used to be terminal and
unexplained: the `deploy-fixer` correctly declines every cause outside `manifest_invalid`, and
nothing else looked. The run died at the tester with a report saying a human had to look, while
the facts that explained it sat unread in the provider's own response.

A `deployer` step now investigates such a failure. The platform gathers the evidence it already
had (the environment record, the WHOLE captured provision-field bag rather than the four fields
a consuming step is handed, and the run's provisioning timeline), asks the provider for its own
account through a new optional `EnvironmentProvider.diagnostics` capability, and runs one inline
model call that names the fault layer and picks one remediation from a list the engine narrowed
first. The engine performs it and the deployer re-enters its own path, so the provider's next
verdict is what settles the frame. When nothing is worth trying, the run still fails, but with a
named cause instead of a tester's guess.

The Kubernetes backend implements the new capability: `describe` reads the namespace phase, the
Deployments' unsatisfied conditions, every pod through `analyzePodStatus`, the namespace's
warning events and a log tail from each unhealthy pod, and `remediate` rolls the Deployments the
`kubectl rollout restart` way. Every other provider is unaffected and degrades to the platform's
own evidence, which it states rather than presenting as an absence of problems.

Internal break: `EnvironmentProvisioningServiceDependencies` gains an optional
`readProvisioningLog` and an optional `logger`; both facades wire them through the shared
container, so nothing outside a hand-built instance is affected.

The provisioning-log operation vocabulary gains `remediate`, and the platform appends one such row
whenever it asks a provider to repair an environment in place. It is a distinct actor, the way
`teardown-verify` is: the investigation's own second round rebuilds its timeline from that log, so
an unlogged restart leaves the next round reasoning about an environment it believes nothing has
touched. Additive on `/api/v1` (spec `info.version` 1.63.0); the clients tolerate unknown enum
values, and a consumer that maps `operation` through an exhaustive table gains a member to name.
