---
'@cat-factory/local-server': patch
---

Run the five remaining telemetry conformance suites against the local `node:sqlite` store.

`defineLlmMetricsSuite`, `defineAgentContextSuite`, `defineAgentSearchQuerySuite`,
`defineProvisioningLogSuite` and `defineSubscriptionQuotaSuite` each ran against D1 and Postgres
but never against the store a mothership-mode laptop actually records its own runs in, whose
coverage was a hand-rolled 813-line sibling. The bespoke describes the suites subsume are deleted;
what stays is what is local-only (the synchronous batch transaction, the exact prune count, the
ingest reader). The shared provisioning-log suite also gains the `targetId` filter case the local
file had and the suite lacked, so all three stores now assert it.
