---
'@cat-factory/worker': patch
---

Split the Worker's agent-executor resolution out of `buildWorkerCoreDependencies` into
`selectWorkerAgentExecutor`, matching the file's existing selector idiom. No behaviour change: the
executor is composed from the same inputs in the same order, and the test override still wins.
