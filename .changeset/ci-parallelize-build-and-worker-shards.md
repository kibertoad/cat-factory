---
---

CI-only: parallelize the PR pipeline's blocking critical path. The monolithic
`Build & typecheck` job is split into three parallel lanes (`Build & typecheck` core,
`Publish integrity`, `Frontend checks`) behind a single aggregated `Build` gate, and the
Cloudflare worker test lane is bumped from 2 to 3 shards. Per-job `timeout-minutes` are added
across `ci.yml`. No package behaviour changes.
