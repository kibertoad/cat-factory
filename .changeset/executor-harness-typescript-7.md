---
'@cat-factory/executor-harness': patch
'@cat-factory/deploy-harness': patch
'@cat-factory/local-server': patch
---

Bump the container-harness build toolchains to TypeScript 7.

The executor-harness and deploy-harness were the last packages still building on
TypeScript 6 (`^6.0.3`), and their Docker build stages compiled `dist/` with an even
older standalone `typescript@^5.6.0` / `@types/node@^22.0.0`. Both are now aligned with
the rest of the monorepo: the package `devDependency` moves to `7.0.2` and each
Dockerfile build stage to `typescript@^7.0.0` / `@types/node@^26.0.0` (matching the
runtime `node:26` base), so the published images are actually compiled on TS 7 rather
than only local dev. The other harness deps (`hono`, `@hono/node-server`, `@types/node`,
`vitest`) were already on the repo-consistent latest ranges.

Editing the harness `package.json` + `Dockerfile` re-tags the runner images, so
`@cat-factory/executor-harness` bumps 1.43.6 -> 1.43.7, `@cat-factory/deploy-harness`
0.2.6 -> 0.2.7, and all six image-tag pins are synced to match: the
`deploy/backend/{package.json,wrangler.toml}` refs plus `RECOMMENDED_HARNESS_IMAGE` and
`RECOMMENDED_DEPLOY_IMAGE` in `@cat-factory/local-server`. The lockfile was also deduped
to drop redundant duplicate entries.
