---
'@cat-factory/executor-harness': patch
'@cat-factory/local-server': patch
---

Bump the executor-harness toolchain to TypeScript 7.

The harness was the last package still building on TypeScript 6 (`^6.0.3`), and its
Docker build stage compiled `dist/` with an even older standalone `typescript@^5.6.0` /
`@types/node@^22.0.0`. Both are now aligned with the rest of the monorepo: the package
`devDependency` moves to `7.0.2` and the Dockerfile build stage to `typescript@^7.0.0` /
`@types/node@^26.0.0` (matching the runtime `node:26` base). The other harness
deps (`hono`, `@hono/node-server`, `@types/node`, `vitest`) were already on the
repo-consistent latest ranges.

Editing the harness `package.json` + `Dockerfile` re-tags the runner image, so
`@cat-factory/executor-harness` bumps 1.43.6 -> 1.43.7 and the three image-tag pins
(`deploy/backend/{package.json,wrangler.toml}` + `RECOMMENDED_HARNESS_IMAGE` in
`@cat-factory/local-server`) are synced to match.
