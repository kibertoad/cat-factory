# @cat-factory/sandbox-fixtures

## 0.7.46

### Patch Changes

- 8fad695: Update dependencies to latest.

  - `undici` 7→8 (test-only `MockAgent`). undici's MockAgent must match Node's
    bundled undici to intercept the global `fetch`; Node 26 bundles undici 8.5.0,
    so the test runner / CI is pinned to **Node 26**. Production runtime is
    unaffected — `undici` is a dev/test dependency only, and the service still runs
    on any Node >=20 (e.g. the example `deploy/node` image stays on Node 24).
  - Minor/patch bumps: `wrangler` 4.105, `@cloudflare/*`, `@types/node` 26.0.1,
    `vue` 3.5.39, `msw` 2.14.6, `valibot` 1.4.2, `workers-ai-provider` 3.2.1,
    `@toad-contracts/*` (core 0.4.0, valibot 0.5.0, hono/testing/http-client 0.3.2),
    `@aws-sdk/client-s3` 3.1075.
  - The AI SDK (`ai`, `@ai-sdk/*`) is intentionally held at v6 / v3-v4: the latest
    `workers-ai-provider` (3.2.1, the Cloudflare Workers AI provider) still peers on
    `ai@^6` / `@ai-sdk/provider@^3` and is not yet compatible with `ai` v7.
  - Pinned the whole Vue runtime family to one version via a pnpm `override`
    (`vue` + `@vue/*` → 3.5.39). Bumping `vue` to 3.5.39 left Nuxt 4.4.8's
    transitive deps pinning parts of the graph to 3.5.38, so two copies of Vue were
    bundled into the SPA; Vue's render internals are module-level singletons, so the
    second copy crashed the app on boot (`Cannot read properties of null (reading
'ce')` in `renderSlot`) — a blank 500 page that hung the whole e2e suite. One
    version = one singleton.
  - GitHub Actions: `actions/checkout` v6→v7, `pnpm/action-setup` v6.0.9,
    `zizmorcore/zizmor-action` v0.5.7, `changesets/action` pinned to v1.9.0. CI Node 24→26.

- Updated dependencies [8fad695]
  - @cat-factory/contracts@0.43.3

## 0.7.45

### Patch Changes

- Updated dependencies [fb339db]
  - @cat-factory/contracts@0.43.2

## 0.7.44

### Patch Changes

- c11a0cc: Add a `prepublishOnly` build hook so each package is compiled to `dist/` before it is
  packed, regardless of how publish is invoked. `dist/` is gitignored and was only built by
  the canonical `pnpm ci:publish` flow, so a bare `pnpm publish` could ship an empty shell
  (this is what happened to `@cat-factory/gitlab` and `@cat-factory/provider-s3`). The hook
  removes that footgun for every publishable library.
- Updated dependencies [c11a0cc]
  - @cat-factory/contracts@0.43.1

## 0.7.43

### Patch Changes

- Updated dependencies [eab73b8]
- Updated dependencies [eab73b8]
  - @cat-factory/contracts@0.43.0

## 0.7.42

### Patch Changes

- 67c7196: Break the `orchestration → sandbox → sandbox-fixtures → orchestration` package
  dependency cycle so the workspace graph is acyclic. The cycle was closed by a
  single type-only conformance test in `sandbox-fixtures` that imported
  `@cat-factory/orchestration` (a `devDependency`). That test now lives in
  `orchestration` (which owns the requirements/clarity logic types and already sees
  the fixtures), leaving `sandbox-fixtures` a pure leaf data package. No runtime
  behaviour changes; this only removes a dev-time cycle that blocked a per-package
  build task graph.

## 0.7.41

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/contracts@0.42.0

## 0.7.40

### Patch Changes

- Updated dependencies [63e2177]
  - @cat-factory/contracts@0.41.0

## 0.7.39

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/contracts@0.40.1

## 0.7.38

### Patch Changes

- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
  - @cat-factory/contracts@0.40.0

## 0.7.37

### Patch Changes

- Updated dependencies [b5231b0]
  - @cat-factory/contracts@0.39.0

## 0.7.36

### Patch Changes

- Updated dependencies [6d829bb]
  - @cat-factory/contracts@0.38.0

## 0.7.35

### Patch Changes

- Updated dependencies [714b7c9]
  - @cat-factory/contracts@0.37.0

## 0.7.34

### Patch Changes

- Updated dependencies [efbd910]
  - @cat-factory/contracts@0.36.0

## 0.7.33

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/contracts@0.35.0

## 0.7.32

### Patch Changes

- Updated dependencies [76543fa]
  - @cat-factory/contracts@0.34.0

## 0.7.31

### Patch Changes

- Updated dependencies [17adf4c]
  - @cat-factory/contracts@0.33.0

## 0.7.30

### Patch Changes

- Updated dependencies [eb48652]
  - @cat-factory/contracts@0.32.0

## 0.7.29

### Patch Changes

- Updated dependencies [9f7ee39]
- Updated dependencies [81b60d4]
  - @cat-factory/contracts@0.31.0

## 0.7.28

### Patch Changes

- Updated dependencies [ea59e91]
  - @cat-factory/contracts@0.30.0

## 0.7.27

### Patch Changes

- Updated dependencies [b82304e]
  - @cat-factory/contracts@0.29.0

## 0.7.26

### Patch Changes

- Updated dependencies [765cc42]
  - @cat-factory/contracts@0.28.0

## 0.7.25

### Patch Changes

- Updated dependencies [52d886a]
  - @cat-factory/contracts@0.27.0

## 0.7.24

### Patch Changes

- Updated dependencies [a639189]
  - @cat-factory/contracts@0.26.0

## 0.7.23

### Patch Changes

- Updated dependencies [ed3a673]
  - @cat-factory/contracts@0.25.1

## 0.7.22

### Patch Changes

- Updated dependencies [69d2270]
  - @cat-factory/contracts@0.25.0

## 0.7.21

### Patch Changes

- Updated dependencies [3546e3d]
  - @cat-factory/contracts@0.24.0

## 0.7.20

### Patch Changes

- Updated dependencies [ce81233]
  - @cat-factory/contracts@0.23.0

## 0.7.19

### Patch Changes

- Updated dependencies [6ff1f10]
  - @cat-factory/contracts@0.22.0

## 0.7.18

### Patch Changes

- Updated dependencies [04befe8]
  - @cat-factory/contracts@0.21.0

## 0.7.17

### Patch Changes

- Updated dependencies [2c24da8]
  - @cat-factory/contracts@0.20.0

## 0.7.16

### Patch Changes

- Updated dependencies [4120ac5]
  - @cat-factory/contracts@0.19.0

## 0.7.15

### Patch Changes

- Updated dependencies [25efe48]
  - @cat-factory/contracts@0.18.0

## 0.7.14

### Patch Changes

- Updated dependencies [c7b8012]
  - @cat-factory/contracts@0.17.1

## 0.7.13

### Patch Changes

- Updated dependencies [aa06003]
  - @cat-factory/contracts@0.17.0

## 0.7.12

### Patch Changes

- Updated dependencies [0ac64b8]
  - @cat-factory/contracts@0.16.0

## 0.7.11

### Patch Changes

- Updated dependencies [fde0437]
  - @cat-factory/contracts@0.15.0

## 0.7.10

### Patch Changes

- Updated dependencies [82d771e]
  - @cat-factory/contracts@0.14.0

## 0.7.9

### Patch Changes

- Updated dependencies [ce27690]
  - @cat-factory/contracts@0.13.1

## 0.7.8

### Patch Changes

- Updated dependencies [5c915fd]
  - @cat-factory/contracts@0.13.0

## 0.7.7

### Patch Changes

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
- Updated dependencies [4de2f5f]
  - @cat-factory/contracts@0.12.0

## 0.7.6

### Patch Changes

- Updated dependencies [1e31cbc]
  - @cat-factory/contracts@0.11.0

## 0.7.5

### Patch Changes

- Updated dependencies [d0081e1]
  - @cat-factory/contracts@0.10.0

## 0.7.4

### Patch Changes

- Updated dependencies [ae29687]
  - @cat-factory/contracts@0.9.0

## 0.7.3

### Patch Changes

- Updated dependencies [c70df09]
  - @cat-factory/contracts@0.8.0

## 0.7.2

### Patch Changes

- 4fa5ed9: Re-release all publishable packages. The previous release bumped these on `main` but never reached npm (the publish job was never triggered), so npm is a release behind. This changeset re-triggers the release so every package publishes.
- Updated dependencies [4fa5ed9]
  - @cat-factory/contracts@0.7.2

## 0.7.1

### Patch Changes

- 7463cf2: Add `repository` metadata (url + monorepo `directory`) to every published package.json. npm provenance attestation rejected the previous release because `repository.url` was empty and could not be matched against the source repo; declaring it lets the publish (and provenance) succeed, and re-triggers publishing of all packages from the failed release.
- Updated dependencies [7463cf2]
  - @cat-factory/contracts@0.7.1

## 0.7.0

### Minor Changes

- c4ef995: Add **`@cat-factory/sandbox-fixtures`** — a published package of hand-authored,
  standardized, **graded** no-repo fixtures for the Sandbox, plus the asymmetric
  grading model that scores them.

  - **`@cat-factory/sandbox-fixtures`** (new): inline (text-only) agent inputs that
    need NO repository checkout — `requirements-review`, `clarity-review`, `reviewer`
    (code review), and architecture-proposal review (`architect-companion`) — each
    spanning a simple → complex range. Every fixture declares the genuine findings a
    strong answer should surface, each rated by **trickiness** (how hard to spot —
    catching it is a "wow") and **impact** (how bad to miss). The standardized
    `SandboxFixtureDefinition` projects to the wire `SandboxFixture` via
    `toSandboxFixture`. Depends only on `@cat-factory/contracts` so the published
    `@cat-factory/sandbox` can load it via `workspace:*`.
  - **`@cat-factory/contracts`** (breaking, pre-1.0): the `findings` fixture objective
    now carries graded `expectations` (`{ id, summary, trickiness, impact, matchHints }`)
    instead of a flat `expectedFindings: string[]`; the objective result records the
    asymmetric breakdown (`impactRecall`, `wowBonus`, `caught`/`total`,
    `missedHighImpact`). New `clarity` inline fixture kind.
  - **`@cat-factory/sandbox`**: loads the workspace builtin fixtures by default
    (`listBuiltinFixtures`, re-exporting `@cat-factory/sandbox-fixtures`); replaces the
    flat `scoreExpectedFindings` recall with `scoreExpectations` (impact-weighted miss
    penalty so missing something impactful hurts most, plus a trickiness-weighted "wow"
    bonus for catching the subtle items) and `renderExpectationBrief` for the judge;
    adds the `architecture-review` (`architect-companion`) catalog entry and a
    `suggestExperiment` helper that maps selected models × prompts × fixtures to a
    ready-to-create experiment for a selected agent.

  No CI cache list change is needed: the new package sits under
  `backend/packages/*`, already covered by the workflow's `node_modules` cache glob;
  it is added to the `backend/tsconfig.build.json` composite build graph (the
  incremental `.tsbuildinfo` cache) so it builds before its `@cat-factory/sandbox`
  consumer.

### Patch Changes

- Updated dependencies [fe53445]
- Updated dependencies [d94e75c]
- Updated dependencies [3d9a9d8]
- Updated dependencies [3bc8c79]
- Updated dependencies [9d3a956]
- Updated dependencies [8d11833]
- Updated dependencies [ad9ba9e]
- Updated dependencies [3e0d753]
- Updated dependencies [8065fed]
- Updated dependencies [385bd93]
- Updated dependencies [0972696]
- Updated dependencies [e9b9356]
- Updated dependencies [e8005ba]
- Updated dependencies [3a12f15]
- Updated dependencies [b40da13]
- Updated dependencies [8eed38c]
- Updated dependencies [268c15d]
- Updated dependencies [157cd02]
- Updated dependencies [db77061]
- Updated dependencies [57d70fa]
- Updated dependencies [88b3170]
- Updated dependencies [fe0b7f8]
- Updated dependencies [f73652c]
- Updated dependencies [db336b1]
- Updated dependencies [8807f5c]
- Updated dependencies [9be11e1]
- Updated dependencies [5ec0d25]
- Updated dependencies [a691853]
- Updated dependencies [f066c59]
- Updated dependencies [4a08935]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [5c8ca33]
- Updated dependencies [b156b4b]
- Updated dependencies [7cf2a2d]
- Updated dependencies [2d66d34]
- Updated dependencies [197264e]
- Updated dependencies [3a12f15]
- Updated dependencies [37baa7f]
- Updated dependencies [553a67d]
- Updated dependencies [311a110]
- Updated dependencies [f16ae62]
- Updated dependencies [36018cb]
- Updated dependencies [799be66]
- Updated dependencies [d65c979]
- Updated dependencies [7157fd7]
- Updated dependencies [21ca647]
- Updated dependencies [c4ef995]
- Updated dependencies [8eed95b]
- Updated dependencies [0b38aa6]
- Updated dependencies [de5a9d7]
- Updated dependencies [d5e9141]
- Updated dependencies [2dd7e56]
- Updated dependencies [5ca8086]
- Updated dependencies [d0697d1]
- Updated dependencies [7dc8e57]
- Updated dependencies [cc8d96a]
- Updated dependencies [7c37653]
- Updated dependencies [43f2443]
- Updated dependencies [acac735]
- Updated dependencies [3841315]
- Updated dependencies [48d2f0d]
- Updated dependencies [3e6a844]
  - @cat-factory/contracts@0.7.0
