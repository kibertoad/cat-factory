---
---

Fix production deploy failures and adopt Turborepo for the cross-package task
graph. The frontend deploy was failing because `@cat-factory/contracts` was never
built before `nuxt generate`; the backend deploy needs an R2-scoped Cloudflare
token (documented). Turborepo (`turbo.json`) now orchestrates
build/typecheck/test/generate/deploy/dev with `dependsOn: ["^build"]`, so no
entrypoint runs ahead of its workspace dependencies — replacing the per-package
`pre*` build hooks. Root scripts and the production deploy workflow now run through
`turbo run …`.
