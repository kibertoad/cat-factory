---
"@cat-factory/orchestration": patch
---

ExecutionService split, phase 1: lift the `deployer` and `tracker` step branches out of
`stepInstance`'s per-kind body into dedicated `StepHandler`s (built inline in the engine,
each delegating to the existing `runDeployer`/`runTracker` paths). Behaviour-preserving;
verified on both runtimes via the cross-runtime conformance suite.
