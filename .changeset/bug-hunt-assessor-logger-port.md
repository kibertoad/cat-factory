---
'@cat-factory/orchestration': patch
---

Fix the `@cat-factory/orchestration` build: `BugHuntAssessorService` declared a local
`{ warn(obj, msg?) }` logger interface, which is the banned pre-port shape and the opposite
argument order from the kernel `Logger` the container actually wires. It typechecked in isolation
and failed the moment `createCore` passed the real logger in, taking the whole build graph
(and every downstream package's tests) with it. It now takes the kernel `Logger` port and emits
message-first.
