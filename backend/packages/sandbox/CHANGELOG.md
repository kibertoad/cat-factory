# @cat-factory/sandbox

## 0.12.11

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
  - @cat-factory/agents@0.142.2
  - @cat-factory/sandbox-fixtures@0.8.8

## 0.12.10

### Patch Changes

- Updated dependencies [da77447]
  - @cat-factory/contracts@0.326.0
  - @cat-factory/agents@0.142.1
  - @cat-factory/kernel@0.317.1
  - @cat-factory/sandbox-fixtures@0.8.7

## 0.12.9

### Patch Changes

- Updated dependencies [4125beb]
  - @cat-factory/contracts@0.325.0
  - @cat-factory/kernel@0.317.0
  - @cat-factory/agents@0.142.0
  - @cat-factory/sandbox-fixtures@0.8.6

## 0.12.8

### Patch Changes

- Updated dependencies [1d3c115]
  - @cat-factory/agents@0.141.0
  - @cat-factory/kernel@0.316.0

## 0.12.7

### Patch Changes

- Updated dependencies [432b4e4]
  - @cat-factory/contracts@0.324.0
  - @cat-factory/kernel@0.315.0
  - @cat-factory/agents@0.140.1
  - @cat-factory/sandbox-fixtures@0.8.5

## 0.12.6

### Patch Changes

- Updated dependencies [9d4b0c2]
  - @cat-factory/agents@0.140.0

## 0.12.5

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
  - @cat-factory/agents@0.139.1
  - @cat-factory/contracts@0.323.1
  - @cat-factory/kernel@0.314.1
  - @cat-factory/sandbox-fixtures@0.8.4

## 0.12.4

### Patch Changes

- Updated dependencies [72ecc7c]
  - @cat-factory/agents@0.139.0
  - @cat-factory/contracts@0.323.0
  - @cat-factory/kernel@0.314.0
  - @cat-factory/sandbox-fixtures@0.8.3

## 0.12.3

### Patch Changes

- Updated dependencies [5b281a3]
  - @cat-factory/agents@0.138.0
  - @cat-factory/contracts@0.322.0
  - @cat-factory/kernel@0.313.0
  - @cat-factory/sandbox-fixtures@0.8.2

## 0.12.2

### Patch Changes

- Updated dependencies [53a4c40]
  - @cat-factory/contracts@0.321.0
  - @cat-factory/kernel@0.312.0
  - @cat-factory/agents@0.137.1
  - @cat-factory/sandbox-fixtures@0.8.1

## 0.12.1

### Patch Changes

- Updated dependencies [4a3af5a]
  - @cat-factory/kernel@0.311.0
  - @cat-factory/agents@0.137.0

## 0.12.0

### Minor Changes

- cda15b8: Widen the Sandbox: more agent kinds, rubrics that match the task, and a repo-scale review fixture.

  Every cell now renders its task input through the SAME pure prompt builder its production caller
  uses, instead of a hand-rolled approximation that dropped each prompt's output contract and scope
  rules. `@cat-factory/agents` gains `composedSystemPromptFor`, the one place that decides
  bespoke-vs-composed prompt assembly (container dispatch and the Sandbox both ride it), and the
  Sandbox baseline text is now the promotable `shippedBasePromptFor` unit rather than
  `PROMPT_VERSIONS[id].text`, which for an inline engine kind is the already-composed prompt.

  The `task-estimator`'s JSON output contract is now the named `TRIAGE_JSON_CONTRACT` and an
  `OVERRIDE_PRESERVED_FRAGMENTS` member, so a per-workspace override (or a promoted Sandbox
  candidate) can no longer delete the shape `coerceTaskEstimate` parses. An unedited prompt is
  byte-identical.

  Four new rubrics (`architecture-review`, `bug-triage`, `estimation`, `answer-recommendation`); two
  new testable kinds (`task-estimator`, `requirements-writer`) with their fixtures; and a repo-scale
  multi-file code-review fixture delivered through `injectedContextFiles`.

  Breaks internal shapes, per the pre-1.0 rule for everything the public API does not cover:

  - `SandboxAgentKindMeta` / the `/sandbox/overview` response replace the single `bucket` field with
    `bucket` (production surface) plus `sandboxRun` and `unsupportedReason`. The last is a bounded
    reason CODE (`sandboxUnsupportedReasonSchema`), not prose: the backend refusal and the SPA's
    translated note are both derived from it. Stored fixtures, experiments and prompt candidates are
    unaffected.
  - The builtin fixture library is now reconciled against the shipped catalog on every read rather
    than seeded once when a workspace has none, so a workspace that used the Sandbox before a release
    picks up that release's fixtures. A builtin row whose content has drifted from the catalog is
    refreshed in place; workspace-authored fixtures are never touched.
  - `clarity-review` and `architect-companion` grade on new rubrics, so their dimension keys change.
    Grades recorded before this change carry the old keys and are no longer comparable with new ones;
    re-launch an experiment to re-grade it.
  - A Sandbox prompt candidate cloned from the `requirements-review`, `clarity-review` or
    `requirements-writer` baseline before this change contains the directives half of its prompt.
    Re-clone it rather than promoting it, or promotion doubles those directives.

### Patch Changes

- Updated dependencies [302e05a]
- Updated dependencies [cda15b8]
  - @cat-factory/contracts@0.320.0
  - @cat-factory/kernel@0.310.0
  - @cat-factory/sandbox-fixtures@0.8.0
  - @cat-factory/agents@0.136.0

## 0.11.162

### Patch Changes

- Updated dependencies [3afea3a]
  - @cat-factory/contracts@0.319.0
  - @cat-factory/kernel@0.309.0
  - @cat-factory/agents@0.135.0
  - @cat-factory/sandbox-fixtures@0.7.361

## 0.11.161

### Patch Changes

- Updated dependencies [3f7d8b2]
  - @cat-factory/agents@0.134.0
  - @cat-factory/contracts@0.318.0
  - @cat-factory/kernel@0.308.0
  - @cat-factory/sandbox-fixtures@0.7.360

## 0.11.160

### Patch Changes

- Updated dependencies [2a2b6ef]
  - @cat-factory/kernel@0.307.0
  - @cat-factory/agents@0.133.3

## 0.11.159

### Patch Changes

- Updated dependencies [5333319]
  - @cat-factory/kernel@0.306.0
  - @cat-factory/agents@0.133.2

## 0.11.158

### Patch Changes

- Updated dependencies [053aac8]
  - @cat-factory/contracts@0.317.0
  - @cat-factory/kernel@0.305.0
  - @cat-factory/agents@0.133.1
  - @cat-factory/sandbox-fixtures@0.7.359

## 0.11.157

### Patch Changes

- Updated dependencies [eb5fa75]
- Updated dependencies [9d8fdf6]
  - @cat-factory/contracts@0.316.0
  - @cat-factory/kernel@0.304.0
  - @cat-factory/agents@0.133.0
  - @cat-factory/sandbox-fixtures@0.7.358

## 0.11.156

### Patch Changes

- Updated dependencies [eb740be]
  - @cat-factory/contracts@0.315.0
  - @cat-factory/kernel@0.303.0
  - @cat-factory/agents@0.132.1
  - @cat-factory/sandbox-fixtures@0.7.357

## 0.11.155

### Patch Changes

- Updated dependencies [7f990ea]
  - @cat-factory/contracts@0.314.0
  - @cat-factory/kernel@0.302.0
  - @cat-factory/agents@0.132.0
  - @cat-factory/sandbox-fixtures@0.7.356

## 0.11.154

### Patch Changes

- Updated dependencies [409238f]
  - @cat-factory/kernel@0.301.0
  - @cat-factory/contracts@0.313.0
  - @cat-factory/agents@0.131.0
  - @cat-factory/sandbox-fixtures@0.7.355

## 0.11.153

### Patch Changes

- Updated dependencies [0ef48d1]
  - @cat-factory/kernel@0.300.0
  - @cat-factory/contracts@0.312.0
  - @cat-factory/agents@0.130.2
  - @cat-factory/sandbox-fixtures@0.7.354

## 0.11.152

### Patch Changes

- Updated dependencies [d5c1f1c]
- Updated dependencies [c67e924]
  - @cat-factory/agents@0.130.1
  - @cat-factory/kernel@0.299.1
  - @cat-factory/contracts@0.311.0
  - @cat-factory/sandbox-fixtures@0.7.353

## 0.11.151

### Patch Changes

- Updated dependencies [056e18d]
  - @cat-factory/contracts@0.310.0
  - @cat-factory/kernel@0.299.0
  - @cat-factory/agents@0.130.0
  - @cat-factory/sandbox-fixtures@0.7.352

## 0.11.150

### Patch Changes

- Updated dependencies [a81879b]
  - @cat-factory/contracts@0.309.0
  - @cat-factory/kernel@0.298.2
  - @cat-factory/agents@0.129.2
  - @cat-factory/sandbox-fixtures@0.7.351

## 0.11.149

### Patch Changes

- Updated dependencies [0e1e0fa]
  - @cat-factory/contracts@0.308.1
  - @cat-factory/agents@0.129.1
  - @cat-factory/kernel@0.298.1
  - @cat-factory/sandbox-fixtures@0.7.350

## 0.11.148

### Patch Changes

- Updated dependencies [7312e0a]
  - @cat-factory/kernel@0.298.0
  - @cat-factory/contracts@0.308.0
  - @cat-factory/agents@0.129.0
  - @cat-factory/sandbox-fixtures@0.7.349

## 0.11.147

### Patch Changes

- Updated dependencies [95408c2]
  - @cat-factory/contracts@0.307.0
  - @cat-factory/kernel@0.297.0
  - @cat-factory/agents@0.128.2
  - @cat-factory/sandbox-fixtures@0.7.348

## 0.11.146

### Patch Changes

- Updated dependencies [792ecde]
  - @cat-factory/agents@0.128.1
  - @cat-factory/kernel@0.296.1

## 0.11.145

### Patch Changes

- Updated dependencies [fc56d82]
- Updated dependencies [fc9afb4]
  - @cat-factory/contracts@0.306.0
  - @cat-factory/kernel@0.296.0
  - @cat-factory/agents@0.128.0
  - @cat-factory/sandbox-fixtures@0.7.347

## 0.11.144

### Patch Changes

- Updated dependencies [edd4fd0]
  - @cat-factory/kernel@0.295.0
  - @cat-factory/contracts@0.305.0
  - @cat-factory/agents@0.127.3
  - @cat-factory/sandbox-fixtures@0.7.346

## 0.11.143

### Patch Changes

- Updated dependencies [36e0c9b]
  - @cat-factory/contracts@0.304.0
  - @cat-factory/agents@0.127.2
  - @cat-factory/kernel@0.294.1
  - @cat-factory/sandbox-fixtures@0.7.345

## 0.11.142

### Patch Changes

- Updated dependencies [569181d]
  - @cat-factory/contracts@0.303.0
  - @cat-factory/kernel@0.294.0
  - @cat-factory/agents@0.127.1
  - @cat-factory/sandbox-fixtures@0.7.344

## 0.11.141

### Patch Changes

- Updated dependencies [1a0b593]
  - @cat-factory/contracts@0.302.0
  - @cat-factory/kernel@0.293.0
  - @cat-factory/agents@0.127.0
  - @cat-factory/sandbox-fixtures@0.7.343

## 0.11.140

### Patch Changes

- Updated dependencies [7d1477c]
  - @cat-factory/kernel@0.292.2
  - @cat-factory/agents@0.126.8

## 0.11.139

### Patch Changes

- c09ddbe: Render a review verdict as blocks a human can skim, and ask the reviewer to write it that way.

  A companion's verdict (the architect/spec/code/doc reviewers) arrives as ONE string: `comments`
  only exist where the graded output has ids to anchor to, so everything the reviewer found lands in
  `summary`. Unshaped, a model writes that as a single dense paragraph numbering its points inline
  ("(1) … (2) …"), and the run panel then appended it to the score inside the same line
  (`78% < 80% — <four hundred words>`). Nothing about that is skimmable: a reader cannot tell what
  blocks the work from what is a nit without reading all of it.

  Both halves move. `REVIEW_SUMMARY_LAYOUT` (agents, `prompts/shared.ts`) asks for a fixed skeleton,
  a one-line verdict then `**Must fix**` / `**Should fix**` / `**Minor**` bullet groups, and is
  carried by every companion (built-in and deployment-registered, since they share one prompt). It
  survives a per-workspace prompt override, like the other fragments that describe how the platform
  reads a reply rather than what it should look for. A reviewer that already reports structured
  findings beside its summary is deliberately excluded: every judge, the `pr-reviewer` and the tester
  have that array rendered as its own list, so the layout would make them write each point twice.
  The SPA renders those summaries through the existing `MarkdownProse` reader instead of plain-text
  dumps, and each companion round is now its own card rather than a continuation of the score line.
  The same render fix reaches the reviewer prose the first markdown sweep missed: judge summary and
  findings, best-practice adherence, the PR-review summary, findings and challenge verdicts, and the
  tester report. It stops at the fields carrying a VALUE a human copies rather than prose (a
  suggested fix, a gate's failure summary), which stay preformatted: markdown would emphasise the
  `__dunder__` in a path and curl the quotes in a command.

  Kernel's `extractJson` now repairs raw control characters inside a JSON string literal. A
  multi-line summary is exactly what makes a model forget the `\n` escape, and refusing that reply
  costs the whole verdict (a companion that returns nothing parseable fails the run) over a quoting
  slip. The repair is a SECOND pass, run only once every candidate in the reply has been read as
  written: a repair makes text parse that was meant to be skipped, so tried inline it would let an
  example shape or a prose aside shadow the real verdict written after it. Fence bodies are now all
  searched, not just the first. The harness's own reader gained the same repair (hence a runner image
  bump), because it reads the reply FIRST and each refusal there costs a billed repair completion
  before the engine ever sees it.

  The judge prompt bumps to `judge@v2`: its summary is now rendered beside its findings, so it is
  asked for a short whole-verdict paragraph that does not restate them. Scoring is untouched. A
  companion kind also stops resolving to the `review` phase's prompt version — a companion runs the
  companion prompt, so both the editor's baseline label and the sandbox baseline named a revision of
  text the kind never sends.

- Updated dependencies [c09ddbe]
  - @cat-factory/agents@0.126.7
  - @cat-factory/kernel@0.292.1

## 0.11.138

### Patch Changes

- Updated dependencies [fc4a1e4]
  - @cat-factory/contracts@0.301.0
  - @cat-factory/kernel@0.292.0
  - @cat-factory/agents@0.126.6
  - @cat-factory/sandbox-fixtures@0.7.342

## 0.11.137

### Patch Changes

- Updated dependencies [ee733ee]
  - @cat-factory/contracts@0.300.0
  - @cat-factory/kernel@0.291.0
  - @cat-factory/agents@0.126.5
  - @cat-factory/sandbox-fixtures@0.7.341

## 0.11.136

### Patch Changes

- Updated dependencies [01086d8]
  - @cat-factory/contracts@0.299.1
  - @cat-factory/kernel@0.290.1
  - @cat-factory/agents@0.126.4
  - @cat-factory/sandbox-fixtures@0.7.340

## 0.11.135

### Patch Changes

- Updated dependencies [1bcdacc]
  - @cat-factory/kernel@0.290.0
  - @cat-factory/agents@0.126.3

## 0.11.134

### Patch Changes

- Updated dependencies [195b248]
  - @cat-factory/contracts@0.299.0
  - @cat-factory/agents@0.126.2
  - @cat-factory/kernel@0.289.1
  - @cat-factory/sandbox-fixtures@0.7.339

## 0.11.133

### Patch Changes

- Updated dependencies [bc2478d]
  - @cat-factory/contracts@0.298.0
  - @cat-factory/kernel@0.289.0
  - @cat-factory/agents@0.126.1
  - @cat-factory/sandbox-fixtures@0.7.338

## 0.11.132

### Patch Changes

- Updated dependencies [a634746]
  - @cat-factory/contracts@0.297.0
  - @cat-factory/kernel@0.288.0
  - @cat-factory/agents@0.126.0
  - @cat-factory/sandbox-fixtures@0.7.337

## 0.11.131

### Patch Changes

- Updated dependencies [7893f35]
  - @cat-factory/contracts@0.296.0
  - @cat-factory/kernel@0.287.0
  - @cat-factory/agents@0.125.8
  - @cat-factory/sandbox-fixtures@0.7.336

## 0.11.130

### Patch Changes

- Updated dependencies [07ff467]
  - @cat-factory/contracts@0.295.0
  - @cat-factory/agents@0.125.7
  - @cat-factory/kernel@0.286.3
  - @cat-factory/sandbox-fixtures@0.7.335

## 0.11.129

### Patch Changes

- Updated dependencies [9b3473a]
  - @cat-factory/contracts@0.294.0
  - @cat-factory/agents@0.125.6
  - @cat-factory/kernel@0.286.2
  - @cat-factory/sandbox-fixtures@0.7.334

## 0.11.128

### Patch Changes

- Updated dependencies [b889842]
  - @cat-factory/kernel@0.286.1
  - @cat-factory/agents@0.125.5

## 0.11.127

### Patch Changes

- Updated dependencies [b25732f]
  - @cat-factory/contracts@0.293.0
  - @cat-factory/kernel@0.286.0
  - @cat-factory/agents@0.125.4
  - @cat-factory/sandbox-fixtures@0.7.333

## 0.11.126

### Patch Changes

- Updated dependencies [7119ca7]
  - @cat-factory/contracts@0.292.2
  - @cat-factory/kernel@0.285.3
  - @cat-factory/agents@0.125.3
  - @cat-factory/sandbox-fixtures@0.7.332

## 0.11.125

### Patch Changes

- Updated dependencies [57a7ecd]
  - @cat-factory/contracts@0.292.1
  - @cat-factory/kernel@0.285.2
  - @cat-factory/agents@0.125.2
  - @cat-factory/sandbox-fixtures@0.7.331

## 0.11.124

### Patch Changes

- Updated dependencies [5f6699a]
  - @cat-factory/contracts@0.292.0
  - @cat-factory/agents@0.125.1
  - @cat-factory/kernel@0.285.1
  - @cat-factory/sandbox-fixtures@0.7.330

## 0.11.123

### Patch Changes

- Updated dependencies [22b2459]
- Updated dependencies [2428b6b]
  - @cat-factory/kernel@0.285.0
  - @cat-factory/agents@0.125.0
  - @cat-factory/contracts@0.291.0
  - @cat-factory/sandbox-fixtures@0.7.329

## 0.11.122

### Patch Changes

- Updated dependencies [19baddf]
  - @cat-factory/kernel@0.284.0
  - @cat-factory/agents@0.124.0

## 0.11.121

### Patch Changes

- Updated dependencies [31f43c1]
  - @cat-factory/contracts@0.290.0
  - @cat-factory/kernel@0.283.0
  - @cat-factory/agents@0.123.6
  - @cat-factory/sandbox-fixtures@0.7.328

## 0.11.120

### Patch Changes

- Updated dependencies [3ff215a]
  - @cat-factory/contracts@0.289.1
  - @cat-factory/kernel@0.282.1
  - @cat-factory/agents@0.123.5
  - @cat-factory/sandbox-fixtures@0.7.327

## 0.11.119

### Patch Changes

- Updated dependencies [e3cf16a]
  - @cat-factory/contracts@0.289.0
  - @cat-factory/kernel@0.282.0
  - @cat-factory/agents@0.123.4
  - @cat-factory/sandbox-fixtures@0.7.326

## 0.11.118

### Patch Changes

- Updated dependencies [83764b5]
  - @cat-factory/contracts@0.288.0
  - @cat-factory/agents@0.123.3
  - @cat-factory/kernel@0.281.3
  - @cat-factory/sandbox-fixtures@0.7.325

## 0.11.117

### Patch Changes

- Updated dependencies [1fbd83c]
- Updated dependencies [00228c6]
  - @cat-factory/contracts@0.287.1
  - @cat-factory/kernel@0.281.2
  - @cat-factory/agents@0.123.2
  - @cat-factory/sandbox-fixtures@0.7.324

## 0.11.116

### Patch Changes

- Updated dependencies [bf473bd]
  - @cat-factory/contracts@0.287.0
  - @cat-factory/agents@0.123.1
  - @cat-factory/kernel@0.281.1
  - @cat-factory/sandbox-fixtures@0.7.323

## 0.11.115

### Patch Changes

- Updated dependencies [4715b74]
- Updated dependencies [8c1d8a6]
  - @cat-factory/contracts@0.286.0
  - @cat-factory/kernel@0.281.0
  - @cat-factory/agents@0.123.0
  - @cat-factory/sandbox-fixtures@0.7.322

## 0.11.114

### Patch Changes

- Updated dependencies [afe1250]
  - @cat-factory/contracts@0.285.0
  - @cat-factory/kernel@0.280.0
  - @cat-factory/agents@0.122.0
  - @cat-factory/sandbox-fixtures@0.7.321

## 0.11.113

### Patch Changes

- Updated dependencies [e3fdc15]
  - @cat-factory/contracts@0.284.0
  - @cat-factory/agents@0.121.4
  - @cat-factory/kernel@0.279.3
  - @cat-factory/sandbox-fixtures@0.7.320

## 0.11.112

### Patch Changes

- Updated dependencies [3036af7]
  - @cat-factory/agents@0.121.3
  - @cat-factory/kernel@0.279.2

## 0.11.111

### Patch Changes

- Updated dependencies [de7caaf]
  - @cat-factory/contracts@0.283.1
  - @cat-factory/agents@0.121.2
  - @cat-factory/kernel@0.279.1
  - @cat-factory/sandbox-fixtures@0.7.319

## 0.11.110

### Patch Changes

- Updated dependencies [f0e1c45]
  - @cat-factory/kernel@0.279.0
  - @cat-factory/agents@0.121.1

## 0.11.109

### Patch Changes

- Updated dependencies [6ad1d8b]
  - @cat-factory/contracts@0.283.0
  - @cat-factory/kernel@0.278.0
  - @cat-factory/agents@0.121.0
  - @cat-factory/sandbox-fixtures@0.7.318

## 0.11.108

### Patch Changes

- Updated dependencies [a596b9c]
  - @cat-factory/contracts@0.282.0
  - @cat-factory/kernel@0.277.0
  - @cat-factory/agents@0.120.2
  - @cat-factory/sandbox-fixtures@0.7.317

## 0.11.107

### Patch Changes

- Updated dependencies [2585b2f]
  - @cat-factory/contracts@0.281.0
  - @cat-factory/kernel@0.276.0
  - @cat-factory/agents@0.120.1
  - @cat-factory/sandbox-fixtures@0.7.316

## 0.11.106

### Patch Changes

- Updated dependencies [faddbf5]
  - @cat-factory/contracts@0.280.0
  - @cat-factory/agents@0.120.0
  - @cat-factory/kernel@0.275.4
  - @cat-factory/sandbox-fixtures@0.7.315

## 0.11.105

### Patch Changes

- Updated dependencies [8a06abc]
- Updated dependencies [8a06abc]
  - @cat-factory/contracts@0.279.0
  - @cat-factory/agents@0.119.3
  - @cat-factory/kernel@0.275.3
  - @cat-factory/sandbox-fixtures@0.7.314

## 0.11.104

### Patch Changes

- Updated dependencies [11f9efa]
  - @cat-factory/contracts@0.278.0
  - @cat-factory/agents@0.119.2
  - @cat-factory/kernel@0.275.2
  - @cat-factory/sandbox-fixtures@0.7.313

## 0.11.103

### Patch Changes

- Updated dependencies [c44e9d7]
  - @cat-factory/contracts@0.277.0
  - @cat-factory/agents@0.119.1
  - @cat-factory/kernel@0.275.1
  - @cat-factory/sandbox-fixtures@0.7.312

## 0.11.102

### Patch Changes

- Updated dependencies [dfa4a8e]
  - @cat-factory/kernel@0.275.0
  - @cat-factory/agents@0.119.0

## 0.11.101

### Patch Changes

- Updated dependencies [3e9a6af]
  - @cat-factory/contracts@0.276.0
  - @cat-factory/kernel@0.274.0
  - @cat-factory/agents@0.118.1
  - @cat-factory/sandbox-fixtures@0.7.311

## 0.11.100

### Patch Changes

- Updated dependencies [a62bcf8]
- Updated dependencies [fe8ca56]
- Updated dependencies [2544fb3]
- Updated dependencies [2544fb3]
  - @cat-factory/kernel@0.273.0
  - @cat-factory/contracts@0.275.0
  - @cat-factory/agents@0.118.0
  - @cat-factory/sandbox-fixtures@0.7.310

## 0.11.99

### Patch Changes

- Updated dependencies [35bc18f]
- Updated dependencies [882b94f]
- Updated dependencies [f2ead2a]
  - @cat-factory/kernel@0.272.0
  - @cat-factory/contracts@0.274.0
  - @cat-factory/agents@0.117.12
  - @cat-factory/sandbox-fixtures@0.7.309

## 0.11.98

### Patch Changes

- Updated dependencies [6e07961]
- Updated dependencies [9f9c240]
  - @cat-factory/kernel@0.271.0
  - @cat-factory/contracts@0.273.0
  - @cat-factory/agents@0.117.11
  - @cat-factory/sandbox-fixtures@0.7.308

## 0.11.97

### Patch Changes

- Updated dependencies [6c6dd0c]
- Updated dependencies [70745b6]
  - @cat-factory/kernel@0.270.0
  - @cat-factory/contracts@0.272.0
  - @cat-factory/agents@0.117.10
  - @cat-factory/sandbox-fixtures@0.7.307

## 0.11.96

### Patch Changes

- Updated dependencies [55310f6]
- Updated dependencies [55310f6]
  - @cat-factory/contracts@0.271.0
  - @cat-factory/kernel@0.269.0
  - @cat-factory/agents@0.117.9
  - @cat-factory/sandbox-fixtures@0.7.306

## 0.11.95

### Patch Changes

- Updated dependencies [17687a1]
  - @cat-factory/contracts@0.270.0
  - @cat-factory/kernel@0.268.0
  - @cat-factory/agents@0.117.8
  - @cat-factory/sandbox-fixtures@0.7.305

## 0.11.94

### Patch Changes

- Updated dependencies [01bb6d2]
- Updated dependencies [f0154ce]
- Updated dependencies [eac67c5]
- Updated dependencies [2b74bd0]
  - @cat-factory/contracts@0.269.0
  - @cat-factory/kernel@0.267.0
  - @cat-factory/agents@0.117.7
  - @cat-factory/sandbox-fixtures@0.7.304

## 0.11.93

### Patch Changes

- Updated dependencies [eaab22a]
  - @cat-factory/contracts@0.268.0
  - @cat-factory/kernel@0.266.0
  - @cat-factory/agents@0.117.6
  - @cat-factory/sandbox-fixtures@0.7.303

## 0.11.92

### Patch Changes

- Updated dependencies [74ea2bc]
  - @cat-factory/contracts@0.267.0
  - @cat-factory/kernel@0.265.0
  - @cat-factory/agents@0.117.5
  - @cat-factory/sandbox-fixtures@0.7.302

## 0.11.91

### Patch Changes

- Updated dependencies [1c8df4a]
  - @cat-factory/contracts@0.266.0
  - @cat-factory/kernel@0.264.0
  - @cat-factory/agents@0.117.4
  - @cat-factory/sandbox-fixtures@0.7.301

## 0.11.90

### Patch Changes

- Updated dependencies [6637bbd]
  - @cat-factory/contracts@0.265.0
  - @cat-factory/kernel@0.263.0
  - @cat-factory/agents@0.117.3
  - @cat-factory/sandbox-fixtures@0.7.300

## 0.11.89

### Patch Changes

- Updated dependencies [be9b8dc]
  - @cat-factory/contracts@0.264.0
  - @cat-factory/agents@0.117.2
  - @cat-factory/kernel@0.262.2
  - @cat-factory/sandbox-fixtures@0.7.299

## 0.11.88

### Patch Changes

- Updated dependencies [1025674]
- Updated dependencies [e5f7eb0]
  - @cat-factory/contracts@0.263.0
  - @cat-factory/agents@0.117.1
  - @cat-factory/kernel@0.262.1
  - @cat-factory/sandbox-fixtures@0.7.298

## 0.11.87

### Patch Changes

- Updated dependencies [8cbd518]
- Updated dependencies [8cbd518]
- Updated dependencies [7a2730a]
  - @cat-factory/contracts@0.262.0
  - @cat-factory/kernel@0.262.0
  - @cat-factory/agents@0.117.0
  - @cat-factory/sandbox-fixtures@0.7.297

## 0.11.86

### Patch Changes

- Updated dependencies [f7882cf]
- Updated dependencies [e6aa37d]
- Updated dependencies [aabfb4d]
  - @cat-factory/contracts@0.261.1
  - @cat-factory/kernel@0.261.0
  - @cat-factory/agents@0.116.8
  - @cat-factory/sandbox-fixtures@0.7.296

## 0.11.85

### Patch Changes

- Updated dependencies [9d6bce0]
  - @cat-factory/kernel@0.260.0
  - @cat-factory/agents@0.116.7

## 0.11.84

### Patch Changes

- Updated dependencies [24f76f1]
- Updated dependencies [964cfa6]
  - @cat-factory/contracts@0.261.0
  - @cat-factory/kernel@0.259.0
  - @cat-factory/agents@0.116.6
  - @cat-factory/sandbox-fixtures@0.7.295

## 0.11.83

### Patch Changes

- Updated dependencies [ae44914]
- Updated dependencies [4be3510]
  - @cat-factory/contracts@0.260.0
  - @cat-factory/kernel@0.258.0
  - @cat-factory/agents@0.116.5
  - @cat-factory/sandbox-fixtures@0.7.294

## 0.11.82

### Patch Changes

- Updated dependencies [11dae5b]
  - @cat-factory/contracts@0.259.0
  - @cat-factory/kernel@0.257.0
  - @cat-factory/agents@0.116.4
  - @cat-factory/sandbox-fixtures@0.7.293

## 0.11.81

### Patch Changes

- Updated dependencies [6076cf1]
- Updated dependencies [2fdb08d]
- Updated dependencies [11a2966]
  - @cat-factory/agents@0.116.3
  - @cat-factory/kernel@0.256.0
  - @cat-factory/contracts@0.258.0
  - @cat-factory/sandbox-fixtures@0.7.292

## 0.11.80

### Patch Changes

- Updated dependencies [00bff05]
  - @cat-factory/contracts@0.257.0
  - @cat-factory/agents@0.116.2
  - @cat-factory/kernel@0.255.1
  - @cat-factory/sandbox-fixtures@0.7.291

## 0.11.79

### Patch Changes

- Updated dependencies [ab0c228]
  - @cat-factory/contracts@0.256.0
  - @cat-factory/kernel@0.255.0
  - @cat-factory/agents@0.116.1
  - @cat-factory/sandbox-fixtures@0.7.290

## 0.11.78

### Patch Changes

- Updated dependencies [184d263]
- Updated dependencies [ee6ce7c]
  - @cat-factory/agents@0.116.0
  - @cat-factory/kernel@0.254.0
  - @cat-factory/contracts@0.255.0
  - @cat-factory/sandbox-fixtures@0.7.289

## 0.11.77

### Patch Changes

- Updated dependencies [16576d6]
  - @cat-factory/kernel@0.253.0
  - @cat-factory/contracts@0.254.0
  - @cat-factory/agents@0.115.0
  - @cat-factory/sandbox-fixtures@0.7.288

## 0.11.76

### Patch Changes

- Updated dependencies [5202fb9]
  - @cat-factory/kernel@0.252.0
  - @cat-factory/contracts@0.253.0
  - @cat-factory/agents@0.114.7
  - @cat-factory/sandbox-fixtures@0.7.287

## 0.11.75

### Patch Changes

- Updated dependencies [e845d65]
  - @cat-factory/kernel@0.251.0
  - @cat-factory/agents@0.114.6

## 0.11.74

### Patch Changes

- Updated dependencies [4c071ec]
  - @cat-factory/contracts@0.252.0
  - @cat-factory/kernel@0.250.0
  - @cat-factory/agents@0.114.5
  - @cat-factory/sandbox-fixtures@0.7.286

## 0.11.73

### Patch Changes

- Updated dependencies [3fbc87e]
- Updated dependencies [c9adc67]
  - @cat-factory/contracts@0.251.0
  - @cat-factory/kernel@0.249.0
  - @cat-factory/agents@0.114.4
  - @cat-factory/sandbox-fixtures@0.7.285

## 0.11.72

### Patch Changes

- Updated dependencies [e7e27ee]
  - @cat-factory/contracts@0.250.0
  - @cat-factory/kernel@0.248.0
  - @cat-factory/agents@0.114.3
  - @cat-factory/sandbox-fixtures@0.7.284

## 0.11.71

### Patch Changes

- Updated dependencies [53cd697]
  - @cat-factory/contracts@0.249.0
  - @cat-factory/kernel@0.247.0
  - @cat-factory/agents@0.114.2
  - @cat-factory/sandbox-fixtures@0.7.283

## 0.11.70

### Patch Changes

- Updated dependencies [6d3f784]
  - @cat-factory/kernel@0.246.0
  - @cat-factory/contracts@0.248.0
  - @cat-factory/agents@0.114.1
  - @cat-factory/sandbox-fixtures@0.7.282

## 0.11.69

### Patch Changes

- Updated dependencies [0937581]
- Updated dependencies [250b7dc]
  - @cat-factory/contracts@0.247.0
  - @cat-factory/kernel@0.245.0
  - @cat-factory/agents@0.114.0
  - @cat-factory/sandbox-fixtures@0.7.281

## 0.11.68

### Patch Changes

- Updated dependencies [ec96387]
- Updated dependencies [7f5ed08]
- Updated dependencies [4e4d1b4]
  - @cat-factory/contracts@0.246.0
  - @cat-factory/kernel@0.244.0
  - @cat-factory/agents@0.113.0
  - @cat-factory/sandbox-fixtures@0.7.280

## 0.11.67

### Patch Changes

- Updated dependencies [10e7a15]
- Updated dependencies [ca213b1]
  - @cat-factory/contracts@0.245.0
  - @cat-factory/agents@0.112.6
  - @cat-factory/kernel@0.243.1
  - @cat-factory/sandbox-fixtures@0.7.279

## 0.11.66

### Patch Changes

- Updated dependencies [d69115d]
  - @cat-factory/contracts@0.244.0
  - @cat-factory/kernel@0.243.0
  - @cat-factory/agents@0.112.5
  - @cat-factory/sandbox-fixtures@0.7.278

## 0.11.65

### Patch Changes

- Updated dependencies [f775c1d]
- Updated dependencies [bac6776]
- Updated dependencies [3857ea4]
  - @cat-factory/kernel@0.242.0
  - @cat-factory/contracts@0.243.0
  - @cat-factory/agents@0.112.4
  - @cat-factory/sandbox-fixtures@0.7.277

## 0.11.64

### Patch Changes

- Updated dependencies [7cf3e70]
  - @cat-factory/agents@0.112.3
  - @cat-factory/kernel@0.241.1

## 0.11.63

### Patch Changes

- Updated dependencies [e7867db]
- Updated dependencies [00c4d94]
  - @cat-factory/contracts@0.242.0
  - @cat-factory/kernel@0.241.0
  - @cat-factory/agents@0.112.2
  - @cat-factory/sandbox-fixtures@0.7.276

## 0.11.62

### Patch Changes

- Updated dependencies [c5a1a16]
  - @cat-factory/contracts@0.241.0
  - @cat-factory/kernel@0.240.0
  - @cat-factory/agents@0.112.1
  - @cat-factory/sandbox-fixtures@0.7.275

## 0.11.61

### Patch Changes

- Updated dependencies [dd90c1e]
- Updated dependencies [289b3de]
- Updated dependencies [dd90c1e]
- Updated dependencies [dd90c1e]
  - @cat-factory/contracts@0.240.0
  - @cat-factory/agents@0.112.0
  - @cat-factory/kernel@0.239.0
  - @cat-factory/sandbox-fixtures@0.7.274

## 0.11.60

### Patch Changes

- Updated dependencies [4e5640d]
- Updated dependencies [a675c63]
  - @cat-factory/kernel@0.238.0
  - @cat-factory/contracts@0.239.0
  - @cat-factory/agents@0.111.0
  - @cat-factory/sandbox-fixtures@0.7.273

## 0.11.59

### Patch Changes

- Updated dependencies [2c7d17d]
- Updated dependencies [aa62acf]
  - @cat-factory/kernel@0.237.0
  - @cat-factory/contracts@0.238.0
  - @cat-factory/agents@0.110.9
  - @cat-factory/sandbox-fixtures@0.7.272

## 0.11.58

### Patch Changes

- Updated dependencies [99be350]
  - @cat-factory/contracts@0.237.0
  - @cat-factory/agents@0.110.8
  - @cat-factory/kernel@0.236.1
  - @cat-factory/sandbox-fixtures@0.7.271

## 0.11.57

### Patch Changes

- Updated dependencies [c9c1dd3]
  - @cat-factory/contracts@0.236.0
  - @cat-factory/kernel@0.236.0
  - @cat-factory/agents@0.110.7
  - @cat-factory/sandbox-fixtures@0.7.270

## 0.11.56

### Patch Changes

- Updated dependencies [6b9f696]
  - @cat-factory/kernel@0.235.1
  - @cat-factory/agents@0.110.6

## 0.11.55

### Patch Changes

- Updated dependencies [cec0c3e]
  - @cat-factory/contracts@0.235.0
  - @cat-factory/kernel@0.235.0
  - @cat-factory/agents@0.110.5
  - @cat-factory/sandbox-fixtures@0.7.269

## 0.11.54

### Patch Changes

- Updated dependencies [8cbf1a7]
  - @cat-factory/contracts@0.234.0
  - @cat-factory/agents@0.110.4
  - @cat-factory/kernel@0.234.2
  - @cat-factory/sandbox-fixtures@0.7.268

## 0.11.53

### Patch Changes

- Updated dependencies [ee6601e]
  - @cat-factory/contracts@0.233.0
  - @cat-factory/agents@0.110.3
  - @cat-factory/kernel@0.234.1
  - @cat-factory/sandbox-fixtures@0.7.267

## 0.11.52

### Patch Changes

- Updated dependencies [937d4af]
  - @cat-factory/contracts@0.232.0
  - @cat-factory/kernel@0.234.0
  - @cat-factory/agents@0.110.2
  - @cat-factory/sandbox-fixtures@0.7.266

## 0.11.51

### Patch Changes

- Updated dependencies [2580fee]
- Updated dependencies [eb4ca17]
  - @cat-factory/kernel@0.233.0
  - @cat-factory/contracts@0.231.0
  - @cat-factory/agents@0.110.1
  - @cat-factory/sandbox-fixtures@0.7.265

## 0.11.50

### Patch Changes

- Updated dependencies [1f14793]
- Updated dependencies [2619d79]
  - @cat-factory/contracts@0.230.1
  - @cat-factory/kernel@0.232.0
  - @cat-factory/agents@0.110.0
  - @cat-factory/sandbox-fixtures@0.7.264

## 0.11.49

### Patch Changes

- Updated dependencies [e7e4404]
  - @cat-factory/contracts@0.230.0
  - @cat-factory/kernel@0.231.0
  - @cat-factory/agents@0.109.2
  - @cat-factory/sandbox-fixtures@0.7.263

## 0.11.48

### Patch Changes

- Updated dependencies [10e0341]
- Updated dependencies [10e0341]
  - @cat-factory/contracts@0.229.0
  - @cat-factory/kernel@0.230.0
  - @cat-factory/agents@0.109.1
  - @cat-factory/sandbox-fixtures@0.7.262

## 0.11.47

### Patch Changes

- Updated dependencies [fccb1df]
  - @cat-factory/contracts@0.228.0
  - @cat-factory/kernel@0.229.0
  - @cat-factory/agents@0.109.0
  - @cat-factory/sandbox-fixtures@0.7.261

## 0.11.46

### Patch Changes

- Updated dependencies [437a0c6]
  - @cat-factory/contracts@0.227.0
  - @cat-factory/agents@0.108.3
  - @cat-factory/kernel@0.228.1
  - @cat-factory/sandbox-fixtures@0.7.260

## 0.11.45

### Patch Changes

- Updated dependencies [43fd5c0]
  - @cat-factory/kernel@0.228.0
  - @cat-factory/contracts@0.226.0
  - @cat-factory/agents@0.108.2
  - @cat-factory/sandbox-fixtures@0.7.259

## 0.11.44

### Patch Changes

- Updated dependencies [0456066]
  - @cat-factory/contracts@0.225.0
  - @cat-factory/kernel@0.227.0
  - @cat-factory/agents@0.108.1
  - @cat-factory/sandbox-fixtures@0.7.258

## 0.11.43

### Patch Changes

- Updated dependencies [f1a6cb3]
- Updated dependencies [cc17221]
- Updated dependencies [889a497]
- Updated dependencies [3605630]
  - @cat-factory/contracts@0.224.0
  - @cat-factory/kernel@0.226.0
  - @cat-factory/agents@0.108.0
  - @cat-factory/sandbox-fixtures@0.7.257

## 0.11.42

### Patch Changes

- Updated dependencies [36b1853]
  - @cat-factory/contracts@0.223.0
  - @cat-factory/kernel@0.225.0
  - @cat-factory/agents@0.107.1
  - @cat-factory/sandbox-fixtures@0.7.256

## 0.11.41

### Patch Changes

- Updated dependencies [413095f]
  - @cat-factory/contracts@0.222.0
  - @cat-factory/kernel@0.224.0
  - @cat-factory/agents@0.107.0
  - @cat-factory/sandbox-fixtures@0.7.255

## 0.11.40

### Patch Changes

- Updated dependencies [04e44f8]
  - @cat-factory/contracts@0.221.0
  - @cat-factory/kernel@0.223.0
  - @cat-factory/agents@0.106.8
  - @cat-factory/sandbox-fixtures@0.7.254

## 0.11.39

### Patch Changes

- Updated dependencies [c8ba2cd]
- Updated dependencies [807e442]
- Updated dependencies [807e442]
- Updated dependencies [175f78f]
- Updated dependencies [807e442]
  - @cat-factory/contracts@0.220.0
  - @cat-factory/kernel@0.222.0
  - @cat-factory/agents@0.106.7
  - @cat-factory/sandbox-fixtures@0.7.253

## 0.11.38

### Patch Changes

- Updated dependencies [1106c93]
  - @cat-factory/contracts@0.219.0
  - @cat-factory/agents@0.106.6
  - @cat-factory/kernel@0.221.1
  - @cat-factory/sandbox-fixtures@0.7.252

## 0.11.37

### Patch Changes

- Updated dependencies [f63145d]
- Updated dependencies [3b88f66]
  - @cat-factory/contracts@0.218.0
  - @cat-factory/kernel@0.221.0
  - @cat-factory/agents@0.106.5
  - @cat-factory/sandbox-fixtures@0.7.251

## 0.11.36

### Patch Changes

- Updated dependencies [7f86f07]
- Updated dependencies [7f86f07]
  - @cat-factory/contracts@0.217.0
  - @cat-factory/kernel@0.220.0
  - @cat-factory/agents@0.106.4
  - @cat-factory/sandbox-fixtures@0.7.250

## 0.11.35

### Patch Changes

- Updated dependencies [87161e8]
  - @cat-factory/contracts@0.216.0
  - @cat-factory/kernel@0.219.0
  - @cat-factory/agents@0.106.3
  - @cat-factory/sandbox-fixtures@0.7.249

## 0.11.34

### Patch Changes

- Updated dependencies [96ad850]
- Updated dependencies [96ad850]
  - @cat-factory/contracts@0.215.0
  - @cat-factory/kernel@0.218.0
  - @cat-factory/agents@0.106.2
  - @cat-factory/sandbox-fixtures@0.7.248

## 0.11.33

### Patch Changes

- Updated dependencies [4c26c01]
  - @cat-factory/contracts@0.214.0
  - @cat-factory/kernel@0.217.0
  - @cat-factory/agents@0.106.1
  - @cat-factory/sandbox-fixtures@0.7.247

## 0.11.32

### Patch Changes

- Updated dependencies [924c6f9]
  - @cat-factory/contracts@0.213.0
  - @cat-factory/kernel@0.216.0
  - @cat-factory/agents@0.106.0
  - @cat-factory/sandbox-fixtures@0.7.246

## 0.11.31

### Patch Changes

- Updated dependencies [233e279]
- Updated dependencies [54d531d]
  - @cat-factory/contracts@0.212.0
  - @cat-factory/kernel@0.215.0
  - @cat-factory/agents@0.105.0
  - @cat-factory/sandbox-fixtures@0.7.245

## 0.11.30

### Patch Changes

- Updated dependencies [87ed4f9]
  - @cat-factory/contracts@0.211.0
  - @cat-factory/agents@0.104.3
  - @cat-factory/kernel@0.214.1
  - @cat-factory/sandbox-fixtures@0.7.244

## 0.11.29

### Patch Changes

- Updated dependencies [3435bd1]
  - @cat-factory/kernel@0.214.0
  - @cat-factory/agents@0.104.2

## 0.11.28

### Patch Changes

- Updated dependencies [70b4339]
  - @cat-factory/kernel@0.213.0
  - @cat-factory/agents@0.104.1

## 0.11.27

### Patch Changes

- Updated dependencies [f31c644]
- Updated dependencies [4ac6960]
- Updated dependencies [874d684]
  - @cat-factory/kernel@0.212.0
  - @cat-factory/agents@0.104.0
  - @cat-factory/contracts@0.210.1
  - @cat-factory/sandbox-fixtures@0.7.243

## 0.11.26

### Patch Changes

- Updated dependencies [769a3d9]
  - @cat-factory/kernel@0.211.0
  - @cat-factory/agents@0.103.0

## 0.11.25

### Patch Changes

- Updated dependencies [73708cf]
- Updated dependencies [876ee2d]
  - @cat-factory/contracts@0.210.0
  - @cat-factory/kernel@0.210.0
  - @cat-factory/agents@0.102.0
  - @cat-factory/sandbox-fixtures@0.7.242

## 0.11.24

### Patch Changes

- Updated dependencies [0a1170e]
  - @cat-factory/contracts@0.209.0
  - @cat-factory/kernel@0.209.0
  - @cat-factory/agents@0.101.0
  - @cat-factory/sandbox-fixtures@0.7.241

## 0.11.23

### Patch Changes

- Updated dependencies [d320539]
  - @cat-factory/contracts@0.208.0
  - @cat-factory/kernel@0.208.0
  - @cat-factory/agents@0.100.0
  - @cat-factory/sandbox-fixtures@0.7.240

## 0.11.22

### Patch Changes

- Updated dependencies [9e5f785]
  - @cat-factory/contracts@0.207.0
  - @cat-factory/kernel@0.207.0
  - @cat-factory/agents@0.99.0
  - @cat-factory/sandbox-fixtures@0.7.239

## 0.11.21

### Patch Changes

- Updated dependencies [8fbc0b5]
  - @cat-factory/kernel@0.206.0
  - @cat-factory/agents@0.98.0
  - @cat-factory/contracts@0.206.1
  - @cat-factory/sandbox-fixtures@0.7.238

## 0.11.20

### Patch Changes

- Updated dependencies [5511cdc]
  - @cat-factory/contracts@0.206.0
  - @cat-factory/kernel@0.205.0
  - @cat-factory/agents@0.97.0
  - @cat-factory/sandbox-fixtures@0.7.237

## 0.11.19

### Patch Changes

- Updated dependencies [1441041]
  - @cat-factory/contracts@0.205.0
  - @cat-factory/kernel@0.204.0
  - @cat-factory/agents@0.96.1
  - @cat-factory/sandbox-fixtures@0.7.236

## 0.11.18

### Patch Changes

- Updated dependencies [0b52df7]
  - @cat-factory/contracts@0.204.0
  - @cat-factory/kernel@0.203.0
  - @cat-factory/agents@0.96.0
  - @cat-factory/sandbox-fixtures@0.7.235

## 0.11.17

### Patch Changes

- Updated dependencies [9c6ce7a]
  - @cat-factory/kernel@0.202.0
  - @cat-factory/agents@0.95.1

## 0.11.16

### Patch Changes

- Updated dependencies [54e6a45]
- Updated dependencies [08e9bcc]
- Updated dependencies [a7aae8a]
  - @cat-factory/agents@0.95.0
  - @cat-factory/contracts@0.203.0
  - @cat-factory/kernel@0.201.1
  - @cat-factory/sandbox-fixtures@0.7.234

## 0.11.15

### Patch Changes

- Updated dependencies [8c40f33]
  - @cat-factory/agents@0.94.0
  - @cat-factory/kernel@0.201.0

## 0.11.14

### Patch Changes

- Updated dependencies [9d303f0]
  - @cat-factory/contracts@0.202.0
  - @cat-factory/kernel@0.200.0
  - @cat-factory/agents@0.93.0
  - @cat-factory/sandbox-fixtures@0.7.233

## 0.11.13

### Patch Changes

- Updated dependencies [0bffe55]
- Updated dependencies [1cd9d73]
  - @cat-factory/contracts@0.201.0
  - @cat-factory/kernel@0.199.0
  - @cat-factory/agents@0.92.0
  - @cat-factory/sandbox-fixtures@0.7.232

## 0.11.12

### Patch Changes

- Updated dependencies [d9789f9]
  - @cat-factory/kernel@0.198.0
  - @cat-factory/agents@0.91.0
  - @cat-factory/contracts@0.200.0
  - @cat-factory/sandbox-fixtures@0.7.231

## 0.11.11

### Patch Changes

- Updated dependencies [123ac6f]
  - @cat-factory/agents@0.90.0
  - @cat-factory/contracts@0.199.0
  - @cat-factory/kernel@0.197.0
  - @cat-factory/sandbox-fixtures@0.7.230

## 0.11.10

### Patch Changes

- Updated dependencies [99412e2]
  - @cat-factory/contracts@0.198.0
  - @cat-factory/kernel@0.196.0
  - @cat-factory/agents@0.89.1
  - @cat-factory/sandbox-fixtures@0.7.229

## 0.11.9

### Patch Changes

- Updated dependencies [1904eb8]
  - @cat-factory/kernel@0.195.0
  - @cat-factory/agents@0.89.0

## 0.11.8

### Patch Changes

- Updated dependencies [f9db6a6]
  - @cat-factory/agents@0.88.0
  - @cat-factory/kernel@0.194.0

## 0.11.7

### Patch Changes

- Updated dependencies [be7fe66]
  - @cat-factory/contracts@0.197.0
  - @cat-factory/kernel@0.193.0
  - @cat-factory/agents@0.87.2
  - @cat-factory/sandbox-fixtures@0.7.228

## 0.11.6

### Patch Changes

- Updated dependencies [83fd037]
  - @cat-factory/kernel@0.192.0
  - @cat-factory/contracts@0.196.0
  - @cat-factory/agents@0.87.1
  - @cat-factory/sandbox-fixtures@0.7.227

## 0.11.5

### Patch Changes

- Updated dependencies [7248b72]
- Updated dependencies [449d856]
  - @cat-factory/contracts@0.195.0
  - @cat-factory/kernel@0.191.0
  - @cat-factory/agents@0.87.0
  - @cat-factory/sandbox-fixtures@0.7.226

## 0.11.4

### Patch Changes

- Updated dependencies [4ecb25c]
  - @cat-factory/kernel@0.190.0
  - @cat-factory/agents@0.86.0

## 0.11.3

### Patch Changes

- Updated dependencies [7ed2bc0]
  - @cat-factory/contracts@0.194.0
  - @cat-factory/kernel@0.189.0
  - @cat-factory/agents@0.85.0
  - @cat-factory/sandbox-fixtures@0.7.225

## 0.11.2

### Patch Changes

- Updated dependencies [85efc27]
- Updated dependencies [9794c19]
  - @cat-factory/contracts@0.193.0
  - @cat-factory/kernel@0.188.0
  - @cat-factory/agents@0.84.2
  - @cat-factory/sandbox-fixtures@0.7.224

## 0.11.1

### Patch Changes

- Updated dependencies [57e1195]
- Updated dependencies [5b19dab]
  - @cat-factory/contracts@0.192.0
  - @cat-factory/kernel@0.187.0
  - @cat-factory/agents@0.84.1
  - @cat-factory/sandbox-fixtures@0.7.223

## 0.11.0

### Minor Changes

- e087b40: Let a workspace rewrite any agent's system prompt from the pipeline builder, and switch back
  through every version it has run.

  The store is an append-only revision log per `(workspace, agent kind)` — the highest revision is
  live — so restoring an older prompt appends a copy of it rather than overwriting, and "back to the
  built-in" is itself a recorded revision (a null text) that keeps the workspace tracking the shipped
  prompt as it improves instead of pinning a stale copy. The composite key doubles as the concurrency
  control: a second editor's save collides and is refused as `prompt_revision_conflict` rather than
  silently winning last-write.

  An override replaces the shipped TRACK prompt only. `systemPromptFor` gained an optional `override`
  argument and still layers the engine-enforced surface directives and trait guidance on top, so a
  workspace cannot edit away the read-only guardrail or the answer-in-your-reply rule. Holding that
  takes two mechanisms, because an invariant reaches a shipped prompt by two routes and only one of
  them survives having the track prompt replaced: `restoreShippedInvariants` puts back a rule a
  built-in track prompt carried INLINE (without it, editing any kind whose deliverable is its reply —
  spec-writer, the testers, the reviewers — silently drops the answer-in-your-reply rule and the run
  fails on an empty visible reply), and `BESPOKE_CONTAINER_SYSTEM_PROMPTS` declares `merger` /
  `on-call` as a `{ role, directives }` pair since those two bypass `systemPromptFor` entirely. The
  editor SHOWS the resulting appended text (`AgentPromptDetail.appendedText`, measured from the real
  composition) rather than describing it, so the promise is checkable rather than taken on trust.

  The engine resolves the live revision once per dispatch onto
  `AgentRunContext.systemPromptOverride` and pins it to `PipelineStep.promptRevision`, which Kaizen
  folds into its `(prompt, agent, model)` combo key — an edited prompt is its own combo rather than
  inheriting a verification the shipped one earned.

  New: the `agent_prompt_revisions` table (D1 migration 0068 ⇄ Drizzle), the `AgentPromptRepository`
  kernel port (remote-bucket for mothership mode), `GET|PUT /workspaces/:ws/agent-prompts[/:agentKind]`
  gated on `settings.manage`, and the `prompt_revision_conflict` conflict reason.

  The Sandbox is the other half of this feature and is now wired to it in both directions. A
  workspace's own prompts are projected into the prompt browser as read-only `workspace` versions
  (synthesized per request from the revision log, with the live one marked), so an experiment can
  measure a candidate against the prompt that is actually running rather than only against what the
  product ships — previously the only control on offer, and silently the wrong one on any workspace
  that had edited a kind. And a version can be PROMOTED to the live prompt:
  `POST /agent-prompts/:kind/promote`, deliberately on the prompt controller so it answers to
  `settings.manage` rather than the sandbox's `integrations.manage`.

  Behaviour change worth knowing: a stored sandbox `systemText` is now the BASE (track) prompt, and
  `SandboxRunService` composes the platform's directives on top at run time through the same
  `systemPromptFor` override path production uses. Previously it sent the stored text raw, so it
  graded a prompt that is never what gets sent — tolerable while the sandbox was a closed loop, and
  not tolerable once a graded candidate can become the live prompt. Existing candidates keep their
  text; their grades shift, because they are now measured on the composed prompt.

### Patch Changes

- Updated dependencies [e087b40]
  - @cat-factory/contracts@0.191.0
  - @cat-factory/kernel@0.186.0
  - @cat-factory/agents@0.84.0
  - @cat-factory/sandbox-fixtures@0.7.222

## 0.10.14

### Patch Changes

- Updated dependencies [0eacaa2]
  - @cat-factory/contracts@0.190.0
  - @cat-factory/agents@0.83.1
  - @cat-factory/kernel@0.185.1
  - @cat-factory/sandbox-fixtures@0.7.221

## 0.10.13

### Patch Changes

- Updated dependencies [1fa8ef7]
  - @cat-factory/kernel@0.185.0
  - @cat-factory/agents@0.83.0

## 0.10.12

### Patch Changes

- Updated dependencies [f0be8a7]
  - @cat-factory/kernel@0.184.0
  - @cat-factory/agents@0.82.4

## 0.10.11

### Patch Changes

- Updated dependencies [a8cc6b2]
  - @cat-factory/contracts@0.189.0
  - @cat-factory/kernel@0.183.0
  - @cat-factory/agents@0.82.3
  - @cat-factory/sandbox-fixtures@0.7.220

## 0.10.10

### Patch Changes

- Updated dependencies [ac832b9]
  - @cat-factory/contracts@0.188.0
  - @cat-factory/kernel@0.182.0
  - @cat-factory/agents@0.82.2
  - @cat-factory/sandbox-fixtures@0.7.219

## 0.10.9

### Patch Changes

- Updated dependencies [22d82ac]
  - @cat-factory/contracts@0.187.0
  - @cat-factory/kernel@0.181.0
  - @cat-factory/agents@0.82.1
  - @cat-factory/sandbox-fixtures@0.7.218

## 0.10.8

### Patch Changes

- Updated dependencies [e18cfa2]
- Updated dependencies [01d4b6c]
  - @cat-factory/kernel@0.180.0
  - @cat-factory/agents@0.82.0

## 0.10.7

### Patch Changes

- Updated dependencies [b75a08a]
  - @cat-factory/contracts@0.186.0
  - @cat-factory/kernel@0.179.0
  - @cat-factory/agents@0.81.1
  - @cat-factory/sandbox-fixtures@0.7.217

## 0.10.6

### Patch Changes

- Updated dependencies [9d965c9]
- Updated dependencies [8a9f311]
  - @cat-factory/contracts@0.185.0
  - @cat-factory/kernel@0.178.0
  - @cat-factory/agents@0.81.0
  - @cat-factory/sandbox-fixtures@0.7.216

## 0.10.5

### Patch Changes

- Updated dependencies [58e06a2]
  - @cat-factory/contracts@0.184.0
  - @cat-factory/kernel@0.177.0
  - @cat-factory/agents@0.80.1
  - @cat-factory/sandbox-fixtures@0.7.215

## 0.10.4

### Patch Changes

- Updated dependencies [65b87c1]
- Updated dependencies [df48cb0]
  - @cat-factory/contracts@0.183.0
  - @cat-factory/agents@0.80.0
  - @cat-factory/kernel@0.176.0
  - @cat-factory/sandbox-fixtures@0.7.214

## 0.10.3

### Patch Changes

- Updated dependencies [b30cc6e]
  - @cat-factory/contracts@0.182.0
  - @cat-factory/kernel@0.175.0
  - @cat-factory/agents@0.79.0
  - @cat-factory/sandbox-fixtures@0.7.213

## 0.10.2

### Patch Changes

- Updated dependencies [c47eb66]
- Updated dependencies [5abcb9e]
  - @cat-factory/contracts@0.181.0
  - @cat-factory/kernel@0.174.0
  - @cat-factory/agents@0.78.0
  - @cat-factory/sandbox-fixtures@0.7.212

## 0.10.1

### Patch Changes

- Updated dependencies [bead6df]
  - @cat-factory/contracts@0.180.0
  - @cat-factory/kernel@0.173.0
  - @cat-factory/agents@0.77.1
  - @cat-factory/sandbox-fixtures@0.7.211

## 0.10.0

### Minor Changes

- a04f609: Make the requirements-review product-scope boundary visible to both graders and humans.

  The `requirement-review` rubric now carries a `Product scope discipline` dimension (weight 2).
  Without it neither the Sandbox judge nor `cat-bench` could see the change that confined the stage
  to the product / business layer: a well-written, well-calibrated _technical_ finding scored fine on
  every existing axis, since `signal_noise` grades volume rather than layer. `gap_coverage` is
  narrowed to product-level gaps for the same reason.

  The two hand-kept copies of the rubrics (`@cat-factory/sandbox` and the benchmark harness) are now
  pinned equal by a conformity test, since a dimension added to one and not the other fails nothing
  on its own and just makes the two surfaces' scores quietly incomparable.

  The requirements-review window gains a `requirements.scopeNote` line explaining that the stage
  covers product and business requirements only and that technical decisions are settled later by the
  Architect and Researcher steps. Without it the absence of technical questions reads as the reviewer
  having missed something.

### Patch Changes

- Updated dependencies [a04f609]
  - @cat-factory/agents@0.77.0

## 0.9.164

### Patch Changes

- Updated dependencies [68f0edd]
- Updated dependencies [71ea4ec]
- Updated dependencies [6dbd864]
  - @cat-factory/contracts@0.179.0
  - @cat-factory/kernel@0.172.0
  - @cat-factory/agents@0.76.0
  - @cat-factory/sandbox-fixtures@0.7.210

## 0.9.163

### Patch Changes

- Updated dependencies [3260f2d]
  - @cat-factory/agents@0.75.2

## 0.9.162

### Patch Changes

- Updated dependencies [15905ab]
- Updated dependencies [9d8fe9b]
  - @cat-factory/agents@0.75.1
  - @cat-factory/contracts@0.178.0
  - @cat-factory/kernel@0.171.0
  - @cat-factory/sandbox-fixtures@0.7.209

## 0.9.161

### Patch Changes

- Updated dependencies [cf2779a]
  - @cat-factory/contracts@0.177.0
  - @cat-factory/agents@0.75.0
  - @cat-factory/kernel@0.170.0
  - @cat-factory/sandbox-fixtures@0.7.208

## 0.9.160

### Patch Changes

- Updated dependencies [1947062]
  - @cat-factory/contracts@0.176.0
  - @cat-factory/kernel@0.169.0
  - @cat-factory/agents@0.74.1
  - @cat-factory/sandbox-fixtures@0.7.207

## 0.9.159

### Patch Changes

- Updated dependencies [fb71506]
  - @cat-factory/agents@0.74.0

## 0.9.158

### Patch Changes

- Updated dependencies [1c12289]
  - @cat-factory/contracts@0.175.0
  - @cat-factory/kernel@0.168.0
  - @cat-factory/agents@0.73.2
  - @cat-factory/sandbox-fixtures@0.7.206

## 0.9.157

### Patch Changes

- Updated dependencies [55747c5]
  - @cat-factory/contracts@0.174.0
  - @cat-factory/agents@0.73.1
  - @cat-factory/kernel@0.167.1
  - @cat-factory/sandbox-fixtures@0.7.205

## 0.9.156

### Patch Changes

- Updated dependencies [cab85c5]
  - @cat-factory/contracts@0.173.0
  - @cat-factory/agents@0.73.0
  - @cat-factory/kernel@0.167.0
  - @cat-factory/sandbox-fixtures@0.7.204

## 0.9.155

### Patch Changes

- Updated dependencies [8afa4ae]
  - @cat-factory/contracts@0.172.0
  - @cat-factory/kernel@0.166.0
  - @cat-factory/agents@0.72.3
  - @cat-factory/sandbox-fixtures@0.7.203

## 0.9.154

### Patch Changes

- Updated dependencies [200fb4d]
  - @cat-factory/kernel@0.165.1
  - @cat-factory/agents@0.72.2

## 0.9.153

### Patch Changes

- Updated dependencies [f0e9bab]
  - @cat-factory/contracts@0.171.0
  - @cat-factory/kernel@0.165.0
  - @cat-factory/agents@0.72.1
  - @cat-factory/sandbox-fixtures@0.7.202

## 0.9.152

### Patch Changes

- Updated dependencies [583fc80]
- Updated dependencies [640cadd]
  - @cat-factory/contracts@0.170.0
  - @cat-factory/kernel@0.164.0
  - @cat-factory/agents@0.72.0
  - @cat-factory/sandbox-fixtures@0.7.201

## 0.9.151

### Patch Changes

- Updated dependencies [968a214]
  - @cat-factory/contracts@0.169.0
  - @cat-factory/agents@0.71.0
  - @cat-factory/kernel@0.163.1
  - @cat-factory/sandbox-fixtures@0.7.200

## 0.9.150

### Patch Changes

- Updated dependencies [829a905]
- Updated dependencies [829a905]
  - @cat-factory/agents@0.70.1
  - @cat-factory/kernel@0.163.0

## 0.9.149

### Patch Changes

- Updated dependencies [c95600b]
  - @cat-factory/contracts@0.168.0
  - @cat-factory/agents@0.70.0
  - @cat-factory/kernel@0.162.0
  - @cat-factory/sandbox-fixtures@0.7.199

## 0.9.148

### Patch Changes

- Updated dependencies [df9ca7d]
  - @cat-factory/contracts@0.167.0
  - @cat-factory/kernel@0.161.0
  - @cat-factory/agents@0.69.10
  - @cat-factory/sandbox-fixtures@0.7.198

## 0.9.147

### Patch Changes

- Updated dependencies [600a8ad]
  - @cat-factory/kernel@0.160.0
  - @cat-factory/contracts@0.166.0
  - @cat-factory/agents@0.69.9
  - @cat-factory/sandbox-fixtures@0.7.197

## 0.9.146

### Patch Changes

- Updated dependencies [3949f82]
  - @cat-factory/contracts@0.165.0
  - @cat-factory/agents@0.69.8
  - @cat-factory/kernel@0.159.1
  - @cat-factory/sandbox-fixtures@0.7.196

## 0.9.145

### Patch Changes

- Updated dependencies [1f8ca48]
  - @cat-factory/kernel@0.159.0
  - @cat-factory/agents@0.69.7

## 0.9.144

### Patch Changes

- Updated dependencies [5a58b9d]
  - @cat-factory/contracts@0.164.0
  - @cat-factory/kernel@0.158.0
  - @cat-factory/agents@0.69.6
  - @cat-factory/sandbox-fixtures@0.7.195

## 0.9.143

### Patch Changes

- Updated dependencies [55e0a85]
  - @cat-factory/kernel@0.157.0
  - @cat-factory/contracts@0.163.0
  - @cat-factory/agents@0.69.5
  - @cat-factory/sandbox-fixtures@0.7.194

## 0.9.142

### Patch Changes

- Updated dependencies [ecd68c5]
  - @cat-factory/contracts@0.162.0
  - @cat-factory/kernel@0.156.0
  - @cat-factory/agents@0.69.4
  - @cat-factory/sandbox-fixtures@0.7.193

## 0.9.141

### Patch Changes

- Updated dependencies [7c6bd77]
  - @cat-factory/kernel@0.155.0
  - @cat-factory/contracts@0.161.0
  - @cat-factory/agents@0.69.3
  - @cat-factory/sandbox-fixtures@0.7.192

## 0.9.140

### Patch Changes

- Updated dependencies [0e2799e]
- Updated dependencies [239788a]
  - @cat-factory/kernel@0.154.2
  - @cat-factory/agents@0.69.2
  - @cat-factory/contracts@0.160.1
  - @cat-factory/sandbox-fixtures@0.7.191

## 0.9.139

### Patch Changes

- Updated dependencies [770f926]
  - @cat-factory/agents@0.69.1
  - @cat-factory/kernel@0.154.1

## 0.9.138

### Patch Changes

- Updated dependencies [ce1ce11]
  - @cat-factory/agents@0.69.0

## 0.9.137

### Patch Changes

- Updated dependencies [93496b0]
  - @cat-factory/kernel@0.154.0
  - @cat-factory/contracts@0.160.0
  - @cat-factory/agents@0.68.4
  - @cat-factory/sandbox-fixtures@0.7.190

## 0.9.136

### Patch Changes

- Updated dependencies [15249df]
  - @cat-factory/contracts@0.159.0
  - @cat-factory/kernel@0.153.0
  - @cat-factory/agents@0.68.3
  - @cat-factory/sandbox-fixtures@0.7.189

## 0.9.135

### Patch Changes

- Updated dependencies [8254367]
  - @cat-factory/agents@0.68.2

## 0.9.134

### Patch Changes

- Updated dependencies [2323df1]
  - @cat-factory/contracts@0.158.0
  - @cat-factory/kernel@0.152.0
  - @cat-factory/agents@0.68.1
  - @cat-factory/sandbox-fixtures@0.7.188

## 0.9.133

### Patch Changes

- Updated dependencies [71bd63f]
  - @cat-factory/contracts@0.157.0
  - @cat-factory/kernel@0.151.0
  - @cat-factory/agents@0.68.0
  - @cat-factory/sandbox-fixtures@0.7.187

## 0.9.132

### Patch Changes

- Updated dependencies [da0b83b]
  - @cat-factory/agents@0.67.9

## 0.9.131

### Patch Changes

- Updated dependencies [2cfae1e]
  - @cat-factory/agents@0.67.8

## 0.9.130

### Patch Changes

- Updated dependencies [3c7d62b]
- Updated dependencies [3c7d62b]
  - @cat-factory/contracts@0.156.0
  - @cat-factory/kernel@0.150.0
  - @cat-factory/agents@0.67.7
  - @cat-factory/sandbox-fixtures@0.7.186

## 0.9.129

### Patch Changes

- Updated dependencies [916278b]
  - @cat-factory/contracts@0.155.0
  - @cat-factory/kernel@0.149.0
  - @cat-factory/agents@0.67.6
  - @cat-factory/sandbox-fixtures@0.7.185

## 0.9.128

### Patch Changes

- Updated dependencies [1bcb223]
  - @cat-factory/kernel@0.148.5
  - @cat-factory/agents@0.67.5

## 0.9.127

### Patch Changes

- Updated dependencies [91ea6b7]
  - @cat-factory/contracts@0.154.2
  - @cat-factory/kernel@0.148.4
  - @cat-factory/agents@0.67.4
  - @cat-factory/sandbox-fixtures@0.7.184

## 0.9.126

### Patch Changes

- Updated dependencies [3999941]
  - @cat-factory/kernel@0.148.3
  - @cat-factory/agents@0.67.3

## 0.9.125

### Patch Changes

- @cat-factory/agents@0.67.2

## 0.9.124

### Patch Changes

- Updated dependencies [021f2a0]
- Updated dependencies [021f2a0]
  - @cat-factory/contracts@0.154.1
  - @cat-factory/kernel@0.148.2
  - @cat-factory/agents@0.67.1
  - @cat-factory/sandbox-fixtures@0.7.183

## 0.9.123

### Patch Changes

- Updated dependencies [a14fe03]
  - @cat-factory/contracts@0.154.0
  - @cat-factory/agents@0.67.0
  - @cat-factory/kernel@0.148.1
  - @cat-factory/sandbox-fixtures@0.7.182

## 0.9.122

### Patch Changes

- Updated dependencies [8053837]
  - @cat-factory/contracts@0.153.0
  - @cat-factory/kernel@0.148.0
  - @cat-factory/agents@0.66.7
  - @cat-factory/sandbox-fixtures@0.7.181

## 0.9.121

### Patch Changes

- Updated dependencies [511076d]
  - @cat-factory/kernel@0.147.3
  - @cat-factory/agents@0.66.6

## 0.9.120

### Patch Changes

- Updated dependencies [1614e62]
  - @cat-factory/agents@0.66.5

## 0.9.119

### Patch Changes

- Updated dependencies [7f54858]
  - @cat-factory/contracts@0.152.2
  - @cat-factory/kernel@0.147.2
  - @cat-factory/agents@0.66.4
  - @cat-factory/sandbox-fixtures@0.7.180

## 0.9.118

### Patch Changes

- Updated dependencies [972a1bd]
  - @cat-factory/agents@0.66.3

## 0.9.117

### Patch Changes

- Updated dependencies [492d0a2]
  - @cat-factory/kernel@0.147.1
  - @cat-factory/agents@0.66.2

## 0.9.116

### Patch Changes

- Updated dependencies [2d97b16]
  - @cat-factory/agents@0.66.1

## 0.9.115

### Patch Changes

- Updated dependencies [a10bfdf]
  - @cat-factory/kernel@0.147.0
  - @cat-factory/agents@0.66.0

## 0.9.114

### Patch Changes

- Updated dependencies [7aab031]
  - @cat-factory/agents@0.65.5

## 0.9.113

### Patch Changes

- Updated dependencies [f2b25ba]
  - @cat-factory/kernel@0.146.0
  - @cat-factory/contracts@0.152.1
  - @cat-factory/agents@0.65.4
  - @cat-factory/sandbox-fixtures@0.7.179

## 0.9.112

### Patch Changes

- Updated dependencies [e679977]
  - @cat-factory/contracts@0.152.0
  - @cat-factory/agents@0.65.3
  - @cat-factory/kernel@0.145.1
  - @cat-factory/sandbox-fixtures@0.7.178

## 0.9.111

### Patch Changes

- Updated dependencies [9450415]
  - @cat-factory/contracts@0.151.0
  - @cat-factory/kernel@0.145.0
  - @cat-factory/agents@0.65.2
  - @cat-factory/sandbox-fixtures@0.7.177

## 0.9.110

### Patch Changes

- Updated dependencies [54c44bb]
  - @cat-factory/contracts@0.150.0
  - @cat-factory/kernel@0.144.0
  - @cat-factory/agents@0.65.1
  - @cat-factory/sandbox-fixtures@0.7.176

## 0.9.109

### Patch Changes

- Updated dependencies [0abcf31]
- Updated dependencies [6709dc4]
- Updated dependencies [a53bbf7]
  - @cat-factory/contracts@0.149.0
  - @cat-factory/kernel@0.143.0
  - @cat-factory/agents@0.65.0
  - @cat-factory/sandbox-fixtures@0.7.175

## 0.9.108

### Patch Changes

- Updated dependencies [5771e05]
  - @cat-factory/kernel@0.142.0
  - @cat-factory/agents@0.64.2

## 0.9.107

### Patch Changes

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0
  - @cat-factory/agents@0.64.1

## 0.9.106

### Patch Changes

- Updated dependencies [37c642f]
  - @cat-factory/agents@0.64.0

## 0.9.105

### Patch Changes

- Updated dependencies [ea64461]
  - @cat-factory/agents@0.63.0

## 0.9.104

### Patch Changes

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1
  - @cat-factory/agents@0.62.13

## 0.9.103

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0
  - @cat-factory/contracts@0.148.1
  - @cat-factory/agents@0.62.12
  - @cat-factory/sandbox-fixtures@0.7.174

## 0.9.102

### Patch Changes

- Updated dependencies [efa3345]
  - @cat-factory/agents@0.62.11
  - @cat-factory/kernel@0.139.3

## 0.9.101

### Patch Changes

- Updated dependencies [1f5f5bc]
  - @cat-factory/contracts@0.148.0
  - @cat-factory/agents@0.62.10
  - @cat-factory/kernel@0.139.2
  - @cat-factory/sandbox-fixtures@0.7.173

## 0.9.100

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/contracts@0.147.1
  - @cat-factory/kernel@0.139.1
  - @cat-factory/agents@0.62.9
  - @cat-factory/sandbox-fixtures@0.7.172

## 0.9.99

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/contracts@0.147.0
  - @cat-factory/kernel@0.139.0
  - @cat-factory/agents@0.62.8
  - @cat-factory/sandbox-fixtures@0.7.171

## 0.9.98

### Patch Changes

- Updated dependencies [60c0a1e]
  - @cat-factory/contracts@0.146.0
  - @cat-factory/agents@0.62.7
  - @cat-factory/kernel@0.138.1
  - @cat-factory/sandbox-fixtures@0.7.170

## 0.9.97

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/contracts@0.145.0
  - @cat-factory/kernel@0.138.0
  - @cat-factory/agents@0.62.6
  - @cat-factory/sandbox-fixtures@0.7.169

## 0.9.96

### Patch Changes

- Updated dependencies [5924903]
  - @cat-factory/contracts@0.144.0
  - @cat-factory/agents@0.62.5
  - @cat-factory/kernel@0.137.1
  - @cat-factory/sandbox-fixtures@0.7.168

## 0.9.95

### Patch Changes

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0
  - @cat-factory/agents@0.62.4

## 0.9.94

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/contracts@0.143.0
  - @cat-factory/kernel@0.136.0
  - @cat-factory/agents@0.62.3
  - @cat-factory/sandbox-fixtures@0.7.167

## 0.9.93

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0
  - @cat-factory/contracts@0.142.0
  - @cat-factory/agents@0.62.2
  - @cat-factory/sandbox-fixtures@0.7.166

## 0.9.92

### Patch Changes

- Updated dependencies [e618bf5]
  - @cat-factory/contracts@0.141.0
  - @cat-factory/agents@0.62.1
  - @cat-factory/kernel@0.134.1
  - @cat-factory/sandbox-fixtures@0.7.165

## 0.9.91

### Patch Changes

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/contracts@0.140.0
  - @cat-factory/kernel@0.134.0
  - @cat-factory/agents@0.62.0
  - @cat-factory/sandbox-fixtures@0.7.164

## 0.9.90

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0
  - @cat-factory/contracts@0.139.0
  - @cat-factory/agents@0.61.2
  - @cat-factory/sandbox-fixtures@0.7.163

## 0.9.89

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/contracts@0.138.0
  - @cat-factory/kernel@0.132.0
  - @cat-factory/agents@0.61.1
  - @cat-factory/sandbox-fixtures@0.7.162

## 0.9.88

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/kernel@0.131.0
  - @cat-factory/contracts@0.137.0
  - @cat-factory/agents@0.61.0
  - @cat-factory/sandbox-fixtures@0.7.161

## 0.9.87

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/contracts@0.136.0
  - @cat-factory/kernel@0.130.0
  - @cat-factory/agents@0.60.0
  - @cat-factory/sandbox-fixtures@0.7.160

## 0.9.86

### Patch Changes

- Updated dependencies [06a094a]
  - @cat-factory/contracts@0.135.0
  - @cat-factory/agents@0.59.2
  - @cat-factory/kernel@0.129.2
  - @cat-factory/sandbox-fixtures@0.7.159

## 0.9.85

### Patch Changes

- Updated dependencies [6108525]
  - @cat-factory/kernel@0.129.1
  - @cat-factory/agents@0.59.1

## 0.9.84

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/agents@0.59.0
  - @cat-factory/kernel@0.129.0
  - @cat-factory/contracts@0.134.0
  - @cat-factory/sandbox-fixtures@0.7.158

## 0.9.83

### Patch Changes

- Updated dependencies [9e9127f]
  - @cat-factory/contracts@0.133.0
  - @cat-factory/agents@0.58.1
  - @cat-factory/kernel@0.128.1
  - @cat-factory/sandbox-fixtures@0.7.157

## 0.9.82

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0
  - @cat-factory/contracts@0.132.0
  - @cat-factory/agents@0.58.0
  - @cat-factory/sandbox-fixtures@0.7.156

## 0.9.81

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/contracts@0.131.0
  - @cat-factory/kernel@0.127.0
  - @cat-factory/agents@0.57.0
  - @cat-factory/sandbox-fixtures@0.7.155

## 0.9.80

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/contracts@0.130.0
  - @cat-factory/kernel@0.126.0
  - @cat-factory/agents@0.56.0
  - @cat-factory/sandbox-fixtures@0.7.154

## 0.9.79

### Patch Changes

- Updated dependencies [f7e7139]
- Updated dependencies [5fa0a8e]
  - @cat-factory/contracts@0.129.0
  - @cat-factory/kernel@0.125.0
  - @cat-factory/agents@0.55.0
  - @cat-factory/sandbox-fixtures@0.7.153

## 0.9.78

### Patch Changes

- Updated dependencies [e5cd022]
  - @cat-factory/kernel@0.124.0
  - @cat-factory/agents@0.54.12

## 0.9.77

### Patch Changes

- Updated dependencies [6c4bcef]
  - @cat-factory/contracts@0.128.2
  - @cat-factory/kernel@0.123.3
  - @cat-factory/agents@0.54.11
  - @cat-factory/sandbox-fixtures@0.7.152

## 0.9.76

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/kernel@0.123.2
  - @cat-factory/contracts@0.128.1
  - @cat-factory/agents@0.54.10
  - @cat-factory/sandbox-fixtures@0.7.151

## 0.9.75

### Patch Changes

- Updated dependencies [2c7ca2e]
  - @cat-factory/kernel@0.123.1
  - @cat-factory/agents@0.54.9

## 0.9.74

### Patch Changes

- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0
  - @cat-factory/agents@0.54.8

## 0.9.73

### Patch Changes

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/contracts@0.128.0
  - @cat-factory/kernel@0.122.0
  - @cat-factory/agents@0.54.7
  - @cat-factory/sandbox-fixtures@0.7.150

## 0.9.72

### Patch Changes

- Updated dependencies [2a13ece]
  - @cat-factory/kernel@0.121.8
  - @cat-factory/agents@0.54.6

## 0.9.71

### Patch Changes

- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7
  - @cat-factory/agents@0.54.5

## 0.9.70

### Patch Changes

- Updated dependencies [67dccb6]
  - @cat-factory/kernel@0.121.6
  - @cat-factory/agents@0.54.4

## 0.9.69

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
  - @cat-factory/agents@0.54.3
  - @cat-factory/contracts@0.127.1
  - @cat-factory/kernel@0.121.5
  - @cat-factory/sandbox-fixtures@0.7.149

## 0.9.68

### Patch Changes

- Updated dependencies [4810353]
  - @cat-factory/kernel@0.121.4
  - @cat-factory/agents@0.54.2

## 0.9.67

### Patch Changes

- Updated dependencies [edad6e6]
  - @cat-factory/kernel@0.121.3
  - @cat-factory/agents@0.54.1

## 0.9.66

### Patch Changes

- Updated dependencies [d1a4129]
  - @cat-factory/contracts@0.127.0
  - @cat-factory/agents@0.54.0
  - @cat-factory/kernel@0.121.2
  - @cat-factory/sandbox-fixtures@0.7.148

## 0.9.65

### Patch Changes

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1
  - @cat-factory/agents@0.53.6

## 0.9.64

### Patch Changes

- Updated dependencies [f4482c7]
  - @cat-factory/kernel@0.121.0
  - @cat-factory/agents@0.53.5

## 0.9.63

### Patch Changes

- Updated dependencies [cc6d554]
  - @cat-factory/agents@0.53.4

## 0.9.62

### Patch Changes

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0
  - @cat-factory/agents@0.53.3

## 0.9.61

### Patch Changes

- Updated dependencies [a5dcf7d]
  - @cat-factory/kernel@0.119.0
  - @cat-factory/agents@0.53.2

## 0.9.60

### Patch Changes

- Updated dependencies [5072999]
  - @cat-factory/contracts@0.126.0
  - @cat-factory/agents@0.53.1
  - @cat-factory/kernel@0.118.1
  - @cat-factory/sandbox-fixtures@0.7.147

## 0.9.59

### Patch Changes

- Updated dependencies [4f936de]
  - @cat-factory/contracts@0.125.0
  - @cat-factory/kernel@0.118.0
  - @cat-factory/agents@0.53.0
  - @cat-factory/sandbox-fixtures@0.7.146

## 0.9.58

### Patch Changes

- Updated dependencies [127fe3e]
  - @cat-factory/contracts@0.124.1
  - @cat-factory/kernel@0.117.6
  - @cat-factory/agents@0.52.9
  - @cat-factory/sandbox-fixtures@0.7.145

## 0.9.57

### Patch Changes

- Updated dependencies [774908c]
  - @cat-factory/kernel@0.117.5
  - @cat-factory/agents@0.52.8

## 0.9.56

### Patch Changes

- Updated dependencies [08a7da2]
  - @cat-factory/contracts@0.124.0
  - @cat-factory/kernel@0.117.4
  - @cat-factory/agents@0.52.7
  - @cat-factory/sandbox-fixtures@0.7.144

## 0.9.55

### Patch Changes

- Updated dependencies [6b968bb]
  - @cat-factory/kernel@0.117.3
  - @cat-factory/agents@0.52.6

## 0.9.54

### Patch Changes

- Updated dependencies [eeadc97]
  - @cat-factory/kernel@0.117.2
  - @cat-factory/contracts@0.123.1
  - @cat-factory/agents@0.52.5
  - @cat-factory/sandbox-fixtures@0.7.143

## 0.9.53

### Patch Changes

- Updated dependencies [cb7fd14]
  - @cat-factory/kernel@0.117.1
  - @cat-factory/agents@0.52.4

## 0.9.52

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0
  - @cat-factory/agents@0.52.3

## 0.9.51

### Patch Changes

- Updated dependencies [51869b8]
  - @cat-factory/kernel@0.116.0
  - @cat-factory/agents@0.52.2

## 0.9.50

### Patch Changes

- Updated dependencies [a51a498]
  - @cat-factory/kernel@0.115.1
  - @cat-factory/agents@0.52.1

## 0.9.49

### Patch Changes

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/contracts@0.123.0
  - @cat-factory/kernel@0.115.0
  - @cat-factory/agents@0.52.0
  - @cat-factory/sandbox-fixtures@0.7.142

## 0.9.48

### Patch Changes

- Updated dependencies [0f3c88b]
  - @cat-factory/contracts@0.122.0
  - @cat-factory/kernel@0.114.0
  - @cat-factory/agents@0.51.0
  - @cat-factory/sandbox-fixtures@0.7.141

## 0.9.47

### Patch Changes

- Updated dependencies [ed77be6]
  - @cat-factory/kernel@0.113.0
  - @cat-factory/agents@0.50.0
  - @cat-factory/contracts@0.121.2
  - @cat-factory/sandbox-fixtures@0.7.140

## 0.9.46

### Patch Changes

- Updated dependencies [7ee2530]
  - @cat-factory/agents@0.49.3
  - @cat-factory/kernel@0.112.1

## 0.9.45

### Patch Changes

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0
  - @cat-factory/agents@0.49.2

## 0.9.44

### Patch Changes

- Updated dependencies [9aa9e19]
  - @cat-factory/contracts@0.121.1
  - @cat-factory/agents@0.49.1
  - @cat-factory/kernel@0.111.1
  - @cat-factory/sandbox-fixtures@0.7.139

## 0.9.43

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/kernel@0.111.0
  - @cat-factory/agents@0.49.0
  - @cat-factory/contracts@0.121.0
  - @cat-factory/sandbox-fixtures@0.7.138

## 0.9.42

### Patch Changes

- Updated dependencies [bcc843d]
  - @cat-factory/agents@0.48.5
  - @cat-factory/kernel@0.110.1

## 0.9.41

### Patch Changes

- Updated dependencies [a2db337]
- Updated dependencies [a2db337]
  - @cat-factory/agents@0.48.4
  - @cat-factory/contracts@0.120.0
  - @cat-factory/kernel@0.110.0
  - @cat-factory/sandbox-fixtures@0.7.137

## 0.9.40

### Patch Changes

- Updated dependencies [35636d5]
  - @cat-factory/agents@0.48.3

## 0.9.39

### Patch Changes

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1
  - @cat-factory/agents@0.48.2

## 0.9.38

### Patch Changes

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
  - @cat-factory/contracts@0.119.0
  - @cat-factory/kernel@0.109.0
  - @cat-factory/agents@0.48.1
  - @cat-factory/sandbox-fixtures@0.7.136

## 0.9.37

### Patch Changes

- Updated dependencies [4775c40]
  - @cat-factory/agents@0.48.0

## 0.9.36

### Patch Changes

- Updated dependencies [f97d5d3]
  - @cat-factory/agents@0.47.0

## 0.9.35

### Patch Changes

- Updated dependencies [cb088c7]
  - @cat-factory/agents@0.46.0

## 0.9.34

### Patch Changes

- Updated dependencies [09a1c85]
  - @cat-factory/agents@0.45.0

## 0.9.33

### Patch Changes

- Updated dependencies [785576b]
  - @cat-factory/agents@0.44.1

## 0.9.32

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/agents@0.44.0
  - @cat-factory/kernel@0.108.0

## 0.9.31

### Patch Changes

- @cat-factory/agents@0.43.1

## 0.9.30

### Patch Changes

- Updated dependencies [44fafa4]
  - @cat-factory/kernel@0.107.0
  - @cat-factory/agents@0.43.0

## 0.9.29

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/agents@0.42.0
  - @cat-factory/kernel@0.106.0

## 0.9.28

### Patch Changes

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/agents@0.41.0
  - @cat-factory/kernel@0.105.0
  - @cat-factory/contracts@0.118.0
  - @cat-factory/sandbox-fixtures@0.7.135

## 0.9.27

### Patch Changes

- Updated dependencies [4a3e536]
  - @cat-factory/contracts@0.117.0
  - @cat-factory/agents@0.40.13
  - @cat-factory/kernel@0.104.4
  - @cat-factory/sandbox-fixtures@0.7.134

## 0.9.26

### Patch Changes

- Updated dependencies [18a9cb5]
  - @cat-factory/contracts@0.116.1
  - @cat-factory/agents@0.40.12
  - @cat-factory/kernel@0.104.3
  - @cat-factory/sandbox-fixtures@0.7.133

## 0.9.25

### Patch Changes

- Updated dependencies [bc77f89]
  - @cat-factory/contracts@0.116.0
  - @cat-factory/kernel@0.104.2
  - @cat-factory/agents@0.40.11
  - @cat-factory/sandbox-fixtures@0.7.132

## 0.9.24

### Patch Changes

- Updated dependencies [802fc05]
  - @cat-factory/contracts@0.115.0
  - @cat-factory/agents@0.40.10
  - @cat-factory/kernel@0.104.1
  - @cat-factory/sandbox-fixtures@0.7.131

## 0.9.23

### Patch Changes

- Updated dependencies [6198b08]
- Updated dependencies [37d1517]
  - @cat-factory/contracts@0.114.0
  - @cat-factory/kernel@0.104.0
  - @cat-factory/agents@0.40.9
  - @cat-factory/sandbox-fixtures@0.7.130

## 0.9.22

### Patch Changes

- Updated dependencies [14eac27]
  - @cat-factory/contracts@0.113.0
  - @cat-factory/kernel@0.103.0
  - @cat-factory/agents@0.40.8
  - @cat-factory/sandbox-fixtures@0.7.129

## 0.9.21

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/contracts@0.112.0
  - @cat-factory/kernel@0.102.0
  - @cat-factory/agents@0.40.7
  - @cat-factory/sandbox-fixtures@0.7.128

## 0.9.20

### Patch Changes

- Updated dependencies [fdba1ea]
  - @cat-factory/contracts@0.111.0
  - @cat-factory/agents@0.40.6
  - @cat-factory/kernel@0.101.2
  - @cat-factory/sandbox-fixtures@0.7.127

## 0.9.19

### Patch Changes

- Updated dependencies [10787c4]
  - @cat-factory/contracts@0.110.1
  - @cat-factory/kernel@0.101.1
  - @cat-factory/agents@0.40.5
  - @cat-factory/sandbox-fixtures@0.7.126

## 0.9.18

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/contracts@0.110.0
  - @cat-factory/kernel@0.101.0
  - @cat-factory/agents@0.40.4
  - @cat-factory/sandbox-fixtures@0.7.125

## 0.9.17

### Patch Changes

- Updated dependencies [9ea1e77]
  - @cat-factory/contracts@0.109.0
  - @cat-factory/kernel@0.100.0
  - @cat-factory/agents@0.40.3
  - @cat-factory/sandbox-fixtures@0.7.124

## 0.9.16

### Patch Changes

- Updated dependencies [e66accb]
  - @cat-factory/contracts@0.108.1
  - @cat-factory/agents@0.40.2
  - @cat-factory/kernel@0.99.1
  - @cat-factory/sandbox-fixtures@0.7.123

## 0.9.15

### Patch Changes

- Updated dependencies [1afa003]
- Updated dependencies [f91b99d]
  - @cat-factory/kernel@0.99.0
  - @cat-factory/contracts@0.108.0
  - @cat-factory/agents@0.40.1
  - @cat-factory/sandbox-fixtures@0.7.122

## 0.9.14

### Patch Changes

- Updated dependencies [bf31df7]
  - @cat-factory/contracts@0.107.0
  - @cat-factory/agents@0.40.0
  - @cat-factory/kernel@0.98.0
  - @cat-factory/sandbox-fixtures@0.7.121

## 0.9.13

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/contracts@0.106.0
  - @cat-factory/kernel@0.97.0
  - @cat-factory/agents@0.39.4
  - @cat-factory/sandbox-fixtures@0.7.120

## 0.9.12

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [e5b9462]
- Updated dependencies [dd6df12]
  - @cat-factory/contracts@0.105.0
  - @cat-factory/kernel@0.96.0
  - @cat-factory/agents@0.39.3
  - @cat-factory/sandbox-fixtures@0.7.119

## 0.9.11

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/contracts@0.104.0
  - @cat-factory/kernel@0.95.0
  - @cat-factory/agents@0.39.2
  - @cat-factory/sandbox-fixtures@0.7.118

## 0.9.10

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/contracts@0.103.0
  - @cat-factory/kernel@0.94.0
  - @cat-factory/agents@0.39.1
  - @cat-factory/sandbox-fixtures@0.7.117

## 0.9.9

### Patch Changes

- Updated dependencies [77bc73c]
- Updated dependencies [076d02f]
  - @cat-factory/agents@0.39.0
  - @cat-factory/kernel@0.93.0
  - @cat-factory/contracts@0.102.0
  - @cat-factory/sandbox-fixtures@0.7.116

## 0.9.8

### Patch Changes

- Updated dependencies [029a689]
- Updated dependencies [029a689]
  - @cat-factory/contracts@0.101.1
  - @cat-factory/kernel@0.92.0
  - @cat-factory/agents@0.38.2
  - @cat-factory/sandbox-fixtures@0.7.115

## 0.9.7

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/contracts@0.101.0
  - @cat-factory/kernel@0.91.0
  - @cat-factory/agents@0.38.1
  - @cat-factory/sandbox-fixtures@0.7.114

## 0.9.6

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/contracts@0.100.0
  - @cat-factory/kernel@0.90.0
  - @cat-factory/agents@0.38.0
  - @cat-factory/sandbox-fixtures@0.7.113

## 0.9.5

### Patch Changes

- Updated dependencies [3981bbb]
  - @cat-factory/contracts@0.99.0
  - @cat-factory/agents@0.37.2
  - @cat-factory/kernel@0.89.1
  - @cat-factory/sandbox-fixtures@0.7.112

## 0.9.4

### Patch Changes

- Updated dependencies [cfcb6c7]
- Updated dependencies [48f9d97]
  - @cat-factory/kernel@0.89.0
  - @cat-factory/contracts@0.98.0
  - @cat-factory/agents@0.37.1
  - @cat-factory/sandbox-fixtures@0.7.111

## 0.9.3

### Patch Changes

- Updated dependencies [f4c321e]
  - @cat-factory/kernel@0.88.0
  - @cat-factory/agents@0.37.0

## 0.9.2

### Patch Changes

- Updated dependencies [13a284f]
  - @cat-factory/kernel@0.87.0
  - @cat-factory/agents@0.36.0

## 0.9.1

### Patch Changes

- Updated dependencies [102c049]
  - @cat-factory/contracts@0.97.0
  - @cat-factory/agents@0.35.0
  - @cat-factory/kernel@0.86.1
  - @cat-factory/sandbox-fixtures@0.7.110

## 0.9.0

### Minor Changes

- 49b498a: Registry DI migration — the agent-kind registry becomes app-owned (no module global).

  Continues the [registry-DI initiative](docs/initiatives/registry-di-migration.md): the
  plugin-style agent-kind registry (`registerAgentKind` into a module-level `Map`) is replaced by
  an app-owned **`AgentKindRegistry`** instance the composition root news once
  (`defaultAgentKindRegistry()`, pre-loaded with the built-in `bug-investigator` / document /
  initiative kinds), threads through the single `CoreDependencies` object, and re-exposes on the
  `Core` + `ServerContainer` for the HTTP snapshot projection. Module identity stops mattering, the
  external-adapter "phantom Map" gotcha is gone, and tests get a fresh instance instead of
  `clearRegisteredAgentKinds()`. This also fixes the phase-F worker-shard conformance flake at its
  root: the shared suite's `clearRegisteredAgentKinds()` used to wipe the built-in kinds for the
  rest of a single-module run.

  **BREAKING** — the free module-global seams are removed from `@cat-factory/agents` (and the
  facade re-exports): `registerAgentKind`/`registerAgentKinds`, `registered*` (`registeredAgentKind`,
  `registeredAgentStep`, `registeredKindRequiresContainer`, `registeredSystemPrompt`,
  `registeredUserPrompt`, `registeredConfigContributions`, `registeredPreOps`, `registeredPostOps`,
  `registeredAgentPresentation`, `registeredStructuredOutput`, `registeredWebResearchHint`,
  `registeredAgentTuning`, `registeredAgentKinds`), and `clearRegisteredAgentKinds`. Instead export
  the `AgentKindRegistry` class + `defaultAgentKindRegistry()` factory; the pure prompt/catalog fns
  (`systemPromptFor`/`userPromptFor`/`traitsFor`/`hasTrait`/`agentTuningFor`/`configContributionsFor`/
  `configContributionCatalog`/`webResearchGuidanceFor`/`isInlineModelStep`) now take a `registry`
  argument, and a deployment registers custom kinds **by reference** on the instance it injects into
  `buildContainer` / `start()` / `startLocal()` (the `agentKindRegistry` seam), exactly like the
  backend-registries pilot. The runtimes stay symmetric and the cross-runtime conformance suite
  injects a pre-loaded registry to assert a custom kind resolves identically on every facade.

  Also fixes a warm-pool bug in the executor-harness: the read-only multi-repo explore fan-out
  (`runExploreMode`) was gated on `!job.persistentCheckout`, so a `bug-investigator` dispatched to a
  warm local pool (which injects `persistentCheckout: true` on every job) silently dropped its peer
  repos and only saw the primary. The guard is dropped — `runMultiRepoExplore` uses its own
  ephemeral workspace, so the flag is harmlessly ignored.

### Patch Changes

- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/contracts@0.96.0
  - @cat-factory/kernel@0.86.0
  - @cat-factory/agents@0.34.0
  - @cat-factory/sandbox-fixtures@0.7.109

## 0.8.104

### Patch Changes

- Updated dependencies [1f6d9fc]
  - @cat-factory/kernel@0.85.0
  - @cat-factory/agents@0.33.1

## 0.8.103

### Patch Changes

- Updated dependencies [8eaa3f2]
  - @cat-factory/agents@0.33.0

## 0.8.102

### Patch Changes

- Updated dependencies [e5ddaa4]
- Updated dependencies [6213771]
  - @cat-factory/kernel@0.84.0
  - @cat-factory/agents@0.32.0

## 0.8.101

### Patch Changes

- Updated dependencies [9bac054]
  - @cat-factory/kernel@0.83.0
  - @cat-factory/agents@0.31.0

## 0.8.100

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/contracts@0.95.0
  - @cat-factory/kernel@0.82.0
  - @cat-factory/agents@0.30.5
  - @cat-factory/sandbox-fixtures@0.7.108

## 0.8.99

### Patch Changes

- Updated dependencies [6edcce0]
  - @cat-factory/contracts@0.94.0
  - @cat-factory/kernel@0.81.0
  - @cat-factory/agents@0.30.4
  - @cat-factory/sandbox-fixtures@0.7.107

## 0.8.98

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/contracts@0.93.0
  - @cat-factory/kernel@0.80.0
  - @cat-factory/agents@0.30.3
  - @cat-factory/sandbox-fixtures@0.7.106

## 0.8.97

### Patch Changes

- Updated dependencies [1d738f7]
  - @cat-factory/contracts@0.92.0
  - @cat-factory/agents@0.30.2
  - @cat-factory/kernel@0.79.1
  - @cat-factory/sandbox-fixtures@0.7.105

## 0.8.96

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/contracts@0.91.0
  - @cat-factory/kernel@0.79.0
  - @cat-factory/agents@0.30.1
  - @cat-factory/sandbox-fixtures@0.7.104

## 0.8.95

### Patch Changes

- Updated dependencies [b928904]
  - @cat-factory/contracts@0.90.0
  - @cat-factory/kernel@0.78.0
  - @cat-factory/agents@0.30.0
  - @cat-factory/sandbox-fixtures@0.7.103

## 0.8.94

### Patch Changes

- Updated dependencies [7fa7578]
  - @cat-factory/contracts@0.89.0
  - @cat-factory/kernel@0.77.0
  - @cat-factory/agents@0.29.1
  - @cat-factory/sandbox-fixtures@0.7.102

## 0.8.93

### Patch Changes

- Updated dependencies [55661f4]
  - @cat-factory/contracts@0.88.0
  - @cat-factory/kernel@0.76.0
  - @cat-factory/agents@0.29.0
  - @cat-factory/sandbox-fixtures@0.7.101

## 0.8.92

### Patch Changes

- Updated dependencies [ca5c3e8]
  - @cat-factory/contracts@0.87.0
  - @cat-factory/kernel@0.75.0
  - @cat-factory/agents@0.28.0
  - @cat-factory/sandbox-fixtures@0.7.100

## 0.8.91

### Patch Changes

- Updated dependencies [cc924a9]
  - @cat-factory/agents@0.27.1

## 0.8.90

### Patch Changes

- Updated dependencies [b216fdc]
  - @cat-factory/kernel@0.74.0
  - @cat-factory/contracts@0.86.0
  - @cat-factory/agents@0.27.0
  - @cat-factory/sandbox-fixtures@0.7.99

## 0.8.89

### Patch Changes

- Updated dependencies [7fd6a19]
  - @cat-factory/kernel@0.73.0
  - @cat-factory/agents@0.26.18

## 0.8.88

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/contracts@0.85.0
  - @cat-factory/kernel@0.72.0
  - @cat-factory/agents@0.26.17
  - @cat-factory/sandbox-fixtures@0.7.98

## 0.8.87

### Patch Changes

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
  - @cat-factory/contracts@0.84.0
  - @cat-factory/kernel@0.71.0
  - @cat-factory/agents@0.26.16
  - @cat-factory/sandbox-fixtures@0.7.97

## 0.8.86

### Patch Changes

- Updated dependencies [e0aab3f]
  - @cat-factory/contracts@0.83.0
  - @cat-factory/kernel@0.70.2
  - @cat-factory/agents@0.26.15
  - @cat-factory/sandbox-fixtures@0.7.96

## 0.8.85

### Patch Changes

- Updated dependencies [0d51638]
  - @cat-factory/kernel@0.70.1
  - @cat-factory/agents@0.26.14

## 0.8.84

### Patch Changes

- Updated dependencies [eb67d40]
  - @cat-factory/kernel@0.70.0
  - @cat-factory/agents@0.26.13

## 0.8.83

### Patch Changes

- Updated dependencies [5ce03c6]
  - @cat-factory/contracts@0.82.0
  - @cat-factory/agents@0.26.12
  - @cat-factory/kernel@0.69.8
  - @cat-factory/sandbox-fixtures@0.7.95

## 0.8.82

### Patch Changes

- Updated dependencies [7f9d215]
  - @cat-factory/kernel@0.69.7
  - @cat-factory/agents@0.26.11

## 0.8.81

### Patch Changes

- Updated dependencies [4955639]
  - @cat-factory/agents@0.26.10

## 0.8.80

### Patch Changes

- Updated dependencies [4a7a3f1]
  - @cat-factory/contracts@0.81.3
  - @cat-factory/agents@0.26.9
  - @cat-factory/kernel@0.69.6
  - @cat-factory/sandbox-fixtures@0.7.94

## 0.8.79

### Patch Changes

- Updated dependencies [6243bea]
  - @cat-factory/contracts@0.81.2
  - @cat-factory/agents@0.26.8
  - @cat-factory/kernel@0.69.5
  - @cat-factory/sandbox-fixtures@0.7.93

## 0.8.78

### Patch Changes

- Updated dependencies [fc8df61]
  - @cat-factory/agents@0.26.7

## 0.8.77

### Patch Changes

- Updated dependencies [2a91615]
  - @cat-factory/contracts@0.81.1
  - @cat-factory/agents@0.26.6
  - @cat-factory/kernel@0.69.4
  - @cat-factory/sandbox-fixtures@0.7.92

## 0.8.76

### Patch Changes

- Updated dependencies [67d3876]
  - @cat-factory/contracts@0.81.0
  - @cat-factory/agents@0.26.5
  - @cat-factory/kernel@0.69.3
  - @cat-factory/sandbox-fixtures@0.7.91

## 0.8.75

### Patch Changes

- Updated dependencies [d7f6e1c]
- Updated dependencies [63cf6de]
  - @cat-factory/kernel@0.69.2
  - @cat-factory/contracts@0.80.1
  - @cat-factory/agents@0.26.4
  - @cat-factory/sandbox-fixtures@0.7.90

## 0.8.74

### Patch Changes

- Updated dependencies [120de05]
  - @cat-factory/contracts@0.80.0
  - @cat-factory/kernel@0.69.1
  - @cat-factory/agents@0.26.3
  - @cat-factory/sandbox-fixtures@0.7.89

## 0.8.73

### Patch Changes

- Updated dependencies [dcc8b32]
  - @cat-factory/contracts@0.79.0
  - @cat-factory/kernel@0.69.0
  - @cat-factory/agents@0.26.2
  - @cat-factory/sandbox-fixtures@0.7.88

## 0.8.72

### Patch Changes

- Updated dependencies [16ee6cc]
  - @cat-factory/contracts@0.78.1
  - @cat-factory/kernel@0.68.1
  - @cat-factory/agents@0.26.1
  - @cat-factory/sandbox-fixtures@0.7.87

## 0.8.71

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/contracts@0.78.0
  - @cat-factory/kernel@0.68.0
  - @cat-factory/agents@0.26.0
  - @cat-factory/sandbox-fixtures@0.7.86

## 0.8.70

### Patch Changes

- Updated dependencies [9e93fe8]
- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [edf4e69]
- Updated dependencies [f21279e]
- Updated dependencies [6c51e31]
- Updated dependencies [33687cf]
  - @cat-factory/contracts@0.77.0
  - @cat-factory/kernel@0.67.0
  - @cat-factory/agents@0.25.0
  - @cat-factory/sandbox-fixtures@0.7.85

## 0.8.69

### Patch Changes

- Updated dependencies [762fe66]
  - @cat-factory/contracts@0.76.0
  - @cat-factory/agents@0.24.16
  - @cat-factory/kernel@0.66.1
  - @cat-factory/sandbox-fixtures@0.7.84

## 0.8.68

### Patch Changes

- Updated dependencies [fb53662]
  - @cat-factory/kernel@0.66.0
  - @cat-factory/contracts@0.75.0
  - @cat-factory/agents@0.24.15
  - @cat-factory/sandbox-fixtures@0.7.83

## 0.8.67

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/contracts@0.74.0
  - @cat-factory/kernel@0.65.0
  - @cat-factory/agents@0.24.14
  - @cat-factory/sandbox-fixtures@0.7.82

## 0.8.66

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/contracts@0.73.0
  - @cat-factory/kernel@0.64.0
  - @cat-factory/agents@0.24.13
  - @cat-factory/sandbox-fixtures@0.7.81

## 0.8.65

### Patch Changes

- Updated dependencies [70e321b]
  - @cat-factory/contracts@0.72.0
  - @cat-factory/agents@0.24.12
  - @cat-factory/kernel@0.63.4
  - @cat-factory/sandbox-fixtures@0.7.80

## 0.8.64

### Patch Changes

- Updated dependencies [77c6842]
  - @cat-factory/contracts@0.71.0
  - @cat-factory/agents@0.24.11
  - @cat-factory/kernel@0.63.3
  - @cat-factory/sandbox-fixtures@0.7.79

## 0.8.63

### Patch Changes

- Updated dependencies [2e1354f]
  - @cat-factory/contracts@0.70.1
  - @cat-factory/kernel@0.63.2
  - @cat-factory/agents@0.24.10
  - @cat-factory/sandbox-fixtures@0.7.78

## 0.8.62

### Patch Changes

- Updated dependencies [b4c7e60]
  - @cat-factory/contracts@0.70.0
  - @cat-factory/agents@0.24.9
  - @cat-factory/kernel@0.63.1
  - @cat-factory/sandbox-fixtures@0.7.77

## 0.8.61

### Patch Changes

- Updated dependencies [f568a8c]
  - @cat-factory/kernel@0.63.0
  - @cat-factory/contracts@0.69.0
  - @cat-factory/agents@0.24.8
  - @cat-factory/sandbox-fixtures@0.7.76

## 0.8.60

### Patch Changes

- Updated dependencies [41203db]
  - @cat-factory/contracts@0.68.0
  - @cat-factory/agents@0.24.7
  - @cat-factory/kernel@0.62.4
  - @cat-factory/sandbox-fixtures@0.7.75

## 0.8.59

### Patch Changes

- Updated dependencies [cb9e2e3]
  - @cat-factory/contracts@0.67.0
  - @cat-factory/agents@0.24.6
  - @cat-factory/kernel@0.62.3
  - @cat-factory/sandbox-fixtures@0.7.74

## 0.8.58

### Patch Changes

- Updated dependencies [1e55e77]
  - @cat-factory/contracts@0.66.1
  - @cat-factory/agents@0.24.5
  - @cat-factory/kernel@0.62.2
  - @cat-factory/sandbox-fixtures@0.7.73

## 0.8.57

### Patch Changes

- Updated dependencies [ecf4cc1]
  - @cat-factory/contracts@0.66.0
  - @cat-factory/agents@0.24.4
  - @cat-factory/kernel@0.62.1
  - @cat-factory/sandbox-fixtures@0.7.72

## 0.8.56

### Patch Changes

- Updated dependencies [f9678df]
- Updated dependencies [858799e]
  - @cat-factory/contracts@0.65.0
  - @cat-factory/kernel@0.62.0
  - @cat-factory/agents@0.24.3
  - @cat-factory/sandbox-fixtures@0.7.71

## 0.8.55

### Patch Changes

- Updated dependencies [9bb75b0]
  - @cat-factory/contracts@0.64.0
  - @cat-factory/agents@0.24.2
  - @cat-factory/kernel@0.61.1
  - @cat-factory/sandbox-fixtures@0.7.70

## 0.8.54

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/contracts@0.63.0
  - @cat-factory/kernel@0.61.0
  - @cat-factory/agents@0.24.1
  - @cat-factory/sandbox-fixtures@0.7.69

## 0.8.53

### Patch Changes

- Updated dependencies [f383515]
  - @cat-factory/kernel@0.60.0
  - @cat-factory/contracts@0.62.0
  - @cat-factory/agents@0.24.0
  - @cat-factory/sandbox-fixtures@0.7.68

## 0.8.52

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/kernel@0.59.0
  - @cat-factory/contracts@0.61.0
  - @cat-factory/agents@0.23.4
  - @cat-factory/sandbox-fixtures@0.7.67

## 0.8.51

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/kernel@0.58.0
  - @cat-factory/contracts@0.60.0
  - @cat-factory/agents@0.23.3
  - @cat-factory/sandbox-fixtures@0.7.66

## 0.8.50

### Patch Changes

- Updated dependencies [6009266]
  - @cat-factory/agents@0.23.2
  - @cat-factory/kernel@0.57.1

## 0.8.49

### Patch Changes

- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/contracts@0.59.0
  - @cat-factory/kernel@0.57.0
  - @cat-factory/agents@0.23.1
  - @cat-factory/sandbox-fixtures@0.7.65

## 0.8.48

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/contracts@0.58.0
  - @cat-factory/agents@0.23.0
  - @cat-factory/kernel@0.56.1
  - @cat-factory/sandbox-fixtures@0.7.64

## 0.8.47

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/contracts@0.57.0
  - @cat-factory/kernel@0.56.0
  - @cat-factory/agents@0.22.6
  - @cat-factory/sandbox-fixtures@0.7.63

## 0.8.46

### Patch Changes

- Updated dependencies [fdeb466]
  - @cat-factory/kernel@0.55.4
  - @cat-factory/agents@0.22.5

## 0.8.45

### Patch Changes

- Updated dependencies [21b2096]
  - @cat-factory/contracts@0.56.1
  - @cat-factory/agents@0.22.4
  - @cat-factory/kernel@0.55.3
  - @cat-factory/sandbox-fixtures@0.7.62

## 0.8.44

### Patch Changes

- Updated dependencies [ad5d3e0]
  - @cat-factory/contracts@0.56.0
  - @cat-factory/agents@0.22.3
  - @cat-factory/kernel@0.55.2
  - @cat-factory/sandbox-fixtures@0.7.61

## 0.8.43

### Patch Changes

- Updated dependencies [4897078]
  - @cat-factory/contracts@0.55.0
  - @cat-factory/agents@0.22.2
  - @cat-factory/kernel@0.55.1
  - @cat-factory/sandbox-fixtures@0.7.60

## 0.8.42

### Patch Changes

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/kernel@0.55.0
  - @cat-factory/contracts@0.54.0
  - @cat-factory/agents@0.22.1
  - @cat-factory/sandbox-fixtures@0.7.59

## 0.8.41

### Patch Changes

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/kernel@0.54.0
  - @cat-factory/contracts@0.53.0
  - @cat-factory/agents@0.22.0
  - @cat-factory/sandbox-fixtures@0.7.58

## 0.8.40

### Patch Changes

- Updated dependencies [0577404]
  - @cat-factory/contracts@0.52.0
  - @cat-factory/agents@0.21.17
  - @cat-factory/kernel@0.53.1
  - @cat-factory/sandbox-fixtures@0.7.57

## 0.8.39

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/contracts@0.51.0
  - @cat-factory/kernel@0.53.0
  - @cat-factory/agents@0.21.16
  - @cat-factory/sandbox-fixtures@0.7.56

## 0.8.38

### Patch Changes

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0
  - @cat-factory/contracts@0.50.1
  - @cat-factory/agents@0.21.15
  - @cat-factory/sandbox-fixtures@0.7.55

## 0.8.37

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/contracts@0.50.0
  - @cat-factory/kernel@0.51.0
  - @cat-factory/agents@0.21.14
  - @cat-factory/sandbox-fixtures@0.7.54

## 0.8.36

### Patch Changes

- Updated dependencies [e0f1149]
  - @cat-factory/contracts@0.49.0
  - @cat-factory/kernel@0.50.0
  - @cat-factory/agents@0.21.13
  - @cat-factory/sandbox-fixtures@0.7.53

## 0.8.35

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/contracts@0.48.0
  - @cat-factory/kernel@0.49.0
  - @cat-factory/agents@0.21.12
  - @cat-factory/sandbox-fixtures@0.7.52

## 0.8.34

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/contracts@0.47.0
  - @cat-factory/kernel@0.48.0
  - @cat-factory/agents@0.21.11
  - @cat-factory/sandbox-fixtures@0.7.51

## 0.8.33

### Patch Changes

- Updated dependencies [704c99e]
  - @cat-factory/contracts@0.46.0
  - @cat-factory/agents@0.21.10
  - @cat-factory/kernel@0.47.2
  - @cat-factory/sandbox-fixtures@0.7.50

## 0.8.32

### Patch Changes

- Updated dependencies [c2ec53b]
  - @cat-factory/contracts@0.45.1
  - @cat-factory/agents@0.21.9
  - @cat-factory/kernel@0.47.1
  - @cat-factory/sandbox-fixtures@0.7.49

## 0.8.31

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0
  - @cat-factory/contracts@0.45.0
  - @cat-factory/agents@0.21.8
  - @cat-factory/sandbox-fixtures@0.7.48

## 0.8.30

### Patch Changes

- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/kernel@0.46.0
  - @cat-factory/contracts@0.44.0
  - @cat-factory/agents@0.21.7
  - @cat-factory/sandbox-fixtures@0.7.47

## 0.8.29

### Patch Changes

- Updated dependencies [8fad695]
  - @cat-factory/sandbox-fixtures@0.7.46
  - @cat-factory/contracts@0.43.3
  - @cat-factory/kernel@0.45.5
  - @cat-factory/agents@0.21.6

## 0.8.28

### Patch Changes

- Updated dependencies [fb339db]
  - @cat-factory/contracts@0.43.2
  - @cat-factory/agents@0.21.5
  - @cat-factory/kernel@0.45.4
  - @cat-factory/sandbox-fixtures@0.7.45

## 0.8.27

### Patch Changes

- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3
  - @cat-factory/agents@0.21.4

## 0.8.26

### Patch Changes

- c11a0cc: Add a `prepublishOnly` build hook so each package is compiled to `dist/` before it is
  packed, regardless of how publish is invoked. `dist/` is gitignored and was only built by
  the canonical `pnpm ci:publish` flow, so a bare `pnpm publish` could ship an empty shell
  (this is what happened to `@cat-factory/gitlab` and `@cat-factory/provider-s3`). The hook
  removes that footgun for every publishable library.
- Updated dependencies [c11a0cc]
  - @cat-factory/agents@0.21.3
  - @cat-factory/contracts@0.43.1
  - @cat-factory/kernel@0.45.2
  - @cat-factory/sandbox-fixtures@0.7.44

## 0.8.25

### Patch Changes

- Updated dependencies [5363166]
  - @cat-factory/kernel@0.45.1
  - @cat-factory/agents@0.21.2

## 0.8.24

### Patch Changes

- Updated dependencies [eab73b8]
- Updated dependencies [eab73b8]
  - @cat-factory/contracts@0.43.0
  - @cat-factory/kernel@0.45.0
  - @cat-factory/agents@0.21.1
  - @cat-factory/sandbox-fixtures@0.7.43

## 0.8.23

### Patch Changes

- Updated dependencies [67c7196]
  - @cat-factory/sandbox-fixtures@0.7.42

## 0.8.22

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/contracts@0.42.0
  - @cat-factory/kernel@0.44.0
  - @cat-factory/agents@0.21.0
  - @cat-factory/sandbox-fixtures@0.7.41

## 0.8.21

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/kernel@0.43.0
  - @cat-factory/agents@0.20.3
  - @cat-factory/sandbox-fixtures@0.7.40

## 0.8.20

### Patch Changes

- Updated dependencies [63e2177]
  - @cat-factory/contracts@0.41.0
  - @cat-factory/agents@0.20.2
  - @cat-factory/kernel@0.42.2
  - @cat-factory/sandbox-fixtures@0.7.40

## 0.8.19

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/contracts@0.40.1
  - @cat-factory/kernel@0.42.1
  - @cat-factory/agents@0.20.1
  - @cat-factory/sandbox-fixtures@0.7.39

## 0.8.18

### Patch Changes

- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
  - @cat-factory/kernel@0.42.0
  - @cat-factory/contracts@0.40.0
  - @cat-factory/agents@0.20.0
  - @cat-factory/sandbox-fixtures@0.7.38

## 0.8.17

### Patch Changes

- Updated dependencies [b5231b0]
  - @cat-factory/contracts@0.39.0
  - @cat-factory/kernel@0.41.0
  - @cat-factory/agents@0.19.0
  - @cat-factory/sandbox-fixtures@0.7.37

## 0.8.16

### Patch Changes

- Updated dependencies [6d829bb]
  - @cat-factory/contracts@0.38.0
  - @cat-factory/kernel@0.40.0
  - @cat-factory/agents@0.18.5
  - @cat-factory/sandbox-fixtures@0.7.36

## 0.8.15

### Patch Changes

- Updated dependencies [714b7c9]
  - @cat-factory/contracts@0.37.0
  - @cat-factory/kernel@0.39.0
  - @cat-factory/agents@0.18.4
  - @cat-factory/sandbox-fixtures@0.7.35

## 0.8.14

### Patch Changes

- Updated dependencies [efbd910]
  - @cat-factory/contracts@0.36.0
  - @cat-factory/agents@0.18.3
  - @cat-factory/kernel@0.38.1
  - @cat-factory/sandbox-fixtures@0.7.34

## 0.8.13

### Patch Changes

- Updated dependencies [692ccb4]
  - @cat-factory/agents@0.18.2
  - @cat-factory/sandbox-fixtures@0.7.33

## 0.8.12

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/contracts@0.35.0
  - @cat-factory/kernel@0.38.0
  - @cat-factory/agents@0.18.1
  - @cat-factory/sandbox-fixtures@0.7.33

## 0.8.11

### Patch Changes

- Updated dependencies [76543fa]
  - @cat-factory/kernel@0.37.0
  - @cat-factory/contracts@0.34.0
  - @cat-factory/agents@0.18.0
  - @cat-factory/sandbox-fixtures@0.7.32

## 0.8.10

### Patch Changes

- Updated dependencies [17adf4c]
  - @cat-factory/contracts@0.33.0
  - @cat-factory/kernel@0.36.0
  - @cat-factory/agents@0.17.2
  - @cat-factory/sandbox-fixtures@0.7.31

## 0.8.9

### Patch Changes

- Updated dependencies [eb48652]
  - @cat-factory/contracts@0.32.0
  - @cat-factory/kernel@0.35.0
  - @cat-factory/agents@0.17.1
  - @cat-factory/sandbox-fixtures@0.7.30

## 0.8.8

### Patch Changes

- Updated dependencies [9f7ee39]
- Updated dependencies [81b60d4]
  - @cat-factory/contracts@0.31.0
  - @cat-factory/kernel@0.34.0
  - @cat-factory/agents@0.17.0
  - @cat-factory/sandbox-fixtures@0.7.29

## 0.8.7

### Patch Changes

- Updated dependencies [4dd6e97]
  - @cat-factory/agents@0.16.1
  - @cat-factory/sandbox-fixtures@0.7.28

## 0.8.6

### Patch Changes

- Updated dependencies [ea59e91]
  - @cat-factory/contracts@0.30.0
  - @cat-factory/kernel@0.33.0
  - @cat-factory/agents@0.16.0
  - @cat-factory/sandbox-fixtures@0.7.28

## 0.8.5

### Patch Changes

- Updated dependencies [b82304e]
  - @cat-factory/contracts@0.29.0
  - @cat-factory/kernel@0.32.0
  - @cat-factory/agents@0.15.2
  - @cat-factory/sandbox-fixtures@0.7.27

## 0.8.4

### Patch Changes

- Updated dependencies [765cc42]
  - @cat-factory/kernel@0.31.0
  - @cat-factory/contracts@0.28.0
  - @cat-factory/agents@0.15.1
  - @cat-factory/sandbox-fixtures@0.7.26

## 0.8.3

### Patch Changes

- Updated dependencies [52d886a]
  - @cat-factory/kernel@0.30.0
  - @cat-factory/contracts@0.27.0
  - @cat-factory/agents@0.15.0
  - @cat-factory/sandbox-fixtures@0.7.25

## 0.8.2

### Patch Changes

- Updated dependencies [a639189]
  - @cat-factory/kernel@0.29.0
  - @cat-factory/contracts@0.26.0
  - @cat-factory/agents@0.14.9
  - @cat-factory/sandbox-fixtures@0.7.24

## 0.8.1

### Patch Changes

- Updated dependencies [ed3a673]
  - @cat-factory/contracts@0.25.1
  - @cat-factory/agents@0.14.8
  - @cat-factory/kernel@0.28.1
  - @cat-factory/sandbox-fixtures@0.7.23

## 0.8.0

### Minor Changes

- 69d2270: Surface the Sandbox (the parallel prompt/model testing surface) end to end. Previously
  only the domain logic (`@cat-factory/sandbox`), wire contracts and kernel ports existed,
  with no way to use the feature; this wires the full stack:

  - **Services** (`@cat-factory/orchestration`): `SandboxService` (prompt-version lineage,
    fixture library with lazy builtin seeding, experiment definitions) + `SandboxRunService`
    (the run-driver + judge — expands an experiment matrix into cells, runs each inline
    candidate against the prompt-version's system text + the fixture input, grades it with a
    judge model against the task rubric, and records the deterministic objective findings
    score). Assembled as the `sandbox` core module when its repositories are wired.
  - **HTTP API** (`@cat-factory/server`): `SandboxController` mounts the prompt/fixture/
    experiment CRUD + `POST /sandbox/experiments/:id/launch`. 503 when unconfigured.
  - **Persistence**: the Sandbox gets its **own database** per runtime for blast-radius
    isolation — a dedicated `SANDBOX_DB` D1 database on the Cloudflare Worker (its own
    `sandbox-migrations/` lineage) and a dedicated `sandbox` Postgres schema on Node
    (Drizzle). Both runtimes contribute the repositories via a single sandbox-owned
    `Partial<CoreDependencies>` mixin, so neither facade enumerates them. Cross-runtime
    conformance asserts parity.
  - **Frontend** (`@cat-factory/app`): a Sandbox window (opened from the sidebar +
    command palette) to clone/version prompts, browse graded fixtures, and define + run
    experiments with a scored results grid.

  BREAKING (deployment): the Cloudflare Worker reads an optional new `SANDBOX_DB` binding;
  without it the Sandbox API answers 503 (the rest of the product is unaffected). To enable
  it, provision a second D1 database and point the binding + its `migrations_dir` at the
  package's `sandbox-migrations/` (see `deploy/backend/wrangler.toml`). On Node the
  `sandbox` schema is created automatically by the boot migrator.

  Container/repo fixtures (a real checkout) are not yet supported by the in-product run
  driver and are refused at launch; the builtin fixtures are all inline.

  Run-driver hardening: a relaunch clears the prior result grid first (new
  `SandboxRunRepository`/`SandboxGradeRepository.removeByExperiment`, mirrored on D1 +
  Drizzle) instead of accumulating duplicate cells; the experiment's terminal status is
  derived from whether any cell was actually graded (`failed` when every candidate failed OR
  every grade failed — never a misleading `done` over a grid of unscored cells, and never
  left `running`); the token budget must be ≥ 1 (a `0` budget is rejected at create rather
  than silently failing every cell) and is documented as a soft cap enforced between cells;
  the judge model defaults to the deployment routing default (no hardcoded vendor) and
  requires an explicit `judgeModel` when none is configured (the experiment builder now
  exposes a judge-model picker so a deployment with no default still has recourse); an
  unparseable / empty / reasoning-only judge reply is now recorded as a grading **error** on
  the cell rather than silently flooring every dimension to the minimum (which read as a
  confident bottom-of-scale grade); the judge-reply JSON extractor — now the single robust
  `extractJson` promoted to `@cat-factory/kernel` and shared by the requirements reviewer, the
  document planner and the Sandbox judge (replacing two weaker object-only copies) — is
  string-literal aware, scans forward past any leading bracket whose span isn't valid JSON
  (so prose like `I weighed [the auth flow]: {…}` no longer defeats extraction for the
  object-returning reviewers), and falls back past a leading non-JSON code fence. The judge
  prompt appends the shared `FINAL_ANSWER_IN_REPLY` directive like the other parsed-reply
  agents, and the provider-for-scope resolution the Sandbox shares with the reviewers is now
  one `resolveScopedModelProvider` kernel helper instead of two copies. The Sandbox window now surfaces a
  non-503 load failure (with a retry) instead of rendering an empty, healthy-looking panel.
  The fixture↔kind mapping the UI filters by now lives on the `@cat-factory/sandbox` catalog
  (`SandboxAgentKindMeta.fixtureKinds`) instead of a parallel frontend switch. Concurrent
  launches of the same experiment are now serialised by an atomic
  `SandboxExperimentRepository.claimForRun` (a conditional transition to `running`, mirrored on
  D1 + Drizzle): only the winner clears + re-expands the result grid, so two simultaneous
  launches can't duplicate the grid or race the grid-clearing deletes, and the grid setup runs
  inside the terminal-status `finally` so a failure there can't strand the experiment
  `running`. The matrix cell cap is surfaced on the overview (`maxCells`) so the builder gates
  on the SAME limit instead of re-encoding the literal. NOTE: the run-driver still executes the
  matrix inline in the launch request (bounded by the cell cap + token budget); a durable
  fan-out (Workflows / pg-boss) for large matrices remains a follow-up.

### Patch Changes

- Updated dependencies [69d2270]
  - @cat-factory/contracts@0.25.0
  - @cat-factory/kernel@0.28.0
  - @cat-factory/sandbox-fixtures@0.7.22
  - @cat-factory/agents@0.14.7

## 0.7.36

### Patch Changes

- Updated dependencies [3546e3d]
  - @cat-factory/contracts@0.24.0
  - @cat-factory/kernel@0.27.0
  - @cat-factory/agents@0.14.6
  - @cat-factory/sandbox-fixtures@0.7.21

## 0.7.35

### Patch Changes

- Updated dependencies [a62044d]
  - @cat-factory/kernel@0.26.1
  - @cat-factory/agents@0.14.5
  - @cat-factory/sandbox-fixtures@0.7.20

## 0.7.34

### Patch Changes

- Updated dependencies [2aae8bc]
  - @cat-factory/kernel@0.26.0
  - @cat-factory/agents@0.14.4
  - @cat-factory/sandbox-fixtures@0.7.20

## 0.7.33

### Patch Changes

- Updated dependencies [f4f954b]
  - @cat-factory/kernel@0.25.0
  - @cat-factory/agents@0.14.3
  - @cat-factory/sandbox-fixtures@0.7.20

## 0.7.32

### Patch Changes

- Updated dependencies [ce81233]
  - @cat-factory/contracts@0.23.0
  - @cat-factory/kernel@0.24.0
  - @cat-factory/agents@0.14.2
  - @cat-factory/sandbox-fixtures@0.7.20

## 0.7.31

### Patch Changes

- Updated dependencies [7346a4f]
  - @cat-factory/kernel@0.23.0
  - @cat-factory/agents@0.14.1
  - @cat-factory/sandbox-fixtures@0.7.19

## 0.7.30

### Patch Changes

- Updated dependencies [6ff1f10]
  - @cat-factory/contracts@0.22.0
  - @cat-factory/kernel@0.22.0
  - @cat-factory/agents@0.14.0
  - @cat-factory/sandbox-fixtures@0.7.19

## 0.7.29

### Patch Changes

- Updated dependencies [04befe8]
  - @cat-factory/contracts@0.21.0
  - @cat-factory/kernel@0.21.0
  - @cat-factory/agents@0.13.0
  - @cat-factory/sandbox-fixtures@0.7.18

## 0.7.28

### Patch Changes

- Updated dependencies [be182e8]
  - @cat-factory/kernel@0.20.0
  - @cat-factory/agents@0.12.0
  - @cat-factory/sandbox-fixtures@0.7.17

## 0.7.27

### Patch Changes

- Updated dependencies [2c24da8]
  - @cat-factory/contracts@0.20.0
  - @cat-factory/kernel@0.19.0
  - @cat-factory/agents@0.11.16
  - @cat-factory/sandbox-fixtures@0.7.17

## 0.7.26

### Patch Changes

- Updated dependencies [4120ac5]
  - @cat-factory/contracts@0.19.0
  - @cat-factory/kernel@0.18.0
  - @cat-factory/agents@0.11.15
  - @cat-factory/sandbox-fixtures@0.7.16

## 0.7.25

### Patch Changes

- Updated dependencies [25efe48]
  - @cat-factory/contracts@0.18.0
  - @cat-factory/kernel@0.17.0
  - @cat-factory/agents@0.11.14
  - @cat-factory/sandbox-fixtures@0.7.15

## 0.7.24

### Patch Changes

- Updated dependencies [c7b8012]
  - @cat-factory/contracts@0.17.1
  - @cat-factory/kernel@0.16.2
  - @cat-factory/agents@0.11.13
  - @cat-factory/sandbox-fixtures@0.7.14

## 0.7.23

### Patch Changes

- Updated dependencies [aa06003]
  - @cat-factory/contracts@0.17.0
  - @cat-factory/kernel@0.16.1
  - @cat-factory/agents@0.11.12
  - @cat-factory/sandbox-fixtures@0.7.13

## 0.7.22

### Patch Changes

- Updated dependencies [208c933]
  - @cat-factory/kernel@0.16.0
  - @cat-factory/agents@0.11.11
  - @cat-factory/sandbox-fixtures@0.7.12

## 0.7.21

### Patch Changes

- Updated dependencies [494fb34]
  - @cat-factory/kernel@0.15.1
  - @cat-factory/agents@0.11.10
  - @cat-factory/sandbox-fixtures@0.7.12

## 0.7.20

### Patch Changes

- Updated dependencies [0ac64b8]
  - @cat-factory/kernel@0.15.0
  - @cat-factory/contracts@0.16.0
  - @cat-factory/agents@0.11.9
  - @cat-factory/sandbox-fixtures@0.7.12

## 0.7.19

### Patch Changes

- Updated dependencies [7d1f829]
  - @cat-factory/agents@0.11.8
  - @cat-factory/sandbox-fixtures@0.7.11

## 0.7.18

### Patch Changes

- Updated dependencies [fde0437]
  - @cat-factory/contracts@0.15.0
  - @cat-factory/kernel@0.14.0
  - @cat-factory/agents@0.11.7
  - @cat-factory/sandbox-fixtures@0.7.11

## 0.7.17

### Patch Changes

- Updated dependencies [77b7d31]
  - @cat-factory/agents@0.11.6
  - @cat-factory/kernel@0.13.4
  - @cat-factory/sandbox-fixtures@0.7.10

## 0.7.16

### Patch Changes

- Updated dependencies [82d771e]
  - @cat-factory/contracts@0.14.0
  - @cat-factory/agents@0.11.5
  - @cat-factory/kernel@0.13.3
  - @cat-factory/sandbox-fixtures@0.7.10

## 0.7.15

### Patch Changes

- Updated dependencies [ce27690]
  - @cat-factory/contracts@0.13.1
  - @cat-factory/kernel@0.13.2
  - @cat-factory/agents@0.11.4
  - @cat-factory/sandbox-fixtures@0.7.9

## 0.7.14

### Patch Changes

- Updated dependencies [c8bd144]
  - @cat-factory/kernel@0.13.1
  - @cat-factory/sandbox-fixtures@0.7.8
  - @cat-factory/agents@0.11.3

## 0.7.13

### Patch Changes

- Updated dependencies [5c915fd]
  - @cat-factory/contracts@0.13.0
  - @cat-factory/kernel@0.13.0
  - @cat-factory/agents@0.11.2
  - @cat-factory/sandbox-fixtures@0.7.8

## 0.7.12

### Patch Changes

- Updated dependencies [22d7fff]
  - @cat-factory/agents@0.11.1
  - @cat-factory/sandbox-fixtures@0.7.7

## 0.7.11

### Patch Changes

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
- Updated dependencies [4de2f5f]
  - @cat-factory/kernel@0.12.0
  - @cat-factory/agents@0.11.0
  - @cat-factory/contracts@0.12.0
  - @cat-factory/sandbox-fixtures@0.7.7

## 0.7.10

### Patch Changes

- Updated dependencies [f8a24e0]
  - @cat-factory/agents@0.10.1
  - @cat-factory/kernel@0.11.1
  - @cat-factory/sandbox-fixtures@0.7.6

## 0.7.9

### Patch Changes

- Updated dependencies [1e31cbc]
  - @cat-factory/contracts@0.11.0
  - @cat-factory/kernel@0.11.0
  - @cat-factory/agents@0.10.0
  - @cat-factory/sandbox-fixtures@0.7.6

## 0.7.8

### Patch Changes

- Updated dependencies [d0081e1]
  - @cat-factory/contracts@0.10.0
  - @cat-factory/agents@0.9.0
  - @cat-factory/kernel@0.10.1
  - @cat-factory/sandbox-fixtures@0.7.5

## 0.7.7

### Patch Changes

- Updated dependencies [ae29687]
  - @cat-factory/contracts@0.9.0
  - @cat-factory/kernel@0.10.0
  - @cat-factory/agents@0.8.2
  - @cat-factory/sandbox-fixtures@0.7.4

## 0.7.6

### Patch Changes

- Updated dependencies [5c20968]
  - @cat-factory/kernel@0.9.0
  - @cat-factory/agents@0.8.1
  - @cat-factory/sandbox-fixtures@0.7.3

## 0.7.5

### Patch Changes

- Updated dependencies [c70df09]
  - @cat-factory/agents@0.8.0
  - @cat-factory/contracts@0.8.0
  - @cat-factory/kernel@0.8.0
  - @cat-factory/sandbox-fixtures@0.7.3

## 0.7.4

### Patch Changes

- Updated dependencies [a0a1bcc]
  - @cat-factory/kernel@0.7.3
  - @cat-factory/agents@0.7.3
  - @cat-factory/sandbox-fixtures@0.7.2

## 0.7.3

### Patch Changes

- fef2964: Add `@cat-factory/sandbox` and `@cat-factory/local-server` to the root `tsc -b`
  build graph (`backend/tsconfig.build.json`). They were publishable (`private: false`,
  `publishConfig.access: public`) and declared `files: ["dist"]`, but neither was
  referenced by the build graph nor pulled in transitively, so `pnpm build` (which
  `ci:publish` runs before `changeset publish`) never produced their `dist`. The last
  release therefore published both with only `package.json` + `LICENSE` and no code.
  This patch re-releases them with their built output. (`@cat-factory/consensus` was
  unaffected — it builds transitively via the cloudflare/node graphs.)

## 0.7.2

### Patch Changes

- 4fa5ed9: Re-release all publishable packages. The previous release bumped these on `main` but never reached npm (the publish job was never triggered), so npm is a release behind. This changeset re-triggers the release so every package publishes.
- Updated dependencies [4fa5ed9]
  - @cat-factory/agents@0.7.2
  - @cat-factory/contracts@0.7.2
  - @cat-factory/kernel@0.7.2
  - @cat-factory/sandbox-fixtures@0.7.2

## 0.7.1

### Patch Changes

- 7463cf2: Add `repository` metadata (url + monorepo `directory`) to every published package.json. npm provenance attestation rejected the previous release because `repository.url` was empty and could not be matched against the source repo; declaring it lets the publish (and provenance) succeed, and re-triggers publishing of all packages from the failed release.
- Updated dependencies [7463cf2]
  - @cat-factory/agents@0.7.1
  - @cat-factory/contracts@0.7.1
  - @cat-factory/kernel@0.7.1
  - @cat-factory/sandbox-fixtures@0.7.1

## 0.7.0

### Minor Changes

- 21ca647: Foundation for the **Sandbox** — a parallel, opt-in surface for the organized
  testing of prompts and models. It answers "which model is best for this task?"
  (one prompt, many models) and "does a better prompt help?" (one model, many
  prompt versions).

  This change lands the isolated foundation only (no runtime wiring yet):

  - **`@cat-factory/sandbox`** (new, isolated package): the pure domain logic —
    the testable-agent-kind catalog with live baseline enumeration (read from
    `@cat-factory/agents`, never persisted), append-only prompt-version lineage
    (clone → versioned candidates + freeform labels), experiment-matrix expansion
    into run cells, and the judge rubrics (lifted from the benchmark harness) plus
    a deterministic objective-findings recall scorer. Nothing in the core product
    depends on this package, so the whole feature can be extracted later.
  - **`@cat-factory/contracts`**: Valibot wire contracts for sandbox prompt
    versions, fixtures, experiments, runs, and grades (`sandbox.ts`).
  - **`@cat-factory/kernel`**: the sandbox repository ports
    (`SandboxPromptVersionRepository`, `SandboxFixtureRepository`,
    `SandboxExperimentRepository`, `SandboxRunRepository`,
    `SandboxGradeRepository`) and the re-exported domain types.

  Follow-ups (per the approved design): the server controller, the durable
  fan-out run driver + judge/objective grading, D1 ⇄ Drizzle persistence with a
  conformance assertion, the dedicated fixture repo + ephemeral-branch lifecycle,
  and the lazy-loaded frontend section.

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
- Updated dependencies [6406c8c]
- Updated dependencies [3d9a9d8]
- Updated dependencies [db77061]
- Updated dependencies [a48c620]
- Updated dependencies [3bc8c79]
- Updated dependencies [9d3a956]
- Updated dependencies [8d11833]
- Updated dependencies [ad9ba9e]
- Updated dependencies [3e0d753]
- Updated dependencies [f83ffd7]
- Updated dependencies [8065fed]
- Updated dependencies [385bd93]
- Updated dependencies [e50e78a]
- Updated dependencies [0972696]
- Updated dependencies [b48c455]
- Updated dependencies [e9b9356]
- Updated dependencies [e8005ba]
- Updated dependencies [3a12f15]
- Updated dependencies [3a12f15]
- Updated dependencies [b40da13]
- Updated dependencies [3a12f15]
- Updated dependencies [8eed38c]
- Updated dependencies [084bf43]
- Updated dependencies [268c15d]
- Updated dependencies [8eed38c]
- Updated dependencies [157cd02]
- Updated dependencies [7c37653]
- Updated dependencies [db77061]
- Updated dependencies [f49fa30]
- Updated dependencies [6406c8c]
- Updated dependencies [57d70fa]
- Updated dependencies [6406c8c]
- Updated dependencies [918764f]
- Updated dependencies [918764f]
- Updated dependencies [88b3170]
- Updated dependencies [fe0b7f8]
- Updated dependencies [f73652c]
- Updated dependencies [db336b1]
- Updated dependencies [8807f5c]
- Updated dependencies [9be11e1]
- Updated dependencies [5ec0d25]
- Updated dependencies [197264e]
- Updated dependencies [a691853]
- Updated dependencies [f066c59]
- Updated dependencies [7d5e060]
- Updated dependencies [4a08935]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [b287996]
- Updated dependencies [b156b4b]
- Updated dependencies [5c8ca33]
- Updated dependencies [b156b4b]
- Updated dependencies [7cf2a2d]
- Updated dependencies [2d66d34]
- Updated dependencies [197264e]
- Updated dependencies [3a12f15]
- Updated dependencies [37baa7f]
- Updated dependencies [c664fe6]
- Updated dependencies [553a67d]
- Updated dependencies [b80d657]
- Updated dependencies [4026793]
- Updated dependencies [311a110]
- Updated dependencies [f16ae62]
- Updated dependencies [36018cb]
- Updated dependencies [799be66]
- Updated dependencies [d65c979]
- Updated dependencies [75a0441]
- Updated dependencies [7157fd7]
- Updated dependencies [21ca647]
- Updated dependencies [c4ef995]
- Updated dependencies [8eed95b]
- Updated dependencies [0b38aa6]
- Updated dependencies [a97e485]
- Updated dependencies [de5a9d7]
- Updated dependencies [f647733]
- Updated dependencies [d5e9141]
- Updated dependencies [2dd7e56]
- Updated dependencies [2d66d34]
- Updated dependencies [86a5843]
- Updated dependencies [a54ada2]
- Updated dependencies [2dd7e56]
- Updated dependencies [5ca8086]
- Updated dependencies [d0697d1]
- Updated dependencies [0090313]
- Updated dependencies [7dc8e57]
- Updated dependencies [cc8d96a]
- Updated dependencies [7c37653]
- Updated dependencies [43f2443]
- Updated dependencies [acac735]
- Updated dependencies [3841315]
- Updated dependencies [48d2f0d]
- Updated dependencies [3e6a844]
  - @cat-factory/contracts@0.7.0
  - @cat-factory/kernel@0.7.0
  - @cat-factory/agents@0.7.0
  - @cat-factory/sandbox-fixtures@0.7.0
