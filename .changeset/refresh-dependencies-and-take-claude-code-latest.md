---
'@cat-factory/executor-harness': patch
'@cat-factory/local-server': patch
'@cat-factory/node-server': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
---

Refresh the dependency tree and take Claude Code at its newest release.

**Direct ranges plus a full lockfile re-resolution**, so transitives move to the newest release each
declared range already admits, under the `minimumReleaseAge` gate that #2079 finally armed:

- **Runtime**: `hono@^4.13.3 → ^4.13.4`, the one runtime dependency with an aged release to take.
- **Tooling**: `oxlint@^1.79.0 → ^1.80.0`, `oxfmt@^0.64.0 → ^0.65.0`, and pnpm `11.23.0 → 11.24.0`
  in `packageManager` and in the UI image, which installs the workspace's pnpm so a repo under test
  builds with the same one CI does.
- **Transitives the re-resolve moved**: `@typescript-eslint/*@8.67.0 → 8.68.0`,
  `@nuxt/icon@2.5.0 → 2.5.1`, `@iconify/collections@1.0.727 → 1.0.728`, `svgo@4.0.2 → 4.1.0` (with
  `css-select@5 → 6` and `css-what@6 → 7` behind it), `bare-fs@4.8.0 → 4.8.1`,
  `picomatch@4.0.5 → 4.0.7`.

**`wrangler` and `@cloudflare/workers-types` deliberately do not move.** `wrangler@4.125.0` is
published and aged, but `@cloudflare/vitest-pool-workers@0.22.0` is still the newest pool and still
pins `wrangler@4.124.0` exactly. Taking the newer one would put a second workerd in the tree and
make the runtime the Worker suite proves a different build from the one `wrangler deploy` ships,
which is the invariant `scripts/check-cloudflare-runtime-pins.mjs` exists to hold. The types pin
follows from that: `5.20260823.1` is aged, but its version IS a workerd date, and the workerd we
resolve is still `1.20260815.1`. Both move on the next pool bump, together.

**Held back, all inside the 24h window when this was cut**: `@types/node@26.3.0` (22h),
`@aws-sdk/client-s3@3.1117.0` (23h), `ai@7.0.79` and the `@ai-sdk/*` line (14h),
`@cloudflare/workers-types@5.20260825.1` (17h, and blocked by workerd besides). The
`node:26-trixie-slim` base image both runner Dockerfiles pin by digest has a newer build
(`sha256:5758d367…`, same Node 26.7.0, a Debian package refresh) that is 17h old, so it is held on
the same rule rather than taken because a digest is not what the pnpm gate governs.

**Claude Code moves to its newest release, 2.1.243 → 2.1.245**, ahead of the release-age window, as
the Dockerfile's standing note about the three agent CLIs allows and as an explicit call re-made
here. Pi (`0.84.3`) and Codex (`0.149.1`) are already at their newest and have since aged past the
window, so this round needs no exemption for them; the Pi extensions take the ordinary aged pick,
`2.7.0 → 2.7.1`.

The executor image tag therefore rolls to `1.132.0` (base + UI): republishing over a live tag does
not roll a deployment out. The deploy image is unchanged and stays at `0.2.16`.
