---
'@cat-factory/worker': major
'@cat-factory/app': major
'@cat-factory/contracts': major
'@cat-factory/core': major
'@cat-factory/prompt-fragments': major
---

Separate reusable libraries from deployment. The libraries now publish to npm
(`main`/`exports` point at built `dist`, with `files` + `publishConfig`); the
worker is no longer private and exposes its handler + Durable Object / Workflow
classes for deployments to re-export, and ships its D1 migrations. The frontend
SPA is now the `@cat-factory/app` Nuxt layer. Deployments live in `deploy/backend`
and `deploy/frontend`; the runner image publishes to GHCR. Releases are managed
with changesets.
