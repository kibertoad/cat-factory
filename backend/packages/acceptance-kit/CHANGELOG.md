# @cat-factory/acceptance-kit

## 0.3.6

### Patch Changes

- Updated dependencies [432b4e4]
  - @cat-factory/contracts@0.324.0
  - @cat-factory/kernel@0.315.0
  - @cat-factory/sdk@0.45.1

## 0.3.5

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
  - @cat-factory/sdk@0.45.1

## 0.3.4

### Patch Changes

- Updated dependencies [72ecc7c]
  - @cat-factory/contracts@0.323.0
  - @cat-factory/kernel@0.314.0
  - @cat-factory/sdk@0.45.0

## 0.3.3

### Patch Changes

- Updated dependencies [5b281a3]
  - @cat-factory/contracts@0.322.0
  - @cat-factory/kernel@0.313.0
  - @cat-factory/sdk@0.45.0

## 0.3.2

### Patch Changes

- Updated dependencies [53a4c40]
  - @cat-factory/contracts@0.321.0
  - @cat-factory/kernel@0.312.0
  - @cat-factory/sdk@0.45.0

## 0.3.1

### Patch Changes

- Updated dependencies [4a3af5a]
  - @cat-factory/kernel@0.311.0

## 0.3.0

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
  - @cat-factory/sdk@0.44.0

## 0.2.5

### Patch Changes

- Updated dependencies [3afea3a]
  - @cat-factory/contracts@0.319.0
  - @cat-factory/kernel@0.309.0
  - @cat-factory/sdk@0.43.0

## 0.2.4

### Patch Changes

- Updated dependencies [3f7d8b2]
  - @cat-factory/contracts@0.318.0
  - @cat-factory/kernel@0.308.0
  - @cat-factory/sdk@0.43.0

## 0.2.3

### Patch Changes

- Updated dependencies [2a2b6ef]
  - @cat-factory/kernel@0.307.0

## 0.2.2

### Patch Changes

- Updated dependencies [5333319]
  - @cat-factory/kernel@0.306.0

## 0.2.1

### Patch Changes

- Updated dependencies [053aac8]
  - @cat-factory/contracts@0.317.0
  - @cat-factory/kernel@0.305.0
  - @cat-factory/sdk@0.43.0

## 0.2.0

### Minor Changes

- f887604: Add `@cat-factory/acceptance-kit`: the building blocks for writing a headless acceptance suite
  against a live deployment (scenario driver, resumable ledger, progress journal, prerequisite gate
  with rendered remedies, waits that state their last observation, the SDK-driven run driver and the
  verification-report reductions), extracted from the platform's own acceptance suite so a deployment
  can cover its own providers, agent kinds and gates the same way.
