---
---

Docs: rewrite the backend "Deploying" section into an accurate, complete
configuration reference for self-hosting cat-factory. Reorients it around the
`deploy/backend` deployment package (post library/deployment split), adds a
`[vars]`-vs-secret map, corrects `CONTAINER_IMPL_ENABLED` / `WORKER_PUBLIC_URL`
(they are vars, not secrets), documents the `WORKER_PUBLIC_URL` must-be-`workers.dev`
caveat and the `ENVIRONMENT = "production"` auth hardening, and covers the opt-in
integrations (GitHub App + two-app tier, document/task/environment sources, the
self-hosted runner pool, and the prompt-fragment library). Also adds `ENVIRONMENT`
to the example `deploy/backend/wrangler.toml`. No code or package changes.
