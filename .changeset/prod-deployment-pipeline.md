---
---

CI: add a change-gated production deployment pipeline (deploy.yml) that, on merge
to main, deploys only the surfaces that actually changed — D1 migrations, the
Cloudflare runner image, the backend Worker, and the frontend Pages SPA. Deploy
jobs run under a protected `environment: production` (so the Cloudflare credentials
are scoped to those jobs and subject to its branch policy / required reviewers), the
workflow refuses to run from any ref other than main (a `workflow_dispatch` against
an unreviewed branch can't ship to production), and every job carries a
`timeout-minutes` so a hung deploy can't hold the deploy concurrency lock.
