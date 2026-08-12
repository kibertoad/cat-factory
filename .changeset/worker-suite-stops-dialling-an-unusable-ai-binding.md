---
'@cat-factory/orchestration': patch
---

Stop a run refusal from floating a phantom unhandled rejection on the Worker.

`RunLifecycleController.start` / `startAgentKind` returned `launch(...)` without awaiting it, and
`launch` refuses SYNCHRONOUSLY (the launch-constraint gate, the gate-override arity check). A bare
`return` therefore handed an already-rejected promise to the async function's adoption step, which
attaches its handler one microtask later: workerd's unhandled-rejection detector runs at the end of
the current microtask checkpoint and saw a rejected promise nobody was watching, while V8's own
detector waits a turn longer and never did. The caller was awaiting it the whole time, so nothing
was ever unhandled; on Cloudflare it simply read in the logs like a crash rather than the 422 it is.
