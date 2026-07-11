---
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

test(conformance): assert cross-runtime prune parity for four un-asserted retention prunes (audit item 7)

Four equally-swept retention prunes had no cross-runtime conformance assertion, so a D1 ⇄
Drizzle drift (wrong column, `<` vs `<=`, missing WHERE) could silently delete live data or
never reclaim. Adds a focused parity suite per store — `defineTokenUsageSuite`,
`defineCommitProjectionSuite`, `defineScheduleRunSuite`, `defineSubscriptionActivationSuite`
(`@cat-factory/conformance`) — each driving the same seed → read → prune assertions through
both facades' real repositories, and wires them into both the Worker (D1) and Node (Postgres)
test suites. Test-only; no runtime behaviour changes.
