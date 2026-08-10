---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Add deployment provisioning to `/api/v1`, so a workspace can be taken from "connected" to "able to
run a pipeline" with no browser. Surface version 1.41.0; every change is additive.

Eight new operations: `POST /api/v1/repos/bootstrap` and `GET /api/v1/repos/bootstrap/{jobId}` create
a repository and adapt it with the bootstrapper agent; `POST /api/v1/environments/connections` and
`.../test` bind or probe the cluster per-run environments deploy onto; `PATCH
/api/v1/services/{serviceId}` declares where a service's manifests live; and `GET /api/v1/models`,
`GET /api/v1/vcs/connection` and `GET /api/v1/merge-presets` report what the deployment has wired. All
`admin`, including the reads: they name deployment configuration rather than board content, and a
caller that can read them is already at the rung that could change them.

`PublicService` also gains an optional `provisioning`, so a caller that just set it can confirm what
landed. It is projected only for the shapes this surface publishes; a service provisioned through
another engine reports nothing rather than a coerced value.

No breaking change: nothing published was renamed, retyped or re-scoped, and the SDKs tolerate the new
enum members by design.
