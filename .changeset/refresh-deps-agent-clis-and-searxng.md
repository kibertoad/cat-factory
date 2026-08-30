---
'@cat-factory/agents': patch
'@cat-factory/app': patch
'@cat-factory/consensus': patch
'@cat-factory/executor-harness': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/local-server': patch
'@cat-factory/node-server': patch
'@cat-factory/orchestration': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-s3': patch
'@cat-factory/worker': patch
---

Refresh the dependency tree, the agent CLIs and the local web-search image.

**Direct ranges plus a lockfile re-resolution from an empty tree**, so transitives move to the
newest release each declared range already admits, under the `minimumReleaseAge` gate:

- **Direct**: `ai@^7.0.83 → ^7.0.84`, `@ai-sdk/anthropic@^4.0.44 → ^4.0.45`,
  `@ai-sdk/openai@^4.0.50 → ^4.0.51`, `@ai-sdk/openai-compatible@^3.0.39 → ^3.0.40`,
  `@ai-sdk/amazon-bedrock@^5.0.66 → ^5.0.67`, `@aws-sdk/client-s3@^3.1120.0 → ^3.1121.0`,
  `happy-dom@^20.11.12 → ^20.11.15`, `knip@^6.32.3 → ^6.33.0`, `pg-boss@^12.28.0 → ^12.28.1`.
  Every one of these was named as held back by the age window in the previous round and has now
  aged past it.
- **Transitives the re-resolve moved**, 42 resolved entries added against 43 removed:
  `oxc-parser@0.143.0 → 0.147.0` with its 19 platform bindings, `@ai-sdk/gateway@4.0.68`,
  `@ai-sdk/provider-utils@5.0.33`, `express-rate-limit@8.7.0`, `fastq@1.20.3`,
  `formatly@0.3.0 → 0.7.0` (knip's own range), `ip-address@10.7.0`, `json-rpc-2.0@1.8.0`,
  `open@11.0.2`, `powershell-utils@0.2.1`, `pretty-bytes@7.1.2`, `pretty-ms@9.3.1`,
  `@iconify/collections@1.0.730`.

The tree stays at 1387 distinct names on both sides, and 1614 resolved entries becomes 1613:
`@oxc-project/types` collapses from three copies to two and `get-tsconfig` from two to one, while
`zod` gains a second.

**That second `zod` is deliberate and is worth knowing about**, because a duplicated singleton is
usually a bug here. No workspace package declares `zod`, so every copy of it fills an
auto-installed optional peer slot, and until now the exact `zod@4.4.3` that
`@cloudflare/vitest-pool-workers@0.22.0` pins as a hard dependency was the only version in the
tree, which dragged every other consumer onto it. `zod@4.5.2` has now aged past the window, so the
peer slots take it and the pool's pin no longer speaks for the whole graph. The split is along a
seam nothing crosses: `4.4.3` is reachable only from the vitest pool, which uses it to validate its
own config, and everything app-reachable (the AI SDK family, `@modelcontextprotocol/sdk`,
`drizzle-orm`) moves to `4.5.2` together, so there is still exactly one `zod` identity in every
place a schema is built in one module and read in another. Do not "fix" this with a top-level
override pinning `4.4.3`: that would freeze the whole tree on a decision that belongs to the test
pool, which is the mistake the `wrangler` note in `pnpm-workspace.yaml` exists to prevent.

**Held back by the age window rather than by a compatibility call**, and takeable next round:
`ai@7.0.85` and the whole `@ai-sdk` line beside it (`anthropic@4.0.46`, `openai@4.0.52`,
`openai-compatible@3.0.41`, `amazon-bedrock@5.0.68`) were all published about six hours ago, and
`happy-dom@20.12.0` misses by two and a half hours.

**The agent CLIs**: Codex `0.150.1 → 0.151.0`, and both Pi extensions `2.7.1 → 2.8.0`. Pi
(`0.84.4`) and Claude Code (`2.1.251`) are already at their newest. The Dockerfile's standing
exemption that lets the three CLI pins run ahead of the age window is not exercised this round:
every version taken here has aged past it on its own, the extensions included, which is the rule
they are held to anyway.

The executor image tag rolls to `1.144.0` for those pins, because republishing over a live tag does
not roll a deployment out. The deploy image is unchanged and stays at `0.6.1`: nothing under
`backend/internal/deploy-harness/` moved, and its `kubectl`/`kustomize`/`helm` pins are managed
deliberately rather than swept (`kubectl` has a `v1.37.0` available against the pinned `v1.36.4`,
which is a call for its own change).

**The `searxng` image in the local compose stack takes `2026.8.29-d226b78bc`**, 29 hours old, after
holding two rounds at `2026.8.22-9fea41204` for tags that kept landing an hour or two short of the
window. The `node:26-trixie-slim` digest both runner Dockerfiles pin does not move: the tag still
resolves to `sha256:c0753125` (Node 26.8.1), unchanged since 2026-08-27.

**Standing holds, restated so the next round need not re-derive them**: `wrangler` and
`@cloudflare/workers-types` do not move for the fifth round running, because
`@cloudflare/vitest-pool-workers@0.22.0` is still the newest pool and still pins `wrangler@4.124.0`
exactly, and the types version is the workerd date that pin resolves to. `drizzle-orm` and
`drizzle-kit` stay at `1.0.0-rc.4`: the only newer publishes are per-commit `rc.5` snapshots, not a
release to pin against. The frontend keeps `typescript@^6.0.3` against the root's `7.0.2` because
`vue-tsc@3.3.11` is what pairs with it, so moving it is a Nuxt-toolchain decision rather than a
sweep. The Java SDK moves nothing: jackson, junit, jspecify and every build plugin are already at
their newest stable on Maven Central, and Go and Python have no dependencies by design.
