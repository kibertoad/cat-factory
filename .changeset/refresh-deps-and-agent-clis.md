---
'@cat-factory/agents': patch
'@cat-factory/app': patch
'@cat-factory/caching': patch
'@cat-factory/consensus': patch
'@cat-factory/executor-harness': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/local-server': patch
'@cat-factory/node-server': patch
'@cat-factory/orchestration': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/worker': patch
---

Refresh the dependency tree and the bundled agent CLIs.

**Direct ranges plus a lockfile re-resolution from an empty tree**, so transitives move to the
newest release each declared range already admits, under the `minimumReleaseAge` gate:

- **Direct**: `ai@^7.0.84 → ^7.0.85`, `@ai-sdk/anthropic@^4.0.45 → ^4.0.46`,
  `@ai-sdk/openai@^4.0.51 → ^4.0.52`, `@ai-sdk/openai-compatible@^3.0.40 → ^3.0.41`,
  `@ai-sdk/provider@^4.0.8 → ^4.0.9`, `@ai-sdk/amazon-bedrock@^5.0.67 → ^5.0.68`,
  `happy-dom@^20.11.15 → ^20.12.0`, `pg-boss@^12.28.1 → ^12.29.0`,
  `layered-loader@^16.1.0 → ^16.1.1`. The whole `@ai-sdk` line and `ai` were named as
  age-blocked by the previous round and have now aged past the window. `layered-loader`
  16.1.1 is 23 hours old and would miss it, but the package is ours and sits on
  `minimumReleaseAgeExclude`, which is exactly the case that list exists for.
- **Transitives the re-resolve moved**, 32 resolved entries added against 32 removed:
  `zod@4.5.2 → 4.5.4`, `@ai-sdk/gateway@4.0.68 → 4.0.69`,
  `@ai-sdk/provider-utils@5.0.33 → 5.0.34`, `qs@6.15.3 → 6.16.0`,
  `serialize-javascript@7.1.0 → 7.1.1`, `type-fest@5.8.0 → 5.9.0`, `ignore@7.0.6 → 7.0.7`,
  `electron-to-chromium@1.5.416 → 1.5.417`.

The tree is structurally unchanged: 1434 distinct names and 1967 resolved entries on both
sides, with no name added and none removed. The two-`zod` split the previous round introduced
holds along the same seam: `@cloudflare/vitest-pool-workers` keeps its hard-pinned `4.4.3` for
its own config validation, and every app-reachable consumer (the AI SDK family,
`@modelcontextprotocol/sdk`, `drizzle-orm`) moves to `4.5.4` together, so a schema built in one
module is still read by the same identity in another.

**The agent CLIs**: Claude Code `2.1.251 → 2.1.252` and Codex `0.151.0 → 0.152.0`, both taken
at their newest under the Dockerfile's standing exemption from the age window (2.1.252 is 17
hours old, 0.152.0 is 8). That exemption covers exactly those three pins and is an explicit
call re-made on each bump. Pi is already newest at `0.84.4`, as are both Pi extensions at
`2.8.0`, and the extensions are held to the ordinary window regardless.

The executor image tag rolls to `1.145.0` for the two CLI pins, because republishing over a
live tag does not roll a deployment out. The deploy image is untouched at `0.6.1`: nothing
under `backend/internal/deploy-harness/` moved.

**Held back by the age window rather than by a compatibility call**, and takeable next round:
`ai@7.0.87` with `@ai-sdk/openai@4.0.53` and `@ai-sdk/amazon-bedrock@5.0.69` beside it (all
published late on 2026-08-31), `@aws-sdk/client-s3@3.1123.0`, `knip@6.34.0`, `undici@8.10.1`,
and the OpenTelemetry line (`@opentelemetry/sdk-*` and `resources` at 2.11.0, the two OTLP
exporters at 0.222.0).

**Held by a deliberate call**, unchanged: `wrangler` stays at `4.124.0` and
`@cloudflare/workers-types` at `5.20260815.1` for the sixth round running, because
`@cloudflare/vitest-pool-workers@0.22.0` is still the newest pool and still pins that exact
wrangler, and the types are derived from the `workerd@1.20260815.1` it brings. `4.127.1` is
available and would split the runtime the tests prove from the runtime that ships. Drizzle
stays at `1.0.0-rc.4`: still only per-commit `rc.5` snapshots. The frontend layer stays on
`typescript@^6.0.3` while the rest of the tree is on `7.0.2`, which is why sherif ignores that
name. The `node:26-trixie-slim` base digest and the `searxng` tag in the local compose stack
are both already the newest published.
