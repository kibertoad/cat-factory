---
"@cat-factory/executor-harness": patch
---

chore: bump the runner image tag to 1.21.1 to force a fresh Cloudflare rollout.

The production deploy guard ("Guard runner image tag was bumped") failed because an
image-affecting file (`backend/internal/executor-harness/package.json` — the `typecheck`
script split plus the prior release version bump) changed since the last deployed commit
while the pinned tag in `deploy/backend` stayed `1.21.0`. Reusing the live tag makes
`wrangler deploy` a no-op rollout, so the guard refuses it. Bump the harness version and
the pinned tag in both `deploy/backend/package.json` (`image:publish`) and
`deploy/backend/wrangler.toml` (`[[containers]] image`) to `1.21.1` so a fresh, immutable
tag rolls out.
