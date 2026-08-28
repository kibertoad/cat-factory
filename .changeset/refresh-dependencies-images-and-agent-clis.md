---
'@cat-factory/acceptance': patch
'@cat-factory/acceptance-kit': patch
'@cat-factory/agents': patch
'@cat-factory/app': patch
'@cat-factory/caching': patch
'@cat-factory/cli': patch
'@cat-factory/consensus': patch
'@cat-factory/deploy-harness': patch
'@cat-factory/eks': patch
'@cat-factory/executor-harness': patch
'@cat-factory/gatekeeper-bindings': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/local-server': patch
'@cat-factory/mcp-server': patch
'@cat-factory/node-server': patch
'@cat-factory/orchestration': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-s3': patch
'@cat-factory/sdk': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
---

Refresh the dependency tree, the base images and the agent CLIs.

**Direct ranges plus a lockfile re-resolution from an empty tree**, so transitives move to the newest
release each declared range already admits, under the `minimumReleaseAge` gate:

- **Runtime**: the `ai` / `@ai-sdk/*` line takes its first aged releases since it was held back last
  round (`ai@^7.0.77 → ^7.0.83`, `@ai-sdk/anthropic@^4.0.41 → ^4.0.44`,
  `@ai-sdk/openai@^4.0.46 → ^4.0.50`, `@ai-sdk/openai-compatible@^3.0.35 → ^3.0.39`,
  `@ai-sdk/provider@^4.0.7 → ^4.0.8`, `@ai-sdk/amazon-bedrock@^5.0.61 → ^5.0.66`), staying on the
  majors `workers-ai-provider` pairs with. Also `hono@^4.13.4 → ^4.13.5`,
  `@aws-sdk/client-s3@^3.1116.0 → ^3.1119.0` and `vue@3.5.41 → 3.5.42` with the whole pinned
  `@vue/*` override family moved in lockstep.
- **Tooling**: `@types/node@^26.2.0 → ^26.4.0`, `turbo@^2.10.11 → ^2.10.12`, `knip@^6.32.2 → ^6.32.3`,
  `happy-dom@^20.11.6 → ^20.11.8`.
- **Java SDK**: `jackson-databind 2.22.1 → 2.22.2`, `junit-jupiter 6.1.2 → 6.1.3`, and the build
  plugins (compiler 3.15.0, source 3.4.0, javadoc 3.12.0, gpg 3.2.8, central-publishing 0.11.0).
- **Transitives the re-resolve moved**, among ~180: `eslint@10.6.0 → 10.9.1`,
  `@tiptap/*@3.24.0/3.30.0 → 3.30.5`, `rollup@4.62.5 → 4.63.0`, `rolldown@1.2.5 → 1.2.6`,
  `terser@5.50.0 → 5.51.1`, `@ai-sdk/gateway@4.0.62 → 4.0.67`, `@ai-sdk/provider-utils@5.0.29 →
5.0.32`, `@inquirer/*`, `@intlify/*` and `vue-i18n` to 11.4.10, `cssnano@8.0.8 → 8.0.10`.

**The re-resolve also drops ~22 packages that were in the tree only through lockfile inertia**:
`@vitejs/devtools-kit`, `tsx`, `@parcel/watcher` (with its platform packages), `devframe`,
`@devframes/*`, `@json-render/core`, `zigpty` and `node-addon-api`. Every one of them occupies an
OPTIONAL peer slot, which pnpm does not auto-install; they survived because each partial install
preferred what the previous tree already held. Resolving from a deleted `node_modules` as well as a
deleted lockfile is what surfaces that, and it is also what collapses the duplicate `h3` and `srvx`
copies. `@parcel/watcher-wasm` still serves the watcher slot, so this costs dev-time niceties at
most.

**The base image both runner Dockerfiles pin by digest moves to `sha256:5758d367…`** (Node 26.7.0),
the build held back at 17h old last round and now 74h old. The newer `26.8.1` digest is 14h old and
is held on the same rule. `searxng` in the local compose stack takes `2026.8.22-9fea41204`.

**Claude Code `2.1.246 → 2.1.250` and Codex `0.150.0 → 0.150.1` take their newest releases** ahead of
the age window, as the Dockerfile's standing note about the three agent CLIs allows. Pi (`0.84.3`)
and both Pi extensions (`2.7.1`) are already at their newest and have aged past the window, so they
need no exemption. Both image tags roll (executor `1.142.0`, deploy `0.5.0`) because republishing
over a live tag does not roll a deployment out.

**`wrangler` and `@cloudflare/workers-types` deliberately do not move**, for the third round running:
`@cloudflare/vitest-pool-workers@0.22.0` is still the newest pool and still pins `wrangler@4.124.0`
exactly, and the types version IS the workerd date that pin resolves (`1.20260815.1`). They move
together on the next pool bump.

**Held back, all inside the 24h window when this was cut**: `@aws-sdk/client-s3@3.1120.0` (12h),
`happy-dom@20.11.12` (16h), `vue-router@5.3.0` (18h), `wrangler@4.127.0` (23h) and
`@cloudflare/workers-types@5.20260828.1` (4h, and blocked by workerd besides). Held on the
compatible-major rule: `pnpm@12.0.0` and `typescript@7` for the frontend, which is on `^6.0.3`
because that is the line Nuxt's build graph resolves.
