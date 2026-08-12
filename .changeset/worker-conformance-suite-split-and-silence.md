---
---

Test-only, no shipped artifact changes: the Worker test pool now runs with the `AI` binding unbound
(the binding has no local simulator, so every inline call it served could only reject after the AI
SDK's retries, and the resulting 111 unhandled rejections per run were absorbed by a blanket
`dangerouslyIgnoreUnhandledErrors` that absorbed genuine ones with them); the Worker's conformance
monolith is split per group so vitest's file-count sharding can balance the lane; and all three
facade suites silence the app's own logger on a green run.
