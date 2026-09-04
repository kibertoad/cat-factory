# @cat-factory/prompt-fragments

## 1.1.30

### Patch Changes

- Updated dependencies [d36d0a8]
  - @cat-factory/kernel@0.335.1
  - @cat-factory/contracts@0.346.1

## 1.1.29

### Patch Changes

- Updated dependencies [0f3fb10]
  - @cat-factory/contracts@0.346.0
  - @cat-factory/kernel@0.335.0

## 1.1.28

### Patch Changes

- Updated dependencies [745eae8]
  - @cat-factory/contracts@0.345.0
  - @cat-factory/kernel@0.334.0

## 1.1.27

### Patch Changes

- Updated dependencies [e7e1f8c]
- Updated dependencies [a1802d9]
  - @cat-factory/contracts@0.344.0
  - @cat-factory/kernel@0.333.0

## 1.1.26

### Patch Changes

- Updated dependencies [3b11b10]
  - @cat-factory/contracts@0.343.0
  - @cat-factory/kernel@0.332.0

## 1.1.25

### Patch Changes

- Updated dependencies [9dfd40b]
  - @cat-factory/contracts@0.342.0
  - @cat-factory/kernel@0.331.0

## 1.1.24

### Patch Changes

- Updated dependencies [1c79070]
  - @cat-factory/contracts@0.341.0
  - @cat-factory/kernel@0.330.0

## 1.1.23

### Patch Changes

- Updated dependencies [8b015a3]
  - @cat-factory/contracts@0.340.0
  - @cat-factory/kernel@0.329.0

## 1.1.22

### Patch Changes

- Updated dependencies [ec0aba1]
  - @cat-factory/contracts@0.339.0
  - @cat-factory/kernel@0.328.0

## 1.1.21

### Patch Changes

- Updated dependencies [436f373]
  - @cat-factory/contracts@0.338.0
  - @cat-factory/kernel@0.327.0

## 1.1.20

### Patch Changes

- Updated dependencies [a745ee2]
  - @cat-factory/contracts@0.337.0
  - @cat-factory/kernel@0.326.0

## 1.1.19

### Patch Changes

- Updated dependencies [92232a6]
- Updated dependencies [a08d2ad]
  - @cat-factory/contracts@0.336.0
  - @cat-factory/kernel@0.325.0

## 1.1.18

### Patch Changes

- Updated dependencies [dc4a5d9]
- Updated dependencies [4d999cb]
  - @cat-factory/contracts@0.335.0
  - @cat-factory/kernel@0.324.0

## 1.1.17

### Patch Changes

- Updated dependencies [0f426b3]
  - @cat-factory/kernel@0.323.2

## 1.1.16

### Patch Changes

- Updated dependencies [332ef26]
  - @cat-factory/kernel@0.323.1

## 1.1.15

### Patch Changes

- Updated dependencies [4b1c76f]
  - @cat-factory/contracts@0.334.0
  - @cat-factory/kernel@0.323.0

## 1.1.14

### Patch Changes

- Updated dependencies [6d4b02a]
  - @cat-factory/kernel@0.322.2

## 1.1.13

### Patch Changes

- Updated dependencies [be0b953]
  - @cat-factory/kernel@0.322.1

## 1.1.12

### Patch Changes

- Updated dependencies [27b22a3]
  - @cat-factory/contracts@0.333.0
  - @cat-factory/kernel@0.322.0

## 1.1.11

### Patch Changes

- Updated dependencies [e1f6325]
- Updated dependencies [90a915e]
  - @cat-factory/contracts@0.332.0
  - @cat-factory/kernel@0.321.3

## 1.1.10

### Patch Changes

- Updated dependencies [e0eed49]
  - @cat-factory/kernel@0.321.2

## 1.1.9

### Patch Changes

- Updated dependencies [7d899c4]
  - @cat-factory/contracts@0.331.0
  - @cat-factory/kernel@0.321.1

## 1.1.8

### Patch Changes

- Updated dependencies [dc12c82]
  - @cat-factory/contracts@0.330.0
  - @cat-factory/kernel@0.321.0

## 1.1.7

### Patch Changes

- Updated dependencies [3ae3386]
  - @cat-factory/contracts@0.329.0
  - @cat-factory/kernel@0.320.0

## 1.1.6

### Patch Changes

- Updated dependencies [c030a23]
  - @cat-factory/kernel@0.319.1

## 1.1.5

### Patch Changes

- Updated dependencies [69b9ed4]
  - @cat-factory/kernel@0.319.0

## 1.1.4

### Patch Changes

- Updated dependencies [a8f8d14]
  - @cat-factory/contracts@0.328.0
  - @cat-factory/kernel@0.318.1

## 1.1.3

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

## 1.1.2

### Patch Changes

- Updated dependencies [da77447]
  - @cat-factory/contracts@0.326.0
  - @cat-factory/kernel@0.317.1

## 1.1.1

### Patch Changes

- Updated dependencies [4125beb]
  - @cat-factory/contracts@0.325.0
  - @cat-factory/kernel@0.317.0

## 1.1.0

### Minor Changes

- 1d3c115: Close the remaining actionable Kaizen findings: what the companion loop is told, and what a prompt
  pays for on every round.

  Six items the platform's own graders filed, all of them either a fact the prompt withheld or a
  fact it paid for twice.

  - **A companion was never told its bar on the first round.** The threshold rode the prior-rounds
    heading, and there is no prior round the first time a step is graded, so the opening verdict of
    every rework loop was a 0..1 rating against a number nobody had stated. The bar and the rope left
    are now their own slice of the run context, set for every grader dispatch.
    `priorReview.roundsRemaining` was the old home and is gone rather than left beside the new one.
    The ROPE needed a second fix to be true: the rework budget was adopted from the task's risk policy
    on the first grading RESULT, one dispatch after the prompt for that grading is composed, so a
    workspace whose policy allows no automatic rework was told on round one that two rounds remained.
    It is resolved once now, at run start, which also removes the second resolution point so the
    number an agent is shown and the number the cap enforces cannot diverge.
  - **A rework prompt re-sent every settled point that was still open.** A point the reviewer raises
    again arrives once as this round's ask and again in the history; on a real run the same six points
    appeared three times with no single list to work through. The history is now deduplicated against
    the current round's list, and the fold is COUNTED in place rather than silent: a round whose every
    point moved into the current list would otherwise read as a round that raised nothing. A point NOT
    re-raised survives in the history, which is the only place it exists. Matching is on the point's
    BODY under its anchor rather than on the anchor alone, because an `anchorId` names an ITEM and one
    item collects several findings: keyed on the anchor, two different asks on one requirement hash
    together and re-raising one drops the other from the prompt for good.
  - **The user prompt was assembled volatile-first.** A provider's cache matches on a prefix, and the
    injected context files (a preOp's output, the run's linked documents) are the largest block in the
    prompt and the same bytes on every round, while the revision feedback is different bytes by
    definition. They were composed the other way round, so each round paid a fresh cache write for the
    whole fold. The wrappers are now an ordered list, invariant material first, which is also what
    makes the ordering reviewable rather than five levels of nesting. The saving is the PRODUCER's
    rework dispatch: `priorOutputs` renders at the tail of the base prompt ahead of every wrapper and
    carries the producer's rewritten reply, so a GRADER's prefix still breaks before the fold. That
    bound is recorded at the code rather than implied away.
  - **A container-backed companion could not run the diff its prompt asked for.** The default explore
    clone is `--depth 1 --single-branch`, so `origin/<base>` and the merge base are both absent and no
    later `git fetch` of a shallow base recovers a common ancestor. It clones with full history now,
    the same reason the `merger` does, and the dispatch's resolved base branch is named in the prompt
    with the diff commands and the rule that the review is planned from the diffstat before anything
    is opened. A measured review spent ~40 exploratory calls discovering the change one file at a
    time. The prompt names no `git fetch`, because the container agent holds no git credential of its
    own and an agent-issued fetch fails on a private repo; it is WITHHELD entirely where the checkout
    is the base branch (a `pr` clone falls back there when the producer opened no pull request, and
    the diff would be empty), and where the base branch name cannot be safely quoted into a command.
  - **Trait guidance naming an injected file is gated on the file arriving.** The two foundational
    sections each open by pointing at a `.cat-context/` path the engine injects only where a
    `FoundationalServiceResolver` is wired; on a deployment with none they were a few hundred words of
    dangling pointer on every turn. `AgentTraitDefinition.guidance` now receives what the dispatch
    delivered and may decline to contribute. An absent delivery means UNKNOWN rather than empty and
    renders in full, so the prompt editor and the sandbox are unchanged, which makes
    `appendedDirectivesFor` a maximum rather than a prediction of one dispatch: a real dispatch may
    send a subset and never more. `BINARY_OUTPUT_GUIDANCE` is deliberately not gated, because its
    absent case is a refusal the agent has to be told about.
  - **New `deployment.*` best-practice fragments.** Three standards for shipping a containerized
    service (image build and publish, workload runtime hardening, the cross-file manifest contract),
    from the class of finding a design review kept re-deriving one round at a time: a numeric UID for
    `runAsNonRoot`, a writable mount for a read-only root filesystem, pull-side registry auth, pull
    policy against tag mutability, and the selector/label/port contract three files share. They are
    OPT-IN: nothing shipped selects them, because there is no deploy-shaped built-in task type and
    unioning them onto `feature` would fold deployment standards into every feature run everywhere.

  Runner image: the explore path's warm-pool checkout refreshed only the branch being explored,
  leaving `origin/<base>` at whatever tip the pool directory was first cloned with, so a reviewer's
  three-dot diff resolved its merge base to that stale tip and reported every commit merged into base
  since as part of the change under review. Fixed in `@cat-factory/executor-harness`, so the pinned
  image tag moves to `1.128.0`.

### Patch Changes

- Updated dependencies [1d3c115]
  - @cat-factory/kernel@0.316.0

## 1.0.92

### Patch Changes

- Updated dependencies [432b4e4]
  - @cat-factory/contracts@0.324.0
  - @cat-factory/kernel@0.315.0

## 1.0.91

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

## 1.0.90

### Patch Changes

- Updated dependencies [72ecc7c]
  - @cat-factory/contracts@0.323.0
  - @cat-factory/kernel@0.314.0

## 1.0.89

### Patch Changes

- Updated dependencies [5b281a3]
  - @cat-factory/contracts@0.322.0
  - @cat-factory/kernel@0.313.0

## 1.0.88

### Patch Changes

- Updated dependencies [53a4c40]
  - @cat-factory/contracts@0.321.0
  - @cat-factory/kernel@0.312.0

## 1.0.87

### Patch Changes

- Updated dependencies [4a3af5a]
  - @cat-factory/kernel@0.311.0

## 1.0.86

### Patch Changes

- Updated dependencies [302e05a]
- Updated dependencies [cda15b8]
  - @cat-factory/contracts@0.320.0
  - @cat-factory/kernel@0.310.0

## 1.0.85

### Patch Changes

- Updated dependencies [3afea3a]
  - @cat-factory/contracts@0.319.0
  - @cat-factory/kernel@0.309.0

## 1.0.84

### Patch Changes

- Updated dependencies [3f7d8b2]
  - @cat-factory/contracts@0.318.0
  - @cat-factory/kernel@0.308.0

## 1.0.83

### Patch Changes

- Updated dependencies [2a2b6ef]
  - @cat-factory/kernel@0.307.0

## 1.0.82

### Patch Changes

- Updated dependencies [5333319]
  - @cat-factory/kernel@0.306.0

## 1.0.81

### Patch Changes

- Updated dependencies [053aac8]
  - @cat-factory/contracts@0.317.0
  - @cat-factory/kernel@0.305.0

## 1.0.80

### Patch Changes

- Updated dependencies [eb5fa75]
- Updated dependencies [9d8fdf6]
  - @cat-factory/contracts@0.316.0
  - @cat-factory/kernel@0.304.0

## 1.0.79

### Patch Changes

- Updated dependencies [eb740be]
  - @cat-factory/contracts@0.315.0
  - @cat-factory/kernel@0.303.0

## 1.0.78

### Patch Changes

- Updated dependencies [7f990ea]
  - @cat-factory/contracts@0.314.0
  - @cat-factory/kernel@0.302.0

## 1.0.77

### Patch Changes

- Updated dependencies [409238f]
  - @cat-factory/kernel@0.301.0
  - @cat-factory/contracts@0.313.0

## 1.0.76

### Patch Changes

- Updated dependencies [0ef48d1]
  - @cat-factory/kernel@0.300.0
  - @cat-factory/contracts@0.312.0

## 1.0.75

### Patch Changes

- Updated dependencies [d5c1f1c]
- Updated dependencies [c67e924]
  - @cat-factory/kernel@0.299.1
  - @cat-factory/contracts@0.311.0

## 1.0.74

### Patch Changes

- Updated dependencies [056e18d]
  - @cat-factory/contracts@0.310.0
  - @cat-factory/kernel@0.299.0

## 1.0.73

### Patch Changes

- Updated dependencies [a81879b]
  - @cat-factory/contracts@0.309.0
  - @cat-factory/kernel@0.298.2

## 1.0.72

### Patch Changes

- Updated dependencies [0e1e0fa]
  - @cat-factory/contracts@0.308.1
  - @cat-factory/kernel@0.298.1

## 1.0.71

### Patch Changes

- Updated dependencies [7312e0a]
  - @cat-factory/kernel@0.298.0
  - @cat-factory/contracts@0.308.0

## 1.0.70

### Patch Changes

- Updated dependencies [95408c2]
  - @cat-factory/contracts@0.307.0
  - @cat-factory/kernel@0.297.0

## 1.0.69

### Patch Changes

- Updated dependencies [792ecde]
  - @cat-factory/kernel@0.296.1

## 1.0.68

### Patch Changes

- Updated dependencies [fc56d82]
- Updated dependencies [fc9afb4]
  - @cat-factory/contracts@0.306.0
  - @cat-factory/kernel@0.296.0

## 1.0.67

### Patch Changes

- Updated dependencies [edd4fd0]
  - @cat-factory/kernel@0.295.0
  - @cat-factory/contracts@0.305.0

## 1.0.66

### Patch Changes

- Updated dependencies [36e0c9b]
  - @cat-factory/contracts@0.304.0
  - @cat-factory/kernel@0.294.1

## 1.0.65

### Patch Changes

- Updated dependencies [569181d]
  - @cat-factory/contracts@0.303.0
  - @cat-factory/kernel@0.294.0

## 1.0.64

### Patch Changes

- Updated dependencies [1a0b593]
  - @cat-factory/contracts@0.302.0
  - @cat-factory/kernel@0.293.0

## 1.0.63

### Patch Changes

- Updated dependencies [7d1477c]
  - @cat-factory/kernel@0.292.2

## 1.0.62

### Patch Changes

- Updated dependencies [c09ddbe]
  - @cat-factory/kernel@0.292.1

## 1.0.61

### Patch Changes

- Updated dependencies [fc4a1e4]
  - @cat-factory/contracts@0.301.0
  - @cat-factory/kernel@0.292.0

## 1.0.60

### Patch Changes

- Updated dependencies [ee733ee]
  - @cat-factory/contracts@0.300.0
  - @cat-factory/kernel@0.291.0

## 1.0.59

### Patch Changes

- Updated dependencies [01086d8]
  - @cat-factory/contracts@0.299.1
  - @cat-factory/kernel@0.290.1

## 1.0.58

### Patch Changes

- Updated dependencies [1bcdacc]
  - @cat-factory/kernel@0.290.0

## 1.0.57

### Patch Changes

- Updated dependencies [195b248]
  - @cat-factory/contracts@0.299.0
  - @cat-factory/kernel@0.289.1

## 1.0.56

### Patch Changes

- Updated dependencies [bc2478d]
  - @cat-factory/contracts@0.298.0
  - @cat-factory/kernel@0.289.0

## 1.0.55

### Patch Changes

- Updated dependencies [a634746]
  - @cat-factory/contracts@0.297.0
  - @cat-factory/kernel@0.288.0

## 1.0.54

### Patch Changes

- Updated dependencies [7893f35]
  - @cat-factory/contracts@0.296.0
  - @cat-factory/kernel@0.287.0

## 1.0.53

### Patch Changes

- Updated dependencies [07ff467]
  - @cat-factory/contracts@0.295.0
  - @cat-factory/kernel@0.286.3

## 1.0.52

### Patch Changes

- Updated dependencies [9b3473a]
  - @cat-factory/contracts@0.294.0
  - @cat-factory/kernel@0.286.2

## 1.0.51

### Patch Changes

- Updated dependencies [b889842]
  - @cat-factory/kernel@0.286.1

## 1.0.50

### Patch Changes

- Updated dependencies [b25732f]
  - @cat-factory/contracts@0.293.0
  - @cat-factory/kernel@0.286.0

## 1.0.49

### Patch Changes

- Updated dependencies [7119ca7]
  - @cat-factory/contracts@0.292.2
  - @cat-factory/kernel@0.285.3

## 1.0.48

### Patch Changes

- Updated dependencies [57a7ecd]
  - @cat-factory/contracts@0.292.1
  - @cat-factory/kernel@0.285.2

## 1.0.47

### Patch Changes

- Updated dependencies [5f6699a]
  - @cat-factory/contracts@0.292.0
  - @cat-factory/kernel@0.285.1

## 1.0.46

### Patch Changes

- Updated dependencies [22b2459]
- Updated dependencies [2428b6b]
  - @cat-factory/kernel@0.285.0
  - @cat-factory/contracts@0.291.0

## 1.0.45

### Patch Changes

- Updated dependencies [19baddf]
  - @cat-factory/kernel@0.284.0

## 1.0.44

### Patch Changes

- Updated dependencies [31f43c1]
  - @cat-factory/contracts@0.290.0
  - @cat-factory/kernel@0.283.0

## 1.0.43

### Patch Changes

- Updated dependencies [3ff215a]
  - @cat-factory/contracts@0.289.1
  - @cat-factory/kernel@0.282.1

## 1.0.42

### Patch Changes

- Updated dependencies [e3cf16a]
  - @cat-factory/contracts@0.289.0
  - @cat-factory/kernel@0.282.0

## 1.0.41

### Patch Changes

- Updated dependencies [83764b5]
  - @cat-factory/contracts@0.288.0
  - @cat-factory/kernel@0.281.3

## 1.0.40

### Patch Changes

- Updated dependencies [1fbd83c]
- Updated dependencies [00228c6]
  - @cat-factory/contracts@0.287.1
  - @cat-factory/kernel@0.281.2

## 1.0.39

### Patch Changes

- Updated dependencies [bf473bd]
  - @cat-factory/contracts@0.287.0
  - @cat-factory/kernel@0.281.1

## 1.0.38

### Patch Changes

- Updated dependencies [4715b74]
- Updated dependencies [8c1d8a6]
  - @cat-factory/contracts@0.286.0
  - @cat-factory/kernel@0.281.0

## 1.0.37

### Patch Changes

- Updated dependencies [afe1250]
  - @cat-factory/contracts@0.285.0
  - @cat-factory/kernel@0.280.0

## 1.0.36

### Patch Changes

- Updated dependencies [e3fdc15]
  - @cat-factory/contracts@0.284.0
  - @cat-factory/kernel@0.279.3

## 1.0.35

### Patch Changes

- Updated dependencies [3036af7]
  - @cat-factory/kernel@0.279.2

## 1.0.34

### Patch Changes

- Updated dependencies [de7caaf]
  - @cat-factory/contracts@0.283.1
  - @cat-factory/kernel@0.279.1

## 1.0.33

### Patch Changes

- Updated dependencies [f0e1c45]
  - @cat-factory/kernel@0.279.0

## 1.0.32

### Patch Changes

- Updated dependencies [6ad1d8b]
  - @cat-factory/contracts@0.283.0
  - @cat-factory/kernel@0.278.0

## 1.0.31

### Patch Changes

- Updated dependencies [a596b9c]
  - @cat-factory/contracts@0.282.0
  - @cat-factory/kernel@0.277.0

## 1.0.30

### Patch Changes

- Updated dependencies [2585b2f]
  - @cat-factory/contracts@0.281.0
  - @cat-factory/kernel@0.276.0

## 1.0.29

### Patch Changes

- Updated dependencies [faddbf5]
  - @cat-factory/contracts@0.280.0
  - @cat-factory/kernel@0.275.4

## 1.0.28

### Patch Changes

- Updated dependencies [8a06abc]
- Updated dependencies [8a06abc]
  - @cat-factory/contracts@0.279.0
  - @cat-factory/kernel@0.275.3

## 1.0.27

### Patch Changes

- Updated dependencies [11f9efa]
  - @cat-factory/contracts@0.278.0
  - @cat-factory/kernel@0.275.2

## 1.0.26

### Patch Changes

- Updated dependencies [c44e9d7]
  - @cat-factory/contracts@0.277.0
  - @cat-factory/kernel@0.275.1

## 1.0.25

### Patch Changes

- Updated dependencies [dfa4a8e]
  - @cat-factory/kernel@0.275.0

## 1.0.24

### Patch Changes

- Updated dependencies [3e9a6af]
  - @cat-factory/contracts@0.276.0
  - @cat-factory/kernel@0.274.0

## 1.0.23

### Patch Changes

- Updated dependencies [a62bcf8]
- Updated dependencies [fe8ca56]
- Updated dependencies [2544fb3]
  - @cat-factory/kernel@0.273.0
  - @cat-factory/contracts@0.275.0

## 1.0.22

### Patch Changes

- Updated dependencies [35bc18f]
- Updated dependencies [882b94f]
- Updated dependencies [f2ead2a]
  - @cat-factory/kernel@0.272.0
  - @cat-factory/contracts@0.274.0

## 1.0.21

### Patch Changes

- Updated dependencies [6e07961]
- Updated dependencies [9f9c240]
  - @cat-factory/kernel@0.271.0
  - @cat-factory/contracts@0.273.0

## 1.0.20

### Patch Changes

- Updated dependencies [6c6dd0c]
- Updated dependencies [70745b6]
  - @cat-factory/kernel@0.270.0
  - @cat-factory/contracts@0.272.0

## 1.0.19

### Patch Changes

- Updated dependencies [55310f6]
- Updated dependencies [55310f6]
  - @cat-factory/contracts@0.271.0
  - @cat-factory/kernel@0.269.0

## 1.0.18

### Patch Changes

- Updated dependencies [17687a1]
  - @cat-factory/contracts@0.270.0
  - @cat-factory/kernel@0.268.0

## 1.0.17

### Patch Changes

- Updated dependencies [01bb6d2]
- Updated dependencies [f0154ce]
- Updated dependencies [eac67c5]
- Updated dependencies [2b74bd0]
  - @cat-factory/contracts@0.269.0
  - @cat-factory/kernel@0.267.0

## 1.0.16

### Patch Changes

- Updated dependencies [eaab22a]
  - @cat-factory/contracts@0.268.0
  - @cat-factory/kernel@0.266.0

## 1.0.15

### Patch Changes

- Updated dependencies [74ea2bc]
  - @cat-factory/contracts@0.267.0
  - @cat-factory/kernel@0.265.0

## 1.0.14

### Patch Changes

- Updated dependencies [1c8df4a]
  - @cat-factory/contracts@0.266.0
  - @cat-factory/kernel@0.264.0

## 1.0.13

### Patch Changes

- Updated dependencies [6637bbd]
  - @cat-factory/contracts@0.265.0
  - @cat-factory/kernel@0.263.0

## 1.0.12

### Patch Changes

- Updated dependencies [be9b8dc]
  - @cat-factory/contracts@0.264.0
  - @cat-factory/kernel@0.262.2

## 1.0.11

### Patch Changes

- Updated dependencies [1025674]
- Updated dependencies [e5f7eb0]
  - @cat-factory/contracts@0.263.0
  - @cat-factory/kernel@0.262.1

## 1.0.10

### Patch Changes

- Updated dependencies [8cbd518]
- Updated dependencies [8cbd518]
- Updated dependencies [7a2730a]
  - @cat-factory/contracts@0.262.0
  - @cat-factory/kernel@0.262.0

## 1.0.9

### Patch Changes

- Updated dependencies [f7882cf]
- Updated dependencies [e6aa37d]
- Updated dependencies [aabfb4d]
  - @cat-factory/contracts@0.261.1
  - @cat-factory/kernel@0.261.0

## 1.0.8

### Patch Changes

- Updated dependencies [9d6bce0]
  - @cat-factory/kernel@0.260.0

## 1.0.7

### Patch Changes

- Updated dependencies [24f76f1]
- Updated dependencies [964cfa6]
  - @cat-factory/contracts@0.261.0
  - @cat-factory/kernel@0.259.0

## 1.0.6

### Patch Changes

- Updated dependencies [ae44914]
- Updated dependencies [4be3510]
  - @cat-factory/contracts@0.260.0
  - @cat-factory/kernel@0.258.0

## 1.0.5

### Patch Changes

- Updated dependencies [11dae5b]
  - @cat-factory/contracts@0.259.0
  - @cat-factory/kernel@0.257.0

## 1.0.4

### Patch Changes

- Updated dependencies [6076cf1]
- Updated dependencies [2fdb08d]
- Updated dependencies [11a2966]
  - @cat-factory/kernel@0.256.0
  - @cat-factory/contracts@0.258.0

## 1.0.3

### Patch Changes

- Updated dependencies [00bff05]
  - @cat-factory/contracts@0.257.0
  - @cat-factory/kernel@0.255.1

## 1.0.2

### Patch Changes

- Updated dependencies [ab0c228]
  - @cat-factory/contracts@0.256.0
  - @cat-factory/kernel@0.255.0

## 1.0.1

### Patch Changes

- Updated dependencies [ee6ce7c]
  - @cat-factory/kernel@0.254.0
  - @cat-factory/contracts@0.255.0

## 1.0.0

### Major Changes

- 16576d6: Close the deployment extension-seam gaps a consumer build hit: every app-owned registry is now
  reachable from the documented boot entry point, and the prompt-fragment pool is injected rather than
  a module global.

  An org package outside this repo built a proprietary reusable operation against the PUBLISHED
  `@cat-factory/*` packages and reported nine gaps. Each seam it hit typechecks, boots, passes CI, and
  is either unreachable from the supported entry point or silently inert once reached. None showed up
  in our own tests because the worked example lives INSIDE this repo, where the composition root calls
  `buildNodeContainer` directly and every package resolves to one copy on disk.

  **Breaking, `@cat-factory/prompt-fragments`.** `registerPromptFragment(s)`,
  `clearRegisteredPromptFragments`, `universalFragments`, `registerTaskTypeDefaultFragments`,
  `clearRegisteredTaskTypeDefaultFragments` and `defaultFragmentIdsForTaskType` are REMOVED. They were
  two module globals, correct only while every reader resolved the same physical copy of the package;
  a `workspace:*` dependency publishes as an EXACT version, so a consumer floating the range onto a
  newer patch got two copies, the registration landed in one, the server read the other, and every
  task of the operation was seeded with fragment ids that folded nothing. Replaced by the app-owned
  `PromptFragmentRegistry` (kernel), injected by reference:
  `promptFragmentRegistryWithBuiltins()` news one carrying the shipped catalog, and it is an option on
  `start()` / `startLocal()` / the Worker overrides. `getFragment` remains, narrowed to the shipped
  catalog. One behaviour change rides along: `registerTaskTypeDefaults` REPLACES a built-in per-type
  set instead of silently unioning with it, so a deployment can now remove a shipped default; spread
  `DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS` to keep both.

  **Also breaking (internal surfaces, pre-1.0, no shims).** `validateRegistrations` /
  `collectRegistrationProblems` take their registries as ONE `registries` object (a facade passes its
  container) instead of seven hand-listed optional fields; that hand-list is why the local mothership
  boot validated five registries while its own comment claimed parity with `start()`, so a custom task
  type naming an unregistered pipeline booted clean on a laptop and failed on the Postgres path.
  `FragmentLibraryService` takes a `promptFragmentSource` and no longer falls back to the module pool.
  `TaskTypeCreationDefaults.fragmentIdsFor` is async. `PromptFragmentSource` gains a required
  `inProcess` flag, read by boot validation to tell "this deployment registered nothing" from "the
  pool lives on the mothership", which are the same empty list and opposite facts.

  **What is new rather than moved.** `start()` and `startLocal()` gain `pipelineRegistry`,
  `gateRegistry`, `judgeRegistry`, `stepResolverRegistry`, `vcsRegistry` and `promptFragmentRegistry`;
  the seam drift guard now asserts against those ENTRY POINTS rather than only the container builder
  behind them, which is how `pipelineRegistry` sat on `NodeContainerOptions` (documented, guarded,
  green) while no boot path forwarded it and local deployments had no escape hatch at all. A registered
  task type may declare `conditionalFragmentIds`, standing context selected by a `showWhen` condition
  over the answers a case supplied, evaluated once at creation by the same evaluator the form's own
  field visibility uses. A code-registered fragment carrying a `documentRef` now FAILS boot rather than
  being carried through the catalog, rendered as a live source in the library UI, and ignored at run
  time. An unresolvable standing-context id is reported on the run that dropped it instead of only as
  one boot warning that cannot be told apart from a typo, and is COUNTED on the new
  `fragments.dropped_from_run` operational counter, because a run going without its standards still
  succeeds and only a rate says a deployment is doing it every time. And a mothership-mode node reads
  the pool from the mothership over `GET /internal/prompt-fragments`, throwing rather than answering
  with an empty pool.

### Patch Changes

- Updated dependencies [16576d6]
  - @cat-factory/kernel@0.253.0
  - @cat-factory/contracts@0.254.0

## 0.16.0

### Minor Changes

- 5202fb9: An agent now builds against the current design, and is told how to read it

  A linked document was frozen at import time. `probeVersion` existed on every provider and had exactly
  one caller (the fragment-library body cache); nothing on the run path ever looked at the source again.
  So a Figma frame edited after import fed every later run the old markdown, with the run reading as
  perfectly healthy. For a requirements page that is an annoyance; for a design under active iteration
  it means the agent routinely builds the previous revision.

  The linked-context resolution path now re-confirms each document at dispatch, through the kernel
  `LinkedDocumentRefresher` port. The cost model is the design, because that path runs per STEP: probe
  the source's version, compare it against the token the stored body came from, and re-import only what
  actually moved. That comparison needed something to compare to, which the row did not have, so
  `documents.source_version` is new. It is part of the idempotent-reimport comparison even though no
  agent reads it: a Figma file version bumps on any edit anywhere in the file, so leaving a stale token
  on an unchanged body would re-download the whole design on every dispatch, forever. NULL covers three
  cases that all mean "cannot be proven current" and all self-heal on one re-import: an upload, a
  source exposing no version, a row predating the column.

  Three things bound the cost, each a different half of it. The new short-TTL `linkedDocumentVersion`
  cache holds the OUTCOME of the whole ladder rather than the body or just the probe, so a burst of step
  dispatches costs one round trip per document, concurrent dispatches of one document dedupe onto a
  single download, and a source that is DOWN is remembered as down instead of being re-asked by every
  dispatch for as long as the outage lasts (a cache loader that throws caches nothing, which is why the
  failure is a value). It has no refresh window, since the load already is the check. The workspace's
  connection is resolved ONCE per pass for the whole corpus through a new batched
  `resolveConnections`, not per document and again inside each probe. And the per-document fan-out is
  bounded, because a task can attach a corpus budget's worth of Figma frames and each miss expands into
  chunked per-frame node reads. Coherence is invalidation plus the TTL: connect/disconnect drops the
  workspace group, a manual import drops that document's entry. The entry stays enabled on the Worker's
  isolate-safe profile, since an external version token is neither our own mutable state nor in need of
  a bus to heal.

  The ladder also has to CONVERGE, which took one non-obvious hop: `reimport` records the caller's
  probed token when the source's own fetch exposes none. A provider may resolve its version best-effort
  inside `fetchDocument` (GitHub docs' commit sha degrades to null on a rate-limited request) while its
  cheap probe still answers, so the row was left holding null, mismatched the probe on every future
  dispatch, and re-downloaded the whole document forever while reporting "this source has no revision"
  about a source that plainly has one.

  Freshness reaches the agent as a header line, and it is a three-way verdict rather than a boolean.
  `confirmed` contributes `Revision: <token>`, so "which revision did this run build against" is
  answerable from the checkout afterwards. `not-applicable` renders nothing: an upload has no source to
  trail, so a staleness warning there would invent a problem. `unconfirmed` warns and names which of
  four gaps applies, because "reconnect the source", "wait out the outage", "this source has no revision
  to compare" and "this deployment cannot read the credential" are four different fixes and one merged
  "unknown" sends the reader at the wrong one. The last of those is mothership mode, not a defensive
  branch: a node with no main database cannot read a connection sealed with the mothership's key, so the
  read fails permanently and by design, and calling that an outage would send an operator hunting a
  Figma incident that does not exist. One renderer serves both surfaces a document reaches (the
  materialised `.cat-context/` file and the in-prompt injection an INLINE kind gets instead of a
  checkout), because a judge or reviewer scoring against a stale design is the same failure as a
  container agent building from one, and an omitted note reads exactly like a copy that was checked.
  Every gap also increments the new `document.freshness_gap` counter, dimensioned by reason and source:
  each of these conditions repeats per dispatch while it lasts, so the log line answers "what happened
  to this run" and only a rate answers "is this spreading". The refresh still never throws, so a source
  outage costs the run a stale body and a stated warning rather than the run, and the readability
  refusal now runs on the refreshed records, since a page emptied since import is the case most worth
  refusing. That
  includes the REQUIREMENTS REVIEW, the first step of the default pipelines and the one a human signs
  off on, which resolves its attachments through the same refresher rather than reviewing the
  import-time copy while the coder two steps later builds from the current one. A deployment with no
  refresher wired gets no verdict at all rather than a synthesised one: it did not conclude these bodies
  are unverifiable, it never asked.

  Separately, the one fragment that tells an agent how to consume design context was selected by nothing.
  Its `appliesTo` selector is a management-surface hint the run path never drove, it is in no seed pin
  set, and basic mode hides the per-task fragment picker — so the standard case, a designer links a frame
  and starts a run, executed with a design context file on disk and no instruction anywhere to honour it.
  The engine now folds it whenever the run's resolved context carries a design-origin document. The
  trigger is the document rather than the block type, which the retired selector got wrong in both
  directions (it missed a design linked to an unlabelled task and fired on a frontend task with no
  design), and that selector is DELETED rather than left beside the new rule: the deterministic
  selector and the management surface still read it, so leaving it would keep labelling the fragment
  frontend-only while the engine folded it for anything carrying a design. It rides the normal fold, so
  a workspace override still wins and the two-tier brief/full verbosity still applies. The flag settles
  off the corpus read rather than off the finished linked context, so the fragment fold (an LLM call,
  when a standard needs condensing) is not serialised behind a live source probe on every dispatch.

  Two hygiene fixes ride along, both about a claim over a pasted URL. `makeDocumentUrlResolver` now
  consults host-pinned parsers before host-blind ones instead of in registration order: Notion's
  `parseRef` claims any UUID-shaped run anywhere, so registered first it stole a Figma URL whose file key
  carried one, and the point lookup then searched the wrong key space and found nothing — a linked design
  reaching the agent as no context at all. And the two source traits that decide these things
  (`isDesignSource`, `isHostPinnedSource`) live in contracts off one exhaustive `Record`, because the SPA
  has to label a design source too and the run path reads them where no provider is reachable.

  Reviewing: the refresh sits on the hot path of every dispatch, so the thing to check is the ladder's
  short-circuits (an unchanged design must cost one cached round trip and no download, a failed one must
  not be retried per dispatch, and the second dispatch after a re-import must do nothing at all) rather
  than the verdicts. The re-import running INSIDE the cache loader is the deliberate part: it is what
  lets one entry bound the expensive half and dedupe concurrent dispatches, and its consequence is that
  a caller which deduped onto someone else's outcome re-reads the row rather than labelling the body it
  already holds with a revision it does not carry. The `sourceVersion` column is nullable on purpose and
  a backfill would be wrong: an empty string cannot be told apart from a source that genuinely has no
  version, and the two get different treatment.

### Patch Changes

- Updated dependencies [5202fb9]
  - @cat-factory/contracts@0.253.0

## 0.15.78

### Patch Changes

- Updated dependencies [4c071ec]
  - @cat-factory/contracts@0.252.0

## 0.15.77

### Patch Changes

- Updated dependencies [3fbc87e]
- Updated dependencies [c9adc67]
  - @cat-factory/contracts@0.251.0

## 0.15.76

### Patch Changes

- Updated dependencies [e7e27ee]
  - @cat-factory/contracts@0.250.0

## 0.15.75

### Patch Changes

- Updated dependencies [53cd697]
  - @cat-factory/contracts@0.249.0

## 0.15.74

### Patch Changes

- Updated dependencies [6d3f784]
  - @cat-factory/contracts@0.248.0

## 0.15.73

### Patch Changes

- Updated dependencies [0937581]
- Updated dependencies [250b7dc]
  - @cat-factory/contracts@0.247.0

## 0.15.72

### Patch Changes

- Updated dependencies [ec96387]
- Updated dependencies [7f5ed08]
- Updated dependencies [4e4d1b4]
  - @cat-factory/contracts@0.246.0

## 0.15.71

### Patch Changes

- Updated dependencies [10e7a15]
- Updated dependencies [ca213b1]
  - @cat-factory/contracts@0.245.0

## 0.15.70

### Patch Changes

- Updated dependencies [d69115d]
  - @cat-factory/contracts@0.244.0

## 0.15.69

### Patch Changes

- Updated dependencies [bac6776]
- Updated dependencies [3857ea4]
  - @cat-factory/contracts@0.243.0

## 0.15.68

### Patch Changes

- Updated dependencies [e7867db]
- Updated dependencies [00c4d94]
  - @cat-factory/contracts@0.242.0

## 0.15.67

### Patch Changes

- Updated dependencies [c5a1a16]
  - @cat-factory/contracts@0.241.0

## 0.15.66

### Patch Changes

- Updated dependencies [dd90c1e]
- Updated dependencies [289b3de]
- Updated dependencies [dd90c1e]
  - @cat-factory/contracts@0.240.0

## 0.15.65

### Patch Changes

- Updated dependencies [a675c63]
  - @cat-factory/contracts@0.239.0

## 0.15.64

### Patch Changes

- Updated dependencies [aa62acf]
  - @cat-factory/contracts@0.238.0

## 0.15.63

### Patch Changes

- Updated dependencies [99be350]
  - @cat-factory/contracts@0.237.0

## 0.15.62

### Patch Changes

- Updated dependencies [c9c1dd3]
  - @cat-factory/contracts@0.236.0

## 0.15.61

### Patch Changes

- Updated dependencies [cec0c3e]
  - @cat-factory/contracts@0.235.0

## 0.15.60

### Patch Changes

- Updated dependencies [8cbf1a7]
  - @cat-factory/contracts@0.234.0

## 0.15.59

### Patch Changes

- Updated dependencies [ee6601e]
  - @cat-factory/contracts@0.233.0

## 0.15.58

### Patch Changes

- Updated dependencies [937d4af]
  - @cat-factory/contracts@0.232.0

## 0.15.57

### Patch Changes

- Updated dependencies [eb4ca17]
  - @cat-factory/contracts@0.231.0

## 0.15.56

### Patch Changes

- Updated dependencies [1f14793]
  - @cat-factory/contracts@0.230.1

## 0.15.55

### Patch Changes

- Updated dependencies [e7e4404]
  - @cat-factory/contracts@0.230.0

## 0.15.54

### Patch Changes

- Updated dependencies [10e0341]
- Updated dependencies [10e0341]
  - @cat-factory/contracts@0.229.0

## 0.15.53

### Patch Changes

- Updated dependencies [fccb1df]
  - @cat-factory/contracts@0.228.0

## 0.15.52

### Patch Changes

- Updated dependencies [437a0c6]
  - @cat-factory/contracts@0.227.0

## 0.15.51

### Patch Changes

- Updated dependencies [43fd5c0]
  - @cat-factory/contracts@0.226.0

## 0.15.50

### Patch Changes

- Updated dependencies [0456066]
  - @cat-factory/contracts@0.225.0

## 0.15.49

### Patch Changes

- Updated dependencies [f1a6cb3]
- Updated dependencies [cc17221]
- Updated dependencies [889a497]
- Updated dependencies [3605630]
  - @cat-factory/contracts@0.224.0

## 0.15.48

### Patch Changes

- Updated dependencies [36b1853]
  - @cat-factory/contracts@0.223.0

## 0.15.47

### Patch Changes

- Updated dependencies [413095f]
  - @cat-factory/contracts@0.222.0

## 0.15.46

### Patch Changes

- Updated dependencies [04e44f8]
  - @cat-factory/contracts@0.221.0

## 0.15.45

### Patch Changes

- Updated dependencies [c8ba2cd]
- Updated dependencies [807e442]
- Updated dependencies [807e442]
- Updated dependencies [175f78f]
- Updated dependencies [807e442]
  - @cat-factory/contracts@0.220.0

## 0.15.44

### Patch Changes

- Updated dependencies [1106c93]
  - @cat-factory/contracts@0.219.0

## 0.15.43

### Patch Changes

- Updated dependencies [f63145d]
- Updated dependencies [3b88f66]
  - @cat-factory/contracts@0.218.0

## 0.15.42

### Patch Changes

- Updated dependencies [7f86f07]
  - @cat-factory/contracts@0.217.0

## 0.15.41

### Patch Changes

- Updated dependencies [87161e8]
  - @cat-factory/contracts@0.216.0

## 0.15.40

### Patch Changes

- Updated dependencies [96ad850]
- Updated dependencies [96ad850]
  - @cat-factory/contracts@0.215.0

## 0.15.39

### Patch Changes

- Updated dependencies [4c26c01]
  - @cat-factory/contracts@0.214.0

## 0.15.38

### Patch Changes

- Updated dependencies [924c6f9]
  - @cat-factory/contracts@0.213.0

## 0.15.37

### Patch Changes

- Updated dependencies [233e279]
- Updated dependencies [54d531d]
  - @cat-factory/contracts@0.212.0

## 0.15.36

### Patch Changes

- Updated dependencies [87ed4f9]
  - @cat-factory/contracts@0.211.0

## 0.15.35

### Patch Changes

- Updated dependencies [874d684]
  - @cat-factory/contracts@0.210.1

## 0.15.34

### Patch Changes

- Updated dependencies [73708cf]
- Updated dependencies [876ee2d]
  - @cat-factory/contracts@0.210.0

## 0.15.33

### Patch Changes

- Updated dependencies [0a1170e]
  - @cat-factory/contracts@0.209.0

## 0.15.32

### Patch Changes

- Updated dependencies [d320539]
  - @cat-factory/contracts@0.208.0

## 0.15.31

### Patch Changes

- Updated dependencies [9e5f785]
  - @cat-factory/contracts@0.207.0

## 0.15.30

### Patch Changes

- Updated dependencies [8fbc0b5]
  - @cat-factory/contracts@0.206.1

## 0.15.29

### Patch Changes

- Updated dependencies [5511cdc]
  - @cat-factory/contracts@0.206.0

## 0.15.28

### Patch Changes

- Updated dependencies [1441041]
  - @cat-factory/contracts@0.205.0

## 0.15.27

### Patch Changes

- Updated dependencies [0b52df7]
  - @cat-factory/contracts@0.204.0

## 0.15.26

### Patch Changes

- Updated dependencies [54e6a45]
- Updated dependencies [08e9bcc]
- Updated dependencies [a7aae8a]
  - @cat-factory/contracts@0.203.0

## 0.15.25

### Patch Changes

- Updated dependencies [9d303f0]
  - @cat-factory/contracts@0.202.0

## 0.15.24

### Patch Changes

- Updated dependencies [0bffe55]
- Updated dependencies [1cd9d73]
  - @cat-factory/contracts@0.201.0

## 0.15.23

### Patch Changes

- Updated dependencies [d9789f9]
  - @cat-factory/contracts@0.200.0

## 0.15.22

### Patch Changes

- Updated dependencies [123ac6f]
  - @cat-factory/contracts@0.199.0

## 0.15.21

### Patch Changes

- Updated dependencies [99412e2]
  - @cat-factory/contracts@0.198.0

## 0.15.20

### Patch Changes

- Updated dependencies [be7fe66]
  - @cat-factory/contracts@0.197.0

## 0.15.19

### Patch Changes

- Updated dependencies [83fd037]
  - @cat-factory/contracts@0.196.0

## 0.15.18

### Patch Changes

- Updated dependencies [7248b72]
- Updated dependencies [449d856]
  - @cat-factory/contracts@0.195.0

## 0.15.17

### Patch Changes

- 7ed2bc0: Condense long best-practice standards for the agents that re-read them every turn.

  Coding agents (`coder`, `fixer`, `ci-fixer`, `conflict-resolver`) re-send their whole system
  prompt on every turn of a long loop, so each folded standard is billed again and again. The
  two-tier `body` / `brief` split exists for exactly that, but only the code-authored built-in
  catalog could supply a brief: a managed standard — hand-authored, repo-sourced, or a living
  Confluence/Notion page, and including one that OVERRIDES a built-in id — always folded in full.
  Those are the long ones.

  A tenant can now link a short version (a field in the library editor, or a `brief:` frontmatter
  key on a repo-sourced guideline file), and a standard over ~1,500 characters with none gets one
  generated by a small model, persisted, and reused by every later dispatch. The stored brief is
  keyed by a fingerprint of the body it condensed, so an edit, a repo resync, or a re-resolved
  living document invalidates it and the next coding dispatch re-condenses — no change feed, and
  the same mechanism covers all three. Reviewer and planner kinds are untouched: they read the full
  standard, and never trigger a condensation.

  A standard that cannot be usefully shortened is a normal outcome — the generator is told to keep
  every rule even where that means returning the text near its original length — so that verdict is
  recorded against the body too, and the full standard is folded without asking again until someone
  edits it. A provider failure is deliberately not recorded, so a bad minute never disables
  condensation for a fragment. Whether a condensation is usable is judged as a proportion of the
  standard it condenses rather than a fixed length, so a very long standard condensed well is
  accepted while a short one restated at almost full length is not.

  Adds `prompt_fragments.brief` and a `fragment_briefs` table on both runtimes. No shipped built-in
  reaches the threshold, so the built-in catalog is unchanged; a deployment with no model wired
  folds full bodies exactly as before, as does every failure on the path — a brief changes how a
  standard is stated, never what it requires.

- Updated dependencies [7ed2bc0]
  - @cat-factory/contracts@0.194.0

## 0.15.16

### Patch Changes

- Updated dependencies [85efc27]
- Updated dependencies [9794c19]
  - @cat-factory/contracts@0.193.0

## 0.15.15

### Patch Changes

- Updated dependencies [57e1195]
  - @cat-factory/contracts@0.192.0

## 0.15.14

### Patch Changes

- Updated dependencies [e087b40]
  - @cat-factory/contracts@0.191.0

## 0.15.13

### Patch Changes

- Updated dependencies [0eacaa2]
  - @cat-factory/contracts@0.190.0

## 0.15.12

### Patch Changes

- Updated dependencies [a8cc6b2]
  - @cat-factory/contracts@0.189.0

## 0.15.11

### Patch Changes

- Updated dependencies [ac832b9]
  - @cat-factory/contracts@0.188.0

## 0.15.10

### Patch Changes

- Updated dependencies [22d82ac]
  - @cat-factory/contracts@0.187.0

## 0.15.9

### Patch Changes

- Updated dependencies [b75a08a]
  - @cat-factory/contracts@0.186.0

## 0.15.8

### Patch Changes

- Updated dependencies [9d965c9]
  - @cat-factory/contracts@0.185.0

## 0.15.7

### Patch Changes

- Updated dependencies [58e06a2]
  - @cat-factory/contracts@0.184.0

## 0.15.6

### Patch Changes

- Updated dependencies [65b87c1]
- Updated dependencies [df48cb0]
  - @cat-factory/contracts@0.183.0

## 0.15.5

### Patch Changes

- Updated dependencies [b30cc6e]
  - @cat-factory/contracts@0.182.0

## 0.15.4

### Patch Changes

- Updated dependencies [c47eb66]
  - @cat-factory/contracts@0.181.0

## 0.15.3

### Patch Changes

- Updated dependencies [bead6df]
  - @cat-factory/contracts@0.180.0

## 0.15.2

### Patch Changes

- Updated dependencies [68f0edd]
  - @cat-factory/contracts@0.179.0

## 0.15.1

### Patch Changes

- Updated dependencies [9d8fe9b]
  - @cat-factory/contracts@0.178.0

## 0.15.0

### Minor Changes

- cf2779a: Cut coder token/quota burn and fix subscription usage attribution.

  - **Two-tier best-practice fragments.** `PromptFragment` gains an optional `brief` body; a new `brief-standards` trait marks the high-turn code-writing implementer kinds (coder, fixer, ci-fixer, conflict-resolver) so their system prompt — re-sent on every turn of a long agentic loop — folds the condensed standard instead of the full body. Reviewer/planner kinds keep the full text. The brief is resolved ALONGSIDE the body it condenses and never re-looked-up by id, so a workspace/account-tier row that overrides a built-in id folds its own full body rather than the built-in's condensed text. Backward-safe: no `brief` / unmarked kind ⇒ the full body, unchanged. `brief` authored for every built-in fragment that can reach an implementer kind (node, react, design, migration).
  - **No-progress guard on the claude-code path.** The `ProgressGuard` that killed rabbit-holing Pi runs (no-edit probing, error-retry loops, web rabbit-holes) now also runs on the claude-code subscription harness, which previously had only the wall-clock watchdog. Its no-edit exploration allowance scales with the task-estimator's complexity when an estimator ran (conservative default otherwise), so it only ever catches absolute spiralling and never truncates a productively-editing run. Subagent dispatches (`Agent`/`Task`) are neutral to the no-edit bound, since the edits they make are invisible on the parent stream.
  - **Trimmed always-on prompt bloat.** The harness no longer appends its own spec-reading block (deduped — it now comes solely from the backend `spec-aware` trait, so a spec-aware Pi run stops carrying it twice); the blueprint orientation note is included only when the checkout (or, for a multi-repo run, one of its legs) actually ships `blueprints/`; and the spec-reading guidance now steers agents to the overview index and the relevant-and-adjacent shards in one line.
  - **Fix subscription token-usage attribution.** A container/subscription step's `token_usage` row recorded `provider='unknown'` / `model=''` because the durable poll path rebuilt a stripped job handle without the dispatch model. It now forwards `step.model`, so the row records the real provider + model.

### Patch Changes

- Updated dependencies [cf2779a]
  - @cat-factory/contracts@0.177.0

## 0.14.24

### Patch Changes

- Updated dependencies [1947062]
  - @cat-factory/contracts@0.176.0

## 0.14.23

### Patch Changes

- Updated dependencies [1c12289]
  - @cat-factory/contracts@0.175.0

## 0.14.22

### Patch Changes

- Updated dependencies [55747c5]
  - @cat-factory/contracts@0.174.0

## 0.14.21

### Patch Changes

- Updated dependencies [cab85c5]
  - @cat-factory/contracts@0.173.0

## 0.14.20

### Patch Changes

- Updated dependencies [8afa4ae]
  - @cat-factory/contracts@0.172.0

## 0.14.19

### Patch Changes

- Updated dependencies [f0e9bab]
  - @cat-factory/contracts@0.171.0

## 0.14.18

### Patch Changes

- Updated dependencies [583fc80]
- Updated dependencies [640cadd]
  - @cat-factory/contracts@0.170.0

## 0.14.17

### Patch Changes

- Updated dependencies [968a214]
  - @cat-factory/contracts@0.169.0

## 0.14.16

### Patch Changes

- Updated dependencies [c95600b]
  - @cat-factory/contracts@0.168.0

## 0.14.15

### Patch Changes

- Updated dependencies [df9ca7d]
  - @cat-factory/contracts@0.167.0

## 0.14.14

### Patch Changes

- Updated dependencies [600a8ad]
  - @cat-factory/contracts@0.166.0

## 0.14.13

### Patch Changes

- Updated dependencies [3949f82]
  - @cat-factory/contracts@0.165.0

## 0.14.12

### Patch Changes

- Updated dependencies [5a58b9d]
  - @cat-factory/contracts@0.164.0

## 0.14.11

### Patch Changes

- Updated dependencies [55e0a85]
  - @cat-factory/contracts@0.163.0

## 0.14.10

### Patch Changes

- Updated dependencies [ecd68c5]
  - @cat-factory/contracts@0.162.0

## 0.14.9

### Patch Changes

- Updated dependencies [7c6bd77]
  - @cat-factory/contracts@0.161.0

## 0.14.8

### Patch Changes

- Updated dependencies [239788a]
  - @cat-factory/contracts@0.160.1

## 0.14.7

### Patch Changes

- Updated dependencies [93496b0]
  - @cat-factory/contracts@0.160.0

## 0.14.6

### Patch Changes

- Updated dependencies [15249df]
  - @cat-factory/contracts@0.159.0

## 0.14.5

### Patch Changes

- Updated dependencies [2323df1]
  - @cat-factory/contracts@0.158.0

## 0.14.4

### Patch Changes

- 71bd63f: Review adherence reports + per-agent effort self-assessment, surfaced in run details.

  - **Best-practice fragments are now fed granularly.** Each selected best-practice standard is
    folded into an agent's system prompt as its OWN delimited, labelled block (carrying a stable
    id and its human title) instead of one `\n\n`-joined blob, so an agent can tell the standards
    apart and cite one by title. Fragment titles are threaded end-to-end (resolver → resolved
    fragments → prompt composer).
  - **Code + PR review agents report best-practice adherence.** The `reviewer` companion and the
    `pr-reviewer` now return a `fragmentAdherence` list — per standard, a 1..10 rating of how well
    the reviewed change/PR adheres plus the issues that standard surfaced — recorded on the step
    (`PipelineStep.fragmentAdherence`) and surfaced in run details + the PR-review window. When no
    best-practice standards were reachable, the reviewer states so explicitly.
  - **Every container agent reports effort.** Each container agent is asked to write a short effort
    self-assessment (how hard the work was, what reduced its effectiveness, the key obstacles) to a
    sentinel file the harness lifts onto the result; the engine records it (`PipelineStep.effortReport`)
    and it is shown in run details. Flows through both runtimes (verbatim on Cloudflare/local, coerced
    on the self-hosted runner pool). Requires the bumped executor-harness image.
  - **Fragment management UI.** The fragment editor gains an "auto-generate title" button (an inline
    LLM call) and inline editing of a hand-authored fragment's title / summary / body / tags.

- Updated dependencies [71bd63f]
  - @cat-factory/contracts@0.157.0

## 0.14.3

### Patch Changes

- Updated dependencies [3c7d62b]
  - @cat-factory/contracts@0.156.0

## 0.14.2

### Patch Changes

- Updated dependencies [916278b]
  - @cat-factory/contracts@0.155.0

## 0.14.1

### Patch Changes

- Updated dependencies [91ea6b7]
  - @cat-factory/contracts@0.154.2

## 0.14.0

### Minor Changes

- b1d1e2c: Add a programmatic seam to mark prompt fragments as the default for every new task of a
  given type. A deployment (local or hosted) registers its own custom fragments via
  `registerPromptFragments(...)` and then declares them as the per-type default via the new
  `registerTaskTypeDefaultFragments(taskType, fragmentIds)` — so e.g. every new
  documentation or review task starts with that org's guidance, with no per-block or
  per-workspace configuration. The board seeds a new task's `fragmentIds` through
  `defaultFragmentIdsForTaskType(taskType)`; the built-in document writing-style default is
  now expressed through this seam and augmented (never replaced) by registered ids.

## 0.13.48

### Patch Changes

- Updated dependencies [021f2a0]
  - @cat-factory/contracts@0.154.1

## 0.13.47

### Patch Changes

- Updated dependencies [a14fe03]
  - @cat-factory/contracts@0.154.0

## 0.13.46

### Patch Changes

- Updated dependencies [8053837]
  - @cat-factory/contracts@0.153.0

## 0.13.45

### Patch Changes

- Updated dependencies [7f54858]
  - @cat-factory/contracts@0.152.2

## 0.13.44

### Patch Changes

- Updated dependencies [f2b25ba]
  - @cat-factory/contracts@0.152.1

## 0.13.43

### Patch Changes

- Updated dependencies [e679977]
  - @cat-factory/contracts@0.152.0

## 0.13.42

### Patch Changes

- Updated dependencies [9450415]
  - @cat-factory/contracts@0.151.0

## 0.13.41

### Patch Changes

- Updated dependencies [54c44bb]
  - @cat-factory/contracts@0.150.0

## 0.13.40

### Patch Changes

- Updated dependencies [0abcf31]
- Updated dependencies [a53bbf7]
  - @cat-factory/contracts@0.149.0

## 0.13.39

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/contracts@0.148.1

## 0.13.38

### Patch Changes

- Updated dependencies [1f5f5bc]
  - @cat-factory/contracts@0.148.0

## 0.13.37

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/contracts@0.147.1

## 0.13.36

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/contracts@0.147.0

## 0.13.35

### Patch Changes

- Updated dependencies [60c0a1e]
  - @cat-factory/contracts@0.146.0

## 0.13.34

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/contracts@0.145.0

## 0.13.33

### Patch Changes

- Updated dependencies [5924903]
  - @cat-factory/contracts@0.144.0

## 0.13.32

### Patch Changes

- Updated dependencies [f5ddc02]
  - @cat-factory/contracts@0.143.0

## 0.13.31

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/contracts@0.142.0

## 0.13.30

### Patch Changes

- Updated dependencies [e618bf5]
  - @cat-factory/contracts@0.141.0

## 0.13.29

### Patch Changes

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/contracts@0.140.0

## 0.13.28

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/contracts@0.139.0

## 0.13.27

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/contracts@0.138.0

## 0.13.26

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/contracts@0.137.0

## 0.13.25

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/contracts@0.136.0

## 0.13.24

### Patch Changes

- Updated dependencies [06a094a]
  - @cat-factory/contracts@0.135.0

## 0.13.23

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/contracts@0.134.0

## 0.13.22

### Patch Changes

- Updated dependencies [9e9127f]
  - @cat-factory/contracts@0.133.0

## 0.13.21

### Patch Changes

- Updated dependencies [b414f34]
  - @cat-factory/contracts@0.132.0

## 0.13.20

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/contracts@0.131.0

## 0.13.19

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/contracts@0.130.0

## 0.13.18

### Patch Changes

- Updated dependencies [f7e7139]
  - @cat-factory/contracts@0.129.0

## 0.13.17

### Patch Changes

- Updated dependencies [6c4bcef]
  - @cat-factory/contracts@0.128.2

## 0.13.16

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/contracts@0.128.1

## 0.13.15

### Patch Changes

- Updated dependencies [1e684b7]
  - @cat-factory/contracts@0.128.0

## 0.13.14

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

## 0.13.13

### Patch Changes

- Updated dependencies [d1a4129]
  - @cat-factory/contracts@0.127.0

## 0.13.12

### Patch Changes

- Updated dependencies [5072999]
  - @cat-factory/contracts@0.126.0

## 0.13.11

### Patch Changes

- Updated dependencies [4f936de]
  - @cat-factory/contracts@0.125.0

## 0.13.10

### Patch Changes

- Updated dependencies [127fe3e]
  - @cat-factory/contracts@0.124.1

## 0.13.9

### Patch Changes

- Updated dependencies [08a7da2]
  - @cat-factory/contracts@0.124.0

## 0.13.8

### Patch Changes

- Updated dependencies [eeadc97]
  - @cat-factory/contracts@0.123.1

## 0.13.7

### Patch Changes

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/contracts@0.123.0

## 0.13.6

### Patch Changes

- Updated dependencies [0f3c88b]
  - @cat-factory/contracts@0.122.0

## 0.13.5

### Patch Changes

- Updated dependencies [ed77be6]
  - @cat-factory/contracts@0.121.2

## 0.13.4

### Patch Changes

- Updated dependencies [9aa9e19]
  - @cat-factory/contracts@0.121.1

## 0.13.3

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/contracts@0.121.0

## 0.13.2

### Patch Changes

- Updated dependencies [a2db337]
  - @cat-factory/contracts@0.120.0

## 0.13.1

### Patch Changes

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
  - @cat-factory/contracts@0.119.0

## 0.13.0

### Minor Changes

- f97d5d3: Add `seedMigrationPlan`, the `preset_tech_migration` plan post-processor (tech-migration slice T7),
  landed unwired ahead of the preset registration (T8). Running at ingest after the generic
  phase-template normalizer, it stamps per-item spawn DECORATION keyed off each item's migration phase:
  the blast-zone report + transition-design document(s) become `document` tasks with `.md` target paths
  under the frozen `migrationDocsDir` on the doc-quick pipeline; coverage/delivery/verify items stay
  ordinary coding tasks routed by the policy's estimate rules. It wires the phase-2 confidence case — a
  single human-gated `confidence-case.md` document that `dependsOn` every surviving coverage item,
  canonicalizing a planner-authored one or injecting it when omitted — caps phase-2 coverage at eight
  items (scrubbing dropped ids from every surviving `dependsOn`), and applies the human-review gate
  policy (confidence-case + transition-design are always gated as the coverage→delivery control points;
  `humanReview` additionally gates the informational blast-zone report). Every spawned item carries the
  `migration.*` fragments that APPLY to its primary producer — `coder` for coding items, `doc-writer`
  for documents — via the new `migrationFragmentIdsFor(agentKind)` from `@cat-factory/prompt-fragments`
  (alongside the full-set `MIGRATION_FRAGMENT_IDS` T8's `defaultFragmentIds` reuses), so a document
  task no longer receives the coding-only behaviour-preservation standard (manual `fragmentIds` pins
  bypass `appliesTo` at run time, so the scoping is applied at stamp time). The shared `seedPlan`
  primitives (`strInput`/`fileSlug`/`uniqueDocPath`/`mergeGateOverride`) are lifted into
  `presets/plan-helpers.ts` so docs-refresh and tech-migration share one implementation. Pure + total;
  no runtime behaviour changes until T8 registers the preset.

## 0.12.0

### Minor Changes

- f1906cb: Initiative presets — slice 8 (docs-refresh pilot): register the `preset_docs_refresh` initiative
  preset — the FIRST real preset, and the registration pattern the technological-migration preset
  (T8) copies. Incorporates inter-phase follow-up #1 (adopt the generic `phaseTemplate` shape
  enforcement; do NOT hand-roll phase shaping in `seedPlan`); follow-up #2 (templated pipelines)
  stays deferred.

  - **agents** (`presets/docs-refresh/preset.ts`): the `preset_docs_refresh` registration — a
    descriptor FORM (doc types, placement mode, docs/diagrams/business-rules dirs with `showWhen`,
    scope hint, human-review opt-in, writing-style fragments), a `detect` probe reusing slice 6's
    `detectDocsLayout`, a declarative `phaseTemplate` (Foundations `required` + one OPTIONAL phase
    per doc type, `allowAdditionalPhases: false`), `promptAdditions` turning the analyst into a
    documentation gap-auditor and shaping the planner's phases + item granularity, and a `seedPlan`
    that stamps per-item spawn DECORATION only (pipeline per doc type, `taskType`/`docKind`/derived
    `targetPath`, writing-style `fragmentIds`, and — when human review is opted in — the per-run
    `spawn.gates` override at each pipeline's review point). Registered as a module side effect on
    import (the `@cat-factory/gates` pattern), so it is available in every deployment with no
    per-facade wiring — the two runtimes cannot drift on it. Plan SHAPE lives in the template + the
    generic ingest normalizer; DECORATION lives in `seedPlan`; the two never overlap.
  - **kernel** (`domain/seed.ts`): the preset's interviewer-free planning pipeline
    `pl_initiative_docs` (`[initiative-analyst, initiative-planner, initiative-committer]`, no human
    gates — the form is the interview; per-task review is the opt-in gate-override seam) + its
    exported id `INITIATIVE_DOCS_PIPELINE_ID`, plus `DOCUMENT_QUICK_PIPELINE_ID` for the README /
    diagram spawn pipeline.
  - **prompt-fragments**: re-export the `styleFragments` collection so the preset builds its
    writing-style form options from the same source of truth (no duplicated fragment ids/labels).

  Backend-only: the SPA renders the new preset from its descriptor with no frontend changes (the
  slice-4 generic form renderer + picker), and human review maps to SPAWNED-task gates, so the
  planning run stays unattended.

## 0.11.0

### Minor Changes

- 4a7fca0: Technological-migration initiative — slice T4: the `migration.*` best-practice prompt-fragment
  collection.

  Adds a new `migration` collection to the universal fragment catalog — the default fragment pack
  the upcoming `preset_tech_migration` initiative preset applies to the coding, testing and document
  agents it spawns. Three fragments, each a standalone standard folded verbatim into an agent's
  system prompt when selected:

  - **`migration.discipline`** — the invariant methodology: establish the full (direct + transitive)
    blast zone before touching anything, pin observable behaviour with tests BEFORE the swap
    (coverage before delivery), decide the backwards-compatibility degree deliberately, deliver
    incrementally with the behaviour suite green throughout, and finish by removing the old path.
  - **`migration.behaviour-preservation`** — how to prove the swap is behaviour-neutral: characterize
    at a seam ABOVE the swapped layer, assert observable outcomes (never raw vendor error codes,
    implicit ordering, or locking/isolation mechanics), preserve the edge-case semantics that silently
    differ across technologies (NULL vs empty string, precision/rounding, collation, pagination,
    identity exposure), and keep set-based work set-based — never a per-row app-side loop (the N+1
    regression trap).
  - **`migration.confidence-case`** — the authoring standard for the evidence-backed coverage proof a
    human audits before delivery: a per-touchpoint map of inventory row to NAMED covering tests and
    the behaviour each pins, gaps/waivers justified against the coverage bar, risk mitigations, and
    the safety nets — grounded evidence, not assertion, from the single writer of the case document.

  Pure additive catalog data (existing fragments and the catalog contract are unchanged); wired into
  `FRAGMENTS`, resolvable via `getFragment`. The prompt-fragments package gains a vitest suite that
  guards the collection's catalog invariants (namespacing/shape conventions, wiring + resolution,
  global id uniqueness) — deliberately not the fragment prose, which is its own source of truth.

## 0.10.27

### Patch Changes

- Updated dependencies [b35e1a0]
  - @cat-factory/contracts@0.118.0

## 0.10.26

### Patch Changes

- Updated dependencies [4a3e536]
  - @cat-factory/contracts@0.117.0

## 0.10.25

### Patch Changes

- Updated dependencies [18a9cb5]
  - @cat-factory/contracts@0.116.1

## 0.10.24

### Patch Changes

- Updated dependencies [bc77f89]
  - @cat-factory/contracts@0.116.0

## 0.10.23

### Patch Changes

- Updated dependencies [802fc05]
  - @cat-factory/contracts@0.115.0

## 0.10.22

### Patch Changes

- Updated dependencies [6198b08]
  - @cat-factory/contracts@0.114.0

## 0.10.21

### Patch Changes

- Updated dependencies [14eac27]
  - @cat-factory/contracts@0.113.0

## 0.10.20

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/contracts@0.112.0

## 0.10.19

### Patch Changes

- Updated dependencies [fdba1ea]
  - @cat-factory/contracts@0.111.0

## 0.10.18

### Patch Changes

- Updated dependencies [10787c4]
  - @cat-factory/contracts@0.110.1

## 0.10.17

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/contracts@0.110.0

## 0.10.16

### Patch Changes

- Updated dependencies [9ea1e77]
  - @cat-factory/contracts@0.109.0

## 0.10.15

### Patch Changes

- Updated dependencies [e66accb]
  - @cat-factory/contracts@0.108.1

## 0.10.14

### Patch Changes

- Updated dependencies [1afa003]
- Updated dependencies [f91b99d]
  - @cat-factory/contracts@0.108.0

## 0.10.13

### Patch Changes

- Updated dependencies [bf31df7]
  - @cat-factory/contracts@0.107.0

## 0.10.12

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/contracts@0.106.0

## 0.10.11

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [e5b9462]
  - @cat-factory/contracts@0.105.0

## 0.10.10

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/contracts@0.104.0

## 0.10.9

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/contracts@0.103.0

## 0.10.8

### Patch Changes

- Updated dependencies [076d02f]
  - @cat-factory/contracts@0.102.0

## 0.10.7

### Patch Changes

- Updated dependencies [029a689]
  - @cat-factory/contracts@0.101.1

## 0.10.6

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/contracts@0.101.0

## 0.10.5

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/contracts@0.100.0

## 0.10.4

### Patch Changes

- Updated dependencies [3981bbb]
  - @cat-factory/contracts@0.99.0

## 0.10.3

### Patch Changes

- Updated dependencies [cfcb6c7]
- Updated dependencies [48f9d97]
  - @cat-factory/contracts@0.98.0

## 0.10.2

### Patch Changes

- Updated dependencies [102c049]
  - @cat-factory/contracts@0.97.0

## 0.10.1

### Patch Changes

- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/contracts@0.96.0

## 0.10.0

### Minor Changes

- 8eaa3f2: Universal writing-style fragments for document-authoring tasks (WS2 of the
  documentation-type task initiative). Two built-in fragments — `style.anti-llmisms`
  (cut the machine-written tells: filler intensifiers, hedging, throat-clearing,
  summary-that-restates, bullet inflation) and `style.concise-actionable` (lead with
  the point, active voice, one idea per paragraph, every recommendation names an actor
  and an action) — now guide the document-authoring agents.

  They reach those agents through a new `doc-aware` capability trait, the document
  analogue of `code-aware`: the `doc-researcher` / `doc-outliner` / `doc-writer` /
  `doc-finalizer` kinds carry it on their definitions and the `doc-reviewer` companion
  carries it too, so the execution engine folds the block's selected style fragments
  into each one's system prompt via the same `AgentContextBuilder` path `code-aware`
  uses — no parallel fragment path in the prompt builders. Because the reviewer sees
  the same bodies, the style guidance is both the writer's instruction and the
  reviewer's criteria (an explicit clause in the companion prompt says so).

  A new document task is pre-seeded with both style fragments (default-on,
  user-removable like any block pin) via `DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS`, seeded
  onto the task's `fragmentIds` in `BoardService.addTask` — the selection default lives
  at task creation, not hard-coded in a prompt.

  The fragment "add" pickers (service, task, and workspace-default) now render their
  options as labelled per-category sections instead of one flat list, so the catalog
  stays navigable now that a block can pin across two tracks at once — the technical
  collections (Node / React / …) and the Writing-style fragments.

## 0.9.55

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/contracts@0.95.0

## 0.9.54

### Patch Changes

- Updated dependencies [6edcce0]
  - @cat-factory/contracts@0.94.0

## 0.9.53

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/contracts@0.93.0

## 0.9.52

### Patch Changes

- Updated dependencies [1d738f7]
  - @cat-factory/contracts@0.92.0

## 0.9.51

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/contracts@0.91.0

## 0.9.50

### Patch Changes

- Updated dependencies [b928904]
  - @cat-factory/contracts@0.90.0

## 0.9.49

### Patch Changes

- Updated dependencies [7fa7578]
  - @cat-factory/contracts@0.89.0

## 0.9.48

### Patch Changes

- Updated dependencies [55661f4]
  - @cat-factory/contracts@0.88.0

## 0.9.47

### Patch Changes

- Updated dependencies [ca5c3e8]
  - @cat-factory/contracts@0.87.0

## 0.9.46

### Patch Changes

- Updated dependencies [b216fdc]
  - @cat-factory/contracts@0.86.0

## 0.9.45

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/contracts@0.85.0

## 0.9.44

### Patch Changes

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
  - @cat-factory/contracts@0.84.0

## 0.9.43

### Patch Changes

- Updated dependencies [e0aab3f]
  - @cat-factory/contracts@0.83.0

## 0.9.42

### Patch Changes

- Updated dependencies [5ce03c6]
  - @cat-factory/contracts@0.82.0

## 0.9.41

### Patch Changes

- Updated dependencies [4a7a3f1]
  - @cat-factory/contracts@0.81.3

## 0.9.40

### Patch Changes

- Updated dependencies [6243bea]
  - @cat-factory/contracts@0.81.2

## 0.9.39

### Patch Changes

- Updated dependencies [2a91615]
  - @cat-factory/contracts@0.81.1

## 0.9.38

### Patch Changes

- Updated dependencies [67d3876]
  - @cat-factory/contracts@0.81.0

## 0.9.37

### Patch Changes

- Updated dependencies [d7f6e1c]
  - @cat-factory/contracts@0.80.1

## 0.9.36

### Patch Changes

- Updated dependencies [120de05]
  - @cat-factory/contracts@0.80.0

## 0.9.35

### Patch Changes

- Updated dependencies [dcc8b32]
  - @cat-factory/contracts@0.79.0

## 0.9.34

### Patch Changes

- Updated dependencies [16ee6cc]
  - @cat-factory/contracts@0.78.1

## 0.9.33

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/contracts@0.78.0

## 0.9.32

### Patch Changes

- Updated dependencies [9e93fe8]
- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [edf4e69]
- Updated dependencies [f21279e]
- Updated dependencies [6c51e31]
  - @cat-factory/contracts@0.77.0

## 0.9.31

### Patch Changes

- Updated dependencies [762fe66]
  - @cat-factory/contracts@0.76.0

## 0.9.30

### Patch Changes

- Updated dependencies [fb53662]
  - @cat-factory/contracts@0.75.0

## 0.9.29

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/contracts@0.74.0

## 0.9.28

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/contracts@0.73.0

## 0.9.27

### Patch Changes

- Updated dependencies [70e321b]
  - @cat-factory/contracts@0.72.0

## 0.9.26

### Patch Changes

- Updated dependencies [77c6842]
  - @cat-factory/contracts@0.71.0

## 0.9.25

### Patch Changes

- Updated dependencies [2e1354f]
  - @cat-factory/contracts@0.70.1

## 0.9.24

### Patch Changes

- Updated dependencies [b4c7e60]
  - @cat-factory/contracts@0.70.0

## 0.9.23

### Patch Changes

- Updated dependencies [f568a8c]
  - @cat-factory/contracts@0.69.0

## 0.9.22

### Patch Changes

- Updated dependencies [41203db]
  - @cat-factory/contracts@0.68.0

## 0.9.21

### Patch Changes

- Updated dependencies [cb9e2e3]
  - @cat-factory/contracts@0.67.0

## 0.9.20

### Patch Changes

- Updated dependencies [1e55e77]
  - @cat-factory/contracts@0.66.1

## 0.9.19

### Patch Changes

- Updated dependencies [ecf4cc1]
  - @cat-factory/contracts@0.66.0

## 0.9.18

### Patch Changes

- Updated dependencies [f9678df]
- Updated dependencies [858799e]
  - @cat-factory/contracts@0.65.0

## 0.9.17

### Patch Changes

- Updated dependencies [9bb75b0]
  - @cat-factory/contracts@0.64.0

## 0.9.16

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/contracts@0.63.0

## 0.9.15

### Patch Changes

- Updated dependencies [f383515]
  - @cat-factory/contracts@0.62.0

## 0.9.14

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/contracts@0.61.0

## 0.9.13

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/contracts@0.60.0

## 0.9.12

### Patch Changes

- Updated dependencies [1952d6b]
  - @cat-factory/contracts@0.59.0

## 0.9.11

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/contracts@0.58.0

## 0.9.10

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/contracts@0.57.0

## 0.9.9

### Patch Changes

- Updated dependencies [21b2096]
  - @cat-factory/contracts@0.56.1

## 0.9.8

### Patch Changes

- Updated dependencies [ad5d3e0]
  - @cat-factory/contracts@0.56.0

## 0.9.7

### Patch Changes

- Updated dependencies [4897078]
  - @cat-factory/contracts@0.55.0

## 0.9.6

### Patch Changes

- Updated dependencies [915861c]
  - @cat-factory/contracts@0.54.0

## 0.9.5

### Patch Changes

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/contracts@0.53.0

## 0.9.4

### Patch Changes

- Updated dependencies [0577404]
  - @cat-factory/contracts@0.52.0

## 0.9.3

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/contracts@0.51.0

## 0.9.2

### Patch Changes

- Updated dependencies [29d8b5d]
  - @cat-factory/contracts@0.50.1

## 0.9.1

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/contracts@0.50.0

## 0.9.0

### Minor Changes

- e0f1149: Design-context sources: add Zeplin, generalize the abstraction, drop the Claude Design backend connector.

  - **New source: Zeplin** (`source='zeplin'`, per-workspace Bearer PAT) — a real server-fetchable
    REST handoff source exposing screens, components and design tokens. On by default; a no-op until a
    workspace connects it.
  - **De-Figma-shaped abstraction:** Figma and Zeplin now map into a shared, source-neutral
    `DesignContext` model rendered by `renderDesignContext` (`integrations/documents/design.logic.ts`).
    The per-source prompt fragments collapse into a single `design.context` fragment.
  - **Breaking — Claude Design backend connector removed.** Its only real read path is login-bound
    (Claude Code's `DesignSync` / `/design-sync`, via the user's claude.ai login), so a headless
    multi-tenant backend can never authenticate. The provider, the `'claude-design'` source value, the
    descriptor `credentialScope` field, and the entire per-user `user_document_connections` store
    (D1 + Drizzle tables, repositories, kernel ports, scope-aware `DocumentConnectionService`) are
    removed — all document sources are workspace-scoped again. The supported Claude Design workflow is
    now: `/design-sync` into the repo → commit → agents read it as checkout files. Stale
    `user_document_connections` rows are dropped (D1 migration `0020`, Drizzle drop migration); per the
    pre-1.0 policy there is no data migration.

### Patch Changes

- Updated dependencies [e0f1149]
  - @cat-factory/contracts@0.49.0

## 0.8.9

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/contracts@0.48.0

## 0.8.8

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/contracts@0.47.0

## 0.8.7

### Patch Changes

- Updated dependencies [704c99e]
  - @cat-factory/contracts@0.46.0

## 0.8.6

### Patch Changes

- Updated dependencies [c2ec53b]
  - @cat-factory/contracts@0.45.1

## 0.8.5

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/contracts@0.45.0

## 0.8.4

### Patch Changes

- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/contracts@0.44.0

## 0.8.3

### Patch Changes

- Updated dependencies [8fad695]
  - @cat-factory/contracts@0.43.3

## 0.8.2

### Patch Changes

- Updated dependencies [fb339db]
  - @cat-factory/contracts@0.43.2

## 0.8.1

### Patch Changes

- c11a0cc: Add a `prepublishOnly` build hook so each package is compiled to `dist/` before it is
  packed, regardless of how publish is invoked. `dist/` is gitignored and was only built by
  the canonical `pnpm ci:publish` flow, so a bare `pnpm publish` could ship an empty shell
  (this is what happened to `@cat-factory/gitlab` and `@cat-factory/provider-s3`). The hook
  removes that footgun for every publishable library.
- Updated dependencies [c11a0cc]
  - @cat-factory/contracts@0.43.1

## 0.8.0

### Minor Changes

- eab73b8: feat(documents): add Claude Design as a per-user design-context document source

  Implements the Claude Design half of the design record in
  `backend/docs/figma-claude-design-context.md`. Claude Design becomes a new
  `DocumentSourceProvider` (`source='claude-design'`) that reuses the whole documents
  integration (link plumbing, controller, `.cat-context/` materialization, prompt
  fragment), with a deterministic design-system normalizer that turns a project's
  `_ds_manifest.json` / `@dsCard`-marked component HTML + CSS custom properties into the
  same `### Components` / `### Design tokens` Markdown shape the Figma provider emits — so
  it earns its place over a plain HTML upload.

  Auth is a **personal per-user PAT**, supported on every runtime: a new descriptor flag
  `credentialScope: 'user'` routes such a source to a new per-user
  `user_document_connections` store (D1 ⇄ Drizzle, encrypted at rest under a distinct HKDF
  info), keyed by the acting user and never shared with the workspace. `DocumentConnectionService`
  becomes scope-aware; the import path threads the acting user. Workspace-scoped sources
  (Notion/Confluence/GitHub/Figma/Linear) are unchanged. The acting user falls back to the
  empty user id ONLY when auth is disabled (dev-open / single-user local mode) so those
  deployments still connect; when auth is enabled the controller fails closed with a 401
  rather than silently using the shared empty-user bucket.

  Claude Design is **opt-in**, not on by default: its credentialed project-read API is
  still provisional (the read is claude.ai-login-bound, no per-user service token yet), so
  it is excluded from the default `DOCUMENT_SOURCES` set and must be enabled explicitly
  (`DOCUMENT_SOURCES=…,claude-design`) once the API is real — every other source stays on
  by default.

  Also hoists the host-pinned `safeFetch`/SSRF guard/capped-read into a shared
  `documents/http.ts` reused by Figma and Claude Design. Wired symmetrically into both
  facades and gated by a new cross-runtime conformance case (per-user connect → list →
  disconnect).

- eab73b8: feat(documents): add Figma as a design-context document source

  Implements the Figma half of the design record in
  `backend/docs/figma-claude-design-context.md`. Figma becomes a new
  `DocumentSourceProvider` (`source='figma'`) authenticated by a per-workspace
  personal access token, reusing the whole documents integration (connection table,
  sealing, link plumbing, controller, `.cat-context/` materialization). `fetchDocument`
  renders a frame/file's layout tree, text, components-used and (Enterprise-gated)
  design tokens to Markdown, with a best-effort rendered-preview URL on a reference
  line. Wired symmetrically into both the Cloudflare and Node facades (and the
  `DOCUMENT_SOURCES` allow-list), gated by a cross-runtime conformance case. Adds the
  `design.figma-context` prompt fragment for frontend agents. (Claude Design ships in a
  companion changeset.)

  Also makes a URL pasted into a block description auto-match its imported document by the
  document's stable `(source, externalId)` — canonicalised through the providers'
  `parseRef` (`AgentContextBuilder.documentUrlResolver`) — instead of by exact URL-string
  equality, which silently failed for a real Figma share link (title path segment, dash
  node id, `&t=` tracking params) whose canonical stored `url` omits that noise.

### Patch Changes

- Updated dependencies [eab73b8]
- Updated dependencies [eab73b8]
  - @cat-factory/contracts@0.43.0

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

- 8d11833: Companion agents + acceptance-test rework (the structured spec replaces the
  client-only scenario surface), plus a vocabulary split so "requirements" (the
  linked-prose context review) and "spec" (the structured in-repo document) are no
  longer the same word.

  - **Companion agents.** A companion grades a prior producer step's output, returns
    an overall quality rating (0..1), and — below the step's threshold (default 0.8) —
    loops the producer back for automatic rework BEFORE a human is asked, failing the
    run (`companion_rejected`) once the rework budget is spent. Companions declare an
    allow-list of target kinds and are placed as their own chain step in the pipeline
    builder (with a per-step `thresholds` array, parallel to `gates`). Built-ins:
    `architect-companion`, `spec-companion`, and `reviewer` reframed as the coder's
    companion. Wired into `ExecutionService` (`evaluateCompanion` + a unified rework
    revision path shared with the human "request changes" flow).
  - **Companion-gated requirements rework.** The per-block requirements review's
    rework step is now gated by a quality companion: below threshold the reworked doc
    is NOT accepted (the review stays `ready`), and the companion's challenge is
    surfaced in the review window and fed into the next rework. Persisted on
    `requirement_reviews.companion` (D1 migration 0036 + Drizzle).
  - **Acceptance tests via the spec.** The client-only scenarios store/UI is removed;
    the structured Given/When/Then acceptance scenarios live in the service spec
    (authored by the `spec-writer`, reviewed on its gated step) and are derived into
    Gherkin. The redundant `acceptance` polish agent is dropped; `playwright` still
    writes the runnable tests. `spec-writer`'s prompt now treats complete
    acceptance-scenario coverage as a first-class deliverable.
  - **`architect` is now a container agent** that explores the repo (read-only, like
    `analysis`) before proposing. Both read-only kinds share one reusable execution
    path: a new harness `/explore` endpoint (dispatch kind `explore`) clones the branch,
    runs the agent read-only and returns its prose report/proposal — making no commit,
    opening no PR, and (unlike `/run`) NOT treating an edit-free run as a failure. A
    shared read-only guardrail is appended to their system prompts.
  - **Companion rework correctness.** When a companion loops a producer back, EVERY step
    between the producer and the companion is now reset and re-run (clearing stale
    container job handles), so an intermediate container step re-dispatches fresh work
    instead of re-attaching to its evicted job. The automatic rework budget now counts
    only automatic attempts (`companion.attempts`); a human "request changes" on a
    companion's gate re-runs the producer without consuming it.
  - **Rename: requirements → spec** for the structured family. In-repo `requirements/`
    → `spec/` (`spec.json`, `spec/features/*.feature`; legacy `requirements/`
    relocated on first run); `RequirementsDoc` → `SpecDoc`; `requirements-writer` →
    `spec-writer`; the pipeline analyst `requirements` → `requirements-review`;
    `pl_requirements` → `pl_spec`. The context-review family (`RequirementReview*`,
    `requirement_reviews`) keeps the `requirements` name.

  The harness image changed (the `/requirements` endpoint + `requirements/` paths
  became `/spec` + `spec/`), so `@cat-factory/executor-harness` and the
  `deploy/backend` image tag are bumped to 1.0.6 and must be re-published + rolled out.

- 88b3170: Separate reusable libraries from deployment. The libraries now publish to npm
  (`main`/`exports` point at built `dist`, with `files` + `publishConfig`); the
  worker is no longer private and exposes its handler + Durable Object / Workflow
  classes for deployments to re-export, and ships its D1 migrations. The frontend
  SPA is now the `@cat-factory/app` Nuxt layer. Deployments live in `deploy/backend`
  and `deploy/frontend`; the runner image publishes to GHCR. Releases are managed
  with changesets.
- 8eed95b: Service-scoped best-practice prompt fragments, delivered by agent traits.

  A service (frame block) now owns an explicit selection of best-practice / guideline
  fragments — its programming standards — chosen from the **universal fragment pool**.
  That pool is the built-in catalog plus any fragments a deployment registers at startup
  via the new `registerPromptFragment` seam in `@cat-factory/prompt-fragments` (mirroring
  `registerAgentKind` / the model-provider registry); `GET /prompt-fragments` serves the
  merged pool. A workspace can also configure a **default set new services inherit**
  (`GET|PUT /workspaces/:ws/service-fragment-defaults`), seeded onto a frame's
  `serviceFragmentIds` when it is created (board drop, repo import, or bootstrap).

  Agents gain first-class **capability traits** (`@cat-factory/agents`): a registry of
  standard + custom traits with `traitsFor` / `hasTrait`, assignable to built-in kinds and
  to custom kinds via `AgentKindDefinition.traits`. Two standard traits ship:

  - **`code-aware`** (coder, ci-fixer, fixer, reviewer, architect): the running service's
    selected fragments are folded into the agent's system prompt, unioned with the block's
    own manual pins. Other kinds keep only their block pins.
  - **`spec-aware`** (every code-touching kind): the agent's system prompt gains guidance to
    read the in-repo `spec/` artifact (overview.md → rules.md → features/\*.feature →
    spec.json) and treat it as the source of truth for required behaviour.

  This **replaces the automatic per-run relevance selector**: fragment delivery is now
  explicit (the service's selection) and trait-gated (code-aware) rather than guessed per
  run. Per-block manual pins (`Block.fragmentIds`) still apply to that block's own agents.
  The tenant fragment **library** (account/workspace CRUD + repo sources) remains as a
  management surface but no longer feeds the run path.

  Persistence is mirrored on both runtimes: a `service_fragment_ids` column on `blocks`
  and a `workspace_fragment_defaults` table (Cloudflare D1 migration `0040` +
  `D1ServiceFragmentDefaultsRepository`; Node Drizzle schema/migration +
  `DrizzleServiceFragmentDefaultsRepository`), with the cross-runtime conformance suite
  asserting the workspace-default round-trip, new-service inheritance, and the
  code-aware-only folding on both facades. The UI adds a per-service "Service best
  practices" picker in the inspector and a "Default service best practices" workspace
  settings panel.

  BREAKING (Node facade dev/test only): the Drizzle migration lineage under
  `runtimes/node/drizzle/` was squashed into a single fresh baseline migration — the prior
  incremental migrations had a forked, non-commutative history (left by merging two
  branches) that broke `drizzle-kit generate`/`check`. There are no production Postgres
  deployments, so existing dev/test databases should be dropped and re-created from the
  new baseline rather than migrated. CI now runs `db:check` to keep the lineage honest.

### Patch Changes

- 8eed38c: Author relative imports with explicit `.js` extensions across the shared backend
  packages so their emitted `dist` is directly resolvable by Node's ESM loader (no
  bundler required). This lets the Node runtime run the built output on plain Node
  (`node dist/main.js`) — no tsx, no esbuild bundle — and is inert for the Cloudflare
  Worker (wrangler bundles regardless). `handlebars/runtime` is imported as
  `handlebars/runtime.js` for the same reason (its type is sourced from the full
  package, type-only). No behaviour or public-API change.
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
