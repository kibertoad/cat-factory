---
---

CI: add a change-gated production deployment pipeline (deploy.yml) that, on merge
to main, deploys only the surfaces that actually changed — D1 migrations, the
Cloudflare runner image, the backend Worker, and the frontend Pages SPA.
