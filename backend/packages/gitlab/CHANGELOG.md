# @cat-factory/gitlab

## 0.22.16

### Patch Changes

- Updated dependencies [27b22a3]
  - @cat-factory/contracts@0.333.0
  - @cat-factory/kernel@0.322.0

## 0.22.15

### Patch Changes

- Updated dependencies [e1f6325]
- Updated dependencies [90a915e]
  - @cat-factory/contracts@0.332.0
  - @cat-factory/kernel@0.321.3

## 0.22.14

### Patch Changes

- Updated dependencies [e0eed49]
  - @cat-factory/kernel@0.321.2

## 0.22.13

### Patch Changes

- Updated dependencies [7d899c4]
  - @cat-factory/contracts@0.331.0
  - @cat-factory/kernel@0.321.1

## 0.22.12

### Patch Changes

- Updated dependencies [dc12c82]
  - @cat-factory/contracts@0.330.0
  - @cat-factory/kernel@0.321.0

## 0.22.11

### Patch Changes

- Updated dependencies [3ae3386]
  - @cat-factory/contracts@0.329.0
  - @cat-factory/kernel@0.320.0

## 0.22.10

### Patch Changes

- Updated dependencies [c030a23]
  - @cat-factory/kernel@0.319.1

## 0.22.9

### Patch Changes

- Updated dependencies [69b9ed4]
  - @cat-factory/kernel@0.319.0

## 0.22.8

### Patch Changes

- Updated dependencies [a8f8d14]
  - @cat-factory/contracts@0.328.0
  - @cat-factory/kernel@0.318.1

## 0.22.7

### Patch Changes

- 0cfa7a2: Refresh the dependency tree, the pinned GitHub Actions and the Docker images, and move the three bundled agent CLIs.
  
  **Registry deps** (direct ranges plus a full lockfile re-resolution, so transitives move to the
  newest release each declared range already admits):
  
  - **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.68 → ^7.0.77`,
    `@ai-sdk/anthropic@^4.0.39 → ^4.0.41`, `@ai-sdk/openai@^4.0.43 → ^4.0.46`,
    `@ai-sdk/openai-compatible@^3.0.31 → ^3.0.35`, `@ai-sdk/amazon-bedrock@^5.0.58 → ^5.0.61`.
  - **Runtime deps**: `jose@^6.2.9 → ^6.2.10`, `pg-boss@^12.27.0 → ^12.28.0`,
    `capnweb@^0.11.1 → ^0.12.0`, `@aws-sdk/client-s3@^3.1113.0 → ^3.1116.0`,
    `@cloudflare/workers-types@^5.20260819.1 → ^5.20260823.1`.
  - **Frontend**: `@nuxt/ui@^4.10.0 → ^4.11.0`, `happy-dom@^20.11.2 → ^20.11.6`,
    `vue-tsc@^3.3.10 → ^3.3.11`. The frontend's `typescript@^6.0.3` is deliberately unchanged:
    `vue-tsc` still resolves `typescript/lib/tsc`, a subpath TypeScript 7's exports map does not
    expose, so the SPA stays on 6 until `vue-tsc` supports the Go port.
  - **Tooling**: `@stryker-mutator/*@9.6.1 → 10.0.0` (its only breaking change is dropping Node 20;
    CI runs 26) and pnpm `11.22.0 → 11.23.0`.
  
  **Changesets moves as a coupled major**: `@changesets/cli@^2.31.1 → ^3.0.1` plus
  `changesets/action@v1.9.0 → v2.1.1`, which refuse each other's majors. Two behaviour changes had to
  be pinned back to what this repo already relied on: `.changeset/config.json` now sets
  `privatePackages: { version: true, tag: false }`, because v3 stopped versioning private packages by
  default and `@cat-factory/executor-harness`'s version IS the runner image tag; and `release.yml`
  takes the renamed inputs (`version-script`, `publish-script`, `pr-title`, `commit-message`), the
  `pr-number` output, and the token through the `github-token` input, which v2 no longer accepts from
  the environment. v2 pushes the release branch and tags through the GitHub API, so that job's
  checkout no longer persists git credentials.
  
  **Held back, all inside the ~24h `minimumReleaseAge` window when this was cut**: `@types/node@26.3.0`,
  `hono@4.13.4`, `oxlint@1.80.0`, `oxfmt@0.65.0`, `ai@7.0.78`, `@ai-sdk/openai-compatible@3.0.36`,
  `@aws-sdk/client-s3@3.1117.0`. `pg-boss@12.28.0` was ~20 minutes short of the same window and was
  taken anyway, so it is listed in `minimumReleaseAgeExclude` — the ONE third-party entry there, added
  deliberately with a PRUNE ME note, since it has already aged past the gate and removing the line is
  now a no-op re-resolve.
  
  **`wrangler` is now pinned by override**, not merely ranged. `@cloudflare/vitest-pool-workers@0.22.0`
  pins `wrangler` (and through it `workerd` and `miniflare`) EXACTLY, so any in-range refresh floats our
  caret ahead of the pool's pin and the tree gains a SECOND workerd — not just ~100MB of duplicated
  platform binary per arch, but a runtime the Worker suite proves that is a different build from the one
  `wrangler deploy` ships. The override holds it at whatever pool-workers pins, exactly as the three
  esbuild pins beside it already do, and moves when that package moves.
  
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
- Updated dependencies [08752da]
- Updated dependencies [0cfa7a2]
- Updated dependencies [dc26bb5]
  - @cat-factory/contracts@0.327.0
  - @cat-factory/kernel@0.318.0

## 0.22.6

### Patch Changes

- Updated dependencies [da77447]
  - @cat-factory/contracts@0.326.0
  - @cat-factory/kernel@0.317.1

## 0.22.5

### Patch Changes

- Updated dependencies [4125beb]
  - @cat-factory/contracts@0.325.0
  - @cat-factory/kernel@0.317.0

## 0.22.4

### Patch Changes

- Updated dependencies [1d3c115]
  - @cat-factory/kernel@0.316.0

## 0.22.3

### Patch Changes

- Updated dependencies [432b4e4]
  - @cat-factory/contracts@0.324.0
  - @cat-factory/kernel@0.315.0

## 0.22.2

### Patch Changes

- 3db0d43: Refresh the whole dependency tree, re-roll both runner images, and move the three bundled agent CLIs.

  **Registry deps** (direct ranges plus a full lockfile re-resolution, so transitives move to the
  newest release each declared range already admits):

  - **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.64 → ^7.0.68`,
    `@ai-sdk/anthropic@^4.0.38 → ^4.0.39`, `@ai-sdk/openai@^4.0.41 → ^4.0.43`,
    `@ai-sdk/openai-compatible@^3.0.30 → ^3.0.31`, `@ai-sdk/amazon-bedrock@^5.0.55 → ^5.0.58`.
  - **Runtime deps**: `hono@^4.13.1 → ^4.13.3`, `@hono/node-server@^2.1.0 → ^2.1.1`,
    `jose@^6.2.8 → ^6.2.9`, `capnweb@^0.11.0 → ^0.11.1`, `@aws-sdk/client-s3@^3.1109.0 → ^3.1113.0`.
  - **Tooling**: `wrangler@^4.122.0 → ^4.124.0`,
    `@cloudflare/workers-types@^5.20260812.1 → ^5.20260819.1` (which is what wrangler 4.124 now
    peer-requires), `@cloudflare/vitest-pool-workers@^0.21.2 → ^0.22.0`, `vitest@^4.1.10 → ^4.1.11`,
    `@vitest/coverage-v8@^4.1.10 → ^4.1.11`, `oxlint@^1.78.0 → ^1.79.0`, `oxfmt@^0.63.0 → ^0.64.0`,
    `publint@^0.3.23 → ^0.3.24`, `turbo@^2.10.9 → ^2.10.11`, `vue-tsc@^3.3.9 → ^3.3.10`,
    `@types/pg@^8.21.0 → ^8.23.1`, pnpm `11.21.0 → 11.22.0`.

  **The three agent CLIs the executor image bundles** move together: Pi `0.84.1 → 0.84.2`, Codex
  `0.147.0 → 0.148.0`, Claude Code `2.1.231 → 2.1.237`. The Claude Code pin is taken at its newest
  release, ahead of the 24h `minimumReleaseAge` window, which is the explicit call that pin's own note
  asks to re-make on every bump. Pi's two extensions move in lockstep as their monorepo publishes
  them, `2.4.0 → 2.6.2`.

  **The UI-tester image** aligns its Playwright with the one the e2e suite drives (`1.61.1 → 1.62.1`),
  and moves `@yarnpkg/cli-dist@4.10.3 → 4.18.0` and `serve@14.2.5 → 14.2.6`. **The deploy image** takes
  `kubectl v1.36.3 → v1.36.4` and `helm v4.2.3 → v4.2.4`; kustomize is already current at `v5.8.1`.

  Both image tags therefore move in this change (`cat-factory-executor:1.127.0`,
  `cat-factory-executor-ui:1.127.0`, `cat-factory-deploy:0.2.14`): republishing over a live tag does
  not roll a deployment out.

  No `minimumReleaseAgeExclude` entries were added and none were needed: every registry bump above
  already clears the gate. Five packages had a newer release the gate still withholds
  (`@ai-sdk/*`, `ai@7.0.70`, `happy-dom@20.11.6`, `@aws-sdk/client-s3@3.1114.0`,
  `@cloudflare/workers-types@5.20260820.1`), so each lands one release short of the registry's head.
  `drizzle-orm`/`drizzle-kit` stay on `1.0.0-rc.4`: the only newer builds are commit-suffixed
  snapshots, not a released `rc.5`. Majors available but deliberately not taken here, each being its
  own change: `@changesets/cli@3`, `@stryker-mutator/*@10`, and TypeScript 7 for the two frontend
  packages still on 6.

- Updated dependencies [3db0d43]
  - @cat-factory/contracts@0.323.1
  - @cat-factory/kernel@0.314.1

## 0.22.1

### Patch Changes

- Updated dependencies [72ecc7c]
  - @cat-factory/contracts@0.323.0
  - @cat-factory/kernel@0.314.0

## 0.22.0

### Minor Changes

- 5b281a3: Act on the first external-API sweep: three vendor surfaces had already moved, two more carry
  announced dates, and eight had drifted.

  **Broken.** Confluence page reads move to Cloud REST v2 (`GET /wiki/api/v2/pages/{id}`); the v1
  content endpoint they targeted was retired on 2025-04-30, and CQL search stays on v1 because v2
  publishes no search endpoint. incident.io enrichment posts to `POST /v2/actions`, an endpoint that
  exists, where `POST /v2/incident_updates` never has at any version: the investigation lands as an
  unassigned action on the live incident rather than a status-page update (which would re-alert
  customers) or a follow-up (which is post-incident work). The MCP tool-server probe is now dual-era:
  revision `2026-07-28` deleted the `initialize` handshake, `notifications/initialized` and
  protocol-level sessions, so the probe opens in the modern stateless dialect and falls back to the
  handshake on a refusal that is not one of the three MCP-reserved error codes, or on any refusal
  naming a handshake-era revision. `server/discover`'s `supportedVersions` is negotiated onto rather
  than read and discarded, and the HTTP status is read before the body, so a 401 answered in JSON
  (the ordinary shape for an OAuth-protected server) is one refusal rather than two.

  **Dated.** The Langfuse sink is now the OTLP exporter pointed at Langfuse's OpenTelemetry endpoint;
  the batch ingestion API it used to speak is deprecated, sunsets on Langfuse Cloud on 2026-11-16, and
  its three event types are already unsupported on the v4 data model.

  **Drift.** Google userinfo reads from `openidconnect.googleapis.com/v1/userinfo`, the host Google's
  own discovery document publishes. Datadog monitor reads ask for `group_states=all` and fold
  `state.groups[*].last_triggered_ts` over the groups that are STILL ALERTING, so the
  post-release-health gate can once again tell a standing alert from one this release caused; the
  field it used to read is not in Datadog's schema, so the transition time was silently always
  absent, and the per-group timestamp outlives the group recovering, so folding it over every group
  would hand a week-old standing alert to whatever release a since-cleared blip landed after. Figma OAuth refreshes at `/v1/oauth/token`, which
  superseded `/v1/oauth/refresh`. The MCP authorization-server discovery walk drops an undocumented
  location, adds the OpenID Connect path-insert one, and enforces RFC 8414's issuer-equality check
  against a DECLARED issuer: in the origin fallback there is no published identifier to compare
  against, so the equality would refuse every deployment whose authorization server identifies as a
  fronted IdP or a tenant path. Linear rate limits are read off the error `code`, because Linear
  answers an exhausted quota with HTTP 400, and a setup check reports one as the new `rate_limited`
  verdict: the key is valid and the fix is to wait, which neither `auth_failed` nor a generic error
  says. The OTLP exporter reads `partialSuccess` instead of treating any 200 as full acceptance.
  GitLab 413s carry their own remedy. The Gemini image contract narrows `thinking_level` to the two
  values that exist, states the per-model reference-image split, and declares the 401 an invalid key
  really returns. The DeepSeek base URL drops an undocumented `/v1`.

  **Additive on the wire:** a task source's setup check can answer `rate_limited`, an eighth verdict
  in `taskSourceDiagnosticStatusSchema`.

  **Breaking for an embedder:** kernel's `GateContext` and `JudgeContext` now carry a required
  `logger`. Both are built by the engine (`makeGateContext`) and by `stubGateContext` /
  `stubJudgeContext` in tests, so a registered gate or judge needs no change.

### Patch Changes

- Updated dependencies [5b281a3]
  - @cat-factory/contracts@0.322.0
  - @cat-factory/kernel@0.313.0

## 0.21.2

### Patch Changes

- Updated dependencies [53a4c40]
  - @cat-factory/contracts@0.321.0
  - @cat-factory/kernel@0.312.0

## 0.21.1

### Patch Changes

- Updated dependencies [4a3af5a]
  - @cat-factory/kernel@0.311.0

## 0.21.0

### Minor Changes

- 302e05a: Close the gaps a third-party acceptance suite hit, and fix the 422 our own suite would have hit.

  The kit is published so a deployment can cover its OWN providers, gates and environment backends.
  The first consumer to actually do that came back with thirteen findings, and one of them is a real
  defect here: a task `description` caps at 2,000 characters, both scaffold briefs in
  `backend/internal/acceptance` measure past it (2,507 and 2,697), and scenario 01 passed them straight
  through. The platform's own acceptance pass could not create its first task, and would have found
  that out as a `422` after an operator had created two repositories and wired a workspace.

  `briefFields` now owns the branch, reading the cap from the contracts rather than restating it: over
  it the brief becomes an attached document (this surface's own documented path for spec-sized input),
  under it nothing changes at all. `MAX_TASK_DESCRIPTION_CHARS` is exported so the branch and the route
  cannot disagree.

  The rest of the kit changes are seams a consumer had to re-derive by reading our source. A
  `resource.ts` giving an external RESOURCE the record-before-you-can-observe discipline `resume.ts`
  gives runs, because a teardown needs the provider's id plus what the provision captured and neither
  can be re-derived, so a killed pass leaks a machine nothing on disk can name. `PassOptions.onSettled`,
  so a reclaim report lands INSIDE the closing words rather than after the sentence written to be read
  last. An `unknown` verdict constructor beside its two siblings, and `Prerequisite.probe`, so a check
  reaching a host that is not the deployment still gets kernel's transport classification. A
  `ConfigProblem` export. Provider-neutral evidence prose (`checkEphemeralEnvironment` claimed the
  disposer reclaimed "the namespace", which is false of every non-Kubernetes backend). The console
  password prompt as an opt-in `@cat-factory/acceptance-kit/console-credential` subpath, so the base
  package keeps no terminal code. And the `.env` MERGE half published from `@cat-factory/cli` beside
  the `renderEnvFile` it completes.

  On `/api/v1` (spec `1.57.0`, all additive): `PublicServiceProvisioning` gains a `custom` variant so a
  service pinned to a deployment's own environment backend can be declared and, more importantly, READ
  BACK (the projection dropped what it could not describe, so a pinned service and an unpinned one
  answered identically); `GET /api/v1/environments/connections` closes the write-only loop on handlers,
  reporting BOTH manifest-id fields because the engine matches a pinned service against either and each
  way of registering a handler sets only one; and `GET /api/v1/repos/{owner}/{name}/contents` reads one
  file out of a linked repository, so a caller can grade what a run committed without a second VCS
  credential. That read answers `ref: null` for a request that named none, since the branch the provider
  resolved is not something it learns and the platform's recorded default may be one it invented; `sha`
  is the handle to record. It refuses rather than answering approximately in three cases: past its own
  cap, past the PROVIDER's contents ceiling (`file_too_large` either way, which is also what stops
  GitHub's over-limit `403` reading as a revoked credential), and for bytes that are not UTF-8
  (`file_not_text`, carrying the `sha`).

  Watch for: `provisioning.type` must now be narrowed before `manifestSource` is read, since the public
  union is no longer single-member. A `custom` service patch that omits `manifestPath` CLEARS the stored
  one, which is the only way this surface can express "back to the manifest type's default".
  `RepoFileContent` gains an optional `lossy`, so a `VcsClient` implementation outside this repo should
  set it where it can tell. What was DELIBERATELY not added, and why, is
  `backend/docs/adr/0058-acceptance-kit-consumer-gaps.md`.

### Patch Changes

- Updated dependencies [302e05a]
- Updated dependencies [cda15b8]
  - @cat-factory/contracts@0.320.0
  - @cat-factory/kernel@0.310.0

## 0.20.31

### Patch Changes

- Updated dependencies [3afea3a]
  - @cat-factory/contracts@0.319.0
  - @cat-factory/kernel@0.309.0

## 0.20.30

### Patch Changes

- Updated dependencies [3f7d8b2]
  - @cat-factory/contracts@0.318.0
  - @cat-factory/kernel@0.308.0

## 0.20.29

### Patch Changes

- Updated dependencies [2a2b6ef]
  - @cat-factory/kernel@0.307.0

## 0.20.28

### Patch Changes

- Updated dependencies [5333319]
  - @cat-factory/kernel@0.306.0

## 0.20.27

### Patch Changes

- Updated dependencies [053aac8]
  - @cat-factory/contracts@0.317.0
  - @cat-factory/kernel@0.305.0

## 0.20.26

### Patch Changes

- Updated dependencies [eb5fa75]
- Updated dependencies [9d8fdf6]
  - @cat-factory/contracts@0.316.0
  - @cat-factory/kernel@0.304.0

## 0.20.25

### Patch Changes

- Updated dependencies [eb740be]
  - @cat-factory/contracts@0.315.0
  - @cat-factory/kernel@0.303.0

## 0.20.24

### Patch Changes

- Updated dependencies [7f990ea]
  - @cat-factory/contracts@0.314.0
  - @cat-factory/kernel@0.302.0

## 0.20.23

### Patch Changes

- Updated dependencies [409238f]
  - @cat-factory/kernel@0.301.0
  - @cat-factory/contracts@0.313.0

## 0.20.22

### Patch Changes

- Updated dependencies [0ef48d1]
  - @cat-factory/kernel@0.300.0
  - @cat-factory/contracts@0.312.0

## 0.20.21

### Patch Changes

- Updated dependencies [d5c1f1c]
- Updated dependencies [c67e924]
  - @cat-factory/kernel@0.299.1
  - @cat-factory/contracts@0.311.0

## 0.20.20

### Patch Changes

- Updated dependencies [056e18d]
  - @cat-factory/contracts@0.310.0
  - @cat-factory/kernel@0.299.0

## 0.20.19

### Patch Changes

- Updated dependencies [a81879b]
  - @cat-factory/contracts@0.309.0
  - @cat-factory/kernel@0.298.2

## 0.20.18

### Patch Changes

- Updated dependencies [0e1e0fa]
  - @cat-factory/contracts@0.308.1
  - @cat-factory/kernel@0.298.1

## 0.20.17

### Patch Changes

- Updated dependencies [7312e0a]
  - @cat-factory/kernel@0.298.0
  - @cat-factory/contracts@0.308.0

## 0.20.16

### Patch Changes

- Updated dependencies [95408c2]
  - @cat-factory/contracts@0.307.0
  - @cat-factory/kernel@0.297.0

## 0.20.15

### Patch Changes

- Updated dependencies [792ecde]
  - @cat-factory/kernel@0.296.1

## 0.20.14

### Patch Changes

- Updated dependencies [fc56d82]
- Updated dependencies [fc9afb4]
  - @cat-factory/contracts@0.306.0
  - @cat-factory/kernel@0.296.0

## 0.20.13

### Patch Changes

- Updated dependencies [edd4fd0]
  - @cat-factory/kernel@0.295.0
  - @cat-factory/contracts@0.305.0

## 0.20.12

### Patch Changes

- Updated dependencies [36e0c9b]
  - @cat-factory/contracts@0.304.0
  - @cat-factory/kernel@0.294.1

## 0.20.11

### Patch Changes

- Updated dependencies [569181d]
  - @cat-factory/contracts@0.303.0
  - @cat-factory/kernel@0.294.0

## 0.20.10

### Patch Changes

- Updated dependencies [1a0b593]
  - @cat-factory/contracts@0.302.0
  - @cat-factory/kernel@0.293.0

## 0.20.9

### Patch Changes

- Updated dependencies [7d1477c]
  - @cat-factory/kernel@0.292.2

## 0.20.8

### Patch Changes

- Updated dependencies [c09ddbe]
  - @cat-factory/kernel@0.292.1

## 0.20.7

### Patch Changes

- Updated dependencies [fc4a1e4]
  - @cat-factory/contracts@0.301.0
  - @cat-factory/kernel@0.292.0

## 0.20.6

### Patch Changes

- Updated dependencies [ee733ee]
  - @cat-factory/contracts@0.300.0
  - @cat-factory/kernel@0.291.0

## 0.20.5

### Patch Changes

- Updated dependencies [01086d8]
  - @cat-factory/contracts@0.299.1
  - @cat-factory/kernel@0.290.1

## 0.20.4

### Patch Changes

- Updated dependencies [1bcdacc]
  - @cat-factory/kernel@0.290.0

## 0.20.3

### Patch Changes

- Updated dependencies [195b248]
  - @cat-factory/contracts@0.299.0
  - @cat-factory/kernel@0.289.1

## 0.20.2

### Patch Changes

- Updated dependencies [bc2478d]
  - @cat-factory/contracts@0.298.0
  - @cat-factory/kernel@0.289.0

## 0.20.1

### Patch Changes

- Updated dependencies [a634746]
  - @cat-factory/contracts@0.297.0
  - @cat-factory/kernel@0.288.0

## 0.20.0

### Minor Changes

- 7893f35: `/api/v1` can ADOPT a repository that already exists: `GET /api/v1/repos/available` lists what a
  workspace's connection can reach, and `POST /api/v1/repos/link` adopts one by name. Surface version
  1.44.0, additive.

  The hole they close was invisible from the surface. `GET /api/v1/repos` serves the repositories a
  workspace has LINKED, which is a set someone assembles in the app: linking is explicit per workspace,
  the provider webhook for an added repository does not project one, and a resync refreshes what is
  already linked rather than rediscovering the installation. So a repository that exists and is
  perfectly reachable is absent from every public read until a human opens the picker, and
  `POST /api/v1/services` answers 404 for its `repoId`, which is byte-for-byte what a caller gets for a
  repository that does not exist. A deployment could CREATE a repository through this API (1.41.0's
  bootstrap) and could not adopt one it already had.

  The two reads are a population pair rather than a duplicate, with `linked` as the join, so an absent
  repository is now diagnosable: reachable-but-unadopted appears in `/repos/available` with
  `linked: false`, and one that does not exist appears in neither. The adopt takes `owner`/`name`
  because a caller setting a workspace up from configuration knows the name and cannot know a provider
  id for a repository no public read lists; it is idempotent, answers the same row shape `/repos`
  serves (projected from the same read, so the two cannot disagree about whether a repository is free),
  and refuses an unreachable one with `404 repo_not_reachable`, a reason that covers "does not exist"
  and "your credential is not granted it" together because a provider answers those identically.
  `GitHubSyncService.linkRepoBySlug` resolves through the same path the app's own picker uses, and
  matches the OWNER as well as the name: a slug search can surface a look-alike, and linking that one
  would file a caller's work in someone else's account while answering 200.

  The acceptance suite uses them, which is what makes a hand-written `.env` a supported way in rather
  than a setup only `configure` could finish. Spec 01 adopts a repository the workspace does not hold
  instead of refusing; `target-repos` gates on REACHABILITY, point-reading `/repos/available` for
  anything unlinked and reporting "reachable but not adopted yet" as a pass; and `configure` adopts each
  repository rather than printing instructions for doing it by hand. Every attempt states its outcome,
  because a loop that reports only its positive answer is indistinguishable from one doing nothing, and
  what a refusal now asks for is only what no API can do: create the repository, and grant the
  credential access to it.

  Review follow-ups on the pair, all still inside 1.44.0 and still additive:

  Both rows now report whether a repository is SPOKEN FOR, from one account-scoped judgement.
  `/repos/available` publishes `serviceId` and `linkedElsewhere` exactly as `/repos` does, because a
  repository nobody here has linked can still back a service on another board of the account, and
  `POST /api/v1/services` refuses it either way. A discovery read that could not say so handed a
  caller a repository whose next call fails, and it was the acceptance gate that felt it first: it
  green-lit a pass that then died on the adopt, after the run the gate exists to precede. The
  judgement is now `PublicBoardReads.repoUse`, asked once of the projection (the repos list) and once
  of a batch of ids (the available read), so there is no second derivation to drift.

  The available read also publishes `truncated`. The provider legs behind it stop at a page cap and a
  search cap, so on a wide connection the rows are a prefix and a reachable repository can be missing
  from them, which is indistinguishable from the non-existence this read exists to diagnose. A
  point-read (`?q=owner/name`) resolves the exact slug directly and stays authoritative either way.

  A provider refusal is answered as one on BOTH operations and on either provider. The available read
  was left unwrapped, so a revoked credential or a rate limit on it arrived as `500 internal` rather
  than the documented 503/429; and the mapping recognised `GitHubApiError` alone, so a GitLab-connected
  workspace got that same `500` for a revoked token on both routes. Kernel now owns a `VcsApiError`
  base that both provider clients extend, which is the identity a consumer above the adapters branches
  on.

  The adopt is idempotent for a repository the credential can no longer reach: it resolves from what
  the workspace LINKS before consulting the provider, so a re-run no longer answers 404 for a
  repository `GET /api/v1/repos` still lists (a personal repository, or a narrowed App grant). And the
  link's `owner` accepts a namespace PATH, so a GitLab project under nested groups can be adopted at
  all: the available read published `group/subgroup` and the adopt refused it with a 422.

  In the suite, "the connection cannot reach it" is now recognised by `details.reason`, not by the 404
  alone: a deployment older than these endpoints answers an unmatched route with the same status, and
  reading that as "create the repository" sent an operator to create one they already had.

  Internal, breaking for in-repo callers only: `GitHubSyncService.listAvailableRepos` answers
  `{ repos, truncated }` rather than an array, the kernel `GitHubClient.searchInstallationRepos` port
  answers a `Paged` rather than an array (every adapter caps something, and a search that filters a
  bounded listing can return two rows and still be a prefix, which no row count reveals), and the
  `viewerRepos` / `patInstallationRepos` caches hold the whole page rather than its items (an
  enumeration that stopped at the cap is a prefix, and caching only the rows served that prefix to
  every later keystroke as the complete set).

### Patch Changes

- Updated dependencies [7893f35]
  - @cat-factory/contracts@0.296.0
  - @cat-factory/kernel@0.287.0

## 0.19.20

### Patch Changes

- Updated dependencies [07ff467]
  - @cat-factory/contracts@0.295.0
  - @cat-factory/kernel@0.286.3

## 0.19.19

### Patch Changes

- Updated dependencies [9b3473a]
  - @cat-factory/contracts@0.294.0
  - @cat-factory/kernel@0.286.2

## 0.19.18

### Patch Changes

- b889842: Report the actual cause of a failure everywhere, not just on a "Test connection" button.

  The previous slice taught the connection PROBES to read the cause chain, because on Node a transport
  failure is `TypeError: fetch failed` and what happened hangs off `.cause`. It turned out the repo had
  three describers of a thrown value and the other two stopped at `error.message`: `getErrorMessage`
  (the string a human is shown, and what a persisted failure reason or a PR comment records) and
  `describeError` (every log line). So a probe could name `connect ECONNREFUSED 127.0.0.1:6443` while
  the log line and the toast for the same failure still said `fetch failed`, which is what made a
  Kubernetes connect failure unexplainable even with the probe fixed.

  All three now flatten through one kernel core (`shared/error-chain.logic.ts`): `.cause` plus each
  `AggregateError` branch (so a dual-stack `localhost` reports what happened on each address), scrubbed
  through `redactSecrets`, capped with a marker saying what it dropped, and bounded by link identity so
  a cause cycle terminates. Roughly 90 hand-rolled `e instanceof Error ? e.message : String(e)` copies
  across the backend now call `getErrorMessage`, and five local `errMessage`/`messageOf` wrappers are
  deleted.

  Who may read a chain is part of the rule. An AUTHENTICATED reader gets it, because the inner link is
  usually the only thing saying whether the fix is theirs or the deployment's; where a deployment's
  model endpoints are platform-internal, their host and port do reach a workspace member through an
  ordinary 4xx. An UNAUTHENTICATED surface does not: `/ready` on BOTH facades answers with kernel's
  `publicDiagnostic` (the outermost link, scrubbed) rather than publishing the deployment's database
  address, sharing one helper so the two runtimes cannot drift to different depths.

  A VERDICT does not read the rendered string either. `errorChainMatches` tests each link uncapped, so
  a sentinel phrase pushed past the display budget by a long wrapper cannot silently turn a recognised
  rollout stop into a crash. Relatedly, log fields get their own, much wider cap than the 400 characters
  a human-facing message is held to, and an error with nothing to say answers with the empty string
  rather than the bare constructor name, so a call site's `getErrorMessage(e) || '<what to do>'` guard
  still fires.

  `redactSecrets` now spares a single-case word and an env-var-shaped identifier where a field-name rule
  matched: it scrubs the message a person reads, and `Missing required key: OPENAI_API_KEY` must not
  lose the name they have to go and set. Every credential shape the rules exist for still matches.

  An error message may therefore now carry appended causes where it did not before. The opening phrase
  is unchanged, which is what the downstream `/dispatch failed/i` and eviction-sentinel checks match on.

  On the SPA, every failure toast goes through the one funnel that already existed for pipeline errors,
  instead of 29 per-component copies of the same `notifyError(title, e)` and ~83 direct `toast.add`
  calls rendering the raw message. Beyond the translated copy that funnel already resolved, a failure
  toast now stays until dismissed instead of vanishing after about five seconds, its text is
  selectable, and one click copies the whole report: the action that failed, the class of failure, the
  backend's own account, and the `requestId` that is the only join between what the user saw and the
  server log line explaining it. Conflict (409) toasts get the same treatment, which matters most on
  the unknown-reason path, since that is where a reason an older SPA build has never heard of lands.

  `@cat-factory/cli` carries its own copy of the describer rather than importing kernel. That package is
  published and deliberately runtime-dependency-free, so a `workspace:*` import from its `bin` resolves
  through pnpm's link locally and is simply absent off the registry; a conformity test pins the copy to
  kernel's output byte for byte.

- Updated dependencies [b889842]
  - @cat-factory/kernel@0.286.1

## 0.19.17

### Patch Changes

- Updated dependencies [b25732f]
  - @cat-factory/contracts@0.293.0
  - @cat-factory/kernel@0.286.0

## 0.19.16

### Patch Changes

- Updated dependencies [7119ca7]
  - @cat-factory/contracts@0.292.2
  - @cat-factory/kernel@0.285.3

## 0.19.15

### Patch Changes

- Updated dependencies [57a7ecd]
  - @cat-factory/contracts@0.292.1
  - @cat-factory/kernel@0.285.2

## 0.19.14

### Patch Changes

- Updated dependencies [5f6699a]
  - @cat-factory/contracts@0.292.0
  - @cat-factory/kernel@0.285.1

## 0.19.13

### Patch Changes

- Updated dependencies [22b2459]
- Updated dependencies [2428b6b]
  - @cat-factory/kernel@0.285.0
  - @cat-factory/contracts@0.291.0

## 0.19.12

### Patch Changes

- Updated dependencies [19baddf]
  - @cat-factory/kernel@0.284.0

## 0.19.11

### Patch Changes

- Updated dependencies [31f43c1]
  - @cat-factory/contracts@0.290.0
  - @cat-factory/kernel@0.283.0

## 0.19.10

### Patch Changes

- Updated dependencies [3ff215a]
  - @cat-factory/contracts@0.289.1
  - @cat-factory/kernel@0.282.1

## 0.19.9

### Patch Changes

- Updated dependencies [e3cf16a]
  - @cat-factory/contracts@0.289.0
  - @cat-factory/kernel@0.282.0

## 0.19.8

### Patch Changes

- Updated dependencies [83764b5]
  - @cat-factory/contracts@0.288.0
  - @cat-factory/kernel@0.281.3

## 0.19.7

### Patch Changes

- Updated dependencies [1fbd83c]
- Updated dependencies [00228c6]
  - @cat-factory/contracts@0.287.1
  - @cat-factory/kernel@0.281.2

## 0.19.6

### Patch Changes

- Updated dependencies [bf473bd]
  - @cat-factory/contracts@0.287.0
  - @cat-factory/kernel@0.281.1

## 0.19.5

### Patch Changes

- Updated dependencies [4715b74]
- Updated dependencies [8c1d8a6]
  - @cat-factory/contracts@0.286.0
  - @cat-factory/kernel@0.281.0

## 0.19.4

### Patch Changes

- Updated dependencies [afe1250]
  - @cat-factory/contracts@0.285.0
  - @cat-factory/kernel@0.280.0

## 0.19.3

### Patch Changes

- Updated dependencies [e3fdc15]
  - @cat-factory/contracts@0.284.0
  - @cat-factory/kernel@0.279.3

## 0.19.2

### Patch Changes

- Updated dependencies [3036af7]
  - @cat-factory/kernel@0.279.2

## 0.19.1

### Patch Changes

- Updated dependencies [de7caaf]
  - @cat-factory/contracts@0.283.1
  - @cat-factory/kernel@0.279.1

## 0.19.0

### Minor Changes

- f0e1c45: Issue writeback is a `TaskSourceProvider` capability, and GitLab Issues accept webhooks

  The engine's writeback (a comment when the PR opens, comment + resolve on merge, the intake
  pickup claim, a parked review's questions and the acknowledgement of a reply) dispatched on a
  hard-coded `github | jira | linear` chain inside one service. GitLab Issues, a shipped task
  source, therefore had full intake and no way to answer it, and a tracker a deployment registers
  could not have one however it was wired. Providers now declare `writeback`, the outbound mirror
  of the existing `webhook` capability, and the service dispatches through the registry.

  `GitLabIssuesProvider` also gains the inbound half: GitLab echoes a shared secret in
  `x-gitlab-token` rather than signing the body, so its adapter compares that in constant time and
  still fails closed on an empty secret. Board equality is now the source's own rule
  (`TaskSourceProvider.sameBoard`), because GitLab project paths are case-sensitive where every
  other board id folds.

  A writeback adapter declares where it gets its authority (`authenticates`), which decides what an
  unreadable tracker connection costs. Jira and Linear post with the stored bag, so a row that will
  not open takes their writeback with it. GitHub Issues and GitLab Issues authenticate through the
  workspace's VCS installation and read that row only for the inbound reply secret, so they keep
  posting and lose just the reply grammar, which is withheld rather than promised.

  Two internal breaks, per the pre-1.0 policy. The facades' `commentOnGitHubIssue` /
  `closeGitHubIssue` / `labelGitHubIssue` writeback seams are gone (the source resolves its own
  installation now), and a writeback for a workspace with no stored connection REFUSES where the
  Jira and Linear legs used to return quietly: that silent return let the parked-review echo record
  its idempotency marker for a comment the tracker never received.

### Patch Changes

- Updated dependencies [f0e1c45]
  - @cat-factory/kernel@0.279.0

## 0.18.15

### Patch Changes

- Updated dependencies [6ad1d8b]
  - @cat-factory/contracts@0.283.0
  - @cat-factory/kernel@0.278.0

## 0.18.14

### Patch Changes

- Updated dependencies [a596b9c]
  - @cat-factory/contracts@0.282.0
  - @cat-factory/kernel@0.277.0

## 0.18.13

### Patch Changes

- Updated dependencies [2585b2f]
  - @cat-factory/contracts@0.281.0
  - @cat-factory/kernel@0.276.0

## 0.18.12

### Patch Changes

- Updated dependencies [faddbf5]
  - @cat-factory/contracts@0.280.0
  - @cat-factory/kernel@0.275.4

## 0.18.11

### Patch Changes

- Updated dependencies [8a06abc]
- Updated dependencies [8a06abc]
  - @cat-factory/contracts@0.279.0
  - @cat-factory/kernel@0.275.3

## 0.18.10

### Patch Changes

- Updated dependencies [11f9efa]
  - @cat-factory/contracts@0.278.0
  - @cat-factory/kernel@0.275.2

## 0.18.9

### Patch Changes

- Updated dependencies [c44e9d7]
  - @cat-factory/contracts@0.277.0
  - @cat-factory/kernel@0.275.1

## 0.18.8

### Patch Changes

- Updated dependencies [dfa4a8e]
  - @cat-factory/kernel@0.275.0

## 0.18.7

### Patch Changes

- Updated dependencies [3e9a6af]
  - @cat-factory/contracts@0.276.0
  - @cat-factory/kernel@0.274.0

## 0.18.6

### Patch Changes

- Updated dependencies [a62bcf8]
- Updated dependencies [fe8ca56]
- Updated dependencies [2544fb3]
  - @cat-factory/kernel@0.273.0
  - @cat-factory/contracts@0.275.0

## 0.18.5

### Patch Changes

- Updated dependencies [35bc18f]
- Updated dependencies [882b94f]
- Updated dependencies [f2ead2a]
  - @cat-factory/kernel@0.272.0
  - @cat-factory/contracts@0.274.0

## 0.18.4

### Patch Changes

- Updated dependencies [6e07961]
- Updated dependencies [9f9c240]
  - @cat-factory/kernel@0.271.0
  - @cat-factory/contracts@0.273.0

## 0.18.3

### Patch Changes

- Updated dependencies [6c6dd0c]
- Updated dependencies [70745b6]
  - @cat-factory/kernel@0.270.0
  - @cat-factory/contracts@0.272.0

## 0.18.2

### Patch Changes

- Updated dependencies [55310f6]
- Updated dependencies [55310f6]
  - @cat-factory/contracts@0.271.0
  - @cat-factory/kernel@0.269.0

## 0.18.1

### Patch Changes

- Updated dependencies [17687a1]
  - @cat-factory/contracts@0.270.0
  - @cat-factory/kernel@0.268.0

## 0.18.0

### Minor Changes

- f0154ce: Let a GitLab-only deployment run the recurring bug-intake schedule and the interactive bug hunt.

  The GitLab task source could import an issue you pointed at and search the project a service frame
  was linked to, but neither of the two paths that PICK work by predicate: the recurring `bug-intake`
  schedule and the bug hunt. So a shop running GitLab for both code and issues could have its agents
  work in its repositories and still had to connect a second tracker to schedule anything.

  `GitLabIssuesProvider` now implements `searchIssues`, `listBoards` and `listBugCandidates`, all
  three riding the project-scoped issue read the earlier slice added: the scope is an ARGUMENT of the
  request rather than a qualifier in a query string, and GitLab returns the description, labels, age
  and note count in the same response, so a whole hunt scan is one call per page and never a
  per-candidate fetch. A schedule scopes itself with a new `gitlabProject` board field (its own leg,
  because a GitLab namespace nests and `owner/name` cannot express it) which the recurring-pipeline
  modal now renders.

  Two provider differences are stated rather than smoothed over. GitLab's issue search covers the
  description as well as the title, so a title-fragment predicate now rides a new `textIn: 'title'`
  narrowing: without it a schedule configured on a fragment would have started a pipeline on an issue
  that merely mentions it in its body. And `issueType` is ignored, as it already is on Linear:
  GitLab's own type vocabulary is `issue` / `incident` / `test_case` / `task`, which has no member
  meaning "bug", and `bug` is exactly what intake defaults the predicate to, so a GitLab intake
  narrows to bugs through a label instead.

  This also fixes a live mis-routing the previous slice opened: the bug hunt mapped a caller's board
  id onto the leg its provider reads with an `if`-chain that fell through to the opaque
  deployment-registered leg, so every GitLab hunt handed its project path to a field no built-in
  provider reads and reported an empty board. It is now an exhaustive record over the built-in
  vocabulary, so a fifth built-in source fails to compile until it names its leg.

  A predicate a source cannot evaluate is now declared rather than dropped in silence. GitLab and
  Linear both ignore `issueType`, and both intake forms rendered the field anyway, so an operator
  configuring a schedule saw a filter that was never applied: on an unattended `bug-intake` schedule,
  whose default is `bug`, that starts the bugfix pipeline on whatever is oldest and open. A provider
  now states its gaps on `TaskSourceProvider.ignoredIntakePredicates`, `TaskSourceState` carries them
  to the SPA, and the recurring-schedule and bug-hunt modals replace the field with what to narrow
  with instead. `intakePredicateSupport.test.ts` keeps a declaration honest by compiling each source's
  query with and without each predicate, so the answer is read off the compiler rather than restated
  beside it.

  Two GitLab-specific corrections ride along. The intake walk now pages on GitLab's own
  `Link: rel="next"` (carried out on the new `ProjectIssuePage`) instead of treating a short page as
  the last one: `max_page_size` is an instance setting an administrator can lower below the overscan
  size, and on such an instance every page is short, so the walk stopped after page 1 and reported a
  board it never finished as exhausted. And a walk whose workspace has no GitLab connection now
  refuses instead of returning an empty list, which the intake step renders as the cause of a
  no-pickup fire rather than as "no matching open issues".

  `ProjectIssuePage` replaces the bare hit array `VcsClient.searchProjectIssues` /
  `GitHubClient.searchProjectIssues` returned. Both are internal ports with one implementation.

### Patch Changes

- Updated dependencies [01bb6d2]
- Updated dependencies [f0154ce]
- Updated dependencies [eac67c5]
- Updated dependencies [2b74bd0]
  - @cat-factory/contracts@0.269.0
  - @cat-factory/kernel@0.267.0

## 0.17.3

### Patch Changes

- Updated dependencies [eaab22a]
  - @cat-factory/contracts@0.268.0
  - @cat-factory/kernel@0.266.0

## 0.17.2

### Patch Changes

- Updated dependencies [74ea2bc]
  - @cat-factory/contracts@0.267.0
  - @cat-factory/kernel@0.265.0

## 0.17.1

### Patch Changes

- Updated dependencies [1c8df4a]
  - @cat-factory/contracts@0.266.0
  - @cat-factory/kernel@0.264.0

## 0.17.0

### Minor Changes

- 6637bbd: Add GitLab Issues as a task source: import, search and setup check.

  `gitlab` joins `BUILTIN_TASK_SOURCE_KINDS`, so a shop that runs GitLab for both code and issues can
  link an issue onto a board block as agent context instead of connecting a second vendor beside its
  repositories. `GitLabIssuesProvider` stores no credentials of its own: it reads through the
  workspace's existing GitLab connection, the same credentialless shape GitHub Issues has. The
  recurring `bug-intake` schedule, the bug hunt, push intake and ticket writeback are the remaining
  slices ([`docs/initiatives/gitlab-issues-intake.md`](./docs/initiatives/gitlab-issues-intake.md)).

  The public-API `TaskSourceKind` enum gains a member (OpenAPI 1.25.0, SDKs regenerated). Additive on
  a closed vocabulary the clients already tolerate unknown members of, so a consumer built against
  1.24.0 keeps parsing every response it understood.

  Four internal shapes changed, none externally consumed:

  - `VcsClient` / `GitHubClient` gain an optional `searchProjectIssues(connection, ref, query)`.
    GitLab's global issue search accepts no project qualifier, so a repo scope cannot be expressed as
    query text there the way GitHub's `repo:` does; the scope is an argument instead, and the
    predicates ride a `ProjectIssueQuery` the vendor evaluates.
  - `TaskSourceProvider.fetchTask` takes `workspaceId`. A GitLab PAT connection is keyed on the
    workspace, not on the account owning the project, so without it the provider could only scan
    every connection on the deployment for one able to read the id.
  - `TaskSourceProvider` gains an optional `repoScope`, whose PRESENCE declares the source
    repo-backed. One member rather than a flag beside a matcher, because the same fact decides two
    things that must agree: that the source's search is handed a resolved repository, and that the
    workspace's imported rows narrow to one.
  - `TaskSourceState` gains `supportsIntake` and `ridesVcsProvider`, both derived from the registered
    provider: whether it implements the predicate search a schedule fires, and which VCS connection
    it authenticates through (so the settings panel can name the right remedy for an unavailable
    source instead of inferring one).

  Two live bugs are fixed on the way. A workspace connected to GitLab reported **GitHub Issues** as
  available (availability keyed on a connection EXISTING rather than on its provider, and both live in
  one row per workspace), so the source looked connected and its import resolved an empty projection.
  And the recurring-schedule form offered every connected source regardless of whether its provider
  could search on a schedule, which saved a schedule that could never fire.

  Three surfaces that hard-coded `github` are now asked of the registry, which is what makes a
  FOURTH source work rather than merely exist: the search route resolves a repo scope for any source
  declaring `repoScope` (a repo-backed source refuses a null one, so GitLab search was 422ing on
  every query), the imported-issue list narrows every repo-backed source's rows to the service's own
  repository, and the issue-tracker settings panel renders one card per registered source instead of
  one hard-coded card per built-in.

### Patch Changes

- Updated dependencies [6637bbd]
  - @cat-factory/contracts@0.265.0
  - @cat-factory/kernel@0.263.0

## 0.16.19

### Patch Changes

- Updated dependencies [be9b8dc]
  - @cat-factory/contracts@0.264.0
  - @cat-factory/kernel@0.262.2

## 0.16.18

### Patch Changes

- Updated dependencies [1025674]
- Updated dependencies [e5f7eb0]
  - @cat-factory/contracts@0.263.0
  - @cat-factory/kernel@0.262.1

## 0.16.17

### Patch Changes

- Updated dependencies [8cbd518]
- Updated dependencies [8cbd518]
- Updated dependencies [7a2730a]
  - @cat-factory/contracts@0.262.0
  - @cat-factory/kernel@0.262.0

## 0.16.16

### Patch Changes

- Updated dependencies [f7882cf]
- Updated dependencies [e6aa37d]
- Updated dependencies [aabfb4d]
  - @cat-factory/contracts@0.261.1
  - @cat-factory/kernel@0.261.0

## 0.16.15

### Patch Changes

- Updated dependencies [9d6bce0]
  - @cat-factory/kernel@0.260.0

## 0.16.14

### Patch Changes

- Updated dependencies [24f76f1]
- Updated dependencies [964cfa6]
  - @cat-factory/contracts@0.261.0
  - @cat-factory/kernel@0.259.0

## 0.16.13

### Patch Changes

- Updated dependencies [ae44914]
- Updated dependencies [4be3510]
  - @cat-factory/contracts@0.260.0
  - @cat-factory/kernel@0.258.0

## 0.16.12

### Patch Changes

- Updated dependencies [11dae5b]
  - @cat-factory/contracts@0.259.0
  - @cat-factory/kernel@0.257.0

## 0.16.11

### Patch Changes

- Updated dependencies [6076cf1]
- Updated dependencies [2fdb08d]
- Updated dependencies [11a2966]
  - @cat-factory/kernel@0.256.0
  - @cat-factory/contracts@0.258.0

## 0.16.10

### Patch Changes

- Updated dependencies [00bff05]
  - @cat-factory/contracts@0.257.0
  - @cat-factory/kernel@0.255.1

## 0.16.9

### Patch Changes

- Updated dependencies [ab0c228]
  - @cat-factory/contracts@0.256.0
  - @cat-factory/kernel@0.255.0

## 0.16.8

### Patch Changes

- Updated dependencies [ee6ce7c]
  - @cat-factory/kernel@0.254.0
  - @cat-factory/contracts@0.255.0

## 0.16.7

### Patch Changes

- Updated dependencies [16576d6]
  - @cat-factory/kernel@0.253.0
  - @cat-factory/contracts@0.254.0

## 0.16.6

### Patch Changes

- Updated dependencies [5202fb9]
  - @cat-factory/kernel@0.252.0
  - @cat-factory/contracts@0.253.0

## 0.16.5

### Patch Changes

- Updated dependencies [e845d65]
  - @cat-factory/kernel@0.251.0

## 0.16.4

### Patch Changes

- Updated dependencies [4c071ec]
  - @cat-factory/contracts@0.252.0
  - @cat-factory/kernel@0.250.0

## 0.16.3

### Patch Changes

- Updated dependencies [3fbc87e]
- Updated dependencies [c9adc67]
  - @cat-factory/contracts@0.251.0
  - @cat-factory/kernel@0.249.0

## 0.16.2

### Patch Changes

- Updated dependencies [e7e27ee]
  - @cat-factory/contracts@0.250.0
  - @cat-factory/kernel@0.248.0

## 0.16.1

### Patch Changes

- Updated dependencies [53cd697]
  - @cat-factory/contracts@0.249.0
  - @cat-factory/kernel@0.247.0

## 0.16.0

### Minor Changes

- 6d3f784: Local mode takes its source-control token from the sign-in screen

  A local deployment with no `GITHUB_PAT` / `GITLAB_PAT` used to send a developer to the right
  token page and then have nowhere to put the result: the token had to go into `.env`, followed by
  a restart. The sign-in screen now accepts it directly, and it becomes the deployment's own
  credential (sealed on the machine under `ENCRYPTION_KEY`), live for the next dispatch, gate probe
  and repo read. `.env` still wins where it is set, and closes the browser flow.

  `@cat-factory/server` additionally exports `githubRepoOrigin`, the clone origin a dispatch already
  fell back to, so a facade whose own resolver handles only the non-GitHub case can delegate the
  GitHub half instead of restating the URL.

  Internal breaks in the affected packages: `VcsIdentityEntry.configuredToken` and
  `CoreDependencies.sharedStackCloneToken` are now getters, `buildGitLabEngineClient` takes a token
  or a getter, and the local facade's `createLocalGitHubClient` / `createLocalGitLabClient` take a
  token getter and always return a client (an unconfigured deployment REFUSES on use, naming the
  fix, rather than presenting no client at all).

### Patch Changes

- Updated dependencies [6d3f784]
  - @cat-factory/kernel@0.246.0
  - @cat-factory/contracts@0.248.0

## 0.15.43

### Patch Changes

- Updated dependencies [0937581]
- Updated dependencies [250b7dc]
  - @cat-factory/contracts@0.247.0
  - @cat-factory/kernel@0.245.0

## 0.15.42

### Patch Changes

- Updated dependencies [ec96387]
- Updated dependencies [7f5ed08]
- Updated dependencies [4e4d1b4]
  - @cat-factory/contracts@0.246.0
  - @cat-factory/kernel@0.244.0

## 0.15.41

### Patch Changes

- Updated dependencies [10e7a15]
- Updated dependencies [ca213b1]
  - @cat-factory/contracts@0.245.0
  - @cat-factory/kernel@0.243.1

## 0.15.40

### Patch Changes

- Updated dependencies [d69115d]
  - @cat-factory/contracts@0.244.0
  - @cat-factory/kernel@0.243.0

## 0.15.39

### Patch Changes

- Updated dependencies [f775c1d]
- Updated dependencies [bac6776]
- Updated dependencies [3857ea4]
  - @cat-factory/kernel@0.242.0
  - @cat-factory/contracts@0.243.0

## 0.15.38

### Patch Changes

- Updated dependencies [7cf3e70]
  - @cat-factory/kernel@0.241.1

## 0.15.37

### Patch Changes

- Updated dependencies [e7867db]
- Updated dependencies [00c4d94]
  - @cat-factory/contracts@0.242.0
  - @cat-factory/kernel@0.241.0

## 0.15.36

### Patch Changes

- Updated dependencies [c5a1a16]
  - @cat-factory/contracts@0.241.0
  - @cat-factory/kernel@0.240.0

## 0.15.35

### Patch Changes

- Updated dependencies [dd90c1e]
- Updated dependencies [289b3de]
- Updated dependencies [dd90c1e]
- Updated dependencies [dd90c1e]
  - @cat-factory/contracts@0.240.0
  - @cat-factory/kernel@0.239.0

## 0.15.34

### Patch Changes

- Updated dependencies [4e5640d]
- Updated dependencies [a675c63]
  - @cat-factory/kernel@0.238.0
  - @cat-factory/contracts@0.239.0

## 0.15.33

### Patch Changes

- Updated dependencies [2c7d17d]
- Updated dependencies [aa62acf]
  - @cat-factory/kernel@0.237.0
  - @cat-factory/contracts@0.238.0

## 0.15.32

### Patch Changes

- Updated dependencies [99be350]
  - @cat-factory/contracts@0.237.0
  - @cat-factory/kernel@0.236.1

## 0.15.31

### Patch Changes

- Updated dependencies [c9c1dd3]
  - @cat-factory/contracts@0.236.0
  - @cat-factory/kernel@0.236.0

## 0.15.30

### Patch Changes

- Updated dependencies [6b9f696]
  - @cat-factory/kernel@0.235.1

## 0.15.29

### Patch Changes

- Updated dependencies [cec0c3e]
  - @cat-factory/contracts@0.235.0
  - @cat-factory/kernel@0.235.0

## 0.15.28

### Patch Changes

- Updated dependencies [8cbf1a7]
  - @cat-factory/contracts@0.234.0
  - @cat-factory/kernel@0.234.2

## 0.15.27

### Patch Changes

- Updated dependencies [ee6601e]
  - @cat-factory/contracts@0.233.0
  - @cat-factory/kernel@0.234.1

## 0.15.26

### Patch Changes

- Updated dependencies [937d4af]
  - @cat-factory/contracts@0.232.0
  - @cat-factory/kernel@0.234.0

## 0.15.25

### Patch Changes

- Updated dependencies [2580fee]
- Updated dependencies [eb4ca17]
  - @cat-factory/kernel@0.233.0
  - @cat-factory/contracts@0.231.0

## 0.15.24

### Patch Changes

- Updated dependencies [1f14793]
- Updated dependencies [2619d79]
  - @cat-factory/contracts@0.230.1
  - @cat-factory/kernel@0.232.0

## 0.15.23

### Patch Changes

- Updated dependencies [e7e4404]
  - @cat-factory/contracts@0.230.0
  - @cat-factory/kernel@0.231.0

## 0.15.22

### Patch Changes

- Updated dependencies [10e0341]
- Updated dependencies [10e0341]
  - @cat-factory/contracts@0.229.0
  - @cat-factory/kernel@0.230.0

## 0.15.21

### Patch Changes

- Updated dependencies [fccb1df]
  - @cat-factory/contracts@0.228.0
  - @cat-factory/kernel@0.229.0

## 0.15.20

### Patch Changes

- Updated dependencies [437a0c6]
  - @cat-factory/contracts@0.227.0
  - @cat-factory/kernel@0.228.1

## 0.15.19

### Patch Changes

- Updated dependencies [43fd5c0]
  - @cat-factory/kernel@0.228.0
  - @cat-factory/contracts@0.226.0

## 0.15.18

### Patch Changes

- Updated dependencies [0456066]
  - @cat-factory/contracts@0.225.0
  - @cat-factory/kernel@0.227.0

## 0.15.17

### Patch Changes

- Updated dependencies [f1a6cb3]
- Updated dependencies [cc17221]
- Updated dependencies [889a497]
- Updated dependencies [3605630]
  - @cat-factory/contracts@0.224.0
  - @cat-factory/kernel@0.226.0

## 0.15.16

### Patch Changes

- Updated dependencies [36b1853]
  - @cat-factory/contracts@0.223.0
  - @cat-factory/kernel@0.225.0

## 0.15.15

### Patch Changes

- Updated dependencies [413095f]
  - @cat-factory/contracts@0.222.0
  - @cat-factory/kernel@0.224.0

## 0.15.14

### Patch Changes

- Updated dependencies [04e44f8]
  - @cat-factory/contracts@0.221.0
  - @cat-factory/kernel@0.223.0

## 0.15.13

### Patch Changes

- Updated dependencies [c8ba2cd]
- Updated dependencies [807e442]
- Updated dependencies [807e442]
- Updated dependencies [175f78f]
- Updated dependencies [807e442]
  - @cat-factory/contracts@0.220.0
  - @cat-factory/kernel@0.222.0

## 0.15.12

### Patch Changes

- Updated dependencies [1106c93]
  - @cat-factory/contracts@0.219.0
  - @cat-factory/kernel@0.221.1

## 0.15.11

### Patch Changes

- Updated dependencies [f63145d]
- Updated dependencies [3b88f66]
  - @cat-factory/contracts@0.218.0
  - @cat-factory/kernel@0.221.0

## 0.15.10

### Patch Changes

- Updated dependencies [7f86f07]
- Updated dependencies [7f86f07]
  - @cat-factory/contracts@0.217.0
  - @cat-factory/kernel@0.220.0

## 0.15.9

### Patch Changes

- Updated dependencies [87161e8]
  - @cat-factory/contracts@0.216.0
  - @cat-factory/kernel@0.219.0

## 0.15.8

### Patch Changes

- Updated dependencies [96ad850]
- Updated dependencies [96ad850]
  - @cat-factory/contracts@0.215.0
  - @cat-factory/kernel@0.218.0

## 0.15.7

### Patch Changes

- Updated dependencies [4c26c01]
  - @cat-factory/contracts@0.214.0
  - @cat-factory/kernel@0.217.0

## 0.15.6

### Patch Changes

- Updated dependencies [924c6f9]
  - @cat-factory/contracts@0.213.0
  - @cat-factory/kernel@0.216.0

## 0.15.5

### Patch Changes

- Updated dependencies [233e279]
- Updated dependencies [54d531d]
  - @cat-factory/contracts@0.212.0
  - @cat-factory/kernel@0.215.0

## 0.15.4

### Patch Changes

- Updated dependencies [87ed4f9]
  - @cat-factory/contracts@0.211.0
  - @cat-factory/kernel@0.214.1

## 0.15.3

### Patch Changes

- Updated dependencies [3435bd1]
  - @cat-factory/kernel@0.214.0

## 0.15.2

### Patch Changes

- Updated dependencies [70b4339]
  - @cat-factory/kernel@0.213.0

## 0.15.1

### Patch Changes

- Updated dependencies [f31c644]
- Updated dependencies [4ac6960]
- Updated dependencies [874d684]
  - @cat-factory/kernel@0.212.0
  - @cat-factory/contracts@0.210.1

## 0.15.0

### Minor Changes

- 769a3d9: Close the PR-deep-review parity gap on GitLab: `FetchGitLabClient` now implements
  `listChangedFiles`, `getPullRequestHeadRef`, `getPullRequestHeadSha` and `createReview`. All four
  are optional on the `VcsClient` port and every consumer degrades silently without them, so a
  GitLab deployment previously ran the review flow to completion while the merge track record
  classified every run `unknown` (never matching a per-class merge rule) and the selected findings
  never reached the merge request. Cross-provider conformance now asserts their presence.

  Two breaking shapes ride along, both because a provider that cannot answer must say so rather than
  answer zero:

  - **`GitHubChangedFile.additions` / `deletions` are now `number | null`.** Null means the host did
    not report a count — GitLab withholds the hunk the counts are derived from for an oversized diff,
    and these render straight into the reviewer's prompt, where `+0/-0` describes a file nobody
    touched. GitHub still reports a real `0` for a binary it cannot line-count, and the conformance
    suite pins both. A consumer folding null to `0` must now do so deliberately. GitHub's own mapper
    moves to `githubProjection.toChangedFileProjection` (`@cat-factory/integrations`) so the decision
    sits beside its GitLab counterpart rather than inline in the fetch client.
  - **`logger` is REQUIRED on the GitLab facade builders** (`buildGitLabEngineClient`,
    `buildGitLabConnectClient`, `registerGitLab`) and is kernel's `Logger` rather than a bespoke
    `{ warn }`. It was optional, and consequently no composition root passed one — leaving the page-cap
    truncation warning unreachable in production, on the very reads a review is sliced from. The local
    facade now builds its client through the shared `buildGitLabEngineClient` instead of assembling the
    same pair by hand, so it cannot miss the next thing that builder gains.

### Patch Changes

- Updated dependencies [769a3d9]
  - @cat-factory/kernel@0.211.0

## 0.14.23

### Patch Changes

- Updated dependencies [73708cf]
- Updated dependencies [876ee2d]
  - @cat-factory/contracts@0.210.0
  - @cat-factory/kernel@0.210.0

## 0.14.22

### Patch Changes

- Updated dependencies [0a1170e]
  - @cat-factory/contracts@0.209.0
  - @cat-factory/kernel@0.209.0

## 0.14.21

### Patch Changes

- Updated dependencies [d320539]
  - @cat-factory/contracts@0.208.0
  - @cat-factory/kernel@0.208.0

## 0.14.20

### Patch Changes

- Updated dependencies [9e5f785]
  - @cat-factory/contracts@0.207.0
  - @cat-factory/kernel@0.207.0

## 0.14.19

### Patch Changes

- Updated dependencies [8fbc0b5]
  - @cat-factory/kernel@0.206.0
  - @cat-factory/contracts@0.206.1

## 0.14.18

### Patch Changes

- Updated dependencies [5511cdc]
  - @cat-factory/contracts@0.206.0
  - @cat-factory/kernel@0.205.0

## 0.14.17

### Patch Changes

- Updated dependencies [1441041]
  - @cat-factory/contracts@0.205.0
  - @cat-factory/kernel@0.204.0

## 0.14.16

### Patch Changes

- Updated dependencies [0b52df7]
  - @cat-factory/contracts@0.204.0
  - @cat-factory/kernel@0.203.0

## 0.14.15

### Patch Changes

- Updated dependencies [9c6ce7a]
  - @cat-factory/kernel@0.202.0

## 0.14.14

### Patch Changes

- Updated dependencies [54e6a45]
- Updated dependencies [08e9bcc]
- Updated dependencies [a7aae8a]
  - @cat-factory/contracts@0.203.0
  - @cat-factory/kernel@0.201.1

## 0.14.13

### Patch Changes

- Updated dependencies [8c40f33]
  - @cat-factory/kernel@0.201.0

## 0.14.12

### Patch Changes

- Updated dependencies [9d303f0]
  - @cat-factory/contracts@0.202.0
  - @cat-factory/kernel@0.200.0

## 0.14.11

### Patch Changes

- Updated dependencies [0bffe55]
- Updated dependencies [1cd9d73]
  - @cat-factory/contracts@0.201.0
  - @cat-factory/kernel@0.199.0

## 0.14.10

### Patch Changes

- Updated dependencies [d9789f9]
  - @cat-factory/kernel@0.198.0
  - @cat-factory/contracts@0.200.0

## 0.14.9

### Patch Changes

- Updated dependencies [123ac6f]
  - @cat-factory/contracts@0.199.0
  - @cat-factory/kernel@0.197.0

## 0.14.8

### Patch Changes

- Updated dependencies [99412e2]
  - @cat-factory/contracts@0.198.0
  - @cat-factory/kernel@0.196.0

## 0.14.7

### Patch Changes

- Updated dependencies [1904eb8]
  - @cat-factory/kernel@0.195.0

## 0.14.6

### Patch Changes

- Updated dependencies [f9db6a6]
  - @cat-factory/kernel@0.194.0

## 0.14.5

### Patch Changes

- Updated dependencies [be7fe66]
  - @cat-factory/contracts@0.197.0
  - @cat-factory/kernel@0.193.0

## 0.14.4

### Patch Changes

- Updated dependencies [83fd037]
  - @cat-factory/kernel@0.192.0
  - @cat-factory/contracts@0.196.0

## 0.14.3

### Patch Changes

- Updated dependencies [7248b72]
- Updated dependencies [449d856]
  - @cat-factory/contracts@0.195.0
  - @cat-factory/kernel@0.191.0

## 0.14.2

### Patch Changes

- Updated dependencies [4ecb25c]
  - @cat-factory/kernel@0.190.0

## 0.14.1

### Patch Changes

- Updated dependencies [7ed2bc0]
  - @cat-factory/contracts@0.194.0
  - @cat-factory/kernel@0.189.0

## 0.14.0

### Minor Changes

- 9794c19: Validate a review task's target pull request when the task is created, and surface that pull
  request in the inspector.

  A `review` task carries a reference to an EXISTING pull request, and until now nothing checked it.
  A typo'd number was accepted silently and only surfaced much later as a run that dispatched a
  container, cloned the repo and found nothing to review. Creation now probes the PR through the
  same run-repo seam the review itself uses (`RepoFiles.getPullRequest`, new and optional on the
  `GitHubClient` / `VcsClient` ports, implemented for GitHub and GitLab), so the reference is checked
  against precisely the repository the reviewer will read.

  Only a POSITIVE "no such pull request" refuses — the provider's own 404, which the new port method
  reports as `null` while every other failure throws. An outage, a revoked token or a rate limit
  answers "unknown", not "absent", so those are logged and the task is created: making task creation
  depend on the provider being up would be a worse failure than the one this prevents. Same for
  every unwired case (no VCS connection, a provider that can't read a PR, a reference with no
  resolvable number) — all pass through unchanged.

  One case that looks like validation but is really a correctness fix: a pasted link belonging to a
  DIFFERENT repository is now refused (`review_pr_repo_mismatch`). The reviewer fetches the PR by
  NUMBER from the service's linked repo (ADR 0023 — a cross-repo `prUrl` is not resolved to another
  repo), so such a link previously reviewed whatever PR happened to carry that number on the linked
  repo, with nothing anywhere saying so.

  A confirmed reference is then rewritten to the provider's own URL for that PR, which is what makes
  the second half possible: the block inspector leads a review task's body with an "Under review"
  panel linking the reviewed pull request. That is the task's SUBJECT and it had no affordance at
  all before — only the Execution panel's link to the PR a run PRODUCED, which a review task never
  has. A task created while no VCS was connected keeps just the number, and the panel renders it as
  text rather than pretending to be a link.

### Patch Changes

- Updated dependencies [85efc27]
- Updated dependencies [9794c19]
  - @cat-factory/contracts@0.193.0
  - @cat-factory/kernel@0.188.0

## 0.13.36

### Patch Changes

- Updated dependencies [57e1195]
- Updated dependencies [5b19dab]
  - @cat-factory/contracts@0.192.0
  - @cat-factory/kernel@0.187.0

## 0.13.35

### Patch Changes

- Updated dependencies [e087b40]
  - @cat-factory/contracts@0.191.0
  - @cat-factory/kernel@0.186.0

## 0.13.34

### Patch Changes

- Updated dependencies [0eacaa2]
  - @cat-factory/contracts@0.190.0
  - @cat-factory/kernel@0.185.1

## 0.13.33

### Patch Changes

- Updated dependencies [1fa8ef7]
  - @cat-factory/kernel@0.185.0

## 0.13.32

### Patch Changes

- Updated dependencies [f0be8a7]
  - @cat-factory/kernel@0.184.0

## 0.13.31

### Patch Changes

- Updated dependencies [a8cc6b2]
  - @cat-factory/contracts@0.189.0
  - @cat-factory/kernel@0.183.0

## 0.13.30

### Patch Changes

- Updated dependencies [ac832b9]
  - @cat-factory/contracts@0.188.0
  - @cat-factory/kernel@0.182.0

## 0.13.29

### Patch Changes

- Updated dependencies [22d82ac]
  - @cat-factory/contracts@0.187.0
  - @cat-factory/kernel@0.181.0

## 0.13.28

### Patch Changes

- Updated dependencies [e18cfa2]
- Updated dependencies [01d4b6c]
  - @cat-factory/kernel@0.180.0

## 0.13.27

### Patch Changes

- Updated dependencies [b75a08a]
  - @cat-factory/contracts@0.186.0
  - @cat-factory/kernel@0.179.0

## 0.13.26

### Patch Changes

- Updated dependencies [9d965c9]
  - @cat-factory/contracts@0.185.0
  - @cat-factory/kernel@0.178.0

## 0.13.25

### Patch Changes

- Updated dependencies [58e06a2]
  - @cat-factory/contracts@0.184.0
  - @cat-factory/kernel@0.177.0

## 0.13.24

### Patch Changes

- Updated dependencies [65b87c1]
- Updated dependencies [df48cb0]
  - @cat-factory/contracts@0.183.0
  - @cat-factory/kernel@0.176.0

## 0.13.23

### Patch Changes

- Updated dependencies [b30cc6e]
  - @cat-factory/contracts@0.182.0
  - @cat-factory/kernel@0.175.0

## 0.13.22

### Patch Changes

- Updated dependencies [c47eb66]
- Updated dependencies [5abcb9e]
  - @cat-factory/contracts@0.181.0
  - @cat-factory/kernel@0.174.0

## 0.13.21

### Patch Changes

- Updated dependencies [bead6df]
  - @cat-factory/contracts@0.180.0
  - @cat-factory/kernel@0.173.0

## 0.13.20

### Patch Changes

- Updated dependencies [68f0edd]
- Updated dependencies [71ea4ec]
- Updated dependencies [6dbd864]
  - @cat-factory/contracts@0.179.0
  - @cat-factory/kernel@0.172.0

## 0.13.19

### Patch Changes

- Updated dependencies [9d8fe9b]
  - @cat-factory/contracts@0.178.0
  - @cat-factory/kernel@0.171.0

## 0.13.18

### Patch Changes

- Updated dependencies [cf2779a]
  - @cat-factory/contracts@0.177.0
  - @cat-factory/kernel@0.170.0

## 0.13.17

### Patch Changes

- Updated dependencies [1947062]
  - @cat-factory/contracts@0.176.0
  - @cat-factory/kernel@0.169.0

## 0.13.16

### Patch Changes

- Updated dependencies [1c12289]
  - @cat-factory/contracts@0.175.0
  - @cat-factory/kernel@0.168.0

## 0.13.15

### Patch Changes

- Updated dependencies [55747c5]
  - @cat-factory/contracts@0.174.0
  - @cat-factory/kernel@0.167.1

## 0.13.14

### Patch Changes

- Updated dependencies [cab85c5]
  - @cat-factory/contracts@0.173.0
  - @cat-factory/kernel@0.167.0

## 0.13.13

### Patch Changes

- Updated dependencies [8afa4ae]
  - @cat-factory/contracts@0.172.0
  - @cat-factory/kernel@0.166.0

## 0.13.12

### Patch Changes

- Updated dependencies [200fb4d]
  - @cat-factory/kernel@0.165.1

## 0.13.11

### Patch Changes

- Updated dependencies [f0e9bab]
  - @cat-factory/contracts@0.171.0
  - @cat-factory/kernel@0.165.0

## 0.13.10

### Patch Changes

- Updated dependencies [583fc80]
- Updated dependencies [640cadd]
  - @cat-factory/contracts@0.170.0
  - @cat-factory/kernel@0.164.0

## 0.13.9

### Patch Changes

- Updated dependencies [968a214]
  - @cat-factory/contracts@0.169.0
  - @cat-factory/kernel@0.163.1

## 0.13.8

### Patch Changes

- Updated dependencies [829a905]
- Updated dependencies [829a905]
  - @cat-factory/kernel@0.163.0

## 0.13.7

### Patch Changes

- Updated dependencies [c95600b]
  - @cat-factory/contracts@0.168.0
  - @cat-factory/kernel@0.162.0

## 0.13.6

### Patch Changes

- Updated dependencies [df9ca7d]
  - @cat-factory/contracts@0.167.0
  - @cat-factory/kernel@0.161.0

## 0.13.5

### Patch Changes

- Updated dependencies [600a8ad]
  - @cat-factory/kernel@0.160.0
  - @cat-factory/contracts@0.166.0

## 0.13.4

### Patch Changes

- Updated dependencies [3949f82]
  - @cat-factory/contracts@0.165.0
  - @cat-factory/kernel@0.159.1

## 0.13.3

### Patch Changes

- Updated dependencies [1f8ca48]
  - @cat-factory/kernel@0.159.0

## 0.13.2

### Patch Changes

- Updated dependencies [5a58b9d]
  - @cat-factory/contracts@0.164.0
  - @cat-factory/kernel@0.158.0

## 0.13.1

### Patch Changes

- Updated dependencies [55e0a85]
  - @cat-factory/kernel@0.157.0
  - @cat-factory/contracts@0.163.0

## 0.13.0

### Minor Changes

- ecd68c5: PR verification report — the ENGINE now maintains a structured verification report on each
  run's pull request, so a reviewer sees captured facts instead of the agent's own "tests pass"
  prose. It carries the `ci` gate's aggregated verdict (per-check-run names/conclusions +
  `ci-fixer` attempt count), the tester step's structured report, the `deployer` step's
  ephemeral-environment lifecycle (per-frame outcomes + teardown state), the `merger`'s scored
  assessment and the engine's resolved merge decision, run metadata (task, linked tracker issues,
  repo/provider, pipeline, per-step agent kind + resolved model), and a deep link into the run's
  observability panel — as human-readable markdown plus a fenced JSON block validated by the new
  `prVerificationReportSchema`.

  It is written as a marker-delimited region of the PR description and updated **idempotently in
  place**, so a retry or re-run rewrites it instead of appending a second copy, and the agent's own
  description is preserved. Composition happens as each step settles (an engine hook, not a new
  pipeline step), so a run that fails or parks part-way still leaves its evidence on the PR, and a
  section whose producing step didn't run says so explicitly rather than silently vanishing.

  Everything the report interpolates is agent- or human-authored, and a pull-request description is
  a PARSED, potentially PUBLIC surface, so the text boundary is explicit: every free-text field is
  scrubbed with the same `redactSecrets` the telemetry store uses, and every interpolation
  neutralises the host's auto-link triggers (`#123` / `@name` / `!123`, and a closing keyword in
  front of an issue URL — which would otherwise CLOSE that issue when the PR merges), folds
  newlines inside table cells, and balances any code fence the agent left open so the fenced JSON
  block stays extractable. Lists are capped, and what was capped is named in the report's own
  `truncations` log rather than silently shortened.

  New per-workspace setting **`publishPrVerificationReport`** (default on, mirrored D1 ⇄ Drizzle
  with a migration on both runtimes): a workspace that would rather keep its CI verdicts, test
  outcomes and environment URLs off the pull request can decline. Turning it off stops future
  writes; a report already on a PR is left as it is.

  Provider-neutral: it publishes through the facade's ENGINE VCS client, so a GitLab deployment
  gets the report on its merge-request description too. **Breaking for port implementors:**
  `GitHubClient` and `VcsClient` gain a required `getPullRequestBody` method (the read half of the
  read-splice-write upsert), and `PrVerificationReportPublisher` gains a required `resolveTarget`
  (the engine states the repo/provider the ADAPTER resolved, never the run's last dispatch — which
  on a multi-repo task is a peer repo, not the repo whose PR is being written to). Wiring is per facade (Worker ⇄ Node/local) alongside the existing
  merge/mergeability providers; with no VCS client wired the engine behaves exactly as before.
  The SPA gains a narrow boot-time deep-link replay (`?ws=…&block=…&run=…&view=observability`) so
  the report's observability link resolves.

### Patch Changes

- Updated dependencies [ecd68c5]
  - @cat-factory/contracts@0.162.0
  - @cat-factory/kernel@0.156.0

## 0.12.0

### Minor Changes

- 7c6bd77: Per-workspace GitLab PAT connect flow (backend, GitLab UI-parity slice 2a). A hosted
  deployment can now connect a workspace to GitLab by pasting a personal access token: the
  token is validated against the account's identity, sealed at rest (a new `access_token`
  column on `github_installations`, mirrored across D1 + Drizzle), and the workspace's repos
  are browsed / linked / synced through the SAME GitHub-shaped projection surface. A new
  `ProviderRoutingGitHubClient` routes each installation-keyed call to the App or GitLab client
  by the connection's stored provider, so a deployment can serve GitHub App and GitLab PAT
  workspaces side by side. New endpoints: `GET|POST|DELETE /workspaces/:ws/gitlab/connection`
  (503 until GitLab connect is wired). The connect UI is a follow-up slice.

### Patch Changes

- Updated dependencies [7c6bd77]
  - @cat-factory/kernel@0.155.0
  - @cat-factory/contracts@0.161.0

## 0.11.22

### Patch Changes

- 0e2799e: Close three gaps in the `human-review` PR gate:

  - **Reviewer "Request changes" summaries are no longer ignored.** The gate only reacted to
    inline review threads and plain conversation comments, so a reviewer who requested changes with
    their feedback in the review's top-level summary box (no inline line comments) was invisible —
    the run waited indefinitely for an approval that would never come. The review `body` is now read
    (`FetchGitHubClient` + the `GitHubPullRequestReview` port), surfaced on the snapshot as
    `reviewSummaries`, and folded into the gate's outstanding-feedback set so it dispatches the
    fixer like any other comment.
  - **A standing `CHANGES_REQUESTED` now blocks advancement** even when the required approval count
    is met by other reviewers (`PullRequestReviewSnapshot.changesRequested` + `isApproved`), matching
    GitHub's own merge rule so the gate can't sign off a PR GitHub would refuse to merge.
  - **Approval reduction is order-independent**: reviews are sorted by `submittedAt` before the
    "latest standing review per author" reduction, instead of trusting the API's array order.

- Updated dependencies [0e2799e]
- Updated dependencies [239788a]
  - @cat-factory/kernel@0.154.2
  - @cat-factory/contracts@0.160.1

## 0.11.21

### Patch Changes

- Updated dependencies [770f926]
  - @cat-factory/kernel@0.154.1

## 0.11.20

### Patch Changes

- Updated dependencies [93496b0]
  - @cat-factory/kernel@0.154.0
  - @cat-factory/contracts@0.160.0

## 0.11.19

### Patch Changes

- Updated dependencies [15249df]
  - @cat-factory/contracts@0.159.0
  - @cat-factory/kernel@0.153.0

## 0.11.18

### Patch Changes

- Updated dependencies [2323df1]
  - @cat-factory/contracts@0.158.0
  - @cat-factory/kernel@0.152.0

## 0.11.17

### Patch Changes

- Updated dependencies [71bd63f]
  - @cat-factory/contracts@0.157.0
  - @cat-factory/kernel@0.151.0

## 0.11.16

### Patch Changes

- Updated dependencies [3c7d62b]
- Updated dependencies [3c7d62b]
  - @cat-factory/contracts@0.156.0
  - @cat-factory/kernel@0.150.0

## 0.11.15

### Patch Changes

- Updated dependencies [916278b]
  - @cat-factory/contracts@0.155.0
  - @cat-factory/kernel@0.149.0

## 0.11.14

### Patch Changes

- Updated dependencies [1bcb223]
  - @cat-factory/kernel@0.148.5

## 0.11.13

### Patch Changes

- Updated dependencies [91ea6b7]
  - @cat-factory/contracts@0.154.2
  - @cat-factory/kernel@0.148.4

## 0.11.12

### Patch Changes

- Updated dependencies [3999941]
  - @cat-factory/kernel@0.148.3

## 0.11.11

### Patch Changes

- Updated dependencies [021f2a0]
- Updated dependencies [021f2a0]
  - @cat-factory/contracts@0.154.1
  - @cat-factory/kernel@0.148.2

## 0.11.10

### Patch Changes

- Updated dependencies [a14fe03]
  - @cat-factory/contracts@0.154.0
  - @cat-factory/kernel@0.148.1

## 0.11.9

### Patch Changes

- 8053837: PR deep-review `post`: guard against comment position drift when the PR branch is updated
  after a review starts. The reviewer's dispatch now captures the PR head sha
  (`reviewedHeadSha`), and the `post` resolution re-reads the current head before publishing:
  if the branch moved, every finding is folded into the summary comment instead of being
  anchored to a line number that may have shifted, so comments can't land on the wrong code.
  Adds an optional `pullRequestHeadSha` read to the `GitHubClient`/`VcsClient`/`RepoFiles`
  ports (best-effort; the check is inert where a provider can't read it).
- Updated dependencies [8053837]
  - @cat-factory/contracts@0.153.0
  - @cat-factory/kernel@0.148.0

## 0.11.8

### Patch Changes

- Updated dependencies [511076d]
  - @cat-factory/kernel@0.147.3

## 0.11.7

### Patch Changes

- Updated dependencies [7f54858]
  - @cat-factory/contracts@0.152.2
  - @cat-factory/kernel@0.147.2

## 0.11.6

### Patch Changes

- Updated dependencies [492d0a2]
  - @cat-factory/kernel@0.147.1

## 0.11.5

### Patch Changes

- Updated dependencies [a10bfdf]
  - @cat-factory/kernel@0.147.0

## 0.11.4

### Patch Changes

- Updated dependencies [f2b25ba]
  - @cat-factory/kernel@0.146.0
  - @cat-factory/contracts@0.152.1

## 0.11.3

### Patch Changes

- Updated dependencies [e679977]
  - @cat-factory/contracts@0.152.0
  - @cat-factory/kernel@0.145.1

## 0.11.2

### Patch Changes

- Updated dependencies [9450415]
  - @cat-factory/contracts@0.151.0
  - @cat-factory/kernel@0.145.0

## 0.11.1

### Patch Changes

- Updated dependencies [54c44bb]
  - @cat-factory/contracts@0.150.0
  - @cat-factory/kernel@0.144.0

## 0.11.0

### Minor Changes

- 6709dc4: Migrate the last module-global plugin registries to app-owned DI (the registry-DI initiative):
  pipelines, VCS providers, provider tokens, and agent traits now ride the composition root's
  injected instances instead of a process-wide `Map`, removing the `clear*()` test cruft and the
  phantom-`Map` hazard for separately-published adapter packages (e.g. `@cat-factory/gitlab`).

  **Breaking (pre-1.0, no back-compat):** the following free functions are removed in favour of the
  app-owned registry instances a facade injects:

  - **Pipelines** (`@cat-factory/kernel`): `registerPipeline` / `registerPipelines` /
    `registeredPipelines` / `clearRegisteredPipelines` / `mergeRegisteredPipelines` →
    `PipelineRegistry` (`register` / `registerMany` / `registered` / `merge`) + `defaultPipelineRegistry()`.
    `seedPipelines(registry?)` now takes the registry (the no-arg form returns the built-in catalog).
  - **VCS providers** (`@cat-factory/kernel`): `registerVcsProvider` / `getVcsProvider` /
    `resolveVcsProvider` / `requireVcsProvider` / `isVcsProviderRegistered` / `registeredVcsProviders` /
    `clearVcsProviders` → `VcsProviderRegistry` + `defaultVcsRegistry()` (a required `ServerContainer`
    field, so facade parity is type-enforced). `@cat-factory/gitlab`'s `registerGitLab` now takes the
    registry as its first argument.
  - **Provider tokens** (`@cat-factory/kernel`): `wireProvider` / `getProvider` / `isProviderWired` /
    `requireProvider` / `clearProviders` → `ProviderRegistry` + `defaultProviderRegistry()`, read by the
    gate machine's `GateContext` (which gains `isProviderWired`). The `@cat-factory/gates` `wireX` /
    `applyGateProviders` / `warnUnwiredGates` handles take the registry as their first argument;
    `clearGateProviders` is no longer needed by a facade (a fresh registry per build starts empty).
  - **Agent traits** (`@cat-factory/agents`): `registerAgentTrait` / `registerAgentTraits` /
    `registeredAgentTrait` / `clearRegisteredAgentTraits` / `assignAgentTraits` /
    `clearAssignedAgentTraits` are folded onto the app-owned `AgentKindRegistry`
    (`registerTrait` / `registerTraits` / `traitDefinition` / `assignTraits` / `assignedTraitsFor`);
    `traitsFor` / `hasTrait` / `traitGuidanceFor` keep their signatures. `@cat-factory/consensus`'s
    `registerConsensusTraits` now takes the registry as its first argument.

- a53bbf7: Attach repo files as task context via a repository picker. When a repo-backed
  document source (GitHub / GitLab) is selected in the context-document picker, the
  user now searches for a repository (reusing the shared server-side repo search),
  then picks one or more files from it — either by searching the whole tree by path
  or by browsing it with the monorepo directory browser, which now supports
  multi-pick in file mode. Backed by a new recursive repo-tree read (`listTree` on
  the VCS/GitHub client ports, `GET /github/repos/:id/files`) so file search is a
  single cached call per repo instead of walking the tree level-by-level.

### Patch Changes

- Updated dependencies [0abcf31]
- Updated dependencies [6709dc4]
- Updated dependencies [a53bbf7]
  - @cat-factory/contracts@0.149.0
  - @cat-factory/kernel@0.143.0

## 0.10.22

### Patch Changes

- Updated dependencies [5771e05]
  - @cat-factory/kernel@0.142.0

## 0.10.21

### Patch Changes

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0

## 0.10.20

### Patch Changes

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1

## 0.10.19

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0
  - @cat-factory/contracts@0.148.1

## 0.10.18

### Patch Changes

- Updated dependencies [efa3345]
  - @cat-factory/kernel@0.139.3

## 0.10.17

### Patch Changes

- Updated dependencies [1f5f5bc]
  - @cat-factory/contracts@0.148.0
  - @cat-factory/kernel@0.139.2

## 0.10.16

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/contracts@0.147.1
  - @cat-factory/kernel@0.139.1

## 0.10.15

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/contracts@0.147.0
  - @cat-factory/kernel@0.139.0

## 0.10.14

### Patch Changes

- Updated dependencies [60c0a1e]
  - @cat-factory/contracts@0.146.0
  - @cat-factory/kernel@0.138.1

## 0.10.13

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/contracts@0.145.0
  - @cat-factory/kernel@0.138.0

## 0.10.12

### Patch Changes

- Updated dependencies [5924903]
  - @cat-factory/contracts@0.144.0
  - @cat-factory/kernel@0.137.1

## 0.10.11

### Patch Changes

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0

## 0.10.10

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/contracts@0.143.0
  - @cat-factory/kernel@0.136.0

## 0.10.9

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0
  - @cat-factory/contracts@0.142.0

## 0.10.8

### Patch Changes

- Updated dependencies [e618bf5]
  - @cat-factory/contracts@0.141.0
  - @cat-factory/kernel@0.134.1

## 0.10.7

### Patch Changes

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/contracts@0.140.0
  - @cat-factory/kernel@0.134.0

## 0.10.6

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0
  - @cat-factory/contracts@0.139.0

## 0.10.5

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/contracts@0.138.0
  - @cat-factory/kernel@0.132.0

## 0.10.4

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/kernel@0.131.0
  - @cat-factory/contracts@0.137.0

## 0.10.3

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/contracts@0.136.0
  - @cat-factory/kernel@0.130.0

## 0.10.2

### Patch Changes

- Updated dependencies [06a094a]
  - @cat-factory/contracts@0.135.0
  - @cat-factory/kernel@0.129.2

## 0.10.1

### Patch Changes

- Updated dependencies [6108525]
  - @cat-factory/kernel@0.129.1

## 0.10.0

### Minor Changes

- 995249b: feat(spike): timeboxed research spike tasks — kind, pipeline, findings document, PR + review delivery

  Spike tasks now run as a real timeboxed investigation that produces a findings document
  instead of falling through to a full code-and-PR build:

  - A built-in read-only `spike` agent kind (`container-explore`, structured findings + a prose
    `summary`, opened in the `generic-structured` result view). Its backend post-op renders the
    findings to `docs/research/<slug>.md` (honouring `taskTypeFields.targetPath`) via the
    checkout-free `RepoFiles` port — no harness change.
  - Findings are delivered as a PULL REQUEST by default (`pl_spike`: `requirements-review`(off) →
    `spike` → `conflicts` → `ci` → `human-review` → `merger`): the post-op commits to a work branch
    and opens a PR that the review/merge tail lands, so protected base branches are respected and
    review comments are handled by the existing `human-review` gate + `fixer`. A `pl_spike_direct`
    pipeline keeps the fast, no-PR path (commit straight to base) for unprotected repos. `spike →
pl_spike` is the task-type default, so a spike no longer dispatches a coder.
  - New reusable engine seam: a `RepoOp` may open a pull request and return its ref, which the
    engine records as `block.pullRequest` (the same linkage a container-coding step produces), so a
    deterministic backend-rendered artifact can flow through the normal conflicts/CI/human-review/
    merge tail. `RepoFiles.openPullRequest` (and the underlying `GitHubClient`/`VcsClient` ports)
    now return the PR web `url` (`OpenedPullRequest`), provider-agnostically.
  - A no-PR completion path in the engine: a task run that opened no pull requests now finishes
    `done` (like a frame-level run) instead of stalling at `pr_ready` behind a `pipeline_complete`
    notification whose confirm threw `no_pr_to_merge`. This benefits every PR-less pipeline.
  - Spike creation collects research criteria (research question, success criteria, options to
    compare, target path) alongside the time-box; all are folded into the spike prompt (the
    time-box as a scope-discipline directive). New copy is translated across all locales.

  A repo-less spike (GitHub unwired, or a docs-only spike) settles on `step.custom` — the findings
  render is skipped rather than failing the run; a rejected direct commit is best-effort (the
  findings already live on the step), while a PR-mode open failure is surfaced.

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/kernel@0.129.0
  - @cat-factory/contracts@0.134.0

## 0.9.1

### Patch Changes

- Updated dependencies [9e9127f]
  - @cat-factory/contracts@0.133.0
  - @cat-factory/kernel@0.128.1

## 0.9.0

### Minor Changes

- b414f34: PR deep-review: resolve a parked review by fixing or posting the selected findings.

  The `pr-review` window now offers two terminal resolutions alongside `Finish`, both acting on
  the human's curated finding selection:

  - **Fix** re-dispatches the `pr-reviewer` step as a Fixer (`FIXER_AGENT_KIND`) that clones the
    reviewed PR's head branch, commits fixes addressing the selected findings, and pushes back onto
    it (no new PR).
  - **Post** publishes the selected findings as a single advisory (`COMMENT`) inline PR review — each
    line-anchored finding as an inline comment, the rest folded into the review body.

  Two new optional VCS reads/writes back these resolutions — `getPullRequestHeadRef` and
  `createReview` on the neutral `VcsClient` + `GitHubClient` ports (GitHub-implemented, omitted on
  GitLab), surfaced to the engine through the checkout-free `RepoFiles` seam. All review state stays
  on `step.prReview` (no side table); a cross-runtime conformance assertion covers both resolutions.

  Scoped to a same-repo, non-fork PR (the reviewer's existing limitation); a cross-repo `prUrl` and
  fork PRs remain a tracked follow-up. See `backend/docs/adr/0023-pr-deep-review.md`.

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0
  - @cat-factory/contracts@0.132.0

## 0.8.1

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/contracts@0.131.0
  - @cat-factory/kernel@0.127.0

## 0.8.0

### Minor Changes

- 55cae97: Add a **Review** task type for deep-reviewing an existing open pull request.

  A `review` task defaults to the new `pl_review` pipeline, which runs a built-in read-only
  `pr-reviewer` agent: it slices the PR's diff into cohesive chunks, reviews each within a
  bounded context (so token usage scales on huge PRs), and returns prioritized findings
  rendered in the generic structured result view. The create-task form gains a Review type
  with a target-PR field and an optional review focus.

  Foundations for the tracked follow-ups (human finding-selection + fix/inline-comment
  resolutions): a new provider-neutral `VcsClient`/`GitHubClient.listChangedFiles` method
  (implemented for GitHub), and a no-PR terminal path so read-only pipelines that open no PR
  finish cleanly as `done` instead of stranding on a confirm-and-merge notification.

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/contracts@0.130.0
  - @cat-factory/kernel@0.126.0

## 0.7.71

### Patch Changes

- Updated dependencies [f7e7139]
- Updated dependencies [5fa0a8e]
  - @cat-factory/contracts@0.129.0
  - @cat-factory/kernel@0.125.0

## 0.7.70

### Patch Changes

- Updated dependencies [e5cd022]
  - @cat-factory/kernel@0.124.0

## 0.7.69

### Patch Changes

- Updated dependencies [6c4bcef]
  - @cat-factory/contracts@0.128.2
  - @cat-factory/kernel@0.123.3

## 0.7.68

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/kernel@0.123.2
  - @cat-factory/contracts@0.128.1

## 0.7.67

### Patch Changes

- Updated dependencies [2c7ca2e]
  - @cat-factory/kernel@0.123.1

## 0.7.66

### Patch Changes

- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0

## 0.7.65

### Patch Changes

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/contracts@0.128.0
  - @cat-factory/kernel@0.122.0

## 0.7.64

### Patch Changes

- Updated dependencies [2a13ece]
  - @cat-factory/kernel@0.121.8

## 0.7.63

### Patch Changes

- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7

## 0.7.62

### Patch Changes

- Updated dependencies [67dccb6]
  - @cat-factory/kernel@0.121.6

## 0.7.61

### Patch Changes

- f8f1aa8: Update workspace dependencies (direct + transitive) to the newest versions published before the
  `minimumReleaseAge` supply-chain cutoff. No source changes — dependency ranges + the lockfile only.

  - Refreshed direct deps to their newest cooldown-compliant releases: `wrangler` 4.110.0, `hono`
    4.12.29, `vitest` / `@vitest/coverage-v8` 4.1.10, `oxlint` 1.73.0, `knip` 6.26.0, `msw` 2.15.0,
    `pg-boss` 12.26.0, `sherif` 1.13.0, `turbo` 2.10.4, `vue-tsc` 3.3.7, `@types/node` 26.1.1,
    `@nuxtjs/i18n` 10.4.1, `@aws-sdk/client-s3` 3.1085.0.
  - `typescript` moved off the `7.0.1-rc` prerelease to the stable `7.0.2` release across every
    package that used the RC (the TS-6 world — the frontend layer and the two runner harnesses —
    stays on `^6.0.3`).
  - Vercel AI SDK family held to the `ai@6`-compatible majors that `workers-ai-provider@3.3.1` peers
    require (`ai` 6.0.224, `@ai-sdk/anthropic|openai|provider` on 3.x, `@ai-sdk/openai-compatible` on
    2.x, `@ai-sdk/amazon-bedrock` 4.x) — no v7/v5 major bumps.
  - Coding (`executor-harness`) and deploy runner harnesses updated too, including the pinned
    in-container coding-agent CLIs (Pi 0.80.6, Claude Code 2.1.207, Codex 0.144.1; the Pi todo /
    web-tools extensions stay at their lockstep 1.20.0). Their image tags and the three
    hand-maintained pins were bumped in lockstep, so the runner images must be re-published +
    deployed for the new tags to roll out.

- Updated dependencies [f8f1aa8]
  - @cat-factory/contracts@0.127.1
  - @cat-factory/kernel@0.121.5

## 0.7.60

### Patch Changes

- Updated dependencies [4810353]
  - @cat-factory/kernel@0.121.4

## 0.7.59

### Patch Changes

- Updated dependencies [edad6e6]
  - @cat-factory/kernel@0.121.3

## 0.7.58

### Patch Changes

- Updated dependencies [d1a4129]
  - @cat-factory/contracts@0.127.0
  - @cat-factory/kernel@0.121.2

## 0.7.57

### Patch Changes

- 473e849: Classify VCS (GitHub / GitLab) HTTP failures with cause + fix + doc links (error-message coverage
  initiative, items C1/C4/C5/C6). The `fetch`-based clients used to throw the same bare status dump
  for any non-2xx (`GitHub GET <url> → 401: <body>`), so a revoked token, an exhausted rate limit,
  and a missing scope all read identically.

  - Adds a shared kernel helper `describeVcsApiError` (`@cat-factory/kernel` `domain/vcs-errors.ts`)
    that maps `{ provider, status }` to a remedy. It PRESERVES the raw
    `<Provider> <method> <url> → <status>: <body>` first line (detectors still surface it and it stays
    greppable) and APPENDS a cause + remedy sentence: 401 → token revoked/expired (reconnect the App,
    or refresh `GITHUB_PAT` in local mode); 403 + rate-limit headers / 429 → rate limited, wait for
    the reset (App has a higher limit than a PAT); 403 → missing permission/scope + where to grant it;
    404 → repo/installation not visible to the token. GitLab gets the same shapes, GitLab-flavoured
    (`api` scope, Developer/Maintainer role). Kernel sits below the server layer so it keeps its own
    `VCS_DOC_URLS` (per the doc-URL convention) linking `backend/docs/github-integration.md` /
    `github-operations.md` / `vcs-providers.md`.
  - **C1/C6** — `FetchGitHubClient` (REST `request()` + PAT `requestWithToken()`) and
    `FetchGitLabClient.request()` / `provisioning.ts` now build their `*ApiError` message through the
    helper. Error identity still rides the structured `status` field, so classification is unchanged.
  - **C5** — `Installation X not found on any configured App` now explains the App was likely
    uninstalled or the workspace points at a stale installation, and to reconnect GitHub.
  - **C4** — `No connected GitHub repository found for workspace 'X'` (`ContainerAgentExecutor`) is now
    a `ConflictError` carrying the existing `github_not_connected` reason (was a plain `Error` → 500),
    with a UI-first remedy pointing at the GitHub connect / repo-linking flow. The SPA already maps
    that reason to a translated title.
  - **C4 (async run path)** — the durable dispatch previously caught EVERY `startJob` throw and framed
    it as a container `dispatch` failure ("The container failed to start."), so a `github_not_connected`
    precondition reached the board mislabeled and lost its `reason`. `classifyDispatchFailure`
    (`job.logic.ts`) now distinguishes a pre-dispatch domain precondition (any `DomainError`) as a
    `preflight` failure that keeps its own actionable message and propagates its `reason`, so
    `AgentFailureCard` titles it with the same translated "GitHub not connected" string the 409 toast
    uses (no new locale keys) and shows the remedy in the detail.

  No behaviour changes beyond error identity (C4's 409 + `preflight` classification on the async path)
  and message text.

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1

## 0.7.56

### Patch Changes

- Updated dependencies [f4482c7]
  - @cat-factory/kernel@0.121.0

## 0.7.55

### Patch Changes

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0

## 0.7.54

### Patch Changes

- Updated dependencies [a5dcf7d]
  - @cat-factory/kernel@0.119.0

## 0.7.53

### Patch Changes

- Updated dependencies [5072999]
  - @cat-factory/contracts@0.126.0
  - @cat-factory/kernel@0.118.1

## 0.7.52

### Patch Changes

- Updated dependencies [4f936de]
  - @cat-factory/contracts@0.125.0
  - @cat-factory/kernel@0.118.0

## 0.7.51

### Patch Changes

- Updated dependencies [127fe3e]
  - @cat-factory/contracts@0.124.1
  - @cat-factory/kernel@0.117.6

## 0.7.50

### Patch Changes

- Updated dependencies [774908c]
  - @cat-factory/kernel@0.117.5

## 0.7.49

### Patch Changes

- Updated dependencies [08a7da2]
  - @cat-factory/contracts@0.124.0
  - @cat-factory/kernel@0.117.4

## 0.7.48

### Patch Changes

- Updated dependencies [6b968bb]
  - @cat-factory/kernel@0.117.3

## 0.7.47

### Patch Changes

- Updated dependencies [eeadc97]
  - @cat-factory/kernel@0.117.2
  - @cat-factory/contracts@0.123.1

## 0.7.46

### Patch Changes

- Updated dependencies [cb7fd14]
  - @cat-factory/kernel@0.117.1

## 0.7.45

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0

## 0.7.44

### Patch Changes

- Updated dependencies [51869b8]
  - @cat-factory/kernel@0.116.0

## 0.7.43

### Patch Changes

- Updated dependencies [a51a498]
  - @cat-factory/kernel@0.115.1

## 0.7.42

### Patch Changes

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/contracts@0.123.0
  - @cat-factory/kernel@0.115.0

## 0.7.41

### Patch Changes

- Updated dependencies [0f3c88b]
  - @cat-factory/contracts@0.122.0
  - @cat-factory/kernel@0.114.0

## 0.7.40

### Patch Changes

- Updated dependencies [ed77be6]
  - @cat-factory/kernel@0.113.0
  - @cat-factory/contracts@0.121.2

## 0.7.39

### Patch Changes

- Updated dependencies [7ee2530]
  - @cat-factory/kernel@0.112.1

## 0.7.38

### Patch Changes

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0

## 0.7.37

### Patch Changes

- Updated dependencies [9aa9e19]
  - @cat-factory/contracts@0.121.1
  - @cat-factory/kernel@0.111.1

## 0.7.36

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/kernel@0.111.0
  - @cat-factory/contracts@0.121.0

## 0.7.35

### Patch Changes

- Updated dependencies [bcc843d]
  - @cat-factory/kernel@0.110.1

## 0.7.34

### Patch Changes

- Updated dependencies [a2db337]
  - @cat-factory/contracts@0.120.0
  - @cat-factory/kernel@0.110.0

## 0.7.33

### Patch Changes

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1

## 0.7.32

### Patch Changes

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
  - @cat-factory/contracts@0.119.0
  - @cat-factory/kernel@0.109.0

## 0.7.31

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/kernel@0.108.0

## 0.7.30

### Patch Changes

- Updated dependencies [44fafa4]
  - @cat-factory/kernel@0.107.0

## 0.7.29

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/kernel@0.106.0

## 0.7.28

### Patch Changes

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/kernel@0.105.0
  - @cat-factory/contracts@0.118.0

## 0.7.27

### Patch Changes

- Updated dependencies [4a3e536]
  - @cat-factory/contracts@0.117.0
  - @cat-factory/kernel@0.104.4

## 0.7.26

### Patch Changes

- Updated dependencies [18a9cb5]
  - @cat-factory/contracts@0.116.1
  - @cat-factory/kernel@0.104.3

## 0.7.25

### Patch Changes

- Updated dependencies [bc77f89]
  - @cat-factory/contracts@0.116.0
  - @cat-factory/kernel@0.104.2

## 0.7.24

### Patch Changes

- Updated dependencies [802fc05]
  - @cat-factory/contracts@0.115.0
  - @cat-factory/kernel@0.104.1

## 0.7.23

### Patch Changes

- Updated dependencies [6198b08]
- Updated dependencies [37d1517]
  - @cat-factory/contracts@0.114.0
  - @cat-factory/kernel@0.104.0

## 0.7.22

### Patch Changes

- Updated dependencies [14eac27]
  - @cat-factory/contracts@0.113.0
  - @cat-factory/kernel@0.103.0

## 0.7.21

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/contracts@0.112.0
  - @cat-factory/kernel@0.102.0

## 0.7.20

### Patch Changes

- Updated dependencies [fdba1ea]
  - @cat-factory/contracts@0.111.0
  - @cat-factory/kernel@0.101.2

## 0.7.19

### Patch Changes

- Updated dependencies [10787c4]
  - @cat-factory/contracts@0.110.1
  - @cat-factory/kernel@0.101.1

## 0.7.18

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/contracts@0.110.0
  - @cat-factory/kernel@0.101.0

## 0.7.17

### Patch Changes

- Updated dependencies [9ea1e77]
  - @cat-factory/contracts@0.109.0
  - @cat-factory/kernel@0.100.0

## 0.7.16

### Patch Changes

- Updated dependencies [e66accb]
  - @cat-factory/contracts@0.108.1
  - @cat-factory/kernel@0.99.1

## 0.7.15

### Patch Changes

- Updated dependencies [1afa003]
- Updated dependencies [f91b99d]
  - @cat-factory/kernel@0.99.0
  - @cat-factory/contracts@0.108.0

## 0.7.14

### Patch Changes

- Updated dependencies [bf31df7]
  - @cat-factory/contracts@0.107.0
  - @cat-factory/kernel@0.98.0

## 0.7.13

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/contracts@0.106.0
  - @cat-factory/kernel@0.97.0

## 0.7.12

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [e5b9462]
- Updated dependencies [dd6df12]
  - @cat-factory/contracts@0.105.0
  - @cat-factory/kernel@0.96.0

## 0.7.11

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/contracts@0.104.0
  - @cat-factory/kernel@0.95.0

## 0.7.10

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/contracts@0.103.0
  - @cat-factory/kernel@0.94.0

## 0.7.9

### Patch Changes

- Updated dependencies [77bc73c]
- Updated dependencies [076d02f]
  - @cat-factory/kernel@0.93.0
  - @cat-factory/contracts@0.102.0

## 0.7.8

### Patch Changes

- Updated dependencies [029a689]
- Updated dependencies [029a689]
  - @cat-factory/contracts@0.101.1
  - @cat-factory/kernel@0.92.0

## 0.7.7

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/contracts@0.101.0
  - @cat-factory/kernel@0.91.0

## 0.7.6

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/contracts@0.100.0
  - @cat-factory/kernel@0.90.0

## 0.7.5

### Patch Changes

- Updated dependencies [3981bbb]
  - @cat-factory/contracts@0.99.0
  - @cat-factory/kernel@0.89.1

## 0.7.4

### Patch Changes

- Updated dependencies [cfcb6c7]
- Updated dependencies [48f9d97]
  - @cat-factory/kernel@0.89.0
  - @cat-factory/contracts@0.98.0

## 0.7.3

### Patch Changes

- Updated dependencies [f4c321e]
  - @cat-factory/kernel@0.88.0

## 0.7.2

### Patch Changes

- Updated dependencies [13a284f]
  - @cat-factory/kernel@0.87.0

## 0.7.1

### Patch Changes

- Updated dependencies [102c049]
  - @cat-factory/contracts@0.97.0
  - @cat-factory/kernel@0.86.1

## 0.7.0

### Minor Changes

- 49b498a: Bug-triage pipeline, Phase D — issue-intake foundations (ports + persistence).

  The plumbing the upcoming `bug-intake` step (Phase E) drives: a predicate search across the
  three task-source vendors, the per-schedule intake configuration, the "taken by cat-factory"
  pickup writeback, and the replace-link that keeps a recurring block's issue context from
  accumulating across fires. No engine step yet — this phase is ports, vendor implementations,
  and persistence only.

  - **`TaskSourceProvider.searchIssues` + `IssueIntakeQuery`** (kernel port): open issues on one
    vendor board matching every predicate (title fragment / labels / issue type), oldest-first,
    deduped against the already-worked exclusion list. Predicates are pushed into the vendor
    query wherever expressible — Jira compiles ONE JQL (`statusCategory != Done`, `issuetype`,
    `labels`, `summary ~`, `issuekey NOT IN`, `ORDER BY created ASC`; excluded ids validated
    against the key shape so a malformed id can't inject), GitHub compiles search qualifiers
    (`repo:` `is:open` `type:` `label:` `in:title`, the title fragment quoted as a literal phrase
    so it can't inject a qualifier) with the API's `created-asc` sort (a new `order` param on
    `GitHubClient.searchIssues`, honoured by the GitLab-backed client too) and filters the
    exclusion list case-insensitively from a bounded, paged overscan, Linear compiles a GraphQL
    `IssueFilter` (team, state type not completed/canceled, per-label `labels.some`,
    `title.containsIgnoreCase`) asked for oldest-created-first, also paged so a run of
    already-worked issues at the front can't starve the pickup.
  - **`PipelineSchedule.issueIntake`** (contracts + both runtimes, kept symmetric): the
    schedule-scoped intake config (`source`, per-vendor `board` scope, `predicates`, the GitHub
    `inProgressLabel`) as a new `pipeline_schedules.issue_intake` JSON column — D1 migration
    `0038_schedule_issue_intake.sql` ⇄ Drizzle schema + generated migration — parsed/serialized
    by shared `@cat-factory/server` mapper helpers so the column can't drift, accepted on
    schedule create/update (PATCH is tri-state: omitted = unchanged, null = clear), and pinned
    by a cross-runtime conformance round-trip. Requiring it when the pipeline carries a
    `bug-intake` step is Phase E's schedule validation.
  - **`IssueWritebackProvider.onIssuePickedUp`**: comments "Taken by cat-factory" (+ run link)
    on the block's linked issue(s) and marks them in-progress — Jira transitions into the
    `indeterminate` status category (`pickDoneTransition` generalized into
    `pickTransitionByCategory`), Linear transitions to the team's `started` state (the Linear
    state pickers generalized into `pickStateIdByType`), GitHub applies the schedule's
    `inProgressLabel` (default `in-progress`) via a new `GitHubClient.applyIssueLabel` that
    creates the label — with the required colour — when absent.
    Best-effort per issue like the existing hooks, and deliberately NOT gated on the workspace
    writeback settings — claiming the issue is intake semantics. Wired in both facades.
  - **`TaskLinkService.replaceForBlock`** + `TaskRepository.unlinkAllFromBlock`: detach every
    issue linked to the reused block in ONE batched write (D1 ⇄ Drizzle), then link the newly
    picked issue — so linked context never accumulates across recurring fires.

### Patch Changes

- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/contracts@0.96.0
  - @cat-factory/kernel@0.86.0

## 0.6.12

### Patch Changes

- Updated dependencies [1f6d9fc]
  - @cat-factory/kernel@0.85.0

## 0.6.11

### Patch Changes

- Updated dependencies [e5ddaa4]
  - @cat-factory/kernel@0.84.0

## 0.6.10

### Patch Changes

- Updated dependencies [9bac054]
  - @cat-factory/kernel@0.83.0

## 0.6.9

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/contracts@0.95.0
  - @cat-factory/kernel@0.82.0

## 0.6.8

### Patch Changes

- 6edcce0: Personal-PAT repo access + fail-closed board redaction, and removal of the legacy repo→block link.

  - **Expand the repo picker with your own PAT (all facades).** A user's stored GitHub PAT
    (`user_secrets` kind `github_pat`) now surfaces repos it can reach beyond the workspace's GitHub
    App grant — even on the hosted Cloudflare/Node facades. Linking one creates a **personal service**
    (`GitHubRepo.linkedVia === 'user_pat'`); runs against it already use the initiator's PAT.
  - **Fail-closed frame redaction.** A service frame backed by a repo linked via another member's PAT
    is hidden from members who can't reach it: the board snapshot scrubs the frame to just its
    internal id + a "Permission denied" placeholder and drops its subtree. Access is a fail-closed
    per-user projection (`github_user_repo_access`), refreshed when a user enumerates their PAT repos
    and cleared when they remove their PAT — no live GitHub call on the snapshot path.
  - **New:** `github_repos.linked_via` column + `github_user_repo_access` table (mirrored D1 ⇄
    Drizzle, with a cross-runtime conformance suite); kernel `UserRepoAccessRepository` port and
    optional `GitHubClient.listReposForToken`/`getRepoForToken`; `Block.accessDenied` +
    `GitHubAvailableRepo.personal` wire fields.

  **Breaking (pre-1.0, no migration):** the legacy `github_repos.block_id` repo↔frame link is removed
  — the account-owned `Service` (`getByFrameBlock` → `repoGithubId`) is now the SOLE repo↔frame
  linkage. `RepoProjectionRepository.linkBlock` and `GitHubRepo.blockId` are gone; `resolveRepoTarget`
  now requires a `serviceRepository`; the `RepoBootstrapper` port's `linkRepoToBlock` is replaced by
  `projectBootstrappedRepo` (the caller binds the frame's `Service`). Existing rows' `block_id` is
  dropped; repos remain reachable through their `Service`.

- Updated dependencies [6edcce0]
  - @cat-factory/contracts@0.94.0
  - @cat-factory/kernel@0.81.0

## 0.6.7

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/contracts@0.93.0
  - @cat-factory/kernel@0.80.0

## 0.6.6

### Patch Changes

- Updated dependencies [1d738f7]
  - @cat-factory/contracts@0.92.0
  - @cat-factory/kernel@0.79.1

## 0.6.5

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/contracts@0.91.0
  - @cat-factory/kernel@0.79.0

## 0.6.4

### Patch Changes

- Updated dependencies [b928904]
  - @cat-factory/contracts@0.90.0
  - @cat-factory/kernel@0.78.0

## 0.6.3

### Patch Changes

- Updated dependencies [7fa7578]
  - @cat-factory/contracts@0.89.0
  - @cat-factory/kernel@0.77.0

## 0.6.2

### Patch Changes

- Updated dependencies [55661f4]
  - @cat-factory/contracts@0.88.0
  - @cat-factory/kernel@0.76.0

## 0.6.1

### Patch Changes

- Updated dependencies [ca5c3e8]
  - @cat-factory/contracts@0.87.0
  - @cat-factory/kernel@0.75.0

## 0.6.0

### Minor Changes

- b216fdc: Fragment GitHub-source staleness is now a lightweight commit-version check.

  The full fragment bodies were already cached on our side; the "check for changes"
  probe previously re-listed the whole source directory and hashed every blob sha.
  It now reads only the source directory's current head commit sha and compares it to
  the commit the source was last synced to — a single cheap GitHub/GitLab call, no
  directory listing or file reads.

  Breaking (pre-1.0, no migration): `FragmentSource`/`FragmentSyncResult` now expose
  `lastSyncedCommit` instead of `lastSyncedSha`, and `FragmentSourceStatus` is
  `{ changed, lastSyncedCommit, remoteCommit }` (the per-file `changedCount`/`remoteSha`
  are gone — the resync badge is now a plain "changes available" indicator). A new
  `latestCommitSha` port method is added to `GitHubClient` and `VcsClient`. The physical
  `fragment_sources.last_synced_sha` column is unchanged and reused to store the commit
  sha, so no database migration is required; existing rows re-derive their commit on the
  next sync.

### Patch Changes

- Updated dependencies [b216fdc]
  - @cat-factory/kernel@0.74.0
  - @cat-factory/contracts@0.86.0

## 0.5.0

### Minor Changes

- 7fd6a19: Import-from-repo picker: find and link accessible repos in realtime instead of enumerating the whole installation and filtering in memory. The old path listed every installation repo (capped at a bounded page count) then substring-filtered client-of-the-cap — so on a wide App install a repo beyond that window returned "no matches" for a repo you actually had access to, and every keystroke re-fetched all pages. Two new `GitHubClient` primitives fix it end to end: `searchInstallationRepos` issues one bounded, account-scoped GitHub search per query, and `getRepoById` point-reads the picked repo by id when linking it (so a repo surfaced by search from beyond the enumeration cap links instead of spuriously 409-ing). Blank-query browse-all is unchanged; PAT (local) and GitLab connections filter their bounded token listing. When an installation has no resolvable account to scope the GitHub search to, the App adapter filters its own bounded listing rather than running an unscoped global search (which would surface arbitrary, unlinkable public repos).

### Patch Changes

- Updated dependencies [7fd6a19]
  - @cat-factory/kernel@0.73.0

## 0.4.45

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/contracts@0.85.0
  - @cat-factory/kernel@0.72.0

## 0.4.44

### Patch Changes

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
  - @cat-factory/contracts@0.84.0
  - @cat-factory/kernel@0.71.0

## 0.4.43

### Patch Changes

- Updated dependencies [e0aab3f]
  - @cat-factory/contracts@0.83.0
  - @cat-factory/kernel@0.70.2

## 0.4.42

### Patch Changes

- Updated dependencies [0d51638]
  - @cat-factory/kernel@0.70.1

## 0.4.41

### Patch Changes

- Updated dependencies [eb67d40]
  - @cat-factory/kernel@0.70.0

## 0.4.40

### Patch Changes

- Updated dependencies [5ce03c6]
  - @cat-factory/contracts@0.82.0
  - @cat-factory/kernel@0.69.8

## 0.4.39

### Patch Changes

- Updated dependencies [7f9d215]
  - @cat-factory/kernel@0.69.7

## 0.4.38

### Patch Changes

- Updated dependencies [4a7a3f1]
  - @cat-factory/contracts@0.81.3
  - @cat-factory/kernel@0.69.6

## 0.4.37

### Patch Changes

- Updated dependencies [6243bea]
  - @cat-factory/contracts@0.81.2
  - @cat-factory/kernel@0.69.5

## 0.4.36

### Patch Changes

- Updated dependencies [2a91615]
  - @cat-factory/contracts@0.81.1
  - @cat-factory/kernel@0.69.4

## 0.4.35

### Patch Changes

- Updated dependencies [67d3876]
  - @cat-factory/contracts@0.81.0
  - @cat-factory/kernel@0.69.3

## 0.4.34

### Patch Changes

- Updated dependencies [d7f6e1c]
- Updated dependencies [63cf6de]
  - @cat-factory/kernel@0.69.2
  - @cat-factory/contracts@0.80.1

## 0.4.33

### Patch Changes

- Updated dependencies [120de05]
  - @cat-factory/contracts@0.80.0
  - @cat-factory/kernel@0.69.1

## 0.4.32

### Patch Changes

- Updated dependencies [dcc8b32]
  - @cat-factory/contracts@0.79.0
  - @cat-factory/kernel@0.69.0

## 0.4.31

### Patch Changes

- Updated dependencies [16ee6cc]
  - @cat-factory/contracts@0.78.1
  - @cat-factory/kernel@0.68.1

## 0.4.30

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/contracts@0.78.0
  - @cat-factory/kernel@0.68.0

## 0.4.29

### Patch Changes

- Updated dependencies [9e93fe8]
- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [edf4e69]
- Updated dependencies [f21279e]
- Updated dependencies [6c51e31]
  - @cat-factory/contracts@0.77.0
  - @cat-factory/kernel@0.67.0

## 0.4.28

### Patch Changes

- 3135ae8: Make GitLab a first-class auth identity on the hosted (Cloudflare Worker + Node) path.

  **Wire hosted PAT sign-in into the Cloudflare Worker.** The Worker now registers the PAT-login
  identity registry (`vcsIdentity`) like the Node facade — GitHub always, GitLab when a GitLab
  connection is configured (`GITLAB_TOKEN` / `config.gitlab.enabled`) — so a user can sign in by
  pasting their own GitHub **or** GitLab PAT at `/auth/pat`. Previously the Worker wired none,
  leaving it OAuth-only; since GitLab has no OAuth browser flow, a GitLab user had no way to sign
  in to a Worker deployment at all, even though its engine already gated CI and merged on GitLab.
  `/auth/config` now advertises `patLogin.providers` accordingly, so the SPA renders the PAT form.

  **Implement `GitLabIdentityResolver.resolveOrgs`.** A hosted deployment admits a pasted PAT only
  when the account's login, an org/group it belongs to, or its email domain is allowlisted. Only
  `GitHubIdentityResolver` implemented `resolveOrgs`, so `isPatIdentityAllowed`'s org branch was
  skipped for GitLab — a GitLab account could be a primary identity via `AUTH_ALLOWED_LOGINS` or
  `AUTH_ALLOWED_EMAIL_DOMAINS`, but never `AUTH_ALLOWED_ORGS`. The resolver now enumerates the
  user's GitLab **group** memberships (`GET /groups?min_access_level=10`, lowercased full paths, so
  only groups the user actually belongs to admit), bringing group-based admission to parity with
  GitHub org admission.

  **Bound and diagnose PAT-login org/group admission.** Both `resolveOrgs` implementations
  (GitHub `/user/orgs`, GitLab `/groups`) now follow `Link: rel="next"` pagination up to a ~1000-entry
  cap (and `logger.warn` on truncation, wired from each facade — Node included), so a user whose only
  allowlisted org/group sat past the first 100 is no longer wrongly denied. When org enumeration fails
  because a token can authenticate `/user` but lacks the broader org/group-read scope
  (`read:org` / `read_api`), the `/auth/pat` 403 now hints at the missing scope instead of a flat
  "not allowed", and a hosted deployment's missing-token prompt tells the user to paste their PAT
  rather than to set an env var they don't control.

  Comment-only touches to `@cat-factory/server`'s `AuthController`, the kernel `VcsIdentityRegistry`
  doc, and the SPA login screen to correct the now-stale "hosted facades are OAuth-only" notes.

## 0.4.27

### Patch Changes

- Updated dependencies [762fe66]
  - @cat-factory/contracts@0.76.0
  - @cat-factory/kernel@0.66.1

## 0.4.26

### Patch Changes

- Updated dependencies [fb53662]
  - @cat-factory/kernel@0.66.0
  - @cat-factory/contracts@0.75.0

## 0.4.25

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/contracts@0.74.0
  - @cat-factory/kernel@0.65.0

## 0.4.24

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/contracts@0.73.0
  - @cat-factory/kernel@0.64.0

## 0.4.23

### Patch Changes

- Updated dependencies [70e321b]
  - @cat-factory/contracts@0.72.0
  - @cat-factory/kernel@0.63.4

## 0.4.22

### Patch Changes

- Updated dependencies [77c6842]
  - @cat-factory/contracts@0.71.0
  - @cat-factory/kernel@0.63.3

## 0.4.21

### Patch Changes

- Updated dependencies [2e1354f]
  - @cat-factory/contracts@0.70.1
  - @cat-factory/kernel@0.63.2

## 0.4.20

### Patch Changes

- Updated dependencies [b4c7e60]
  - @cat-factory/contracts@0.70.0
  - @cat-factory/kernel@0.63.1

## 0.4.19

### Patch Changes

- Updated dependencies [f568a8c]
  - @cat-factory/kernel@0.63.0
  - @cat-factory/contracts@0.69.0

## 0.4.18

### Patch Changes

- Updated dependencies [41203db]
  - @cat-factory/contracts@0.68.0
  - @cat-factory/kernel@0.62.4

## 0.4.17

### Patch Changes

- Updated dependencies [cb9e2e3]
  - @cat-factory/contracts@0.67.0
  - @cat-factory/kernel@0.62.3

## 0.4.16

### Patch Changes

- Updated dependencies [1e55e77]
  - @cat-factory/contracts@0.66.1
  - @cat-factory/kernel@0.62.2

## 0.4.15

### Patch Changes

- Updated dependencies [ecf4cc1]
  - @cat-factory/contracts@0.66.0
  - @cat-factory/kernel@0.62.1

## 0.4.14

### Patch Changes

- Updated dependencies [f9678df]
- Updated dependencies [858799e]
  - @cat-factory/contracts@0.65.0
  - @cat-factory/kernel@0.62.0

## 0.4.13

### Patch Changes

- Updated dependencies [9bb75b0]
  - @cat-factory/contracts@0.64.0
  - @cat-factory/kernel@0.61.1

## 0.4.12

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/contracts@0.63.0
  - @cat-factory/kernel@0.61.0

## 0.4.11

### Patch Changes

- Updated dependencies [f383515]
  - @cat-factory/kernel@0.60.0
  - @cat-factory/contracts@0.62.0

## 0.4.10

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/kernel@0.59.0
  - @cat-factory/contracts@0.61.0

## 0.4.9

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/kernel@0.58.0
  - @cat-factory/contracts@0.60.0

## 0.4.8

### Patch Changes

- Updated dependencies [6009266]
  - @cat-factory/kernel@0.57.1

## 0.4.7

### Patch Changes

- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/contracts@0.59.0
  - @cat-factory/kernel@0.57.0

## 0.4.6

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/contracts@0.58.0
  - @cat-factory/kernel@0.56.1

## 0.4.5

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/contracts@0.57.0
  - @cat-factory/kernel@0.56.0

## 0.4.4

### Patch Changes

- Updated dependencies [fdeb466]
  - @cat-factory/kernel@0.55.4

## 0.4.3

### Patch Changes

- Updated dependencies [21b2096]
  - @cat-factory/contracts@0.56.1
  - @cat-factory/kernel@0.55.3

## 0.4.2

### Patch Changes

- Updated dependencies [ad5d3e0]
  - @cat-factory/contracts@0.56.0
  - @cat-factory/kernel@0.55.2

## 0.4.1

### Patch Changes

- Updated dependencies [4897078]
  - @cat-factory/contracts@0.55.0
  - @cat-factory/kernel@0.55.1

## 0.4.0

### Minor Changes

- d5a0637: Close the GitLab-vs-GitHub provider parity gaps so a GitLab deployment behaves like a GitHub
  one across every runtime facade.

  - **Facade parity (the showstopper):** the engine's CI / mergeability / PR-review gate
    providers, the PR merger, the branch updater and the checkout-free `RepoFiles` resolvers are
    now wired from a GitLab-backed client on the **Node and Cloudflare** facades too — previously
    only local mode bridged GitLab into the gates, so a stock GitLab-only Node/CF deployment did
    not gate on real CI or merge for real. Both facades now build the engine VCS client via the
    shared `buildGitLabEngineClient` (GitHub App wins when both are configured).
  - **Review provider:** `FetchGitLabClient` now implements the human-review reads
    (`getPullRequestBaseRef`, `listRequestedReviewers`, `listPullRequestReviews` +
    `getRequiredApprovingReviewCount` from GitLab approvals, `listReviewThreads` /
    `replyToReviewThread` / `resolveReviewThread` over resolvable MR discussions, plus
    `listIssueComments`).
  - **Branch update:** new optional `VcsClient.rebasePullRequest` / `GitHubClient.rebasePullRequest`
    — GitLab has no server-side merge-branch-into-branch endpoint, so the conflicts / human-testing
    gate's "pull latest base" action advances a GitLab MR branch by rebasing it; `GitHubBranchUpdater`
    prefers rebase when the client exposes it and falls back to `mergeBranch` (GitHub) otherwise.
  - **Conformance:** the cross-provider VCS client suite now asserts GitHub and GitLab normalise the
    human-review gate inputs identically and exposes the correct branch-advancing capability per
    provider; a reusable `FakeVcsClient` drives the real gate / merge / branch-update providers
    through the GitLab-backed adapter.
  - **Rebase verdict robustness:** the GitLab MR-rebase poll now sleeps before each status read (so
    a not-yet-started async rebase is never mistaken for a finished one) and decides the outcome by
    whether the source-branch head actually advanced, ignoring the persisted `merge_error` field
    (shared with merge attempts) unless the branch did not move. Covered by poll-transition,
    stale-`merge_error`, conflict and up-to-date tests.
  - **Accurate required-approval count:** `getRequiredApprovingReviewCount` now reads the effective
    per-MR `approvals_required` (it accounts for the rule on the MR's target branch) when the PR
    number is known, falling back to the project default; the port carries the PR number alongside
    the branch (GitHub still reads branch protection and ignores it).
  - **Node facade wiring:** the GitLab-backed engine client feeds only the gate / merge / RepoFiles
    seams; GitHub-issue-specific consumers (the GitHub Issues task source, issue writeback) stay
    gated on a real GitHub client, so a GitLab-only Node deployment no longer offers a
    non-functional "GitHub Issues" task source (parity with the Worker).

### Patch Changes

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/kernel@0.55.0
  - @cat-factory/contracts@0.54.0

## 0.3.9

### Patch Changes

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/kernel@0.54.0
  - @cat-factory/contracts@0.53.0

## 0.3.8

### Patch Changes

- Updated dependencies [0577404]
  - @cat-factory/contracts@0.52.0
  - @cat-factory/kernel@0.53.1

## 0.3.7

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/contracts@0.51.0
  - @cat-factory/kernel@0.53.0

## 0.3.6

### Patch Changes

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0
  - @cat-factory/contracts@0.50.1

## 0.3.5

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/contracts@0.50.0
  - @cat-factory/kernel@0.51.0

## 0.3.4

### Patch Changes

- Updated dependencies [e0f1149]
  - @cat-factory/contracts@0.49.0
  - @cat-factory/kernel@0.50.0

## 0.3.3

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/contracts@0.48.0
  - @cat-factory/kernel@0.49.0

## 0.3.2

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/contracts@0.47.0
  - @cat-factory/kernel@0.48.0

## 0.3.1

### Patch Changes

- Updated dependencies [704c99e]
  - @cat-factory/contracts@0.46.0
  - @cat-factory/kernel@0.47.2

## 0.3.0

### Minor Changes

- 2961b05: Meaningfully widen GitLab support in local mode — a `GITLAB_PAT` deployment now drives the
  real agent workflow, not just sign-in:

  - **`@cat-factory/gitlab`** adds `asGitHubClient(...)`, a `VcsClient`→`GitHubClient` adapter so
    any provider-neutral VCS client (e.g. `FetchGitLabClient`) satisfies the legacy `GitHubClient`
    port the engine's CI gate, merger and repo-read paths still consume.
  - **`@cat-factory/server`** resolves a run's repo origin (clone URL + provider) through an
    injectable `resolveRepoOrigin` seam and stamps the provider onto the dispatched job, instead
    of hardcoding a `github.com` clone URL. The default stays GitHub, so the Worker/Node facades
    are unchanged; a GitLab deployment supplies a GitLab origin so containers clone the right host
    and open merge requests. Without this the clone URL was always github.com, so a GitLab repo
    could never be cloned by an agent container.
  - **`@cat-factory/node-server`** threads `resolveRepoOrigin` through `NodeContainerOptions` to
    the container executor (default GitHub), so a sibling facade can supply a GitLab origin.
  - **`@cat-factory/local-server`** wires a GitLab PAT symmetrically to the GitHub PAT: the agent
    containers' git clone/push token falls back to `GITLAB_PAT`; the CI gate, mergeability, real
    merge and repo-link flows read through a PAT-backed `FetchGitLabClient` (adapted to
    `GitHubClient`); the agent containers clone the configured GitLab host + open merge requests
    (via `resolveRepoOrigin`); and the GitLab host is added to the harness clone/push allow-list
    (`GITHUB_ALLOWED_HOSTS`) so the container doesn't reject the GitLab clone URL. A GitLab-only
    local deployment is now a first-class source-control backend. Set `GITLAB_API_BASE` for a
    self-managed instance. The boot warning and the cross-provider `vcs-conformance` test cover
    both providers.
  - **`@cat-factory/executor-harness`** opens a GitLab **merge request** (not a GitHub PR) when the
    job's `repo.provider` is `gitlab` (set authoritatively by the server, so a self-managed GitLab
    on an arbitrarily-named host is routed correctly), falling back to host inference from the
    clone URL. The REST base + project path are derived from the host, and an already-open MR is
    reused on a resumed run. The GitHub path is unchanged. (The runner image must be republished
    for this to take effect in a deployed worker.)

## 0.2.2

### Patch Changes

- Updated dependencies [c2ec53b]
  - @cat-factory/contracts@0.45.1
  - @cat-factory/kernel@0.47.1

## 0.2.1

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0
  - @cat-factory/contracts@0.45.0

## 0.2.0

### Minor Changes

- 56e6ce6: Local mode: sign in with a source-control PAT (GitHub or GitLab) or email/password.

  Local mode previously ran fully anonymous (dev-open, no user), so per-user features —
  personal subscriptions, your own API keys — failed with 401 ("Sign in to manage …") with
  no way to sign in. Local mode now establishes a real identity:

  - A new provider-agnostic `VcsIdentityResolver` port (kernel) turns a raw PAT into a
    neutral identity (the provider's stable numeric user id — the SAME subject GitHub OAuth
    uses, so a PAT login and an OAuth login resolve to one canonical user). GitHub and GitLab
    resolvers ship in `@cat-factory/server` / `@cat-factory/gitlab`; adding an Nth provider is
    one more resolver entry, no endpoint or UI changes.
  - A new `POST /auth/pat` endpoint (served only where resolvers are wired — local mode)
    mints a session for the account a PAT belongs to. The local login screen offers one-click
    "Continue with GitHub/GitLab" when a `GITHUB_PAT`/`GITLAB_PAT` is configured, an inline
    "paste a PAT" form otherwise, and email/password sign-in (enabled by default in local
    mode, with open signup on the developer's own machine).
  - The SPA now requires sign-in in local mode (anonymous use can't store per-user
    credentials); the session is honored even though the API otherwise runs dev-open.
  - `'gitlab'` is now an identity provider. Identities remain collision-safe via the
    `(provider, subject)` key: a GitHub user and a GitLab user with the same numeric id, and
    a password account (keyed on email), are always distinct.

  Also adds a guard on the per-user credential forms (personal subscriptions, your own API
  keys): when there is genuinely no signed-in user (a non-local deployment running with auth
  disabled), the inputs are blocked with a clear notice instead of accepting data that can't
  be saved.

  BREAKING (local mode only): existing anonymously-created local boards have no owner, so
  after upgrading they become inaccessible once sign-in is required — recreate them under
  your signed-in account. (Pre-1.0, no data migration.)

### Patch Changes

- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/kernel@0.46.0
  - @cat-factory/contracts@0.44.0

## 0.1.7

### Patch Changes

- Updated dependencies [8fad695]
  - @cat-factory/contracts@0.43.3
  - @cat-factory/kernel@0.45.5

## 0.1.6

### Patch Changes

- Updated dependencies [fb339db]
  - @cat-factory/contracts@0.43.2
  - @cat-factory/kernel@0.45.4

## 0.1.5

### Patch Changes

- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3

## 0.1.4

### Patch Changes

- c11a0cc: Republish with the compiled `dist/` payload. A prior `pnpm publish` ran without a build
  step, so the tarball shipped as an empty shell (only `package.json`, no `dist/`) and the
  package could not be imported. A `prepublishOnly` build hook now guarantees the package is
  compiled before it is packed, regardless of how publish is invoked.
- Updated dependencies [c11a0cc]
  - @cat-factory/contracts@0.43.1
  - @cat-factory/kernel@0.45.2

## 0.1.3

### Patch Changes

- Updated dependencies [5363166]
  - @cat-factory/kernel@0.45.1

## 0.1.2

### Patch Changes

- Updated dependencies [eab73b8]
- Updated dependencies [eab73b8]
  - @cat-factory/contracts@0.43.0
  - @cat-factory/kernel@0.45.0

## 0.1.1

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/contracts@0.42.0
  - @cat-factory/kernel@0.44.0

## 0.1.0

### Minor Changes

- bbafec9: Add `@cat-factory/gitlab`: the opt-in GitLab VCS provider, the proof-of-concept
  second backend for the provider-neutral VCS abstraction. It implements the
  neutral `VcsClient` (repo/branch/MR/issue/CI reads + writes over the GitLab REST
  v4 API), a `VcsWebhookVerifier` + `VcsWebhookMapper` (constant-time
  `X-Gitlab-Token` check; `Merge Request`/`Issue`/`Push`/`Pipeline` hooks →
  neutral events), and a `VcsProvisioningClient`, and registers itself via
  `registerGitLab()` → `registerVcsProvider('gitlab')`. Depends only on
  `@cat-factory/kernel` + `@cat-factory/contracts`. Also refines the kernel
  `VcsWebhookMapper` port to take the resolved connection as a parameter.

  The provider is now WIRED into all runtime facades (single-token model, mirroring
  local-mode's PAT): a `GITLAB_TOKEN` (+ optional `GITLAB_API_BASE` /
  `GITLAB_CONNECTION_ID` / `GITLAB_WEBHOOK_SECRET`) enables it, the Worker + Node
  facades call `registerGitLab()` at container build (local inherits Node), and a
  new provider-neutral webhook receiver `POST /vcs/:provider/webhooks`
  (`@cat-factory/server`) verifies the signature against the registered
  `VcsWebhookVerifier`, maps the delivery via the registered `VcsWebhookMapper`, and
  hands the neutral event to the optional `VcsWebhookSink` kernel port. Adds a
  `GitLabConfig` to `AppConfig` and `vcsWebhookSink` to the server container.

  Bug fixes to the GitLab adapter: mergeability now prefers `detailed_merge_status`
  and only maps a genuine `conflict` to the `dirty` state the conflicts gate
  escalates on (a non-conflict block — CI pending, unresolved discussions, behind
  target — no longer spuriously spawns a conflict-resolver); `commitFiles` pins the
  commit parent via `start_sha` when `baseSha` is given; `getFileContent` resolves
  the project default branch instead of an unreliable `HEAD`; listing truncation at
  the page cap is now surfaced via an optional logger; the webhook mapper takes an
  injected `Clock` (deterministic timestamps) and reads the issue author.

  NOT yet migrated: the existing execution consumers (`resolveRepoTarget`, the
  CI/mergeability/merger/repo-files providers, the `github_*` projection
  persistence) still key on the GitHub installation id — projecting a neutral
  webhook event into provider-aware persistence is the remaining strangler step.

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/kernel@0.43.0
