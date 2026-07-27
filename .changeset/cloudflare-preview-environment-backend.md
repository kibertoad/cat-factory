---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/app': minor
---

Add a built-in **Cloudflare Workers preview** environment backend (provision type `cloudflare`,
infra engine `cloudflare`, backend kind `cloudflare`).

It stands up a per-PR Cloudflare Worker by driving the target repository's OWN preview workflow
over the VCS Deployments API — create a deployment, read its statuses for readiness, post an
`inactive` status to tear down. That is three plain HTTPS calls, so it works identically on every
facade, including the Cloudflare Worker one that has neither a Docker daemon nor a filesystem.
Building a Worker needs a CI runner no facade has; the repository already has one.

This replaces the hand-pasted `remote-custom` manifest that shipped in `deploy/preview/cloudflare`,
and it is not only ergonomics — each of the manifest's limits was structural:

- it pinned ONE `owner/repo` and one workers.dev subdomain into JSON the operator had to
  substitute by hand. The backend resolves the repository per run from the service frame, so one
  handler serves every repository in the workspace.
- it could not observe readiness. The statuses endpoint returns an array whose shape the generic
  response mapping cannot extract a URL from, so a `status` request would have mapped the URL
  back to `null` — the manifest therefore had to assert `ready` the moment the deployment record
  existed. The native backend reports `provisioning` until the workflow actually succeeds, and
  every reconcile point converges on the real state.
- it rendered a missing `{{input.pullNumber}}` as an empty string, so a run with no open pull
  request (a blueprint-only pipeline, the environment self-test) provisioned an environment named
  `pr-` at a URL nothing would ever answer, recorded as `ready`. The backend refuses that run with
  a message saying why.

It also pre-flights (`validateRepo`) that the target repository actually carries a preview
workflow, so a missing one is a legible failure at the start rather than an environment stuck
`provisioning` until its TTL.

`ProvisionType` and `InfraEngine` each gain a `cloudflare` member. Both are closed unions guarded
by exhaustive `Record`s in the SPA, so a consumer switching on either will fail its typecheck
until it handles the new member.
