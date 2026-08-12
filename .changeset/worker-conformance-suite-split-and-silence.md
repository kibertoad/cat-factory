---
---

Test-only, no shipped artifact changes: the Worker test pool now runs with the `AI` binding unbound
(the binding has no local simulator, so every inline call it served could only reject after the AI
SDK's retries, and the resulting 111 unhandled rejections per run were absorbed by a blanket
`dangerouslyIgnoreUnhandledErrors` that absorbed genuine ones with them); the Worker's conformance
monolith is split per group so vitest's file-count sharding can balance the lane (with a new
`repo-guards` check requiring every group to run on every facade, since wiring the suite is now
fifteen registrations rather than one and a facade missing a group reports green); and all three
facade suites silence the app's own logger on a green run, re-establishing the gate per test so an
entry point that applies its own log settings cannot un-silence the rest of the run.
