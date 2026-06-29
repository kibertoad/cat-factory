---
---

CI: guard the executor-harness runner image tag on PRs. A new
`scripts/check-runner-image-tag.mjs` asserts the harness version and the
`cat-factory-executor:<tag>` pins in `deploy/backend/{package.json,wrangler.toml}` stay in
lockstep, and that an image-source change bumps the tag. It is wired into the required
`Build & typecheck` CI job (so the mistake is caught on the PR instead of turning `main`
red post-merge) and reused by the `deploy.yml` guard. Also bumps the stale deploy tags to
`1.27.0` to match the harness. CI/deploy-config only — no published package changes.
