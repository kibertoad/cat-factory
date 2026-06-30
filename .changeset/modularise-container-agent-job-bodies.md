---
'@cat-factory/server': patch
---

Internal refactor: extract the per-kind harness job-body builders (`buildKindBody`,
`buildRegisteredAgentBody` and `buildMigratedBuiltInBody`) out of
`ContainerAgentExecutor.ts` into a dedicated `jobBody.ts` module as free functions over a
shared `KindBodyParts`, re-imported at the single `buildJobBody` call site. The existing
`containerAgentJobBody.spec.ts` snapshots (driven through the public `startJob`) stay
byte-identical. Pure code move — no behaviour, API, or wiring change.
