---
"@cat-factory/executor-harness": patch
---

Build the workspace before the container acceptance tests in `docker-publish.yml`. The
acceptance suite imports built packages (`@cat-factory/spend`, `@cat-factory/server`)
that resolve to their gitignored `./dist`, which `pnpm install` never produces, so the
job failed at import time with "Failed to resolve entry for package @cat-factory/spend".
Adding `pnpm build` fixes the publish pipeline; the harness bump republishes the runner
image. No harness behaviour change.
