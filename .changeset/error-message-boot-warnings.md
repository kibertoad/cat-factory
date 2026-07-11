---
'@cat-factory/server': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Boot-time structured warnings for three previously-silent misconfigurations (error-message
coverage initiative, items A5/A9/A10). Each is a single greppable WARN naming the offending
var, its consequence, and a doc link — behaviour is unchanged (the conditions were, and stay,
non-fatal); they were just invisible until the first dispatch failed.

- **A5** — the Node facade's container agent executor is disabled when a prerequisite is
  missing (`PUBLIC_URL`, `AUTH_SESSION_SECRET`, a runner backend, or a GitHub token source),
  but the service still boots "healthy" and repo-operating steps (coder/mocker/tester/merger/…)
  failed only at dispatch, deep in a request. It now logs at boot exactly which prerequisite is
  missing, so the gap is visible up front (the Worker already throws a `configProblem` here).
- **A9** — an unrecognised `LOCAL_CONTAINER_RUNTIME` value silently fell back to `docker`; the
  local preflight now names the rejected value, the accepted set
  (`docker`/`podman`/`orbstack`/`colima`/`apple`), and the fallback taken.
- **A10** — a half-set `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` pair silently disabled
  Cloudflare Workers AI (over REST) on the Node facade; config load now names which half is set
  and which is missing.

Adds a `localMode` section anchor to `@cat-factory/server`'s `ENV_VARS_ANCHORS` so the A9
warning deep-links the local-mode env-var docs.
