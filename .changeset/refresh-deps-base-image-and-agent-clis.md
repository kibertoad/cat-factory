---
'@cat-factory/agents': patch
'@cat-factory/app': patch
'@cat-factory/deploy-harness': patch
'@cat-factory/executor-harness': patch
'@cat-factory/integrations': patch
'@cat-factory/local-server': patch
'@cat-factory/provider-s3': patch
---

Refresh the dependency tree, the runner base image and the agent CLIs.

**Direct ranges plus a lockfile re-resolution from an empty tree**, so transitives move to the
newest release each declared range already admits, under the `minimumReleaseAge` gate:

- **Direct**: `@aws-sdk/client-s3@^3.1119.0 → ^3.1120.0`, `happy-dom@^20.11.8 → ^20.11.12`,
  `markdown-it@^15.0.0 → ^15.0.1`, `p-map@^7.0.6 → ^7.0.7`.
- **Transitives the re-resolve moved**, 39 resolved names in total: `rollup@4.63.0 → 4.63.1` with
  its 24 platform binaries, `terser@5.51.1 → 5.51.2`, `@jridgewell/sourcemap-codec@1.5.5 → 1.6.0`,
  `devalue@5.9.1 → 5.9.2`, `fastq@1.20.1 → 1.20.2`, `json-rpc-2.0@1.7.1 → 1.7.2`, and the
  browserslist data set (`baseline-browser-mapping`, `electron-to-chromium`, `node-releases`,
  `update-browserslist-db`).

This is a narrow round because the previous one landed a day earlier, and the tree shows it: the
re-resolve adds and drops nothing, leaving 1389 resolved names on both sides. Everything held back
is held by the age window rather than by a compatibility decision, and each will be takeable next
round: `ai@7.0.84`, `@ai-sdk/anthropic@4.0.45`, `@ai-sdk/openai@4.0.51`,
`@ai-sdk/amazon-bedrock@5.0.67`, `knip@6.33.0`, `pg-boss@12.28.1` and `fastq@1.20.3` were all
published inside the last 24 hours. The Java SDK moves nothing: jackson, junit, jspecify and every
build plugin are already at their newest on Maven Central.

**The `node:26-trixie-slim` digest both runner Dockerfiles pin moves to `sha256:c0753125`**
(Node 26.8.1), the build held back at 14h old last round and now 37h old. `searxng` in the local
compose stack stays at `2026.8.22-9fea41204`: the newer `2026.8.28-a30b2d474` is 23h old, an hour
short of the window, so it is the first thing to take next round.

**Pi `0.84.3 → 0.84.4` and Claude Code `2.1.250 → 2.1.251` take their newest releases** ahead of
the age window, as the Dockerfile's standing note about the three agent CLIs allows. Codex
(`0.150.1`) and both Pi extensions (`2.7.1`) are already at their newest and have aged past the
window. Both image tags roll (executor `1.143.0`, deploy `0.6.0`) because republishing over a live
tag does not roll a deployment out.

`wrangler` and `@cloudflare/workers-types` deliberately do not move for the fourth round running:
`@cloudflare/vitest-pool-workers@0.22.0` is still the newest pool and still pins `wrangler@4.124.0`
exactly, and the types version IS the workerd date that pin resolves. `drizzle-orm` and
`drizzle-kit` stay at `1.0.0-rc.4` for a different reason: the only newer publishes are per-commit
`1.0.0-rc.5-<sha>` snapshots, not a release to pin against.
