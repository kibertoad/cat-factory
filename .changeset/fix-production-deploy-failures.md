---
---

Fix production deploy failures: build @cat-factory/contracts before the
frontend `nuxt generate` (mirrors the backend `predeploy` hook), and document
the required R2 token scope for the backend Worker deploy.
