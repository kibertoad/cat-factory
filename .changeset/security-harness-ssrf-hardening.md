---
'@cat-factory/integrations': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/executor-harness': patch
---

Security hardening across three surfaces.

Local-runner SSRF: the server-side fetches to a user-supplied runner base URL (the "Test
connection" probe and the run-time LLM proxy forward) now follow redirects manually and
re-validate every hop against the loopback/LAN allow-list, so a reachable runner can no
longer `302` the server into the cloud-metadata endpoint or a public host. `localRunnerUrlError`
also rejects URLs with embedded credentials. New `fetchLocalRunner` helper in
`@cat-factory/integrations`.

Harness inbound auth: the Cloudflare container transport now sends the `x-harness-secret`
header and injects `HARNESS_SHARED_SECRET` into each per-run container's env when the secret
is configured, matching the harness server and the local Docker transport. Unset leaves the
harness open as before (it is only reachable via DO-internal addressing). The self-hosted
runner pool reaches the harness through its own control plane, so its secret is configured
pool-side.

GitHub API requests in the executor harness now build the PR-lookup query with
`URLSearchParams` and encode the owner/name path segments, so a branch or owner containing
`&`/`#` can't split the query or inject a parameter.
