---
'@cat-factory/acceptance': patch
'@cat-factory/acceptance-kit': patch
'@cat-factory/agents': patch
'@cat-factory/app': patch
'@cat-factory/binary-generators': patch
'@cat-factory/caching': patch
'@cat-factory/cli': patch
'@cat-factory/conformance': patch
'@cat-factory/consensus': patch
'@cat-factory/contracts': patch
'@cat-factory/eks': patch
'@cat-factory/example-custom-agent': patch
'@cat-factory/executor-harness': patch
'@cat-factory/gatekeeper-bindings': patch
'@cat-factory/gatekeeper-worker': patch
'@cat-factory/gates': patch
'@cat-factory/gitlab': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/local-server': patch
'@cat-factory/mcp-server': patch
'@cat-factory/node-server': patch
'@cat-factory/observability-langfuse': patch
'@cat-factory/observability-otel': patch
'@cat-factory/orchestration': patch
'@cat-factory/prompt-fragments': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-s3': patch
'@cat-factory/sandbox': patch
'@cat-factory/sandbox-fixtures': patch
'@cat-factory/sdk': patch
'@cat-factory/server': patch
'@cat-factory/spend': patch
'@cat-factory/worker': patch
'@cat-factory/workspaces': patch
---

Refresh the dependency tree, the pinned GitHub Actions and the Docker images, and move the three bundled agent CLIs.

**Registry deps** (direct ranges plus a full lockfile re-resolution, so transitives move to the
newest release each declared range already admits):

- **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.68 → ^7.0.77`,
  `@ai-sdk/anthropic@^4.0.39 → ^4.0.41`, `@ai-sdk/openai@^4.0.43 → ^4.0.46`,
  `@ai-sdk/openai-compatible@^3.0.31 → ^3.0.35`, `@ai-sdk/amazon-bedrock@^5.0.58 → ^5.0.61`.
- **Runtime deps**: `jose@^6.2.9 → ^6.2.10`, `pg-boss@^12.27.0 → ^12.28.0`,
  `capnweb@^0.11.1 → ^0.12.0`, `@aws-sdk/client-s3@^3.1113.0 → ^3.1116.0`.
  `@cloudflare/workers-types` settles at an exact `5.20260815.1` rather than a caret: its version
  IS a workerd date, so a caret floats the types ahead of the runtime that executes them.
- **Frontend**: `@nuxt/ui@^4.10.0 → ^4.11.0`, `happy-dom@^20.11.2 → ^20.11.6`,
  `vue-tsc@^3.3.10 → ^3.3.11`. The frontend's `typescript@^6.0.3` is deliberately unchanged:
  `vue-tsc` still resolves `typescript/lib/tsc`, a subpath TypeScript 7's exports map does not
  expose, so the SPA stays on 6 until `vue-tsc` supports the Go port.
- **Tooling**: `@stryker-mutator/*@9.6.1 → 10.0.0` and pnpm `11.22.0 → 11.23.0`. Stryker 10 drops
  Node 20 (CI runs 26) and ALSO adds `emptyExpressionMutator` to the default mutator set, which
  enlarges every mutated package's mutant population. The three score floors were measured under
  9.6.1 and have not been re-measured against the new population, so they are provisional until the
  nightly reports; `docs/internal/mutation-testing.md` now records which version each floor was
  measured under.

**Changesets moves as a coupled major**: `@changesets/cli@^2.31.1 → ^3.0.1` plus
`changesets/action@v1.9.0 → v2.1.1`, which refuse each other's majors. Two behaviour changes had to
be pinned back to what this repo already relied on: `.changeset/config.json` now sets
`privatePackages: { version: true, tag: false }`, because v3 stopped versioning private packages by
default and `@cat-factory/executor-harness`'s version IS the runner image tag; and `release.yml`
takes the renamed inputs (`version-script`, `publish-script`, `pr-title`, `commit-message`), the
`pr-number` output, and the token through the `github-token` input, which v2 no longer accepts from
the environment. v2 pushes the release branch and tags through the GitHub API, so that job's
checkout no longer persists git credentials.

**Held back, all inside the ~24h release-age window when this was cut**: `@types/node@26.3.0`,
`hono@4.13.4`, `oxlint@1.80.0`, `oxfmt@0.65.0`, `ai@7.0.78`, `@ai-sdk/openai-compatible@3.0.36`,
`@aws-sdk/client-s3@3.1117.0`. `pg-boss@12.28.0` was ~20 minutes short of the same window and was
taken anyway, listed in `minimumReleaseAgeExclude` with a PRUNE ME note. It has since aged past the
window and that entry is gone again.

**`wrangler` moves from a caret to an exact version in every package that declares it.**
`@cloudflare/vitest-pool-workers@0.22.0` pins `wrangler` (and through it `workerd` and `miniflare`)
EXACTLY, so any in-range refresh floats our caret ahead of the pool's pin and the tree gains a SECOND
workerd: not just ~100MB of duplicated platform binary per arch, but a runtime the Worker suite
proves that is a different build from the one `wrangler deploy` ships. This first shipped as a
top-level override, which was the wrong shape (an override OVERRIDES the pool's pin instead of
tracking it) and has since been replaced by the exact declarations plus a guard that fails CI on a
second copy.

**Stryker 10 pulled Babel 8 into a tree whose Nuxt half is on Babel 7**, and the three Babel plugins
Nuxt declares as OPTIONAL PEERS were then filled from the 8.x line while still being handed
`@babel/core@7`. A Babel 8 plugin's `declare()` asserts the core major and throws, so
`pnpm-workspace.yaml` scopes those three names back to 7.x for their Nuxt parents.

**The three agent CLIs the executor image bundles** move together and are all taken at their newest
release, ahead of the release-age window: Pi `0.84.2 → 0.84.3`, Claude Code `2.1.237 → 2.1.243`,
Codex `0.148.0 → 0.149.1`. That exemption is an explicit call re-made at each bump, and the
Dockerfile now says so for all three rather than for Claude Code alone. Pi's two extensions take the
ordinary aged pick, `2.6.2 → 2.7.0`. The UI image moves `pnpm 11.22.0 → 11.23.0` to match the
workspace; its Playwright (1.62.1), Yarn (4.18.0), `serve` (14.2.6) and WireMock (3.13.1) pins are
already current, as are the deploy image's kubectl `v1.36.4` / kustomize `v5.8.1` / helm `v4.2.4` and
both images' `node:26-trixie-slim` digest.

The executor image tag therefore rolls to `1.130.0` (base + UI): republishing over a live tag does
not roll a deployment out. The deploy image is unchanged and stays at `0.2.15`.

**Pinned GitHub Actions**: `actions/checkout v7.0.0 → v7.0.1`, `actions/setup-node v6.4.0 → v7.0.0`,
`actions/setup-java v5.7.0 → v6.0.0` (both majors are ESM rewrites with no change to the inputs used
here), `docker/build-push-action v7.2.0 → v7.3.0`, `docker/login-action v4.2.0 → v4.6.0`,
`docker/setup-buildx-action v4.1.0 → v4.3.0`, `docker/setup-qemu-action v4.1.0 → v4.2.0`,
`dorny/paths-filter v4.0.1 → v4.0.3`, `pnpm/action-setup v6.0.9 → v6.0.10`,
`rharkor/caching-for-turbo v2.5.0 → v2.5.1`, and `zizmorcore/zizmor-action v0.5.7 → v0.6.2`, which
raises the default zizmor from 1.26.1 to 1.29.0.
