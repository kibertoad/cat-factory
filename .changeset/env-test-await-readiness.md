---
'@cat-factory/orchestration': patch
---

Make the environment self-test WAIT for a synchronously-recorded env to become ready before tearing it down. Previously, a provider whose `provision()` returns immediately (a REST provider like a Kargo adapter, which responds with `provisioning`/no-URL and comes up asynchronously) had its env recorded at dispatch and torn down on the very next poll — the self-test only confirmed the create call returned a handle, never that the env actually stood up. `advanceProvisioning` now polls the provider's status (`refreshStatus`) for a synchronously-recorded env and stays in `provisioning` until it reaches `ready` (then tears down), fails the run on a terminal-not-ready status (`failed`/`expired`/torn down) carrying the provider's reason, and relies on the durable driver's existing poll budget to bound the wait. A provider that returns `ready` synchronously (e.g. compose) still advances on the first poll.
