---
---

Move the Cloudflare Worker runtime library from `backend/packages/worker` to
`backend/runtimes/cloudflare` (package name `@cat-factory/worker` unchanged),
introducing a `backend/runtimes/*` workspace home for deployment-runtime facades
alongside the framework-agnostic `backend/packages/*` libraries. No change to any
published artifact.
