# @cat-factory/conformance

## 0.47.18

### Patch Changes

- Updated dependencies [332ef26]
  - @cat-factory/agents@0.146.5
  - @cat-factory/integrations@0.166.21
  - @cat-factory/kernel@0.323.1
  - @cat-factory/orchestration@0.290.1
  - @cat-factory/server@0.307.8
  - @cat-factory/gates@0.11.20
  - @cat-factory/prompt-fragments@1.1.16

## 0.47.17

### Patch Changes

- 4b1c76f: Bound the activity-scaled Reports breakdowns, and give run activity its own repository axis
  
  Two findings from a review of the account Reports surface.
  
  **The two breakdowns that grow with activity were served and rendered whole.**
  `spend.byRun` is one row per pipeline execution that spent anything in the window and
  `spend.byTicket` one per tracker issue a run touched; every other dimension keys on a catalog
  and stays in the tens. The panel read returned all of them and rendered each as a DOM row, so
  a busy account opening a `90d` window paid for the tail twice. The port's "no row cap"
  rationale had gone stale: it enumerated the bounded dimensions and named `ticket` as the one
  exception, having been written before `run` was added, which is strictly worse. The public
  `GET /api/v1/usage/spend` had already capped for its own reasons, so one service was capping
  for one caller and not the other.
  
  `ReportsService.summarize` now caps those two at 100 slices and reports each cap on the
  projection as `capped: [{ dimension, returned, omitted }]`; an empty array means every
  breakdown is complete, and the panel prints the note under the capped card. The cap is applied
  to the aggregated rows rather than pushed into the `GROUP BY` as a SQL `LIMIT`, which is what
  keeps `omitted` an exact count, and the window totals still fold from an uncapped breakdown,
  so what a cap costs the reader is the identity of the tail and never its money. Both callers
  of the port now cap through the one `capSlices` helper; the public `GET /api/v1/usage/spend`
  keeps reporting it as the boolean `truncated` its frozen response schema carries.
  
  **Run activity gained a `repo` dimension.** Spend answered what a repository cost while
  activity could not answer how much work went into it or how much of it failed. The recorded
  reason was that a run is already counted under the service owning its repository, which holds
  only where services map one-to-one onto repositories: several services on one repository is
  the ordinary monorepo shape, and no read publishes that mapping for a caller to fold the
  counts itself. It is one `GROUP BY` over `agent_runs` through the same two primary-key joins
  the `repo` spend dimension uses, so neither can fan the run count out.
  
  Two internal wire changes ride along, per the pre-1.0 rule for internal shapes: the reports
  projection gains `capped` and `activity.byRepo`, and `ReportActivityDimension` gains `repo`.
  The public API is untouched (it publishes no activity axis). In the panel, the repository
  breakdown moves out of the spend-only card row and into the paired spend + activity dimension
  switch beside board, service and task type.
- Updated dependencies [4b1c76f]
  - @cat-factory/contracts@0.334.0
  - @cat-factory/kernel@0.323.0
  - @cat-factory/orchestration@0.290.0
  - @cat-factory/agents@0.146.4
  - @cat-factory/gates@0.11.19
  - @cat-factory/integrations@0.166.20
  - @cat-factory/prompt-fragments@1.1.15
  - @cat-factory/server@0.307.7

## 0.47.16

### Patch Changes

- Updated dependencies [4b41767]
  - @cat-factory/agents@0.146.3
  - @cat-factory/integrations@0.166.19
  - @cat-factory/orchestration@0.289.3
  - @cat-factory/server@0.307.6

## 0.47.15

### Patch Changes

- Updated dependencies [6d4b02a]
  - @cat-factory/kernel@0.322.2
  - @cat-factory/agents@0.146.2
  - @cat-factory/gates@0.11.18
  - @cat-factory/integrations@0.166.18
  - @cat-factory/orchestration@0.289.2
  - @cat-factory/prompt-fragments@1.1.14
  - @cat-factory/server@0.307.5

## 0.47.14

### Patch Changes

- Updated dependencies [be0b953]
  - @cat-factory/agents@0.146.1
  - @cat-factory/integrations@0.166.17
  - @cat-factory/kernel@0.322.1
  - @cat-factory/orchestration@0.289.1
  - @cat-factory/server@0.307.4
  - @cat-factory/gates@0.11.17
  - @cat-factory/prompt-fragments@1.1.13

## 0.47.13

### Patch Changes

- Updated dependencies [27b22a3]
  - @cat-factory/contracts@0.333.0
  - @cat-factory/kernel@0.322.0
  - @cat-factory/orchestration@0.289.0
  - @cat-factory/agents@0.146.0
  - @cat-factory/gates@0.11.16
  - @cat-factory/integrations@0.166.16
  - @cat-factory/prompt-fragments@1.1.12
  - @cat-factory/server@0.307.3

## 0.47.12

### Patch Changes

- 90a915e: Attribute an inline agent step's tokens to the credential that served them, not to the path it
  ran on. A deployment serving inline steps through a subscription harness (the local facade's
  ambient claude/codex CLI, or a container on a leased subscription token) filed every
  non-containerised kind as metered spend with a blank vendor, so companion and research steps
  were counted as money on a plan that costs nothing per token. A resolved model now declares
  its billing, both metering sites forward it, and a subscription row always names a vendor.
  
  The step-level rollup carries the billing kind too (`PipelineStep.usageBilling`), so
  `metrics.costEstimate`, which is a list-price estimate for both billing kinds, renders labelled
  instead of reading as spend.
  
  The declaration travels on the resolved model, so it has to survive the provider decorators
  stacked above it: the AI SDK's `wrapLanguageModel` returns a fresh object that keeps only the
  members it knows about, and the inline concurrency limiter wraps every subscription vendor by
  default. Both decorators now wrap through `wrapModelPreservingMarkers`, which also keeps the
  existing `reportsOwnLlmCalls` marker readable wherever a decorator sits above the model that
  declares it.
  
  A consensus panel reports the billing its models agree on, so a diverted step on one
  subscription credential stops filing as metered too. A panel straddling two credentials keeps
  the metered default, because it did spend real money and one ledger row cannot state both.
- Updated dependencies [e1f6325]
- Updated dependencies [90a915e]
  - @cat-factory/contracts@0.332.0
  - @cat-factory/integrations@0.166.15
  - @cat-factory/orchestration@0.288.6
  - @cat-factory/agents@0.145.3
  - @cat-factory/kernel@0.321.3
  - @cat-factory/gates@0.11.15
  - @cat-factory/prompt-fragments@1.1.11
  - @cat-factory/server@0.307.2

## 0.47.11

### Patch Changes

- Updated dependencies [e0eed49]
  - @cat-factory/kernel@0.321.2
  - @cat-factory/agents@0.145.2
  - @cat-factory/orchestration@0.288.5
  - @cat-factory/server@0.307.1
  - @cat-factory/gates@0.11.14
  - @cat-factory/integrations@0.166.14
  - @cat-factory/prompt-fragments@1.1.10

## 0.47.10

### Patch Changes

- Updated dependencies [7d899c4]
  - @cat-factory/contracts@0.331.0
  - @cat-factory/server@0.307.0
  - @cat-factory/integrations@0.166.13
  - @cat-factory/kernel@0.321.1
  - @cat-factory/agents@0.145.1
  - @cat-factory/gates@0.11.13
  - @cat-factory/orchestration@0.288.4
  - @cat-factory/prompt-fragments@1.1.9

## 0.47.9

### Patch Changes

- Updated dependencies [82a3b94]
  - @cat-factory/agents@0.145.0
  - @cat-factory/orchestration@0.288.3
  - @cat-factory/server@0.306.7

## 0.47.8

### Patch Changes

- Updated dependencies [17e29df]
  - @cat-factory/agents@0.144.0
  - @cat-factory/orchestration@0.288.2
  - @cat-factory/server@0.306.6

## 0.47.7

### Patch Changes

- Updated dependencies [71a39dc]
- Updated dependencies [dc12c82]
  - @cat-factory/orchestration@0.288.1
  - @cat-factory/contracts@0.330.0
  - @cat-factory/kernel@0.321.0
  - @cat-factory/server@0.306.5
  - @cat-factory/agents@0.143.1
  - @cat-factory/gates@0.11.12
  - @cat-factory/integrations@0.166.12
  - @cat-factory/prompt-fragments@1.1.8

## 0.47.6

### Patch Changes

- Updated dependencies [3ae3386]
  - @cat-factory/contracts@0.329.0
  - @cat-factory/kernel@0.320.0
  - @cat-factory/agents@0.143.0
  - @cat-factory/orchestration@0.288.0
  - @cat-factory/gates@0.11.11
  - @cat-factory/integrations@0.166.11
  - @cat-factory/prompt-fragments@1.1.7
  - @cat-factory/server@0.306.4

## 0.47.5

### Patch Changes

- Updated dependencies [c030a23]
  - @cat-factory/kernel@0.319.1
  - @cat-factory/orchestration@0.287.4
  - @cat-factory/server@0.306.3
  - @cat-factory/agents@0.142.6
  - @cat-factory/gates@0.11.10
  - @cat-factory/integrations@0.166.10
  - @cat-factory/prompt-fragments@1.1.6

## 0.47.4

### Patch Changes

- Updated dependencies [69b9ed4]
  - @cat-factory/kernel@0.319.0
  - @cat-factory/agents@0.142.5
  - @cat-factory/gates@0.11.9
  - @cat-factory/integrations@0.166.9
  - @cat-factory/orchestration@0.287.3
  - @cat-factory/prompt-fragments@1.1.5
  - @cat-factory/server@0.306.2

## 0.47.3

### Patch Changes

- Updated dependencies [abc1af8]
  - @cat-factory/server@0.306.1

## 0.47.2

### Patch Changes

- a8f8d14: Close the two accepted findings from the second acceptance-suite gap report (now
  [ADR 0060](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0060-headless-caller-diagnosability.md)).
  
  The four SDK transports no longer render every transport failure as `failed to reach <baseUrl>`,
  which is a reachability verdict made without classifying the cause and the one provably false
  reading when the deployment answered nine calls a moment earlier and then restarted. Each client
  classifies the cause from its own runtime's codes, states only what that cause supports, adds what
  the client had already seen from the origin, and keeps the runtime's chain verbatim at the end. The
  error class and its cause are unchanged, so this is additive.
  
  On `/api/v1` (surface version 1.61.0, additive): `GET /api/v1/environments/manifest-types` publishes
  every id a service's `custom` provisioning may pin, because nothing validates a pin on the way in
  and an unserved id currently fails at the `deployer` step of a run already paid for. Alongside it,
  the service provisioning variant gains an `infraless` member, which
  `PATCH /api/v1/services/{serviceId}` accepts to TAKE A PIN BACK; omitting the key still leaves the
  stored pin alone, so no request a consumer sends today changes meaning. The undo is a member rather
  than a `provisioning: null` because a null-valued optional field is not expressible from the Go,
  Java or Python clients, which each drop one when serializing.
- Updated dependencies [a8f8d14]
  - @cat-factory/contracts@0.328.0
  - @cat-factory/server@0.306.0
  - @cat-factory/agents@0.142.4
  - @cat-factory/gates@0.11.8
  - @cat-factory/integrations@0.166.8
  - @cat-factory/kernel@0.318.1
  - @cat-factory/orchestration@0.287.2
  - @cat-factory/prompt-fragments@1.1.4

## 0.47.1

### Patch Changes

- Updated dependencies [95f75fc]
  - @cat-factory/agents@0.142.3
  - @cat-factory/orchestration@0.287.1
  - @cat-factory/server@0.305.1

## 0.47.0

### Minor Changes

- 08752da: Answering a Coder's question and RULING ON it are now different acts, and a decision the loop
  budget throws away says so.
  
  A local run spent three implementer passes and about €4 producing three commits that reworded one
  comment about a Kubernetes Ingress class, and the fourth walked the wording back to roughly where
  the second left it. Nothing was broken: every part behaved as designed, and the design was the bug.
  
  The Coder asked a question nobody in the loop could answer (which IngressClass the target cluster
  marks as default). Its answerer replied with a standing steer, the same string every time, because
  that is all an unattended caller has. `resolution` did not exist, so the engine had exactly one
  thing it could do with an answered question: fold it into another pass and tell the agent to apply
  it. There was nothing to apply, so the agent did the only thing left and wrote its uncertainty into
  the manifest comment, the README and the commit message, one wording per pass, re-raising the same
  question under a new title each time. The loop ended on `maxLoops`, not on agreement, and then the
  last round's answers were dropped in silence.
  
  **`POST …/follow-ups/…/answer` takes an optional `resolution`.** `answered` (the default, and
  byte-for-byte the old behaviour) means the reply carries something to apply and buys a pass.
  `closed` means the reply rules on the question: it clears the gate identically, spends nothing, and
  rides into every later rework prompt under a heading that says the topic is settled and must not be
  re-argued in the code or the commit message. The answerer picks; the engine does not try to read the
  difference out of prose, which it cannot do. The public-API surface moves to `1.60.0`; the SPA's
  answer box gains a second button.
  
  **Exhausting the send-back budget is no longer indistinguishable from converging.** The gate's
  decision was a boolean whose `false` covered three different situations, one of which was "a
  human's decision is about to be thrown away". It is now a named verdict, and the dropped items are
  stamped `sendBackDropped`, warned about with the budget that ran out, counted under
  `followup.send_back_dropped`, and reported on the pull request. Without the stamp such an item
  stays `answered` with `sentToCoder` false forever, which reads exactly like an answer the Coder
  applied.
  
  **The PR verification report gains a `followUps` section** (payload `version: 10`): what the Coder
  flagged and what was decided, with the three dispositions that mean "not dealt with as triage
  intended" called out above the table rather than left to be derived from a status column. Its
  counts (`total`, `dropped`, `dismissedByPolicy`) are taken over every item the run surfaced rather
  than over the rows the entries cap left visible, and the banner quotes `droppedBudget`, summed over
  the steps that actually dropped something. A pipeline may place more than one follow-up-enabled
  Coder, and a budget summed across all of them reads as half-spent while asserting it was spent.
  
  **A stamped drop is not permanent, and an unbudgeted step is not a drop.** Deciding an item again
  clears `sendBackDropped`, so the send-back the budget could not pay for can be sent once the step
  has a pass to spend; the stamp is terminal in the send-back selection, so left set it made that
  item unsendable forever while the window claimed it had been sent. And a step whose `maxLoops` is
  absent (persisted before the field existed) has the loop UNWIRED rather than exhausted: it passes
  through as before instead of stamping every decided item, warning, and banner-ing a budget of 0/0
  that nobody configured.
  
  **The acceptance suite closes questions instead of answering them.** It was the caller in the story
  above, and its own file header had already reasoned through this exact failure for the clarity-review
  gate. Its steer is a ruling, so it now sends one.
  
  **Fixed alongside, and part of why the agent had so little to work from:** the single-repo coding
  path dropped `job.contextFiles` on the floor. Every sibling caller forwarded them;
  `buildSingleRepoCodingSpec` did not. So a task whose brief was too long for `description` (and
  therefore rode an attached document, which is the documented way to submit a real specification)
  reached the implementer as a prompt naming `.cat-context/<file>.md` beside a checkout that had no
  such directory. The agent rebuilt the brief from whatever summary the prompt carried and filed the
  gap as a follow-up question. Bumps the runner image to `cat-factory-executor:1.130.0`.
  
  **The four SDK clients keep their published follow-up type names.** `PublicFollowUpItemKind` and
  `PublicFollowUpItemStatus` are deduped enums, and adding the report's follow-ups section re-pointed
  both onto a name derived from the section instead: a source break in four released clients,
  arriving as ordinary generated churn. Both are now pinned in the emitter's `INLINE_ENUM_NAMES`, so
  the only change to them is `closed` joining the status list. Python and Java are bumped to `0.5.0`,
  which is what publishes them.

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
  - @cat-factory/orchestration@0.287.0
  - @cat-factory/server@0.305.0
  - @cat-factory/agents@0.142.2
  - @cat-factory/gates@0.11.7
  - @cat-factory/integrations@0.166.7
  - @cat-factory/prompt-fragments@1.1.3

## 0.46.1

### Patch Changes

- Updated dependencies [da77447]
  - @cat-factory/contracts@0.326.0
  - @cat-factory/server@0.304.0
  - @cat-factory/agents@0.142.1
  - @cat-factory/gates@0.11.6
  - @cat-factory/integrations@0.166.6
  - @cat-factory/kernel@0.317.1
  - @cat-factory/orchestration@0.286.1
  - @cat-factory/prompt-fragments@1.1.2

## 0.46.0

### Minor Changes

- 4125beb: Assess a task AFTER the work landed: the `task-reassessor` agent kind.

  A task's complexity / risk / impact ratings were a forecast, made before anyone had written a line,
  and nothing ever revisited them. A pipeline with no `task-estimator` (Simple build, the bug-fix
  presets) had no ratings at all, and a forecast that turned out to be badly wrong left no trace of
  having been wrong.

  `task-reassessor` is the estimator's retrospective twin: a read-only container step that reads the
  change the run actually made and scores the same three axes against it. Placed after the coder it
  either corrects the forecast or produces the first ratings the task ever had, which are the two
  cases this change exists for. It ships in NO preset (it costs a container run per task) and is
  estimate-gatable, so the usual configuration is "measure what the forecast called large".

  It is a KIND rather than a mode of the estimator, and the deciding reason is not taste: the
  estimator is inline by construction (`INLINE_ENGINE_KINDS`, which the preset-satisfiability guard
  keys off, so an inline step must resolve to an inline-usable model) and this one needs a checkout to
  diff. One kind cannot be classified both ways, and either answer is wrong for half its uses. The
  full argument, and the three secondary reasons, are in `backend/docs/task-assessment.md`.

  Behaviour changes worth knowing:

  - **`TaskEstimate` now says what it was formed on.** `basis` (`predicted` / `observed`) plus the last
    reading of the OTHER basis in `supersedes`, which a same-basis re-run inherits rather than
    overwrites, so a retried measurement cannot delete the forecast it is being compared against.
    Both are OPTIONAL on the type
    rather than defaulted into it, because the estimate is stored as a JSON blob read back with no
    schema pass: a row written before this change genuinely carries no basis, and absence reads as
    `predicted` (every one of those rows came from the estimator). A basis this build cannot name
    renders as unrecognised rather than being guessed onto a current member.
  - **An estimate gate's prerequisite is now "a step that PRODUCES an estimate runs earlier"**, not
    "a `task-estimator` runs earlier". One `producesTaskEstimate` predicate in
    `@cat-factory/contracts`, read by the engine's validation, the SPA's pipeline-health advisory and
    the builder's draft warning, which each carried their own copy of the kind id.
  - **`clone.prHead` now names WHICH pull request it fetches**, with a new `prHeadSource` field:
    `task` (the default, the `pr-reviewer`'s declared target, unchanged) or `run` (the PR this run
    opened, the assessor's subject). Declared rather than resolved by a `task ?? run` precedence,
    which would have silently widened the reviewer: a review task whose run also opened a pull request
    would start prefetching a head its review state knows nothing about.
  - **`requirePr` now means two things, split by whether the kind writes on the pull request or reads
    it.** A WRITER (the in-place fixers) still refuses the dispatch, because cloning base would push
    its commits onto the default branch. A READER is SKIPPED before dispatch with a new
    `no_pull_request` step-skip reason: a base checkout holds nothing to measure, and failing would
    end a run whose work has already shipped over a reading nothing gates on. New copy in all ten
    locales.
  - **A pipeline may no longer place a PR-reading step ahead of the step that opens the PR**
    (`assertValidPullRequestReaders`, refused at save and at run start). It would be skipped for want
    of a pull request the very next step creates. No stored pipeline predates the rule.
  - **A block's terminal status now survives a trailing step that claims none.** `merger → assessor →
disposer` used to write `in_progress` over the merger's `done`, leaving `finalizeBlock`'s merger
    backstop to record a merged task as `pr_ready`. `settleStepAndAdvance` reads the block's own
    status rather than trusting the settling resolver's return value, which fixes the same latent bug
    for any future step placed after the merger.
  - **The estimate badge states which reading it shows**, names the reading it replaced, and shows the
    earlier number beside each axis that actually MOVED. New `inspector.estimate.basis.*` and
    `supersededBasis` copy in all ten locales.

  The step records NOTHING when its reply cannot be read, and the run CONTINUES: it returns PROSE
  rather than declaring a structured output like its `merger` / `on-call` neighbours, because for a
  structured explore kind the harness makes an unparseable reply a job failure. That is right for a
  merger with a merge to decide and wrong for a step that runs after the change shipped, where it
  would let a missing brace block a merge-ready pull request (or re-open a task already `done`). The
  trade is the structured repair pass; the tolerant parse the inline estimator already uses is what
  makes it cheap.

### Patch Changes

- Updated dependencies [4125beb]
  - @cat-factory/contracts@0.325.0
  - @cat-factory/kernel@0.317.0
  - @cat-factory/agents@0.142.0
  - @cat-factory/orchestration@0.286.0
  - @cat-factory/server@0.303.0
  - @cat-factory/gates@0.11.5
  - @cat-factory/integrations@0.166.5
  - @cat-factory/prompt-fragments@1.1.1

## 0.45.21

### Patch Changes

- Updated dependencies [1d3c115]
  - @cat-factory/prompt-fragments@1.1.0
  - @cat-factory/agents@0.141.0
  - @cat-factory/kernel@0.316.0
  - @cat-factory/orchestration@0.285.0
  - @cat-factory/server@0.302.0
  - @cat-factory/gates@0.11.4
  - @cat-factory/integrations@0.166.4

## 0.45.20

### Patch Changes

- Updated dependencies [432b4e4]
  - @cat-factory/contracts@0.324.0
  - @cat-factory/kernel@0.315.0
  - @cat-factory/orchestration@0.284.0
  - @cat-factory/server@0.301.0
  - @cat-factory/agents@0.140.1
  - @cat-factory/gates@0.11.3
  - @cat-factory/integrations@0.166.3
  - @cat-factory/prompt-fragments@1.0.92

## 0.45.19

### Patch Changes

- Updated dependencies [9d4b0c2]
  - @cat-factory/agents@0.140.0
  - @cat-factory/server@0.300.0
  - @cat-factory/orchestration@0.283.2

## 0.45.18

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
  - @cat-factory/gates@0.11.2
  - @cat-factory/integrations@0.166.2
  - @cat-factory/kernel@0.314.1
  - @cat-factory/orchestration@0.283.1
  - @cat-factory/prompt-fragments@1.0.91
  - @cat-factory/server@0.299.1

## 0.45.17

### Patch Changes

- Updated dependencies [72ecc7c]
  - @cat-factory/agents@0.139.0
  - @cat-factory/contracts@0.323.0
  - @cat-factory/kernel@0.314.0
  - @cat-factory/orchestration@0.283.0
  - @cat-factory/server@0.299.0
  - @cat-factory/gates@0.11.1
  - @cat-factory/integrations@0.166.1
  - @cat-factory/prompt-fragments@1.0.90

## 0.45.16

### Patch Changes

- Updated dependencies [5b281a3]
  - @cat-factory/agents@0.138.0
  - @cat-factory/contracts@0.322.0
  - @cat-factory/gates@0.11.0
  - @cat-factory/integrations@0.166.0
  - @cat-factory/kernel@0.313.0
  - @cat-factory/orchestration@0.282.0
  - @cat-factory/server@0.298.0
  - @cat-factory/prompt-fragments@1.0.89

## 0.45.15

### Patch Changes

- Updated dependencies [53a4c40]
  - @cat-factory/contracts@0.321.0
  - @cat-factory/kernel@0.312.0
  - @cat-factory/orchestration@0.281.0
  - @cat-factory/server@0.297.0
  - @cat-factory/agents@0.137.1
  - @cat-factory/gates@0.10.64
  - @cat-factory/integrations@0.165.6
  - @cat-factory/prompt-fragments@1.0.88

## 0.45.14

### Patch Changes

- Updated dependencies [75107ec]
  - @cat-factory/server@0.296.1

## 0.45.13

### Patch Changes

- Updated dependencies [4a3af5a]
  - @cat-factory/kernel@0.311.0
  - @cat-factory/agents@0.137.0
  - @cat-factory/orchestration@0.280.0
  - @cat-factory/server@0.296.0
  - @cat-factory/gates@0.10.63
  - @cat-factory/integrations@0.165.5
  - @cat-factory/prompt-fragments@1.0.87

## 0.45.12

### Patch Changes

- Updated dependencies [302e05a]
- Updated dependencies [cda15b8]
  - @cat-factory/contracts@0.320.0
  - @cat-factory/kernel@0.310.0
  - @cat-factory/server@0.295.0
  - @cat-factory/orchestration@0.279.0
  - @cat-factory/agents@0.136.0
  - @cat-factory/gates@0.10.62
  - @cat-factory/integrations@0.165.4
  - @cat-factory/prompt-fragments@1.0.86

## 0.45.11

### Patch Changes

- Updated dependencies [3afea3a]
  - @cat-factory/contracts@0.319.0
  - @cat-factory/kernel@0.309.0
  - @cat-factory/agents@0.135.0
  - @cat-factory/orchestration@0.278.0
  - @cat-factory/server@0.294.0
  - @cat-factory/gates@0.10.61
  - @cat-factory/integrations@0.165.3
  - @cat-factory/prompt-fragments@1.0.85

## 0.45.10

### Patch Changes

- Updated dependencies [3f7d8b2]
  - @cat-factory/agents@0.134.0
  - @cat-factory/contracts@0.318.0
  - @cat-factory/kernel@0.308.0
  - @cat-factory/server@0.293.0
  - @cat-factory/orchestration@0.277.1
  - @cat-factory/gates@0.10.60
  - @cat-factory/integrations@0.165.2
  - @cat-factory/prompt-fragments@1.0.84

## 0.45.9

### Patch Changes

- Updated dependencies [2a2b6ef]
  - @cat-factory/kernel@0.307.0
  - @cat-factory/server@0.292.0
  - @cat-factory/orchestration@0.277.0
  - @cat-factory/integrations@0.165.1
  - @cat-factory/agents@0.133.3
  - @cat-factory/gates@0.10.59
  - @cat-factory/prompt-fragments@1.0.83

## 0.45.8

### Patch Changes

- Updated dependencies [5333319]
  - @cat-factory/kernel@0.306.0
  - @cat-factory/server@0.291.0
  - @cat-factory/integrations@0.165.0
  - @cat-factory/agents@0.133.2
  - @cat-factory/gates@0.10.58
  - @cat-factory/orchestration@0.276.1
  - @cat-factory/prompt-fragments@1.0.82

## 0.45.7

### Patch Changes

- Updated dependencies [053aac8]
  - @cat-factory/contracts@0.317.0
  - @cat-factory/kernel@0.305.0
  - @cat-factory/orchestration@0.276.0
  - @cat-factory/agents@0.133.1
  - @cat-factory/gates@0.10.57
  - @cat-factory/integrations@0.164.1
  - @cat-factory/prompt-fragments@1.0.81
  - @cat-factory/server@0.290.1

## 0.45.6

### Patch Changes

- Updated dependencies [eb5fa75]
- Updated dependencies [9d8fdf6]
  - @cat-factory/contracts@0.316.0
  - @cat-factory/kernel@0.304.0
  - @cat-factory/agents@0.133.0
  - @cat-factory/orchestration@0.275.0
  - @cat-factory/server@0.290.0
  - @cat-factory/integrations@0.164.0
  - @cat-factory/gates@0.10.56
  - @cat-factory/prompt-fragments@1.0.80

## 0.45.5

### Patch Changes

- Updated dependencies [eb740be]
  - @cat-factory/contracts@0.315.0
  - @cat-factory/kernel@0.303.0
  - @cat-factory/server@0.289.0
  - @cat-factory/orchestration@0.274.0
  - @cat-factory/agents@0.132.1
  - @cat-factory/gates@0.10.55
  - @cat-factory/integrations@0.163.1
  - @cat-factory/prompt-fragments@1.0.79

## 0.45.4

### Patch Changes

- Updated dependencies [7f990ea]
  - @cat-factory/contracts@0.314.0
  - @cat-factory/kernel@0.302.0
  - @cat-factory/integrations@0.163.0
  - @cat-factory/agents@0.132.0
  - @cat-factory/orchestration@0.273.0
  - @cat-factory/server@0.288.0
  - @cat-factory/gates@0.10.54
  - @cat-factory/prompt-fragments@1.0.78

## 0.45.3

### Patch Changes

- Updated dependencies [409238f]
  - @cat-factory/kernel@0.301.0
  - @cat-factory/contracts@0.313.0
  - @cat-factory/agents@0.131.0
  - @cat-factory/gates@0.10.53
  - @cat-factory/integrations@0.162.1
  - @cat-factory/orchestration@0.272.1
  - @cat-factory/prompt-fragments@1.0.77
  - @cat-factory/server@0.287.1

## 0.45.2

### Patch Changes

- Updated dependencies [0ef48d1]
  - @cat-factory/kernel@0.300.0
  - @cat-factory/contracts@0.312.0
  - @cat-factory/orchestration@0.272.0
  - @cat-factory/integrations@0.162.0
  - @cat-factory/server@0.287.0
  - @cat-factory/agents@0.130.2
  - @cat-factory/gates@0.10.52
  - @cat-factory/prompt-fragments@1.0.76

## 0.45.1

### Patch Changes

- c67e924: A bug hunt on a repo-backed tracker scopes to the service's repository, not a picked board

  GitHub Issues and GitLab Issues put every issue in one repository, and the only repository a hunt
  may read is the one its service frame is linked to. Both now offer NO board control: the hunt
  carries the container an adopted bug will land in, and the board is that container's service repo,
  resolved through the same `resolveRepoTarget` walk an issue search scopes with (now shared as
  `server/src/modules/tasks/sourceRepoScope.ts`). A board picker there could scan, rate and adopt a
  bug from a repository nothing on the board points at, whose run would then open its PR somewhere
  else entirely.

  Internal wire break (`POST /workspaces/:ws/bug-hunt/:source/hunts`): the body now takes
  `containerId` plus a REQUIRED, NULLABLE `board`. `null` is the only legal value for a repo-backed
  source, and naming one there is refused (`details.reason: 'board_from_service'`) rather than
  ignored; a repo-less source with no board is refused too. Board LISTING is refused for a repo-backed
  source with the same reason, so `GitHubIssuesProvider.listBoards` and
  `GitLabIssuesProvider.listBoards` are gone along with the shared `repoRefsToBoards` projection.
  `TaskSourceState` gains `repoBacked` (derived from the provider's declared `repoScope`) so the SPA
  knows which surface to render before it asks.

  Every refusal now lands as soon as it is decidable, cheapest first: an unhuntable source on the
  registry, then the board shape from the request body alone, then the repository walk, then the
  container. So an unregistered source is refused by name instead of being told to pick a board it
  has no control for, a board named beside an unlinked service no longer costs two round trips to
  learn it was never allowed, and a `containerId` naming no block on this workspace refuses before
  the vendor read and the ranking call rather than at adoption.

- Updated dependencies [d5c1f1c]
- Updated dependencies [c67e924]
  - @cat-factory/agents@0.130.1
  - @cat-factory/integrations@0.161.0
  - @cat-factory/kernel@0.299.1
  - @cat-factory/orchestration@0.271.1
  - @cat-factory/contracts@0.311.0
  - @cat-factory/server@0.286.0
  - @cat-factory/gates@0.10.51
  - @cat-factory/prompt-fragments@1.0.75

## 0.45.0

### Minor Changes

- 056e18d: Hold a run while a companion's MUST-FIX finding is open, whatever the rating said.

  A companion returned one number for a whole deliverable, and that number alone decided whether the
  run moved on. So a reviewer that found something genuinely unshippable — an unhandled failure mode,
  a requirement not met, a claim the work does not support — could still rate the change 0.9 against a
  0.8 bar and watch the pipeline advance past it. The urgency it meant was in the summary prose, in
  the `**Must fix**` group the prompt asked for, which is a channel only a person reads.

  Reviews are now GRADED. Each point a companion raises is its own `comments` entry carrying a
  `severity` of `blocker`, `major` or `minor` (the same three levels the prose groups named), and the
  verdict's two halves are read independently by kernel's new `disposeCompanionVerdict`: any open
  `blocker` reworks the producer whatever the rating, and the rating decides everything else. The
  `summary` becomes a short whole-verdict paragraph rather than a second copy of the list, matching
  what the judge prompt already does, since both are rendered together and a review written twice is
  two orderings that can disagree.

  **Spending the rework budget on a blocker parks for a person, and an unattended risk policy does not
  answer that park.** ADR 0053's rule is that a policy may take the "proceed anyway" a person would
  have been offered when an automatic loop reports it GAVE UP; a reviewer naming a must-fix is not
  that, so accepting the work anyway would be overruling a review nobody read. The distinction is a
  closed vocabulary (`CompanionParkReason`, the sibling of `JudgeParkReason`) rather than prose, and
  only `budget_spent` reaches the policy. The run panel's cap prompt states which of the two it is,
  because the person answering an unanswerable-by-policy park should know what they are being asked to
  overrule.

  That vocabulary is also what a loop stopped EARLY as unproductive (`companionLoopStalled`) now
  resolves against. Abandoning the rounds still on the budget takes the cap's park, so the reason is
  re-decided for the abandoned budget instead of being assumed to be a spent one: a standstill is the
  automation reporting that it gave up, an open `blocker` is not, and a stalled loop routinely carries
  both (the run that motivated the stall rule had two must-fix items open the whole way). So an
  unattended policy answers a stalled quality loop and still waits for a person on a blocked one.

  An out-of-vocabulary severity from a model reads as `major`, the same "unreadable severity reads as
  its safe default" rule the judge and PR-review findings use: the whole assessment is one parse, and
  an unparseable companion verdict fails the run, which is far worse than one point landing a level
  off. `major` and not either extreme, so a typo can neither manufacture a hard stop nor retire a real
  one. A comment with no severity at all (a person's "request changes" note, or one recorded before
  this existed) stays ungraded and never blocks.

  The findings now render. Each verdict card in the run panel lists them worst first with a severity
  badge beside each, which is new: `comments` were persisted and fed back into later rounds but shown
  to nobody, so the point holding a run was invisible to the person being asked to resolve it. Both
  sides of the rework loop read the grades too — the producer is told which comments are blocking and
  works them first, and a re-grading companion sees its earlier rounds' points labelled.

  **Every surface that a person or an integration answers this park from names the findings, because
  the summary no longer can.** With the prose groups gone, three places were reading the review out of
  a channel that stopped carrying it. The extra round a person grants at the cap loops the producer
  back with the verdict's graded `comments` attached, as the automatic rework path already did, so the
  round somebody just paid for names the points it is for. The `approval-gate` entry of
  `GET /api/v1/runs/{runId}/decisions` gains a `blockingFindings` array (spec `1.53.0`, additive), so a
  caller answering `resolve-exceeded` with `proceed` can read the must-fixes it would be overruling
  rather than inferring them from a verdict paragraph. And a companion's findings anchor to a
  structured item by id rather than by quoting prose, which the producer prompt was rendering against
  an empty target: an anchored point now names its item, and a point that anchors neither way is
  addressed to the proposal as a whole.

  **A first batch of nothing but nits no longer costs a round.** The rule that spends one round on a
  first review's findings asked only whether there were any, so a reviewer that followed its own
  instruction (a `minor` is "never worth holding anything for"), rated work above the bar and attached
  one polish note bought a full producer re-run plus a re-grading call. It now takes a point the
  reviewer did NOT call a nit, and the prompt states what each level costs so the grade decides
  something a reviewer can predict. An ungraded point still counts: its urgency is unknown rather than
  known to be low.

  The panel's verdict badge derives its `>=` / `<` glyph from the comparison rather than from
  `passed`, which are no longer the same fact: a round held by an open blocker fails at a rating that
  cleared its bar, and reading one off the other printed `95% < 80%` above the findings explaining it.
  The cap prompt's stalled wording drops its claim about the rating for the same reason.

  A severity read off a STORED row is narrowed through `isReviewCommentSeverity` rather than trusted:
  the schema's `major` fallback runs on the model reply, which is the only thing it parses, so a level
  retired from the vocabulary would reach an exhaustive `Record` and come back `undefined`. Such a
  value now sorts with the ungraded, carries no mechanical force, and is NAMED as unrecognised on the
  panel instead of being painted as a level nobody chose.

  `REVIEW_SUMMARY_LAYOUT` is replaced by `REVIEW_FINDINGS_LAYOUT`; a deployment appending the old
  constant to its own companion prompt should append the new one, and one relying on the shared
  companion prompt needs no change. Website: kibertoad/cat-factory-website#60.

### Patch Changes

- Updated dependencies [056e18d]
  - @cat-factory/contracts@0.310.0
  - @cat-factory/kernel@0.299.0
  - @cat-factory/agents@0.130.0
  - @cat-factory/orchestration@0.271.0
  - @cat-factory/server@0.285.0
  - @cat-factory/gates@0.10.50
  - @cat-factory/integrations@0.160.17
  - @cat-factory/prompt-fragments@1.0.74

## 0.44.2

### Patch Changes

- Updated dependencies [a81879b]
  - @cat-factory/contracts@0.309.0
  - @cat-factory/kernel@0.298.2
  - @cat-factory/agents@0.129.2
  - @cat-factory/gates@0.10.49
  - @cat-factory/integrations@0.160.16
  - @cat-factory/orchestration@0.270.2
  - @cat-factory/prompt-fragments@1.0.73
  - @cat-factory/server@0.284.2

## 0.44.1

### Patch Changes

- Updated dependencies [0e1e0fa]
  - @cat-factory/orchestration@0.270.1
  - @cat-factory/contracts@0.308.1
  - @cat-factory/agents@0.129.1
  - @cat-factory/kernel@0.298.1
  - @cat-factory/server@0.284.1
  - @cat-factory/gates@0.10.48
  - @cat-factory/integrations@0.160.15
  - @cat-factory/prompt-fragments@1.0.72

## 0.44.0

### Minor Changes

- 7312e0a: Stop a refused work-branch push from failing a run whose work is already on the branch.

  The harness checkpoint-pushes the agent's commits every 60s so an evicted container's work
  survives, which makes it its own competing writer: a commit is published within a minute of being
  made, the agent cannot see that from inside the container, and amending it afterwards is ordinary
  git hygiene (the delivery contract even asks it to validate AFTER committing, which is exactly the
  sequence that produces an amend). The final push was then refused as a non-fast-forward and the
  whole run failed with a complete scaffold sitting on the branch.

  Every push after the first now carries `--force-with-lease` against the sha THIS pass published,
  which is the sha the push itself named: `pushBranch` pushes `<sha>:refs/heads/<branch>` and returns
  it, rather than reading `refs/remotes/origin/<branch>` back afterwards, which a fresh coding run's
  single-branch clone never creates. That is the whole discrimination: the run's own rewrite lands, and
  a second writer's commits (a concurrent dispatch, a person) still refuse the push as `(stale info)`,
  which is the "never clobber another run's work" property the resume design leans on.

  The lease is withheld entirely unless the branch still contains the tip this pass started from
  (`workBranchLease`), because the lease alone does not bound the force to this pass's own commits: a
  resumed run that had already landed one checkpoint would otherwise force over the commits it
  resumed from and take an earlier run's work with them.

  A refused push is no longer a generic `git` fault. It reports the new `branch-contended` failure
  cause, and the engine recovers by re-dispatching the step once (`MAX_BRANCH_CONTENTION_RECOVERIES`,
  recorded on `PipelineStep.branchContentionRecoveries` and projected by the debug API): the fresh
  dispatch resumes the branch as it now stands, so the agent continues on top of whatever is on it.
  Past the budget the run fails with a remedy naming which of the two causes it was, rather than git's
  own "use `git pull`" hint, which is advice for a person at a terminal. Each refusal also increments
  the new `container.branch_contended` operational counter, since a re-dispatch that a run reports as
  a clean success is invisible per run and costs a whole agent run twice.

  The checkpoint also stops re-pushing an unchanged branch. Its gate was "the branch advanced past the
  pre-run tip", which stays true forever once it has, so every tick issued a push: an hour-long run
  that commits eight times spent ~60 authenticated round trips, ~52 of them answering "Everything
  up-to-date" and each counting against the host's push rate limits. It now pushes only an
  UNPUBLISHED tip, which makes the interval a loss window rather than a rate (one push per commit the
  agent makes, whatever the model or the run's length) and leaves the durability guarantee unchanged.

  The `build` prompt bumps to v6 with the matching half of the rule stated to the agent: add commits,
  never rewrite them.

  `/api/v1/debug/runs/:runId` gains `branchContentionRecoveries` per step (OpenAPI 1.52.0, additive):
  a run that recovered reports as an ordinary success, so nothing else tells a post-mortem that one
  agent pass was paid for twice.

  Also fixes a git failure printing its stderr twice (`execFile` already folds it into the rejection
  message), which made one refused push read as two attempts.

### Patch Changes

- Updated dependencies [7312e0a]
  - @cat-factory/kernel@0.298.0
  - @cat-factory/contracts@0.308.0
  - @cat-factory/orchestration@0.270.0
  - @cat-factory/agents@0.129.0
  - @cat-factory/server@0.284.0
  - @cat-factory/gates@0.10.47
  - @cat-factory/integrations@0.160.14
  - @cat-factory/prompt-fragments@1.0.71

## 0.43.0

### Minor Changes

- 95408c2: A companion's automatic rework budget is now a risk-policy field instead of a constant in the engine.

  Every other automatic loop reads its ceiling off the task's policy: the CI fixer (`ciMaxAttempts`),
  the iterative requirements review (`maxRequirementIterations`), the Tester's quality gate
  (`maxTesterQualityIterations`), a judge's bounces (`judgeMaxBounces`), the post-release-health watch.
  The companion loop, which has the widest reach of them (every `reviewer`, `architect-companion`,
  `spec-companion` and any pair a deployment registers) and is the one an operator actually watches
  spend container dispatches, was pinned at 3 by `DEFAULT_COMPANION_MAX_ATTEMPTS` with no way to state
  otherwise. `companionMaxReworks` closes that, on both policy tiers (account and workspace) and in the
  policy editor beside the requirement-iteration budget.

  `0` is a real posture rather than a disabled loop: the companion still grades and still writes its
  verdict, and the first verdict below the bar goes straight to the iteration-cap park (or to
  `proceed`, on a policy whose `autonomy` is `unattended`) instead of buying a round. A verdict at or
  above the bar advances, comments and all. That last part is the one place this number changed an
  existing rule rather than parameterising it: a companion's FIRST batch of comments loops the producer
  back whatever it scored, and that rule now asks whether there is a round to spend before it fires.
  Left alone, `0` would have parked every companion step, since a review with nothing at all to say is
  the rare one.

  A step is seeded with the catalog default at run start, where no policy is resolved, so the resolved
  value is adopted onto `step.companion.maxAttempts` at the companion's first grading, the same way the
  Tester's quality budget is adopted on its first report. That read happens once per step, keyed on the
  step having recorded no verdict yet: a human granting an extra round at the cap does it by raising
  that same field (and the grant charges the round immediately), so a later read would report a ceiling
  the step no longer has. Keyed on the attempt count instead, it also fired a second time after a human
  "request changes" on a gated companion, which re-runs the producer while deliberately charging no
  round.

  No behaviour changes by default. The column default and all three built-in seeds carry the 3 the
  engine held, so a stored policy and a freshly seeded one are byte-for-byte identical and no seed
  needed a version bump. The field stays off `/api/v1`, where the risk-policy projection deliberately
  publishes only what decides whether a run can land without a person.

### Patch Changes

- Updated dependencies [95408c2]
  - @cat-factory/contracts@0.307.0
  - @cat-factory/kernel@0.297.0
  - @cat-factory/orchestration@0.269.0
  - @cat-factory/agents@0.128.2
  - @cat-factory/gates@0.10.46
  - @cat-factory/integrations@0.160.13
  - @cat-factory/prompt-fragments@1.0.70
  - @cat-factory/server@0.283.2

## 0.42.3

### Patch Changes

- Updated dependencies [792ecde]
  - @cat-factory/agents@0.128.1
  - @cat-factory/integrations@0.160.12
  - @cat-factory/kernel@0.296.1
  - @cat-factory/orchestration@0.268.1
  - @cat-factory/server@0.283.1
  - @cat-factory/gates@0.10.45
  - @cat-factory/prompt-fragments@1.0.69

## 0.42.2

### Patch Changes

- Updated dependencies [fc56d82]
- Updated dependencies [fc9afb4]
  - @cat-factory/orchestration@0.268.0
  - @cat-factory/contracts@0.306.0
  - @cat-factory/kernel@0.296.0
  - @cat-factory/agents@0.128.0
  - @cat-factory/server@0.283.0
  - @cat-factory/gates@0.10.44
  - @cat-factory/integrations@0.160.11
  - @cat-factory/prompt-fragments@1.0.68

## 0.42.1

### Patch Changes

- edd4fd0: A fourth built-in model preset, **GPT-5.6 Sol** (`mdp_chatgpt`), is seeded for every workspace
  alongside Kimi K2.7, GLM-5.2 and Claude Opus 5, so `claude | chatgpt | kimi` is finally expressible
  as a pin rather than as a note in a config file.

  It needs no new catalog route to be usable. `gpt-5.6-sol` carries an `openrouter` route and a Codex
  `subscription` route, which is the same pair `claude-opus` already had, so `effectiveVariant` lands
  on whichever the workspace holds: an OpenRouter key alone makes the preset dispatchable to a SYSTEM
  API key (a Codex subscription is per-seat and individual-only, so a system token may not spend one),
  and a connected subscription wins where there is one. Deliberately NOT a seeded default on any
  deployment shape: Cloudflare and Node still seed Kimi K2.7, local mode still seeds Claude Opus 5.
  The seed id names a VENDOR rather than a generation (`mdp_chatgpt`, not `mdp_gpt56sol`) so a built-in
  can roll its `baseModelId` forward without becoming a preset nobody selected; argued in ADR 0056.

  **An OpenAI API key is not one of those routes, and the run-start refusal now says which are.**
  `openai` is a first-class poolable provider with its own onboarding copy, so "add an API key for the
  provider" read as a `platform.openai.com` secret key, which cannot make this preset dispatchable.
  `providers_unconfigured` now names each unusable model's DECLARED routes, computed from the catalog by
  the new kernel `declaredModelRouteLabels`: `gpt-5.6-sol (needs OpenRouter or ChatGPT (Codex))`. That
  fixes the misattribution for every subscription-or-gateway-only model rather than for this one, and
  `details.models` still carries the bare ids the SPA and the four SDK clients read.

  **Model presets gained the catalog NAME channel pipelines already had.** The snapshot ships
  `modelPresetCatalogNames` beside `modelPresetCatalogVersions`, built from one `seedModelPresets()`
  read. A brand-new built-in has no stored row to take a name off, which is exactly the state the
  startup advisory offers to fix: without the map the SPA humanises the id, so every board created
  before this release would have been offered "Chatgpt" instead of GPT-5.6 Sol. A new optional field on
  the wire, so an older SPA keeps working off the humanised fallback.

  **The built-in seed is now ONE batched write.** `ModelPresetRepository.upsertMany` (mirrored D1 batch
  and Drizzle transaction, allow-listed for mothership mode) replaces a serial `upsert` per built-in on
  a path that runs at a workspace's first board load, where every shipped built-in used to add a
  round-trip. The single-default invariant is read over the batch: a promoted member demotes every row
  outside it, and each member's own flag stands as written.

  `catalog.test.ts` gains the assertion nothing else could make: every built-in's base model AND every
  per-kind override names a model `MODEL_CATALOG` actually ships. A preset's `baseModelId` is a plain
  string matched at DISPATCH, so a built-in naming a renamed or dropped model typechecks, seeds, lists
  and is selectable, then fails on the first agent step of whichever run picked it. The expectation is
  derived from the catalog rather than hand-listed, so a rename breaks a test instead of a live run. The
  conformance seeding assertion is derived the same way, and now compares the persisted rows against
  the catalog member by member and in order instead of counting them.

  The `acceptance-suite-operator-setup` initiative tracker is retired into
  [ADR 0056](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0056-acceptance-suite-operator-setup.md),
  its committed scope now complete.

- Updated dependencies [edd4fd0]
  - @cat-factory/kernel@0.295.0
  - @cat-factory/contracts@0.305.0
  - @cat-factory/orchestration@0.267.0
  - @cat-factory/server@0.282.0
  - @cat-factory/agents@0.127.3
  - @cat-factory/gates@0.10.43
  - @cat-factory/integrations@0.160.10
  - @cat-factory/prompt-fragments@1.0.67

## 0.42.0

### Minor Changes

- 36e0c9b: A headless caller can now DELETE a board service, and the acceptance suite has a command that clears a
  board back to "before any pass ran".

  The two halves are one change. The acceptance preflight refuses a fresh pass whose target repository
  already backs a service frame an earlier pass created, and it offers three ways out: resume the pass
  that owns it, point the suite at fresh repositories, or delete the frame. The third was not a command:
  deleting a service was an app act, and a public-API key authenticates on `/api/v1` only. So the one
  branch an operator running a HEADLESS pass could not act on headlessly was the one that starts over.

  **`DELETE /api/v1/services/{serviceId}`** (`admin`, OpenAPI `1.51.0`) closes that, additively. It runs
  the same sequence the app's own delete does, so a run still going under the frame is stopped and its
  container killed before anything is removed. Two answers a caller branches on rather than retries: a
  frame holding UNFINISHED tasks is refused with `422 service_has_unfinished_tasks` (deleting one would
  discard work in flight along with its history, so meaning it looks like deleting those tasks first),
  and an ARCHIVED frame is a `404`, which is the population rule every per-service endpoint here
  follows. Archiving stays app-only, deliberately: a surface that publishes neither the archive nor the
  restore has no business deleting through one.

  That refusal is decided BEFORE the run teardown, which is the ordering both delete controllers now
  share (`BoardService.assertRemovable`, handing back the board list the teardown and the remove both
  reuse, so the sequence still costs one read). The guard used to live only inside `removeBlock`, one
  step past a teardown that kills every container, cancels every durable driver and deletes every run
  row under the frame: a `422` therefore described a board it had already emptied of exactly the
  history the refusal exists to protect. It now leaves everything as it was, which is what the SPA's
  own delete has always claimed too.

  **`pnpm --filter @cat-factory/acceptance run reset [runId|latest] [--yes]`** is what uses it. It
  targets what the CONFIGURATION would adopt rather than what a ledger remembers, because the gate
  refuses over the board as it stands and the hardest case is leftover state whose owning ledger is gone
  (another machine, another operator, a state directory somebody cleared). Naming a pass widens the
  target to that pass's whole ledger.

  Three properties are worth knowing before running it. It PREVIEWS by default and changes nothing
  without `--yes`, naming every frame, task and file, and the preview is decided by the same retention
  rule the apply runs, so a pass is listed under "to remove" or under "KEPT" and never under the one it
  will not get. It keeps a pass's local files whenever any frame that ledger names is still on the
  board, since the ledger is the only thing that maps a leftover frame back to a run id, and removing it
  strands that frame with no pass for the next refusal to name; a repository it could not FREE keeps
  every ledger for the same reason one step out, because the frame still holding it is one no read here
  can name at all. And it STATES what no key can reclaim: the two repositories keep whatever a previous
  pass scaffolded (with its branches and pull requests), a reporter-filed issue stays open, and per-PR
  cluster namespaces are untouched, so a cleared board is not a fresh one.

  One diagnosis it deliberately declines to make: `GET /api/v1/repos` reports `linkedElsewhere: true`
  with `serviceId: null` for a service homed on another board of the account AND for a frame ARCHIVED on
  this one (the flag is computed against the frames a board visibly lists), and the two have opposite
  fixes. Every message that names it now names both, `target-repos`' own remedy included, rather than
  sending an operator to a board that does not exist.

  `--all` clears the whole board rather than one configuration's share of it. The two questions the
  default asks are narrow by design (they answer the two refusals a pass earns), so a board accumulates
  frames neither can see: a pass run under a different name prefix, one whose repositories the `.env` has
  since replaced, a frame raised by hand. None of them blocks the next pass, which is why no refusal
  prints the flag and why it is an operator's request rather than a remedy. It reuses the task reads and
  deletes the surface already published (`GET /api/v1/services/{serviceId}/tasks`, whose pages it walks,
  and `DELETE /api/v1/tasks/{taskId}`), so the endpoint added here is still the only new one. Two things
  it changes rather than widens: the preview STATES the scope, because a board holding a single pass
  renders an identical frame list either way, and every pass file in the state directory goes with the
  board, a refused attempt's included, since a board with no frames left maps nothing and a file kept
  back is a run id `latest` may still resolve to.

  The suite's configuration now resolves in two halves, and `reset` needs only the BOARD half (the
  deployment, the key, the two repositories, the state directory). Requiring a cluster and a reporter
  token to clear a board would refuse exactly the operator whose cluster has moved on, which is who is
  resetting.

### Patch Changes

- Updated dependencies [36e0c9b]
  - @cat-factory/contracts@0.304.0
  - @cat-factory/orchestration@0.266.0
  - @cat-factory/server@0.281.0
  - @cat-factory/agents@0.127.2
  - @cat-factory/gates@0.10.42
  - @cat-factory/integrations@0.160.9
  - @cat-factory/kernel@0.294.1
  - @cat-factory/prompt-fragments@1.0.66

## 0.41.0

### Minor Changes

- 569181d: Account-scoped risk policies, inherited by every board (ADR 0055).

  A risk policy could only be authored per board, so an organisation with one merge posture had to
  copy it onto every board and keep the copies in step by hand. There is now an ACCOUNT tier: policies
  authored once for a whole account, which every board under it inherits read-only, may CLONE into its
  own library to edit, and may HIDE so no task on that board can pick it. Managed from a new "Risk
  policies" tab in Account settings; a board's own settings panel lists what it inherits above what it
  owns, plus what it is hiding.

  The board's visible library is `account ⊕ workspace` with the board's own row winning a collision,
  and one merged reader answers for the settings editor, every picker and the ENGINE, so a task can pin
  an inherited policy and the run is governed by the posture the picker offered.

  Two internal breaks, both pre-1.0 surfaces:

  - `RiskPolicyRepository` gained a read-only supertype `WorkspaceRiskPolicyReader`, and the engine,
    the two board guards and `resolveRiskPolicy` now hold that instead of the repository
    (`RunMergePolicyDeps` / `ExecutionServiceDependencies` renamed the field to `riskPolicyReader`).
  - `GET /workspaces/:ws/risk-policies` and the board snapshot answer library entries carrying `tier`.

  `GET /api/v1/risk-policies` now lists inherited policies too (an additive behaviour change: the
  response shape is unchanged, and a deployment with no account policies sees exactly what it saw
  before). Editing or deleting an inherited policy answers `409` with
  `details.reason: 'risk_policy_inherited'`; cloning or hiding a board's own policy answers
  `risk_policy_not_inherited`. `GET /workspaces/:ws/risk-policy-suppressions` answers `503`
  `risk_policy_suppressions_unwired` where the store is absent, matching its write routes rather than
  claiming the board hides nothing.

  **Needs a catfactory.ai page before release.** This adds an operator-facing capability anyone can act
  on with no checkout (author account-wide merge postures; clone or hide an inherited one from a board),
  so per ADR 0051 it owes a website page that the repo's CI cannot see. The website PR is not open yet
  and is NOT part of this change.

### Patch Changes

- Updated dependencies [569181d]
  - @cat-factory/contracts@0.303.0
  - @cat-factory/kernel@0.294.0
  - @cat-factory/orchestration@0.265.0
  - @cat-factory/server@0.280.0
  - @cat-factory/agents@0.127.1
  - @cat-factory/gates@0.10.41
  - @cat-factory/integrations@0.160.8
  - @cat-factory/prompt-fragments@1.0.65

## 0.40.1

### Patch Changes

- Updated dependencies [0a85a59]
  - @cat-factory/orchestration@0.264.1
  - @cat-factory/server@0.279.1

## 0.40.0

### Minor Changes

- 1a0b593: A workspace now states which PIPELINE a run resolves per intake, the way it already states which risk
  policy, and a requirements review's findings are split into the two groups that decide who answers
  them.

  Three changes, one theme: a run nobody is watching should reach a pull request without stopping for a
  person who is not coming, and should stop for one exactly where a person is what the situation needs.

  **Per-scope default pipelines.** `Pipeline.isDefault` and `Pipeline.isUnattendedDefault`, scoped by
  the same `runDefaultScopeFor(intakeOrigin)` the risk-policy default takes, written through the
  `organize` body — the one pipeline write a BUILT-IN accepts, which is what makes a shipped rung
  promotable at all. Only the UNATTENDED scope is seeded: the in-app scope already resolved an answer
  without a flagged row (the interface-mode rung, then catalog order), and seeding one would silently
  overrule the adaptive rung an advanced-mode board runs today. An operator-declared row outranks both.

  The seeded rung is a new built-in, **`pl_unattended`**. It is the adaptive shape with two deliberate
  differences: no `requirements-review`, because the rung a headless caller lands on by default cannot
  open a conversation nobody is there to have; and `human-test` plus `human-review` behind ESTIMATE
  GATES after the guards, because dropping the conversation removes the platform's chance to ask about
  scope, so the oversight is bought back where the evidence is strongest. A caller that wants the
  conversation names `pl_complex` and answers it over `/api/v1/runs/:runId/decisions` or on the ticket.

  `mp_unattended` narrows the three loop budgets its own posture makes cheap (three reviewer passes
  rather than six, two tester-QC iterations, no judge bounce): each is a cap `autonomy: 'unattended'`
  settles as "proceed", so spending it buys the run nothing but tokens. `ciMaxAttempts` is deliberately
  untouched — exhausting it raises `ci_failed`, a park this policy does not answer, so cutting it would
  produce one more stop for a person rather than one fewer. Landing authority is unchanged, and the seed
  is NOT version-bumped: existing workspaces hold a CLONE of their own default there (ADR 0053's
  migration), and a reseed would restore stock ceilings alongside the narrower budgets.

  **The two groups, shown and graded.** The reviewer already classified each finding as answerable from
  practice or needing a product decision; that is now the review window's primary grouping rather than a
  badge on one edge case, with each section saying what its group is. Every Requirement-Writer
  suggestion additionally reports a `confidence`, a different claim from `groundedIn`: that one says
  where the answer came from, this one how sure the Writer is of it (a standard can settle a finding only
  partly; a general practice can be near-universal). Shown as a band on every suggestion.

  **And a run nobody is watching may settle the first group.** Under `autonomy: 'unattended'` the gate
  folds the answers in and carries on when every finding was dismissed, resolved, answered by a person,
  or auto-answered above the policy's new `minAutoAnswerConfidence` floor (default 0.8). One finding in
  the other group, or one graded below the floor, parks the whole review exactly as before, and an
  UNGRADED suggestion clears no floor above zero — so a garbled Writer reply parks the run rather than
  quietly answering it. The step stamps `autoAnsweredByPolicy`, distinct from the existing
  `reviewCapSettledByPolicy`: that one means the loop gave up, this one that it converged on answers
  nobody read. ADR 0053 ruled this out on the grounds that inventing a product judgement is off limits;
  the narrowing that makes it compatible rather than an exception is that TWO independent judgements
  must agree before anything is folded.

  **Under `attended`, nothing about the review changes.** A suggestion there is a draft a person is
  about to read, so grading it changes nothing about who decides.

  Two `/api/v1` additions (`pipelineId` on task creation, and on `GET /pipelines` both a per-row
  `unattendedDefault` and the list-level `unattendedDefaultPipelineId` that is the one to read: the
  resolution has a rung the list cannot show, so a per-row flag alone reports `false` everywhere on a
  workspace whose empty start bodies work). OpenAPI `1.50.0`, plus one behaviour change worth reading
  before upgrading: `POST
/tasks/:taskId/start` with an empty body now STARTS a run for a key that satisfies `decide`, where it
  used to answer `400 pipeline_required`. A `write` key sees no change, deliberately — the seeded rung
  reaches a human test and a human PR review, so offering it to a caller that cannot answer a park
  would trade an actionable "pass a pipelineId" for a 403 about a pipeline it never picked. The refusal
  survives wherever no default resolves.

### Patch Changes

- Updated dependencies [1a0b593]
  - @cat-factory/contracts@0.302.0
  - @cat-factory/kernel@0.293.0
  - @cat-factory/agents@0.127.0
  - @cat-factory/orchestration@0.264.0
  - @cat-factory/server@0.279.0
  - @cat-factory/gates@0.10.40
  - @cat-factory/integrations@0.160.7
  - @cat-factory/prompt-fragments@1.0.64

## 0.39.2

### Patch Changes

- Updated dependencies [7d1477c]
  - @cat-factory/kernel@0.292.2
  - @cat-factory/agents@0.126.8
  - @cat-factory/gates@0.10.39
  - @cat-factory/integrations@0.160.6
  - @cat-factory/orchestration@0.263.2
  - @cat-factory/prompt-fragments@1.0.63
  - @cat-factory/server@0.278.2

## 0.39.1

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
  - @cat-factory/orchestration@0.263.1
  - @cat-factory/server@0.278.1
  - @cat-factory/gates@0.10.38
  - @cat-factory/integrations@0.160.5
  - @cat-factory/prompt-fragments@1.0.62

## 0.39.0

### Minor Changes

- fc4a1e4: A run nobody is watching now finishes instead of waiting on a person who is not coming, and a
  workspace states that posture per intake rather than once for everything.

  Four parks stopped an otherwise-autonomous run, and none of them is a checkpoint anybody asked for:
  a companion at its automatic rework cap, a JUDGE at its bounce cap, an iterative review at its
  reviewer-pass cap, and the Coder's follow-up companion holding the run while any item is undecided.
  Each is the automation reporting that it gave up, and each already offered a person a documented
  "proceed anyway". A run started over `/api/v1`, dispatched from a ticket or fired by a schedule had
  nobody to offer it to, so it waited indefinitely. The headless acceptance suite found this on
  `pl_build`, stopping on an `approval-gate` raised by `architect-companion`.

  A judge's other two parks are deliberately NOT in that set — `onFail: 'park'` is a registration
  asking for a person, and a verdict with no producing step to bounce to never got to try — so
  `disposeJudgeVerdict` now returns a machine-readable `JudgeParkReason` instead of leaving the engine
  to tell them apart by their prose. A review still ASKING questions parks under either posture too:
  the answers are a product judgement, and inventing them is the one thing an unattended policy may
  never do.

  - **`RiskPolicy.autonomy`** (`attended` | `unattended`) decides which way those three go. `attended`
    is byte-for-byte the previous behaviour and is what every existing policy, every custom one, and
    the built-in fallback get. `unattended` takes the "proceed" answer ON THE RECORD:
    `step.companion.capSettledByPolicy` and `followUpItem.dismissedByPolicy` say that policy decided,
    because the last companion verdict already says the producer was below the bar and a run that
    advanced anyway must not read like one whose companion quietly stopped grading.
  - **It never touches a park the PIPELINE asked for.** An approval gate, a `human-test` step, visual
    confirmation, the human/PR review gate, a brainstorm or interview, the fork choice and the input
    gate all stop the run under either value. A companion step that is ALSO gated still raises its
    human approval gate at the cap, because the cap settling is routed through the same pass branch a
    converged companion takes.
  - **A workspace now has TWO default policies.** `isDefault` governs a task somebody started in the
    app; the new `isUnattendedDefault` governs one nothing is watching. Which applies is
    `riskPolicyDefaultScopeFor(intakeOrigin)`, its own `Record` rather than a reuse of
    `isHeadlessIntake` — the two disagree about `schedule`, which is not headless (its reused block
    has no stable place to hold a clarification conversation) and is nonetheless unwatched.
  - **A third built-in, `mp_unattended` ("Unattended delivery")**, seeded as that default. It is
    `Balanced` with one field changed, deliberately: a seed may decide that an unwatched run should
    not wait forever on an automation budget, and may not decide that it gets to land a change an
    operator's own thresholds would have held.
  - **Pinning a task to it is a permission**, not a preference. `refuseRiskPolicySelection` gained a
    `relaxes_run_oversight` arm: `mp_unattended`'s role layer is empty, identical to `Balanced`'s, so
    without it any member could re-point a task onto the seeded policy and remove the human
    checkpoints their workspace's own default raises.
  - **Every grading loop now remembers its own rounds.** `step.companion.verdicts` recorded one verdict
    per cycle and no prompt read it, so a companion re-graded a revised document with no idea what it
    had asked for last time — the loop resampled instead of converging, and a rework budget bought
    nothing. Both sides of the loop now receive the rounds so far (`AgentRunContext.priorReview`,
    folded once in `userPromptFor`, so an inline companion, a container-backed one, a
    deployment-registered one and the producer being reworked all get it), and the 0..1 scale is
    anchored and SHARED with the judge bucket, which had carried its previous verdict all along.

  **Migration, and the one thing to check.** Both facades' migrations materialise `mp_unattended` in
  every existing workspace as a CLONE of that workspace's own default row, with `autonomy` the only
  field changed. Cloning, not seeding stock values: a built-in is editable in place, so a workspace
  that tightened its `Balanced` still holds `id = 'mp_balanced'`, and writing catalog ceilings beside
  it would hand every API-started run there a wider licence to land than its operator granted. Every
  ceiling, budget and per-role restriction is inherited (`dryRunRoles` and `submissionClassesByRole`
  above all). Landing authority does not move underneath anyone; what changes is that such runs stop
  parking on the caps. A deployment that WANTS its API-started runs to keep parking re-points
  `isUnattendedDefault` at a policy whose `autonomy` is `attended`.

  `Balanced` and `Manual review only` are NOT version-bumped. Both new fields land on them as the
  migration's column defaults, so a stored row and a freshly seeded one are identical — advising every
  existing workspace to reseed for a zero-delta change would invite them to overwrite their own edits.

  **Public API (additive, OpenAPI 1.49.0).** `GET /api/v1/risk-policies` gains `isUnattendedDefault`
  and `autonomy`. `isDefault` keeps its exact former meaning, so nothing an existing client was told
  becomes wrong; it was reading about the other scope. A caller predicting whether its own runs can
  reach a terminal state unassisted should read `autonomy` on the `isUnattendedDefault` row.

  **Internal break.** `RiskPolicyRepository.getDefault` takes the scope, and
  `RunMergePolicy.resolve` / the engine's `resolveRiskPolicy` callback take the run. Both are required
  rather than defaulted: a call site that has not decided which kind of run it is resolving for now
  fails to compile, because the alternative reads as correct and silently hands an unwatched run the
  in-app policy.

  Design record: [ADR 0053](../backend/docs/adr/0053-unattended-run-autonomy.md).

### Patch Changes

- Updated dependencies [fc4a1e4]
  - @cat-factory/contracts@0.301.0
  - @cat-factory/kernel@0.292.0
  - @cat-factory/orchestration@0.263.0
  - @cat-factory/server@0.278.0
  - @cat-factory/agents@0.126.6
  - @cat-factory/gates@0.10.37
  - @cat-factory/integrations@0.160.4
  - @cat-factory/prompt-fragments@1.0.61

## 0.38.15

### Patch Changes

- Updated dependencies [ee733ee]
  - @cat-factory/contracts@0.300.0
  - @cat-factory/kernel@0.291.0
  - @cat-factory/orchestration@0.262.0
  - @cat-factory/server@0.277.0
  - @cat-factory/agents@0.126.5
  - @cat-factory/gates@0.10.36
  - @cat-factory/integrations@0.160.3
  - @cat-factory/prompt-fragments@1.0.60

## 0.38.14

### Patch Changes

- Updated dependencies [01086d8]
  - @cat-factory/contracts@0.299.1
  - @cat-factory/integrations@0.160.2
  - @cat-factory/kernel@0.290.1
  - @cat-factory/server@0.276.2
  - @cat-factory/agents@0.126.4
  - @cat-factory/gates@0.10.35
  - @cat-factory/orchestration@0.261.2
  - @cat-factory/prompt-fragments@1.0.59

## 0.38.13

### Patch Changes

- Updated dependencies [1bcdacc]
  - @cat-factory/kernel@0.290.0
  - @cat-factory/agents@0.126.3
  - @cat-factory/gates@0.10.34
  - @cat-factory/integrations@0.160.1
  - @cat-factory/orchestration@0.261.1
  - @cat-factory/prompt-fragments@1.0.58
  - @cat-factory/server@0.276.1

## 0.38.12

### Patch Changes

- 195b248: Tracker writeback is ON by default, and `/api/v1` can now read and change it:
  `GET /api/v1/tracker/writeback` reports what a task's linked tracker issue hears as its pull request
  progresses, and `PATCH /api/v1/tracker/writeback` changes one action without moving the others.
  Surface version 1.46.0, additive.

  **BEHAVIOUR CHANGE, and worth reading before upgrading.** All three writeback actions (comment when
  the pull request opens, comment and CLOSE the issue when it merges, post a headless run's parked
  review findings) now default to ON for a workspace that has never configured them. All three were
  off. Nothing published said what the defaults were, so this is not an `/api/v1` break, but it IS a
  change a deployment notices: a board that never opened the issue-tracker settings panel now closes a
  linked ticket when its task's pull request merges, and comments on it twice on the way. A deployment
  that wants the old behaviour turns it off with one call to the new PATCH (or in the app), and a single
  task can still opt out through its own per-task override.

  The reasoning for the flip is that these actions only ever touch an issue a task is LINKED to, and
  nothing links one by accident: a link arrives because somebody imported the issue, the recurring
  intake picked it up, or a headless caller filed a task with `ticket`. Every one of those is a request
  to work the issue where it was filed, so the half-closed loop was the common outcome and the wrong
  one: a merged pull request beside an issue still sitting open with nothing on it saying the work was
  done. The default now lives in ONE place (`DEFAULT_TRACKER_WRITEBACK` in `@cat-factory/contracts`),
  read by the settings service, the writeback service and the SPA's panel, which previously spelled it
  three times.

  The public pair closes the last gap in the ticket-driven loop. A caller could file a task FROM a
  ticket and the platform would write back to that issue, but WHETHER it did was workspace
  configuration reachable only from the app, so the deployment shape that most needs the loop closed
  (nobody in the SPA at all) could neither read the disposition nor change it, and could not tell "this
  deployment leaves tickets open" from "the writeback is broken". Three things about the shape: it
  publishes the WRITEBACK half of `tracker_settings` and not the filing selection, which is a separate
  decision the writeback does not key off; the write MERGES, so a caller acting on one action cannot
  move the other two; and `updatedAt` is null when nobody has ever chosen, which is how a caller knows
  it is reading defaults rather than somebody's decision.

  **Every writeback write now merges, the app's own included.** An omitted action used to revert to the
  deployment default on the internal wholesale PUT, which the default flip above turns from harmless
  into a silent re-enable: the recurring-pipeline dialog persists a FILING tracker and names no
  writeback action, so scheduling a tech-debt pipeline switched writeback back on for a workspace that
  had deliberately turned it off. Absence now means "not moving this action" on both doors, which is
  the only reading any caller wanted, and the merge itself moved down into the two repositories
  (`TrackerSettingsRepository.merge`, replacing `put`), so the SPA panel and a headless patch naming
  different actions both land instead of one silently losing to the other's stale snapshot.

  The acceptance suite gains a fifth spec built on all of it: an issue filed on the backend repository
  by an OUTSIDE reporter (its own provider credential, since an issue the platform created and closed
  proves only that the credential works), a task filed FROM that issue over `/api/v1`, delivery through
  `pl_build`, and then the pair of claims that the platform CLOSED the issue and commented on it at both
  edges of the pull request's life. The pair matters because a provider closes an issue by itself when a
  merged pull request's text carries `Closes #12`, and that path posts no comment: a closed issue alone
  cannot tell the writeback from the host noticing a word an agent wrote. Two new prerequisites refuse
  before any of it spends anything, and `run configure` opens the token page prefilled.

- Updated dependencies [195b248]
  - @cat-factory/contracts@0.299.0
  - @cat-factory/integrations@0.160.0
  - @cat-factory/orchestration@0.261.0
  - @cat-factory/server@0.276.0
  - @cat-factory/agents@0.126.2
  - @cat-factory/gates@0.10.33
  - @cat-factory/kernel@0.289.1
  - @cat-factory/prompt-fragments@1.0.57

## 0.38.11

### Patch Changes

- Updated dependencies [bc2478d]
  - @cat-factory/contracts@0.298.0
  - @cat-factory/kernel@0.289.0
  - @cat-factory/integrations@0.159.0
  - @cat-factory/server@0.275.0
  - @cat-factory/agents@0.126.1
  - @cat-factory/gates@0.10.32
  - @cat-factory/orchestration@0.260.1
  - @cat-factory/prompt-fragments@1.0.56

## 0.38.10

### Patch Changes

- a634746: A locally-run model can now be given a run's design renders. Its image support resolves in two
  tiers: a table of recognised open-weights families (`KNOWN_LOCAL_MODELS`, so ticking Gemma 4 or Muse
  Glimmer needs no second step), overridden by a per-model declaration on the user's own runner entry
  for anything the table cannot know about.

  The gap was structural rather than a missed case. `acceptsImages` is a per-FLAVOUR fact declared on
  `MODEL_CATALOG`, and a local model has no catalog row: it lives on one person's machine, its id is
  free text, and the OpenAI-compatible `/models` probe the panel discovers models with returns ids and
  nothing else. So every local ref arrived with the modality absent and `resolveDesignImageDelivery`
  answered `unknown_model_image_input` for all of them, forever. That reason exists precisely so this
  would stay visible instead of reading as a text-only model, and the arrival of image-capable local
  models is what turned it from a latent hole into a lost capability.

  The declaration wins over the table on purpose: the person who pulled the weights is the one who
  knows whether they are running a text-only quant, a fine-tune or a re-tagged copy. The table
  therefore carries only families whose SILENCE costs a capability (every member is image-capable; a
  text-only entry would behave identically to an absent one), and a family whose modality depends on
  the size is left out rather than approximated, which is why Gemma 3 is absent while Gemma 4 is
  present. It lives in `@cat-factory/contracts` because the settings panel labels its "not set" option
  with what the table will do and the engine folds the same answer onto the dispatched ref.

  The initiator's declarations are read on EVERY dispatch, because the winning model is not known
  until the shared resolver has walked its sources, so the read goes through a new `AppCaches`
  slice keyed on the user (the endpoint write paths invalidate it). Without that, a deployment with no
  local runners at all still paid a query per step, and a mothership-mode node an extra
  `/internal/persistence` round trip per step.

  Delivery still joins the HARNESS's answer first, and that is what decides where this lands today: a
  local ref names no harness, so a container dispatch runs it on Pi, whose `HARNESS_IMAGE_INPUT` entry
  is `false` and refuses without consulting the ref. The modality is therefore acted on by the inline
  path, and the container path becomes a reader the day an image-carrying harness serves a local model,
  which is a one-line table edit rather than new plumbing. It is resolved for every path regardless,
  because the winning model is not known until the shared resolver has walked its sources.

  `contextTokens` is deliberately NOT declared for a local model, though the same shape could carry it.
  The window a runner serves is a fact about its config rather than about the weights (Ollama's
  `num_ctx` default sits far below what a 128K-window model can do), nothing enforces it for a local
  ref, and stating a number the runner silently ignores would be worse than stating none. The
  truncation trap that follows from that is now written down in `backend/docs/model-support.md`.

  **Internal break:** the endpoint row's enabled-model list changes from `string[]` to a declaration
  array. A row written before this loses its entries on read: bare strings are dropped rather than
  coerced, so the break cannot arrive as a model id of `[object Object]`. The endpoint reports the
  discard (`unreadableModels`) and the panel names it per runner, because a shortened list on its own
  reads exactly like a runner nobody ever enabled a model on and only one of those is fixed by
  re-ticking. The fix is to re-tick the models in "My local runners", which rewrites the whole blob.

- Updated dependencies [a634746]
  - @cat-factory/contracts@0.297.0
  - @cat-factory/kernel@0.288.0
  - @cat-factory/integrations@0.158.0
  - @cat-factory/agents@0.126.0
  - @cat-factory/orchestration@0.260.0
  - @cat-factory/server@0.274.0
  - @cat-factory/gates@0.10.31
  - @cat-factory/prompt-fragments@1.0.55

## 0.38.9

### Patch Changes

- Updated dependencies [7893f35]
  - @cat-factory/contracts@0.296.0
  - @cat-factory/integrations@0.157.0
  - @cat-factory/kernel@0.287.0
  - @cat-factory/orchestration@0.259.0
  - @cat-factory/server@0.273.0
  - @cat-factory/agents@0.125.8
  - @cat-factory/gates@0.10.30
  - @cat-factory/prompt-fragments@1.0.54

## 0.38.8

### Patch Changes

- Updated dependencies [07ff467]
  - @cat-factory/contracts@0.295.0
  - @cat-factory/orchestration@0.258.0
  - @cat-factory/server@0.272.0
  - @cat-factory/agents@0.125.7
  - @cat-factory/gates@0.10.29
  - @cat-factory/integrations@0.156.1
  - @cat-factory/kernel@0.286.3
  - @cat-factory/prompt-fragments@1.0.53

## 0.38.7

### Patch Changes

- Updated dependencies [9b3473a]
  - @cat-factory/contracts@0.294.0
  - @cat-factory/integrations@0.156.0
  - @cat-factory/server@0.271.0
  - @cat-factory/agents@0.125.6
  - @cat-factory/gates@0.10.28
  - @cat-factory/kernel@0.286.2
  - @cat-factory/orchestration@0.257.2
  - @cat-factory/prompt-fragments@1.0.52

## 0.38.6

### Patch Changes

- Updated dependencies [b889842]
  - @cat-factory/kernel@0.286.1
  - @cat-factory/integrations@0.155.5
  - @cat-factory/orchestration@0.257.1
  - @cat-factory/server@0.270.1
  - @cat-factory/agents@0.125.5
  - @cat-factory/gates@0.10.27
  - @cat-factory/prompt-fragments@1.0.51

## 0.38.5

### Patch Changes

- Updated dependencies [b25732f]
  - @cat-factory/contracts@0.293.0
  - @cat-factory/server@0.270.0
  - @cat-factory/kernel@0.286.0
  - @cat-factory/orchestration@0.257.0
  - @cat-factory/agents@0.125.4
  - @cat-factory/gates@0.10.26
  - @cat-factory/integrations@0.155.4
  - @cat-factory/prompt-fragments@1.0.50

## 0.38.4

### Patch Changes

- Updated dependencies [7119ca7]
  - @cat-factory/integrations@0.155.3
  - @cat-factory/orchestration@0.256.4
  - @cat-factory/contracts@0.292.2
  - @cat-factory/server@0.269.3
  - @cat-factory/kernel@0.285.3
  - @cat-factory/agents@0.125.3
  - @cat-factory/gates@0.10.25
  - @cat-factory/prompt-fragments@1.0.49

## 0.38.3

### Patch Changes

- Updated dependencies [3dde85c]
  - @cat-factory/integrations@0.155.2
  - @cat-factory/orchestration@0.256.3
  - @cat-factory/server@0.269.2

## 0.38.2

### Patch Changes

- Updated dependencies [57a7ecd]
  - @cat-factory/integrations@0.155.1
  - @cat-factory/contracts@0.292.1
  - @cat-factory/kernel@0.285.2
  - @cat-factory/orchestration@0.256.2
  - @cat-factory/server@0.269.1
  - @cat-factory/agents@0.125.2
  - @cat-factory/gates@0.10.24
  - @cat-factory/prompt-fragments@1.0.48

## 0.38.1

### Patch Changes

- Updated dependencies [5f6699a]
  - @cat-factory/contracts@0.292.0
  - @cat-factory/integrations@0.155.0
  - @cat-factory/server@0.269.0
  - @cat-factory/agents@0.125.1
  - @cat-factory/gates@0.10.23
  - @cat-factory/kernel@0.285.1
  - @cat-factory/orchestration@0.256.1
  - @cat-factory/prompt-fragments@1.0.47

## 0.38.0

### Minor Changes

- 2428b6b: Attribute a cross-service run's pull request to every involved service frame whose changes ride
  it, not just the first.

  The multi-repo fan-out checks out one repo per REPO, so several involved services living in one
  monorepo already shared a checkout, a work branch and a single pull request. Only the RECORD was
  singular, which left every frame but the first looking like a service the run had opened no pull
  request for. The attribution is now a set (`frameIds`) from the dispatch through the harness echo
  to `block.peerPullRequests`, the merge order, and the verification report. The own-service report
  carries it too, naming the involved services co-located in the task's own repo: those open no pull
  request of their own, so that report is the only place their change is reported. A peer checkout
  also stops inheriting one co-located service's `serviceDirectory`: it is whole-repo, as the primary
  already was, so the services that resolved second are reachable.

  A recorded peer pull request is now ADDRESSED by its repo rather than by its frames, which is what
  a checkout is identified by, and one the platform cannot resolve is named to the merger instead of
  being dropped from the combined diff it scores.

  Internal break: `peerPullRequestSchema.frameId`, `allPullRequests`, `MergePrEntry.frameId`,
  `PrReportTarget.frameId` and the harness `peerRepos`/`peerPullRequests` wire fields are replaced
  by `frameIds`. Peer PRs recorded on a block before this ship lose their frame attribution (the
  pull requests themselves are untouched). Public `/api/v1` is additive only: `PrReportScope` gains
  `frameIds` and keeps `frameId` as its head (surface version 1.40.0). `frameId` is no longer always
  null on an own-service report: it names a co-located involved service when there is one.

  The runner image moves to `cat-factory-executor:1.109.0`.

### Patch Changes

- Updated dependencies [22b2459]
- Updated dependencies [2428b6b]
  - @cat-factory/kernel@0.285.0
  - @cat-factory/agents@0.125.0
  - @cat-factory/server@0.268.0
  - @cat-factory/integrations@0.154.0
  - @cat-factory/orchestration@0.256.0
  - @cat-factory/contracts@0.291.0
  - @cat-factory/gates@0.10.22
  - @cat-factory/prompt-fragments@1.0.46

## 0.37.7

### Patch Changes

- Updated dependencies [19baddf]
  - @cat-factory/kernel@0.284.0
  - @cat-factory/agents@0.124.0
  - @cat-factory/orchestration@0.255.0
  - @cat-factory/server@0.267.0
  - @cat-factory/gates@0.10.21
  - @cat-factory/integrations@0.153.12
  - @cat-factory/prompt-fragments@1.0.45

## 0.37.6

### Patch Changes

- Updated dependencies [31f43c1]
  - @cat-factory/contracts@0.290.0
  - @cat-factory/kernel@0.283.0
  - @cat-factory/orchestration@0.254.0
  - @cat-factory/server@0.266.0
  - @cat-factory/agents@0.123.6
  - @cat-factory/gates@0.10.20
  - @cat-factory/integrations@0.153.11
  - @cat-factory/prompt-fragments@1.0.44

## 0.37.5

### Patch Changes

- Updated dependencies [3ff215a]
  - @cat-factory/orchestration@0.253.1
  - @cat-factory/contracts@0.289.1
  - @cat-factory/kernel@0.282.1
  - @cat-factory/agents@0.123.5
  - @cat-factory/server@0.265.1
  - @cat-factory/gates@0.10.19
  - @cat-factory/integrations@0.153.10
  - @cat-factory/prompt-fragments@1.0.43

## 0.37.4

### Patch Changes

- Updated dependencies [e3cf16a]
  - @cat-factory/contracts@0.289.0
  - @cat-factory/kernel@0.282.0
  - @cat-factory/orchestration@0.253.0
  - @cat-factory/server@0.265.0
  - @cat-factory/agents@0.123.4
  - @cat-factory/gates@0.10.18
  - @cat-factory/integrations@0.153.9
  - @cat-factory/prompt-fragments@1.0.42

## 0.37.3

### Patch Changes

- Updated dependencies [83764b5]
  - @cat-factory/contracts@0.288.0
  - @cat-factory/orchestration@0.252.0
  - @cat-factory/server@0.264.0
  - @cat-factory/agents@0.123.3
  - @cat-factory/gates@0.10.17
  - @cat-factory/integrations@0.153.8
  - @cat-factory/kernel@0.281.3
  - @cat-factory/prompt-fragments@1.0.41

## 0.37.2

### Patch Changes

- Updated dependencies [1fbd83c]
- Updated dependencies [00228c6]
  - @cat-factory/orchestration@0.251.1
  - @cat-factory/contracts@0.287.1
  - @cat-factory/kernel@0.281.2
  - @cat-factory/agents@0.123.2
  - @cat-factory/server@0.263.1
  - @cat-factory/gates@0.10.16
  - @cat-factory/integrations@0.153.7
  - @cat-factory/prompt-fragments@1.0.40

## 0.37.1

### Patch Changes

- Updated dependencies [bf473bd]
  - @cat-factory/contracts@0.287.0
  - @cat-factory/orchestration@0.251.0
  - @cat-factory/server@0.263.0
  - @cat-factory/agents@0.123.1
  - @cat-factory/gates@0.10.15
  - @cat-factory/integrations@0.153.6
  - @cat-factory/kernel@0.281.1
  - @cat-factory/prompt-fragments@1.0.39

## 0.37.0

### Minor Changes

- 8c1d8a6: Narrow the built-in pipeline catalog, and make a step conditional on what the change touches.

  A pipeline step can now carry a RUN CONDITION beside its estimate gate (`stepOptions[i].condition`),
  declaring the service scope it applies to. Every build rung carries BOTH testers: the browser pass
  runs where the change touches a frontend service, the API pass where it touches anything else. Run
  admission drops the condition-excluded steps before its gates, so a preset carrying `tester-ui` is
  not refused on a backend service.

  A condition is a SKIP AXIS, so it is held to the two structural rules an estimate gate is held to
  (`assertValidRunConditions`, mirrored in the SPA's health advisory and in what the builder offers):
  the step's kind must be one that may be absent from a run, and it may not also carry a human
  approval gate. Without that, a condition on `merger` dropped the merge on every run outside its
  scope while the pipeline still finished reporting success.

  A skipped step now records WHY as a machine-readable `skipReason` (`gated` / `condition` /
  `producer_skipped` / `run_complete`) that the SPA renders as translated copy, and its `output` stays
  empty. The
  reason used to be an English sentence written into `output`, which three separate aggregations
  select on to build a model's view of the prior steps — so a condition-skipped tester's note was
  handed to `merger` and `ci-fixer` as if it were the tester's report.

  Five presets are withdrawn (`pl_frontend`, `pl_tech_debt`, `pl_blueprint`, `pl_spec`,
  `pl_environment_analysis`) and one is added: `pl_complex` ("Complex build"), which settles the
  requirements and researches the problem before the standard loop. `pl_code_comments` stays as an
  INTERNAL pipeline: the documentation-refresh preset spawns onto it, so it resolves for a run while
  being withheld from every listing. Withheld from `pipelineCatalogVersions` too, which the health
  advisory reads as "the built-ins that exist" — an internal entry there is reported as newly
  available on every board forever, with no reseed able to clear it. `pipelineCatalogNames` still
  spans the whole catalog, so a task PINNED to an internal pipeline is named (and started) rather
  than silently falling through to a full build.

  Running ONE agent against a block is now a first-class action (`POST
/workspaces/:ws/blocks/:id/agent-kind-executions`, `ExecutionService.startAgentKind`) rather than
  something that needed a single-step preset. It backs the post-bootstrap service mapping, a new
  "Map service" action on the service frame, and the environment wizard's deep analysis.

  BREAKING (internal): a workspace seeded before this change holds rows for the five withdrawn
  presets; the pipeline-health advisory offers their removal, naming a replacement where one exists.
  Anything naming `BLUEPRINT_PIPELINE_ID` / `TECH_DEBT_PIPELINE_ID` should use `BLUEPRINT_AGENT_KIND`
  with `startAgentKind`, or name a build rung directly.

### Patch Changes

- Updated dependencies [4715b74]
- Updated dependencies [8c1d8a6]
  - @cat-factory/contracts@0.286.0
  - @cat-factory/kernel@0.281.0
  - @cat-factory/orchestration@0.250.0
  - @cat-factory/agents@0.123.0
  - @cat-factory/server@0.262.0
  - @cat-factory/gates@0.10.14
  - @cat-factory/integrations@0.153.5
  - @cat-factory/prompt-fragments@1.0.38

## 0.36.14

### Patch Changes

- Updated dependencies [afe1250]
  - @cat-factory/contracts@0.285.0
  - @cat-factory/kernel@0.280.0
  - @cat-factory/agents@0.122.0
  - @cat-factory/orchestration@0.249.0
  - @cat-factory/server@0.261.0
  - @cat-factory/gates@0.10.13
  - @cat-factory/integrations@0.153.4
  - @cat-factory/prompt-fragments@1.0.37

## 0.36.13

### Patch Changes

- Updated dependencies [e3fdc15]
  - @cat-factory/contracts@0.284.0
  - @cat-factory/integrations@0.153.3
  - @cat-factory/server@0.260.3
  - @cat-factory/agents@0.121.4
  - @cat-factory/gates@0.10.12
  - @cat-factory/kernel@0.279.3
  - @cat-factory/orchestration@0.248.5
  - @cat-factory/prompt-fragments@1.0.36

## 0.36.12

### Patch Changes

- Updated dependencies [3036af7]
  - @cat-factory/agents@0.121.3
  - @cat-factory/integrations@0.153.2
  - @cat-factory/kernel@0.279.2
  - @cat-factory/orchestration@0.248.4
  - @cat-factory/server@0.260.2
  - @cat-factory/gates@0.10.11
  - @cat-factory/prompt-fragments@1.0.35

## 0.36.11

### Patch Changes

- Updated dependencies [de7caaf]
  - @cat-factory/contracts@0.283.1
  - @cat-factory/agents@0.121.2
  - @cat-factory/gates@0.10.10
  - @cat-factory/integrations@0.153.1
  - @cat-factory/kernel@0.279.1
  - @cat-factory/orchestration@0.248.3
  - @cat-factory/prompt-fragments@1.0.34
  - @cat-factory/server@0.260.1

## 0.36.10

### Patch Changes

- Updated dependencies [f0e1c45]
  - @cat-factory/kernel@0.279.0
  - @cat-factory/integrations@0.153.0
  - @cat-factory/server@0.260.0
  - @cat-factory/orchestration@0.248.2
  - @cat-factory/agents@0.121.1
  - @cat-factory/gates@0.10.9
  - @cat-factory/prompt-fragments@1.0.33

## 0.36.9

### Patch Changes

- Updated dependencies [6ad1d8b]
  - @cat-factory/contracts@0.283.0
  - @cat-factory/kernel@0.278.0
  - @cat-factory/agents@0.121.0
  - @cat-factory/gates@0.10.8
  - @cat-factory/integrations@0.152.8
  - @cat-factory/orchestration@0.248.1
  - @cat-factory/prompt-fragments@1.0.32
  - @cat-factory/server@0.259.2

## 0.36.8

### Patch Changes

- Updated dependencies [a596b9c]
  - @cat-factory/contracts@0.282.0
  - @cat-factory/orchestration@0.248.0
  - @cat-factory/kernel@0.277.0
  - @cat-factory/integrations@0.152.7
  - @cat-factory/agents@0.120.2
  - @cat-factory/gates@0.10.7
  - @cat-factory/prompt-fragments@1.0.31
  - @cat-factory/server@0.259.1

## 0.36.7

### Patch Changes

- Updated dependencies [2585b2f]
  - @cat-factory/contracts@0.281.0
  - @cat-factory/kernel@0.276.0
  - @cat-factory/orchestration@0.247.0
  - @cat-factory/server@0.259.0
  - @cat-factory/agents@0.120.1
  - @cat-factory/gates@0.10.6
  - @cat-factory/integrations@0.152.6
  - @cat-factory/prompt-fragments@1.0.30

## 0.36.6

### Patch Changes

- Updated dependencies [faddbf5]
  - @cat-factory/contracts@0.280.0
  - @cat-factory/agents@0.120.0
  - @cat-factory/orchestration@0.246.0
  - @cat-factory/server@0.258.0
  - @cat-factory/gates@0.10.5
  - @cat-factory/integrations@0.152.5
  - @cat-factory/kernel@0.275.4
  - @cat-factory/prompt-fragments@1.0.29

## 0.36.5

### Patch Changes

- Updated dependencies [8a06abc]
- Updated dependencies [8a06abc]
  - @cat-factory/contracts@0.279.0
  - @cat-factory/server@0.257.0
  - @cat-factory/orchestration@0.245.0
  - @cat-factory/agents@0.119.3
  - @cat-factory/gates@0.10.4
  - @cat-factory/integrations@0.152.4
  - @cat-factory/kernel@0.275.3
  - @cat-factory/prompt-fragments@1.0.28

## 0.36.4

### Patch Changes

- Updated dependencies [11f9efa]
  - @cat-factory/contracts@0.278.0
  - @cat-factory/orchestration@0.244.0
  - @cat-factory/server@0.256.0
  - @cat-factory/agents@0.119.2
  - @cat-factory/gates@0.10.3
  - @cat-factory/integrations@0.152.3
  - @cat-factory/kernel@0.275.2
  - @cat-factory/prompt-fragments@1.0.27

## 0.36.3

### Patch Changes

- Updated dependencies [c44e9d7]
  - @cat-factory/contracts@0.277.0
  - @cat-factory/agents@0.119.1
  - @cat-factory/gates@0.10.2
  - @cat-factory/integrations@0.152.2
  - @cat-factory/kernel@0.275.1
  - @cat-factory/orchestration@0.243.1
  - @cat-factory/prompt-fragments@1.0.26
  - @cat-factory/server@0.255.1

## 0.36.2

### Patch Changes

- Updated dependencies [dfa4a8e]
  - @cat-factory/orchestration@0.243.0
  - @cat-factory/kernel@0.275.0
  - @cat-factory/agents@0.119.0
  - @cat-factory/server@0.255.0
  - @cat-factory/gates@0.10.1
  - @cat-factory/integrations@0.152.1
  - @cat-factory/prompt-fragments@1.0.25

## 0.36.1

### Patch Changes

- Updated dependencies [3e9a6af]
  - @cat-factory/contracts@0.276.0
  - @cat-factory/kernel@0.274.0
  - @cat-factory/gates@0.10.0
  - @cat-factory/orchestration@0.242.0
  - @cat-factory/integrations@0.152.0
  - @cat-factory/server@0.254.0
  - @cat-factory/agents@0.118.1
  - @cat-factory/prompt-fragments@1.0.24

## 0.36.0

### Minor Changes

- a62bcf8: Deliver notifications by email, and add the notification manager that decides which events go to
  which channel.

  The `EmailSender` port, its SendGrid/Resend adapters and the per-account connection have been live
  for a while and were used only for invitations. A new `EmailNotificationChannel` puts them behind
  the same `NotificationChannel` port the in-app and Slack transports implement, so the engine call
  sites that raise notifications are untouched. It resolves recipients from the SAME rules
  `resolveWorkspaceAccess` applies (account membership is the prerequisite, an account admin always
  qualifies, a `workspace_members` row counts only for a still-current account member), reads them in
  three batched queries rather than a point-read per person, and isolates each send so one bad address
  cannot cost every other recipient their notification. An account with no sender connected produces
  zero attempts and zero warnings.

  The manager (`notification_settings`, one row per workspace, D1 ⇄ Drizzle with a conformance suite)
  stores per-type, per-channel OVERRIDES over the shipped defaults, and one service answers both the
  settings API and the delivery gate so the toggle a human sees cannot say something the engine does
  not do. **By default email carries only the high-impact events**: the ones where something is
  stopped until a human acts (`merge_review`, `decision_required`, `ci_failed`, `test_failed`,
  `release_regression`) or the deployment itself is degraded (`platform_health`, `infra_unreachable`,
  `budget_paused`, `key_drift`). The per-step review parks are deliberately off by default — several
  arrive on nearly every task, and mailing them is the firehose that gets a sender's domain filtered.

  Only the channels whose delivery is a plain yes/no are routed here: the in-app push and email.
  Slack and the outbound webhooks answer "which types" where their DESTINATION is declared (a Slack
  route's channel, a webhook endpoint's own `types` filter), so a second switch would be a place to
  look that does not decide. The settings panel says so and links to the Slack routing.

  Delivery now carries WHICH lifecycle edge it reports (`NotificationDeliveryReason`: `raised` /
  `refreshed` / `settled`), because the service re-delivers a card on every transition it makes and
  the transports split hard on what that means. A STATE transport (the in-app push, the outbound
  webhook) takes every edge, so a board holding an open card sees it settle instead of rendering an
  already-made decision as still actionable. An ALERT transport (email, Slack) takes the `raised` edge
  alone: a mailbox and a chat channel cannot render a correction, so a second "Decision needed" after
  the decision was made is simply false. This also corrects Slack, which re-posted on every resolve
  and dismissal before the edge existed, and it is why the escalation sweep's loop over a workspace's
  overdue cards now performs no routing or audience reads at all. **The edge is a required parameter
  and rides the mothership delegation wire**, where it is refused rather than defaulted: the persisted
  row cannot supply it (a raise and an escalation are both `open`), so a node one build behind fails
  loudly instead of mailing the org about decisions already made.

  Two more behaviours to watch for when reviewing. The in-app push is gated too, but only on the raise:
  muting a type stops the live toast, while the card is still persisted, still in the inbox on the next
  snapshot, and still pushed when it settles. And a settings read that FAILS falls back to the shipped
  default and logs, rather than defaulting to deliver-everything (a mailshot) or deliver-nothing (the
  parked run nobody hears about). In the settings panel the same distinction is explicit: a deployment
  with no routing store and a read that broke are separate states, and only the first renders the
  shipped defaults, because saving is a full replace and a grid built from defaults would otherwise
  overwrite overrides nobody had seen.

### Patch Changes

- Updated dependencies [2544fb3]
- Updated dependencies [a62bcf8]
- Updated dependencies [2544fb3]
- Updated dependencies [fe8ca56]
- Updated dependencies [2544fb3]
- Updated dependencies [2544fb3]
- Updated dependencies [2544fb3]
  - @cat-factory/server@0.253.0
  - @cat-factory/kernel@0.273.0
  - @cat-factory/contracts@0.275.0
  - @cat-factory/integrations@0.151.0
  - @cat-factory/orchestration@0.241.0
  - @cat-factory/agents@0.118.0
  - @cat-factory/gates@0.9.39
  - @cat-factory/prompt-fragments@1.0.23

## 0.35.0

### Minor Changes

- 882b94f: Feed the visual-confirmation gate from the designs a task links. The frames an import retained for
  a linked Figma/Zeplin document now populate the gate's actual-vs-reference gallery on their own, so
  a designer who linked a frame gets screenshot-vs-design comparison with no manual upload at all.

  A reference that was explicitly chosen for a view still wins: an upload is a deliberate act against
  that one task and survives every re-import, while a design render is a projection the next
  body-changing import replaces wholesale. So an upload assigns over the fold, and a view whose
  reference the capture itself named is left alone. Each pair now says which of the two it is showing,
  and says nothing when the capture named its own, because a reference the gate did not source is one
  whose provenance it can only guess at.

  A view name two designs both claim is qualified with its design on BOTH sides rather than just the
  second, the same rule the Figma import applies to a frame name repeated across pages: leaving the
  first bare would hand the plain name to whichever design is listed first, and re-ordering the links
  would then silently re-point a reviewed view at a different screen.

  The gate also states what the linked designs contributed whenever a design is attached, including
  when everything worked, so "no design is linked" stays distinguishable from "one is and it gave
  nothing". The latter carries a per-design reason, since retaining part of a design, failing to
  download it, having no frames at all, and having had nowhere to store them each ask for a different
  fix. That verdict is derived from what the artifact store actually holds rather than from the
  recorded render status alone, so any status claiming retention over an empty shelf reports the
  absence rather than describing a gallery that is not there. The gallery's ceiling on design views is
  shared round-robin across the linked designs instead of being spent in read order, and each design
  that loses frames to it is named, so a design the ceiling shut out cannot read as one with no
  frames.

  Gathering the pairs no longer confuses a gallery ROW with a captured screenshot. A reference-only row
  (a design frame, an uploaded mock) makes a pair too, so a run that captured nothing had been losing
  the warning that gates the gate's approve button behind an acknowledgement, reporting a verified
  gallery of blanks in its run outcome, and summoning reviewers to screenshots that were not there. The
  rule now lives once in `@cat-factory/contracts` and all three ask it.

  `BinaryArtifactStore` grows a batched `listByDocuments`, mirrored D1 ⇄ Drizzle with a conformance
  assertion and allow-listed for mothership mode, so a task linking several designs still costs the
  driver path one read.

### Patch Changes

- Updated dependencies [35bc18f]
- Updated dependencies [882b94f]
- Updated dependencies [f2ead2a]
  - @cat-factory/kernel@0.272.0
  - @cat-factory/integrations@0.150.0
  - @cat-factory/contracts@0.274.0
  - @cat-factory/orchestration@0.240.0
  - @cat-factory/server@0.252.0
  - @cat-factory/agents@0.117.12
  - @cat-factory/gates@0.9.38
  - @cat-factory/prompt-fragments@1.0.22

## 0.34.0

### Minor Changes

- 6e07961: Retain a design document's rendered frames when it is imported. A Figma import now downloads the
  PNGs (the linked frame, or the first six top-level frames of a whole file) and stores them as
  `reference` binary artifacts keyed to the document, on the same shelf the visual-confirmation gate
  already reads from; a re-import that changes the body replaces the previous set wholesale. The
  download is host-pinned to Figma's signed-asset hosts and carries no credential.

  Renders ride a new `DocumentSourceProvider.fetchRenders` port rather than `fetchDocument`, and only
  run on an import that actually writes a body: a design file's version moves on any edit anywhere in
  it, so the dispatch-time freshness ladder re-fetches the text far more often than the pictures
  change.

  A new `documents.render_status` records what became of them (`stored` / `partial` / `none` /
  `failed` / `storage_unavailable`, or null where the question does not apply), because every way of
  ending up with no images is otherwise the same absence. It is derived from what was RETAINED, and
  counts the frames a provider's own cap excluded as unillustrated, so a six-picture pass over a
  twenty-frame file reads as `partial` rather than as a complete design with six screens. A
  deployment with no image storage configured imports the design textually and says so rather than
  downloading bytes it cannot keep; a settings read that FAILS is `failed`, not
  `storage_unavailable`, since telling an operator to configure storage they already have sends them
  to fix the wrong thing.

  A document's renders are exempt from the age-based artifact retention sweep. Age is the right
  lifetime for run debris and the wrong one for a projection of a live row: renders are replaced by
  the next import that changes the body and by nothing else, and an unedited design is never
  re-imported, so a clock-based sweep would leave the row claiming `stored` over an empty set with
  nothing to re-download them.

  Internal break: `binary_artifacts` rows and `documents` rows written before this change carry no
  document keying and no render status. Both self-heal on the next import; nothing needs a backfill.
  `BinaryArtifactMetadataStore.deleteByDocument` is replaced by `deleteByIds`: every id-scoped
  reclaim now names the rows whose bytes it has already removed, so a concurrent import's fresh row
  cannot be deleted out from under its blob.

### Patch Changes

- 9f9c240: Bound a wedged pipeline step on Node, and stop an idle container reclaim from reading as a
  crash. The last two findings of the stuck-run audit.

  **One hang bound, both facades.** `ExecutionConfig.advanceTimeout` (`ADVANCE_TIMEOUT`, default
  `30 minutes`) is now the ceiling on a single `advanceInstance` AND on a single status read: the
  Worker hands it to the durable driver's `step.do` (where it had been a hard-coded constant), and
  Node races it in `driveExecution` through a new injected `DriveOptions.withStepCeiling` seam.
  Node previously had no ceiling at all, and nothing else supplies one: pg-boss heartbeats an
  active job regardless of handler progress, so a hung call left the run `running` with a frozen
  `updated_at`, invisible to the stale-run sweeper, until the queue's expire cap (up to 24h). A
  timed-out advance fails the run rather than retrying in-process, because a second concurrent
  advance would double-drive it; a timed-out poll counts as one unreadable poll against
  `jobPollFailureTolerance`, which is the disposition the Worker has always had for the same
  event.

  **One knob now means one parser.** Every duration knob in `ExecutionConfig` resolves through the
  shared `resolveDurationEnv`, which canonicalises the value both runtimes go on to use. Node's
  own parser knew four of the units Workflows accepts and silently substituted its built-in
  default for the rest, so `ADVANCE_TIMEOUT="1 week"` was a week on Cloudflare and five minutes on
  Node. Values past what a timer can hold, and the calendar units whose length the two runtimes
  would each have to invent, are refused with one warning rather than honoured differently on each
  side.

  **A container that reclaims itself says so.** A per-run Cloudflare Container is kept warm only
  by the driver's job polls, so a poll gap longer than its idle window reclaimed it mid-job; the
  resulting 404 poll was indistinguishable from an OOM and spent the single crash-eviction budget,
  so two hiccups in one step failed a healthy run. The container now records the reclaim cause it
  observed (`idle` alongside the existing `rollout`) and the transport reads it back over one RPC,
  classifying an idle reclaim as `transient` churn with its own operator-facing wording. A record
  is claimed by the polling job rather than deleted, so a retried durable poll reads the same
  answer, and it is dropped when a new job is accepted, so a marker left by a routine idle reclaim
  cannot excuse a later step's genuine crash. The two per-run container classes collapsed onto a
  shared `RunContainer` base carrying this bookkeeping.

  Internal break: the old `rolledOutAt` Durable-Object storage key is gone. A rollout in flight
  across the deploy that ships this loses its attribution and is recovered as a crash instead,
  which costs one eviction on the smaller budget during a single release.

  `DriveConfig` gained a required `advanceTimeoutMs` (`0` disables the ceiling, which is what the
  conformance harness and the unit fakes use), so every construction site declares it.
  `ADVANCE_TIMEOUT` is reserved against capability-credential lookup by exact name, not as an
  `ADVANCE_` family, so a credential key that merely starts with it stays valid.

- Updated dependencies [6e07961]
- Updated dependencies [9f9c240]
  - @cat-factory/kernel@0.271.0
  - @cat-factory/contracts@0.273.0
  - @cat-factory/integrations@0.149.0
  - @cat-factory/orchestration@0.239.0
  - @cat-factory/server@0.251.0
  - @cat-factory/agents@0.117.11
  - @cat-factory/gates@0.9.37
  - @cat-factory/prompt-fragments@1.0.21

## 0.33.1

### Patch Changes

- Updated dependencies [6c6dd0c]
- Updated dependencies [70745b6]
  - @cat-factory/kernel@0.270.0
  - @cat-factory/contracts@0.272.0
  - @cat-factory/orchestration@0.238.0
  - @cat-factory/integrations@0.148.0
  - @cat-factory/server@0.250.0
  - @cat-factory/agents@0.117.10
  - @cat-factory/gates@0.9.36
  - @cat-factory/prompt-fragments@1.0.20

## 0.33.0

### Minor Changes

- 55310f6: Make a linked design something a designer can actually start work from.

  Figma has been a document source for a while, and none of it was reachable by the person it exists
  for. Connecting meant minting a personal access token by hand. Attaching a design meant finding the
  Integrations hub, importing the page there, going back to the board, adding a task, and attaching
  it. Nothing on the board or the task form said "start from a design" at all, and every string on
  the way through said requirements, RFC or PRD. Expanding a design into board structure was worse
  than absent: the planner asks what architecture a document describes, which for a design is a
  service per Figma page.

  Four things close that.

  **OAuth connect.** A source can now declare an `authorization_code` half, and one shared flow runs
  it. The provider contributes four constants (two endpoints, a refresh endpoint or null, the scopes)
  and nothing else: no fetch, no token parsing, no credential mapping, so the second source to gain
  OAuth adds a declaration rather than a second copy of the flow. The credential bag is
  platform-owned, which is what keeps the token lifecycle out of every provider — a provider's whole
  share of it is noticing an access token in the bag it was handed. Declaring an OAuth half is
  deliberately NOT the same as offering one: running it needs an app the deployment registered, so
  the source listing answers "what this source supports" and "what this deployment can run" as two
  separate fields. Folded into one, a board with no registered Figma app would render a "Connect with
  Figma" button that can only 503.

  **A start-from-design entry on the board.** A frame-header button, and an offer on any Add-task
  description that links a page. Both ask only host-pinned sources, which is the safety property
  rather than an optimisation: a host-blind parser claims a shape, so asking Notion about a Figma
  link whose file key carries a UUID-shaped run gets a confident yes and stages the design into
  Notion's key space. The paste is resolved before anything is created, and a reference the parser
  had to WIDEN (Figma's own Copy link emits an unreadable id for any component instance, so the
  parser falls back to the whole file) says so on its own line, apart from the ordinary trim: "I
  attached this frame" and "I attached the entire design" otherwise render identically, and for a
  designer that widening is the defect.

  **Target-aware planning.** `plan` now asks one of two questions, with two different answer shapes:
  what architecture a document describes, or what work it implies inside a service that already
  exists. A targeted response that proposes frames is refused rather than re-read as modules, because
  a model proposing services where one exists has made a mistake and re-reading it would launder that
  onto the board. This is also what makes the `frameId` spawn safe to offer: flattening a board-wide
  plan into a frame discarded the frame titles and types the preview rendered, so the spawn produced
  something other than what was approved, while a plan authored for the target carries one frame that
  IS the target. Design documents require a target for the reason above.

  **Copy and a tour.** Connect copy that names designs, and a `start-from-design` tour in the launch
  arc rather than the catalogue-only half, gated on a design source being connected rather than on
  permission to connect one — that is the admin's job, and gating on it would withhold the tour from
  exactly the persona it is written for.

  Two compatibility notes. `DocumentBoardPlan` gains a required `targetFrameId`, and the OAuth
  install URL is admin-tier even though it only reads: what it hands back is the first half of a
  credential write, completed through a public callback where no tier can be checked.

### Patch Changes

- Updated dependencies [55310f6]
- Updated dependencies [55310f6]
  - @cat-factory/contracts@0.271.0
  - @cat-factory/kernel@0.269.0
  - @cat-factory/integrations@0.147.0
  - @cat-factory/server@0.249.0
  - @cat-factory/orchestration@0.237.0
  - @cat-factory/agents@0.117.9
  - @cat-factory/gates@0.9.35
  - @cat-factory/prompt-fragments@1.0.19

## 0.32.1

### Patch Changes

- Updated dependencies [17687a1]
  - @cat-factory/contracts@0.270.0
  - @cat-factory/kernel@0.268.0
  - @cat-factory/integrations@0.146.0
  - @cat-factory/orchestration@0.236.0
  - @cat-factory/server@0.248.0
  - @cat-factory/agents@0.117.8
  - @cat-factory/gates@0.9.34
  - @cat-factory/prompt-fragments@1.0.18

## 0.32.0

### Minor Changes

- 2b74bd0: Let a mothership open the org credentials a mothership-mode node holds no key for

  Mothership mode splits the encryption keys on purpose: a laptop seals its own agent and model
  credentials under a local key, and the mothership's `ENCRYPTION_KEY` never travels. That split is
  what made every sealed-blob repository safe to serve over the persistence RPC, and it is also what
  left those blobs unreadable on the node. A row a hosted teammate wrote is sealed under the
  mothership's key, so a mothership-mode node could save an infrastructure connection and never
  provision with it, save a Datadog connection and never probe with it, and four earlier slices parked
  a surface rather than ship it broken.

  `POST /internal/secrets/unseal` and `POST /internal/secrets/seal` close that. The node names the
  ROW, never the ciphertext: it posts a source from a closed table plus the row's identifiers, and the
  mothership re-reads the authoritative row from its own store, binds the workspace to an account
  exactly as the persistence RPC does, and decrypts under its own key. A compromised node token can
  therefore only ask for a value it could already have read had it held the key, in an account it can
  already reach, which is what keeps this from being a decryption oracle. The seal direction matters
  just as much: a mothership-mode node provisions environments, and a row it sealed locally would be
  unopenable by the mothership's own teardown with nothing saying so until a reclaim failed.

  Consumers reach it through one kernel seam, `createOrgSecretCipher`. With no delegate wired (every
  hosted deployment, and local mode over its own Postgres) it is a pass-through to the facade's own
  cipher, so nothing changes there.

  With provisioning writes now safe to persist, `environmentRegistryRepository.insert`/`update` join
  the persistence allow-list, and so does `softDelete`, the tombstone half every re-provision and
  every reclaim runs. A mothership-mode node therefore provisions, polls and tears down environments
  for real, and the ephemeral-environment self-test runs end to end. Provisioning and teardown take
  the delegate together rather than separately: teardown opens the very provision fields provisioning
  sealed, so a node holding one and not the other could stand infrastructure up and never reclaim it.

  A mothership-mode node may not itself answer the delegation endpoints. They are wired only where a
  facade holds its own main database, because a node's `ENCRYPTION_KEY` is the local key that seals
  its own agent credentials, and sealing an org row under it is the split this change removes.

  Behaviour change worth knowing about on an existing mothership-mode node: rows it previously sealed
  under its LOCAL key are no longer opened locally. Pre-1.0 internals break rather than grow a
  compatibility path, so re-save an affected environment or observability connection; the key-drift
  sweep reports them.

  Deliberately still off, and stated in the tracker: the document/task source connections (their
  repositories decrypt inside, so there is no sealed field for a row-addressed unseal to name), the
  mothership-side Slack residual, and the sealed-blob consumers a mothership-mode node does not
  currently drive. Each is a table entry plus service threading on the same pattern, not a new
  mechanism.

### Patch Changes

- Updated dependencies [01bb6d2]
- Updated dependencies [f0154ce]
- Updated dependencies [eac67c5]
- Updated dependencies [2b74bd0]
  - @cat-factory/contracts@0.269.0
  - @cat-factory/kernel@0.267.0
  - @cat-factory/orchestration@0.235.0
  - @cat-factory/server@0.247.0
  - @cat-factory/integrations@0.145.0
  - @cat-factory/agents@0.117.7
  - @cat-factory/gates@0.9.33
  - @cat-factory/prompt-fragments@1.0.17

## 0.31.28

### Patch Changes

- Updated dependencies [eaab22a]
  - @cat-factory/contracts@0.268.0
  - @cat-factory/kernel@0.266.0
  - @cat-factory/integrations@0.144.0
  - @cat-factory/server@0.246.0
  - @cat-factory/agents@0.117.6
  - @cat-factory/gates@0.9.32
  - @cat-factory/orchestration@0.234.1
  - @cat-factory/prompt-fragments@1.0.16

## 0.31.27

### Patch Changes

- Updated dependencies [74ea2bc]
  - @cat-factory/contracts@0.267.0
  - @cat-factory/kernel@0.265.0
  - @cat-factory/orchestration@0.234.0
  - @cat-factory/server@0.245.0
  - @cat-factory/agents@0.117.5
  - @cat-factory/gates@0.9.31
  - @cat-factory/integrations@0.143.1
  - @cat-factory/prompt-fragments@1.0.15

## 0.31.26

### Patch Changes

- Updated dependencies [1c8df4a]
  - @cat-factory/contracts@0.266.0
  - @cat-factory/kernel@0.264.0
  - @cat-factory/orchestration@0.233.0
  - @cat-factory/integrations@0.143.0
  - @cat-factory/server@0.244.0
  - @cat-factory/agents@0.117.4
  - @cat-factory/gates@0.9.30
  - @cat-factory/prompt-fragments@1.0.14

## 0.31.25

### Patch Changes

- Updated dependencies [6637bbd]
  - @cat-factory/contracts@0.265.0
  - @cat-factory/kernel@0.263.0
  - @cat-factory/integrations@0.142.0
  - @cat-factory/server@0.243.0
  - @cat-factory/agents@0.117.3
  - @cat-factory/gates@0.9.29
  - @cat-factory/orchestration@0.232.1
  - @cat-factory/prompt-fragments@1.0.13

## 0.31.24

### Patch Changes

- Updated dependencies [be9b8dc]
  - @cat-factory/contracts@0.264.0
  - @cat-factory/orchestration@0.232.0
  - @cat-factory/server@0.242.0
  - @cat-factory/agents@0.117.2
  - @cat-factory/gates@0.9.28
  - @cat-factory/integrations@0.141.2
  - @cat-factory/kernel@0.262.2
  - @cat-factory/prompt-fragments@1.0.12

## 0.31.23

### Patch Changes

- Updated dependencies [1025674]
- Updated dependencies [e5f7eb0]
  - @cat-factory/contracts@0.263.0
  - @cat-factory/server@0.241.0
  - @cat-factory/orchestration@0.231.0
  - @cat-factory/agents@0.117.1
  - @cat-factory/gates@0.9.27
  - @cat-factory/integrations@0.141.1
  - @cat-factory/kernel@0.262.1
  - @cat-factory/prompt-fragments@1.0.11

## 0.31.22

### Patch Changes

- Updated dependencies [8cbd518]
- Updated dependencies [8cbd518]
- Updated dependencies [7a2730a]
  - @cat-factory/contracts@0.262.0
  - @cat-factory/kernel@0.262.0
  - @cat-factory/integrations@0.141.0
  - @cat-factory/agents@0.117.0
  - @cat-factory/orchestration@0.230.0
  - @cat-factory/server@0.240.0
  - @cat-factory/gates@0.9.26
  - @cat-factory/prompt-fragments@1.0.10

## 0.31.21

### Patch Changes

- Updated dependencies [f7882cf]
- Updated dependencies [e6aa37d]
- Updated dependencies [aabfb4d]
  - @cat-factory/orchestration@0.229.0
  - @cat-factory/contracts@0.261.1
  - @cat-factory/server@0.239.2
  - @cat-factory/kernel@0.261.0
  - @cat-factory/agents@0.116.8
  - @cat-factory/gates@0.9.25
  - @cat-factory/integrations@0.140.2
  - @cat-factory/prompt-fragments@1.0.9

## 0.31.20

### Patch Changes

- Updated dependencies [9d6bce0]
  - @cat-factory/kernel@0.260.0
  - @cat-factory/agents@0.116.7
  - @cat-factory/gates@0.9.24
  - @cat-factory/integrations@0.140.1
  - @cat-factory/orchestration@0.228.1
  - @cat-factory/prompt-fragments@1.0.8
  - @cat-factory/server@0.239.1

## 0.31.19

### Patch Changes

- Updated dependencies [24f76f1]
- Updated dependencies [964cfa6]
- Updated dependencies [964cfa6]
  - @cat-factory/contracts@0.261.0
  - @cat-factory/integrations@0.140.0
  - @cat-factory/kernel@0.259.0
  - @cat-factory/orchestration@0.228.0
  - @cat-factory/server@0.239.0
  - @cat-factory/agents@0.116.6
  - @cat-factory/gates@0.9.23
  - @cat-factory/prompt-fragments@1.0.7

## 0.31.18

### Patch Changes

- Updated dependencies [ae44914]
- Updated dependencies [4be3510]
- Updated dependencies [3b89686]
  - @cat-factory/contracts@0.260.0
  - @cat-factory/integrations@0.139.0
  - @cat-factory/server@0.238.0
  - @cat-factory/orchestration@0.227.0
  - @cat-factory/kernel@0.258.0
  - @cat-factory/agents@0.116.5
  - @cat-factory/gates@0.9.22
  - @cat-factory/prompt-fragments@1.0.6

## 0.31.17

### Patch Changes

- Updated dependencies [11dae5b]
  - @cat-factory/contracts@0.259.0
  - @cat-factory/kernel@0.257.0
  - @cat-factory/orchestration@0.226.0
  - @cat-factory/agents@0.116.4
  - @cat-factory/gates@0.9.21
  - @cat-factory/integrations@0.138.3
  - @cat-factory/prompt-fragments@1.0.5
  - @cat-factory/server@0.237.1

## 0.31.16

### Patch Changes

- Updated dependencies [6076cf1]
- Updated dependencies [2fdb08d]
- Updated dependencies [11a2966]
  - @cat-factory/agents@0.116.3
  - @cat-factory/kernel@0.256.0
  - @cat-factory/orchestration@0.225.0
  - @cat-factory/server@0.237.0
  - @cat-factory/contracts@0.258.0
  - @cat-factory/gates@0.9.20
  - @cat-factory/integrations@0.138.2
  - @cat-factory/prompt-fragments@1.0.4

## 0.31.15

### Patch Changes

- Updated dependencies [00bff05]
  - @cat-factory/contracts@0.257.0
  - @cat-factory/orchestration@0.224.0
  - @cat-factory/server@0.236.0
  - @cat-factory/agents@0.116.2
  - @cat-factory/gates@0.9.19
  - @cat-factory/integrations@0.138.1
  - @cat-factory/kernel@0.255.1
  - @cat-factory/prompt-fragments@1.0.3

## 0.31.14

### Patch Changes

- Updated dependencies [ab0c228]
  - @cat-factory/contracts@0.256.0
  - @cat-factory/kernel@0.255.0
  - @cat-factory/integrations@0.138.0
  - @cat-factory/orchestration@0.223.0
  - @cat-factory/server@0.235.0
  - @cat-factory/agents@0.116.1
  - @cat-factory/gates@0.9.18
  - @cat-factory/prompt-fragments@1.0.2

## 0.31.13

### Patch Changes

- Updated dependencies [184d263]
- Updated dependencies [ee6ce7c]
  - @cat-factory/agents@0.116.0
  - @cat-factory/orchestration@0.222.0
  - @cat-factory/kernel@0.254.0
  - @cat-factory/contracts@0.255.0
  - @cat-factory/server@0.234.0
  - @cat-factory/gates@0.9.17
  - @cat-factory/integrations@0.137.2
  - @cat-factory/prompt-fragments@1.0.1

## 0.31.12

### Patch Changes

- Updated dependencies [16576d6]
  - @cat-factory/prompt-fragments@1.0.0
  - @cat-factory/kernel@0.253.0
  - @cat-factory/contracts@0.254.0
  - @cat-factory/orchestration@0.221.0
  - @cat-factory/agents@0.115.0
  - @cat-factory/server@0.233.0
  - @cat-factory/gates@0.9.16
  - @cat-factory/integrations@0.137.1

## 0.31.11

### Patch Changes

- Updated dependencies [5202fb9]
  - @cat-factory/integrations@0.137.0
  - @cat-factory/orchestration@0.220.0
  - @cat-factory/kernel@0.252.0
  - @cat-factory/contracts@0.253.0
  - @cat-factory/prompt-fragments@0.16.0
  - @cat-factory/server@0.232.0
  - @cat-factory/agents@0.114.7
  - @cat-factory/gates@0.9.15

## 0.31.10

### Patch Changes

- Updated dependencies [b8b6888]
  - @cat-factory/gates@0.9.14

## 0.31.9

### Patch Changes

- Updated dependencies [e845d65]
  - @cat-factory/kernel@0.251.0
  - @cat-factory/server@0.231.0
  - @cat-factory/agents@0.114.6
  - @cat-factory/gates@0.9.13
  - @cat-factory/integrations@0.136.2
  - @cat-factory/orchestration@0.219.1

## 0.31.8

### Patch Changes

- Updated dependencies [4c071ec]
  - @cat-factory/contracts@0.252.0
  - @cat-factory/kernel@0.250.0
  - @cat-factory/orchestration@0.219.0
  - @cat-factory/server@0.230.0
  - @cat-factory/agents@0.114.5
  - @cat-factory/gates@0.9.12
  - @cat-factory/integrations@0.136.1
  - @cat-factory/prompt-fragments@0.15.78

## 0.31.7

### Patch Changes

- Updated dependencies [3fbc87e]
- Updated dependencies [c9adc67]
  - @cat-factory/contracts@0.251.0
  - @cat-factory/kernel@0.249.0
  - @cat-factory/orchestration@0.218.0
  - @cat-factory/server@0.229.0
  - @cat-factory/integrations@0.136.0
  - @cat-factory/agents@0.114.4
  - @cat-factory/gates@0.9.11
  - @cat-factory/prompt-fragments@0.15.77

## 0.31.6

### Patch Changes

- Updated dependencies [6ccc104]
  - @cat-factory/integrations@0.135.0
  - @cat-factory/orchestration@0.217.1
  - @cat-factory/server@0.228.1

## 0.31.5

### Patch Changes

- Updated dependencies [e7e27ee]
  - @cat-factory/contracts@0.250.0
  - @cat-factory/kernel@0.248.0
  - @cat-factory/orchestration@0.217.0
  - @cat-factory/server@0.228.0
  - @cat-factory/agents@0.114.3
  - @cat-factory/gates@0.9.10
  - @cat-factory/integrations@0.134.1
  - @cat-factory/prompt-fragments@0.15.76

## 0.31.4

### Patch Changes

- Updated dependencies [cad3408]
- Updated dependencies [eee42e9]
- Updated dependencies [cad3408]
  - @cat-factory/server@0.227.0
  - @cat-factory/integrations@0.134.0
  - @cat-factory/orchestration@0.216.1

## 0.31.3

### Patch Changes

- Updated dependencies [53cd697]
  - @cat-factory/contracts@0.249.0
  - @cat-factory/kernel@0.247.0
  - @cat-factory/integrations@0.133.0
  - @cat-factory/orchestration@0.216.0
  - @cat-factory/gates@0.9.9
  - @cat-factory/server@0.226.0
  - @cat-factory/agents@0.114.2
  - @cat-factory/prompt-fragments@0.15.75

## 0.31.2

### Patch Changes

- Updated dependencies [6d3f784]
  - @cat-factory/kernel@0.246.0
  - @cat-factory/server@0.225.0
  - @cat-factory/contracts@0.248.0
  - @cat-factory/integrations@0.132.0
  - @cat-factory/orchestration@0.215.0
  - @cat-factory/agents@0.114.1
  - @cat-factory/gates@0.9.8
  - @cat-factory/prompt-fragments@0.15.74

## 0.31.1

### Patch Changes

- Updated dependencies [0937581]
- Updated dependencies [250b7dc]
  - @cat-factory/contracts@0.247.0
  - @cat-factory/kernel@0.245.0
  - @cat-factory/server@0.224.0
  - @cat-factory/agents@0.114.0
  - @cat-factory/orchestration@0.214.0
  - @cat-factory/gates@0.9.7
  - @cat-factory/integrations@0.131.1
  - @cat-factory/prompt-fragments@0.15.73

## 0.31.0

### Minor Changes

- ec96387: Account audit log, slices 1 and 2: privileged tenancy actions are now recorded, with the store and the
  first real writers landing together.

  Until now nothing left a record of who did what: role changes, budget edits, invitations sent and
  revoked, board roster changes and access-mode flips all happened with the resulting STATE as the only
  evidence. `audit_events` (D1 ⇄ Drizzle, cross-runtime conformance) is an append-only log of them,
  written at the point each mutation commits, and the tenancy services in `@cat-factory/workspaces` are
  the first writers: account member add / role change, account budget and settings edits, invitation
  create / revoke / accept, and the workspace roster's add / role change / remove / access-mode flip.

  Four decisions worth knowing, because each has a wrong-looking alternative that reads as correct:

  **It gets its OWN store, and not for the reason telemetry has one.** An audit log looks append-heavy
  and therefore telemetry-shaped, but it is the mirror image: low-volume (admin actions, single digits
  per account per month, against telemetry's row-per-LLM-call) and long-retention where telemetry
  prunes at three days. What makes it a storage question is the run-lifecycle slice, after which this
  becomes the only table in the platform that grows monotonically with run volume AND wants a
  multi-year window; on a store with a hard 10 GB per-database ceiling that would put a years-deep
  trail in competition with live transactional state. Measured at ~500 B/row on Postgres (the index
  costing as much as the data, since the keyset carries `id` as its tie-break), so 1,000 runs/day is
  ~550 MB/year. It is a required `AUDIT_DB` D1 database on Cloudflare and an `audit` Postgres schema on
  Node. It is emphatically NOT in the telemetry store: that bucket is written and read on the LAPTOP in
  mothership mode, which would scatter the trail across nodes and leave it readable and deletable by
  the person it audits.

  **OPERATOR ACTION on Cloudflare**: `AUDIT_DB` is required, so a deployment must provision it
  (`wrangler d1 create cat_factory_audit`, then paste the id into its `wrangler.toml`;
  `db:migrate:remote` applies `audit-migrations` alongside the other lineages). Required means
  required, and not softly: the container build refuses an unbound binding, so a Worker deployed
  without it answers the misconfiguration screen on every request rather than running silently
  unaudited, and `/ready` reports `audit` so an operator reads which binding is missing. Per-PR preview
  environments provision and tear the database down automatically.

  **A row states VALUES, never a sentence.** An event carries `action` plus machine-readable
  `details` (`{"previousRole":"viewer","role":"admin"}`), and the viewer composes its copy from
  translated keys. Recording a ready-made English summary is the tempting shape and is wrong here for
  a reason peculiar to this store: rows are kept for years, so prose written today could never be
  re-rendered for a reader in another locale, and a persisted shape cannot be quietly changed later the
  way a wire shape can. `AUDIT_ACTION_DETAIL_KEYS` in contracts names each action's fields, so the
  writer and the viewer agree about the slots and a new action cannot ship with values the copy has no
  place for. For the same "closed but persisted" reason `targetType` is a picklist rather than a free
  string, and both vocabularies read back through guards derived from their own picklists: a member
  retired from the union arrives NAMED as retired (`{ retired: 'account.seat_reassigned' }`), never
  guessed onto a current member and never dropped, since a missing row is the one failure an audit log
  must not have.

  **The actor is a discriminated principal, and `system` is asserted rather than defaulted.** `user`,
  `apiKey` and `system` are three kinds, not a nullable user id, because "the engine did it" and "we
  lost track of who did it" are different facts and a log rendering them identically misattributes a
  human action to automation. Where no acting user resolves (only reachable under `AUTH_DEV_OPEN`, where
  the whole authorization model is bypassed) NOTHING is recorded rather than an event blaming the engine.
  `apiKey` is separate from the user who minted the key, so a leaked key is not indistinguishable from
  that person in the log.

  **`record` cannot FAIL the action it describes, but it is awaited.** The append runs behind
  `runBestEffort`, so a store outage costs the audit row and logs a warning, never the membership change
  the operator asked for. It is deliberately not fire-and-forget: an un-awaited write is discarded when
  a Worker isolate freezes after the response (the rule `http/waitUntil.ts` exists to state), so
  `record`-and-return would have recorded nothing on the primary runtime while every test driving a fake
  recorder went on passing. One store round-trip is worth strictly more than the milliseconds it costs
  an admin action. The READ has the opposite disposition and propagates: a viewer silently rendering an
  empty page when the store is down tells an admin the exact opposite of the truth.

  `CoreDependencies.auditRecorder` is REQUIRED, joining `logger` and `operationalMetrics` for the same
  reason and with the sharpest version of it: an un-wired audit log reads as "nobody changed anything",
  which is precisely the assurance it exists to give. A deployment that does not persist audit events
  passes kernel's `noopAuditRecorder`, which says so in code.

  INTERNAL BREAK: `WorkspaceMemberService.setRole`, `.remove` and `.setAccessMode` each take a trailing
  `actingUserId: string | null`, matching `.add`'s existing shape. Without it those three writes had no
  actor to attribute, and defaulting them to `system` would have been the misattribution above.
  `@cat-factory/server`'s controller supplies `c.get('user')?.id ?? null`.

  Still to come on this initiative: the paginated read endpoint and the admin viewer UI, run-lifecycle
  and API-key events, session revocation, and the retention sweep (so the table is unbounded until that
  slice lands).

- 4e4d1b4: OAuth for external MCP tool servers, so the OAuth-first hosted ecosystem (Linear, Atlassian,
  Figma, Slack's remote server) is reachable at all. A remote (`http`) declaration may now carry
  `oauth`: the `authorization_code` grant, which a `secrets.manage` holder completes once per board
  from the Infrastructure window, and `client_credentials`, which needs no human and covers an
  internal or partner server. Endpoints are discovered per the MCP authorization spec (RFC 9728 →
  RFC 8414 → OIDC discovery) with a declaration override, PKCE and the RFC 8707 `resource` indicator
  are always used, and the grant is sealed per (workspace, server) and refreshed on the dispatch
  path. The access token rides the job body's header channel only, never a prompt or the telemetry
  snapshot.

  Two new unavailability reasons (`oauth_not_connected`, `oauth_token_failed`) and the matching probe
  verdicts keep "nobody connected", "the connection stopped working" and "no credential configured"
  apart, since each sends an operator somewhere different. New table `mcp_oauth_grants` on both
  runtimes (D1 migration 0082 ⇄ a Drizzle migration), in the mothership `remote` bucket and in the
  workspace-delete cascade. Interactive grants need `MCP_OAUTH_REDIRECT_URL` set to the deployment's
  public app URL followed by `/mcp-oauth-callback` and `ENCRYPTION_KEY` for the sealed store; without
  either, an OAuth server is stated to its agent as unavailable rather than dispatched without a
  token.

  The vendor's redirect lands on the SPA, which re-presents the `code` and `state` to a session-gated
  `POST /mcp/oauth/complete`. A backend route receiving the redirect directly could not be gated:
  sessions are bearer tokens and a third-party browser navigation carries none, so it would have to
  sit outside the default-deny session gate, and the "same user who started the flow" and "still
  holds `secrets.manage`" checks would never execute. Routing it through the app is what makes both
  enforceable.

### Patch Changes

- Updated dependencies [ec96387]
- Updated dependencies [7f5ed08]
- Updated dependencies [4e4d1b4]
  - @cat-factory/contracts@0.246.0
  - @cat-factory/kernel@0.244.0
  - @cat-factory/integrations@0.131.0
  - @cat-factory/orchestration@0.213.0
  - @cat-factory/server@0.223.0
  - @cat-factory/agents@0.113.0
  - @cat-factory/gates@0.9.6
  - @cat-factory/prompt-fragments@0.15.72

## 0.30.4

### Patch Changes

- Updated dependencies [10e7a15]
- Updated dependencies [ca213b1]
  - @cat-factory/contracts@0.245.0
  - @cat-factory/orchestration@0.212.0
  - @cat-factory/agents@0.112.6
  - @cat-factory/gates@0.9.5
  - @cat-factory/integrations@0.130.2
  - @cat-factory/kernel@0.243.1
  - @cat-factory/prompt-fragments@0.15.71
  - @cat-factory/server@0.222.2

## 0.30.3

### Patch Changes

- Updated dependencies [d69115d]
  - @cat-factory/contracts@0.244.0
  - @cat-factory/kernel@0.243.0
  - @cat-factory/orchestration@0.211.0
  - @cat-factory/agents@0.112.5
  - @cat-factory/gates@0.9.4
  - @cat-factory/integrations@0.130.1
  - @cat-factory/prompt-fragments@0.15.70
  - @cat-factory/server@0.222.1

## 0.30.2

### Patch Changes

- Updated dependencies [f775c1d]
- Updated dependencies [bac6776]
- Updated dependencies [3857ea4]
  - @cat-factory/kernel@0.242.0
  - @cat-factory/server@0.222.0
  - @cat-factory/contracts@0.243.0
  - @cat-factory/orchestration@0.210.0
  - @cat-factory/integrations@0.130.0
  - @cat-factory/agents@0.112.4
  - @cat-factory/gates@0.9.3
  - @cat-factory/prompt-fragments@0.15.69

## 0.30.1

### Patch Changes

- 7cf3e70: Refresh the dependency tree and re-roll both runner images.

  **Registry deps** (direct ranges plus a full lockfile re-resolution, so transitives move to the newest
  release each declared range already admits):

  - **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.47 → ^7.0.51`,
    `@ai-sdk/anthropic`/`@ai-sdk/openai@^4.0.27 → ^4.0.29`, `@ai-sdk/openai-compatible@^3.0.20 → ^3.0.22`,
    `@ai-sdk/provider@^4.0.4 → ^4.0.5`, `@ai-sdk/amazon-bedrock@^5.0.40 → ^5.0.42`.
  - **Runtime deps**: `hono@^4.12.33 → ^4.13.0`, `@hono/node-server@^2.0.12 → ^2.1.0`,
    `pg-boss@^12.26.4 → ^12.27.0`, `undici@^8.9.0 → ^8.10.0`, `ws@^8.21.1 → ^8.21.2`,
    `@aws-sdk/client-s3@^3.1101.0 → ^3.1102.0`, `nuxt@^4.5.0 → ^4.5.1`.
  - **Tooling**: `oxlint@^1.76.0 → ^1.77.0`, `oxfmt@^0.61.0 → ^0.62.0`, `publint@^0.3.22 → ^0.3.23`,
    `vitest@^4.1.8 → ^4.1.10`, `@cloudflare/workers-types@^5.20260801.1 → ^5.20260804.1`.

  **Runner images** (`@cat-factory/executor-harness` 1.92.1, `@cat-factory/deploy-harness` 0.2.10, with
  all six pinned tags synced):

  - Executor: Claude Code `2.1.220 → 2.1.221`, and the two lockstep Pi extensions
    `rpiv-todo`/`rpiv-web-tools` `2.3.1 → 2.4.0`. Pi stays at `0.83.0` and Codex at `0.146.0`, both
    already the latest. Claude Code `2.1.222` exists but was published inside the release-age window, so
    `2.1.221` is the newest version the supply-chain rule admits.
  - Deploy: `kubectl v1.36.3`, `helm v4.2.3` and `kustomize v5.8.1` are all already the latest, so the
    image moves only for the base re-pin below.
  - Both: the `node:26-trixie-slim` base re-pinned to the current multi-arch index digest.

  No `minimumReleaseAgeExclude` entries were added: every version above already satisfies the gate.

  **Majors**: none were available this sweep except `typescript@6 → 7` for the frontend, which stays on 6
  for the same reason as last time. `vue-tsc@3.3.9` still resolves its compiler through
  `require.resolve('typescript/lib/tsc')`, and TypeScript 7's `exports` map publishes no such entry, so
  the frontend typecheck would fail to resolve at all.

- Updated dependencies [7cf3e70]
  - @cat-factory/agents@0.112.3
  - @cat-factory/integrations@0.129.1
  - @cat-factory/kernel@0.241.1
  - @cat-factory/orchestration@0.209.1
  - @cat-factory/server@0.221.1
  - @cat-factory/gates@0.9.2

## 0.30.0

### Minor Changes

- e7867db: Run evidence and key provisioning on `/api/v1`, and a trajectory link on the PR report

  Everything the platform captured about a run was reachable only from a browser session. A consumer
  whose job is to JUDGE a run (a trial harness deciding whether to accept a change, an evaluation
  pipeline scoring a fleet) could scrape the fenced JSON block out of a pull-request body and read
  `/api/v1/debug/*`, and that was all: the captured screenshots were unreachable, and a run with no
  pull request (a headless job, a run that failed before it pushed) had no evidence surface at all.
  Getting a key at all still needed a browser.

  Three additions, all `/api/v1`:

  - **`GET /runs/:runId/report`** serves the engine's verification report: the SAME bundle it writes
    onto the pull request, composed on read by the same code, so the two can never disagree about
    what a run proved. It answers for runs that never opened a pull request, and it does not consult
    the `publishPrVerificationReport` opt-out, which is a statement about writing onto someone else's
    pull request rather than about reading your own evidence back.
  - **`GET /runs/:runId/artifacts`** and **`GET /artifacts/:artifactId/blob`** list a run's captured
    artifacts and stream their bytes, at `read` scope, with the content type clamped to the image
    allow-list exactly as the session-authed route does. An account with no blob backend gets a 503,
    never an empty list. The blob operation declares every media type it can answer with (the image
    allow-list plus an `application/octet-stream` fallback) rather than one standing in for the rest,
    so a client generated from the spec can switch on the response honestly.
  - **`GET|POST|DELETE /keys`** provisions keys headlessly at `admin` scope. Two enforced bounds make
    that safe: a key minted here can never reach the `admin` rung minting requires (so the chain is
    one link long), and revoking a key now revokes every key it minted, on this surface and in the
    app alike. Otherwise a leaked provisioning key would survive its own revocation.

  Refusals across the three evidence reads carry `error.details.reason`, so causes needing different
  reactions stay apart: `run_not_found`, `artifact_not_found`, `artifact_blob_missing` (the row
  outlived its bytes, which is a storage fault rather than a bad request) and
  `binary_artifact_storage_unconfigured`.

  The **PR verification report** gained the links a machine needs: `observability.trajectoryUrl` (the
  run's tool calls in the order the agents made them) and `observability.reportUrl` (this report,
  served live), both rendered in the prose as well as carried in the JSON, and both built from the
  deployment's public BACKEND url. Report payload version 5 → 6.

  Worth knowing when upgrading:

  - **The report shape is now part of the STABLE public surface.** It is served verbatim on
    `/api/v1`, so from here it grows additively and never renames or retypes in place.
  - **A new `created_by_key_id` column** on `public_api_keys` (D1 migration `0081`, its Drizzle
    mirror, plus an index), which carries the provenance of a headless mint and is what the
    revocation cascade follows. The app's key panel renders it, so a provisioned key no longer reads
    as one whose minter is unknown.
  - **The SDK chain learned binary responses.** An operation whose success body was neither JSON nor
    SSE previously generated as a method that returned NOTHING; the IR now marks it `binary`, each
    of the four transports hands the bytes back in its own idiom, and an unrecognised media type
    fails generation instead of silently discarding a body.
  - **A container wiring bug is fixed on both facades**: the HTTP layer's binary-artifact store
    resolver was built from account settings while the engine's came from `CoreDependencies`, so an
    override reached one side of the app and not the other.

### Patch Changes

- Updated dependencies [e7867db]
- Updated dependencies [00c4d94]
  - @cat-factory/contracts@0.242.0
  - @cat-factory/kernel@0.241.0
  - @cat-factory/integrations@0.129.0
  - @cat-factory/orchestration@0.209.0
  - @cat-factory/server@0.221.0
  - @cat-factory/agents@0.112.2
  - @cat-factory/gates@0.9.1
  - @cat-factory/prompt-fragments@0.15.68

## 0.29.3

### Patch Changes

- Updated dependencies [c5a1a16]
  - @cat-factory/contracts@0.241.0
  - @cat-factory/kernel@0.240.0
  - @cat-factory/gates@0.9.0
  - @cat-factory/orchestration@0.208.0
  - @cat-factory/server@0.220.0
  - @cat-factory/agents@0.112.1
  - @cat-factory/integrations@0.128.1
  - @cat-factory/prompt-fragments@0.15.67

## 0.29.2

### Patch Changes

- Updated dependencies [dd90c1e]
- Updated dependencies [289b3de]
- Updated dependencies [dd90c1e]
- Updated dependencies [dd90c1e]
  - @cat-factory/contracts@0.240.0
  - @cat-factory/agents@0.112.0
  - @cat-factory/orchestration@0.207.0
  - @cat-factory/server@0.219.0
  - @cat-factory/kernel@0.239.0
  - @cat-factory/integrations@0.128.0
  - @cat-factory/gates@0.8.76
  - @cat-factory/prompt-fragments@0.15.66

## 0.29.1

### Patch Changes

- 4e5640d: Adopt a catalog pipeline into the workspace on first run, so no board is stuck behind an advisory.

  Built-in pipelines are copied into each workspace at creation, so a board seeded before a pipeline
  shipped holds no row for it, and the catalog's own copy is invisible to every read: the library lists
  rows, the builder edits rows, a run resolves by row. For a human browsing the pipeline library the
  new-pipeline advisory plus a reseed closes that gap. For anything that PINS a pipeline by id it does
  not, and a reusable operation does exactly that: the pin resolves off the task-type registry, which
  knows nothing about rows, so a task of the operation was creatable on an older board and then refused
  to start with a bare 404 that named nothing the user could act on.

  Run resolution now goes through `pipelineAdoption.adoptForRun`, which returns the stored row or
  materialises the catalog entry and returns that. It WRITES rather than running off the code copy on
  purpose: resolving from the catalog without persisting would leave a run executing a pipeline the
  board's own library cannot show, open in the builder, or attach a schedule to, which is the same
  dishonesty as rendering an absent thing as an empty one. Only `builtin` catalog entries are adoptable,
  and that restriction is the safety argument rather than a convenience: a built-in is read-only and
  becomes deletable only once retired, and a retired id is absent from `seedPipelines` by construction,
  so "no row plus a live built-in entry" can only mean never adopted. A versionless registered pipeline
  is deletable, so adopting one would resurrect a deliberate deletion.

  Two adoptions race by construction (two tasks of one operation started at once both resolve "no row"),
  so this adds `PipelineRepository.insertIfAbsent`, conflict-targeted `DO NOTHING` on the composite key
  on both runtimes. Deliberately not `INSERT OR IGNORE` on D1, which would also swallow an unrelated
  constraint failure on that runtime alone and so hide a real bug behind a passing Postgres suite. Both
  writers write the same catalog definition, so first write wins and the loser has nothing to report.
  `PipelineService.reseed`'s absent branch moved onto the same method, fixing a pre-existing race of its
  own, and both now build the row through one shared `adoptedCatalogRow` so adopting and reseeding cannot
  diverge on labels or archive state.

  Widening what a start resolves means every GATE standing in front of one had to be widened with it,
  which is where the read-only twin `resolveDefinition` earns its place. Each of these read the bare row
  and, finding nothing, did not refuse but CONCLUDED, about a pipeline that was about to run anyway:

  - `individualVendorsForBlock` backs the personal-credential gate on the start request, so an un-adopted
    pipeline resolved to no agent kinds, the gate concluded the run needed no personal subscription, and
    the run then adopted and started ungated.
  - The public API's decide-scope check resolves the caller's `pipelineId` to inspect it for parks. A
    `null` skipped the check entirely, and `start` then adopted and parked the run, so a `write`-only key
    could set in motion exactly the park that scope exists to withhold. Both public start paths now read
    `PipelineService.resolveForRun`, which replaces the `get` that served the stored row (nothing wants
    that read any more). One public-API behaviour change falls out of it, additive: naming a pipeline the
    board has not adopted starts the run (or is refused for want of `decide`) instead of answering `404`
    / `pipeline_not_public`, so an integration pinning a pipeline by id no longer waits on a human to
    reseed the board.
  - The post-merge auto-start resolved dependents from the workspace's pipeline LIST and dropped any
    whose pin had no row, silently, so a merge propagated into a task that never began. It now resolves
    misses through `adoptableCatalog()` (no point read per miss: the list already proves there is no
    row), and a dependent whose pin resolves to nothing at all is reported rather than dropped.

  So a bare `pipelineRepository.get` on a run-adjacent path is now the smell. Adoption is also COUNTED,
  through the new `pipeline.adopted` operational counter: the log line says which board caught up, and
  only the rate says how many are still behind a catalog the deployment already shipped.

  Left refusing on purpose: an initiative policy edit or a recurring schedule naming an un-adopted
  pipeline. Both are authoring paths where the SPA only offers stored pipelines, so the refusal is
  reachable headlessly only, and adopting on an authoring write would materialise rows for pipelines
  nobody ran.

- 4e5640d: Register a reusable operation's canned pipeline as a read-only versioned catalog template.

  An operation bundles a pipeline it PINS by id (`defaultPipelineId`), so how that pipeline is
  registered decides whether the org can ever ship a second version of the operation. The worked
  example registered `pl_org_introduce_api` versionless, which is the shape with no way out: each
  workspace got an editable copy, `reseed` refuses a stored non-builtin, and the advisory's `outdated`
  check reads `builtin` off the stored row, so a board could edit or delete the definition out from
  under the operation while the org could never roll a fix out to it. It now registers `builtin: true`
  with an explicit `version: 1`, which makes it read-only in a workspace (clone to deviate) and puts
  it on the reseed lifecycle.

  The cross-runtime assertion covers the ADOPTION direction, which nothing did: the existing
  `pl_org_flow` test already drives a registered built-in through seed, retire, tombstone and delete.
  This one drives a board seeded BEFORE the org ships the operation, as three apps over one store,
  because a workspace created after the registration is seeded with the pipeline at creation and so
  proves nothing about adoption. It asserts the pipeline is advertised in `pipelineCatalogVersions`
  with no stored row (the new-pipeline advisory's state), that one reseed INSERTS it read-only, that
  the operation is then invocable with its task pinning the adopted pipeline, and that a version bump
  moves the catalog ahead of the stored copy so the same reseed adopts the new definition.

  Worth noting for review: the package's other example pipelines (the initiative-preset routing
  targets `pl_org_audit` / `pl_org_scope` / `pl_org_research` / `pl_org_apply`) are still versionless
  and are deliberately left alone here, since they belong to the initiative-presets examples rather
  than to this initiative. The registration-shape rule is now stated once in
  `backend/docs/pipeline-catalog-lifecycle.md` so neither doc restates it.

- Updated dependencies [4e5640d]
- Updated dependencies [a675c63]
  - @cat-factory/kernel@0.238.0
  - @cat-factory/orchestration@0.206.0
  - @cat-factory/server@0.218.0
  - @cat-factory/contracts@0.239.0
  - @cat-factory/agents@0.111.0
  - @cat-factory/gates@0.8.75
  - @cat-factory/integrations@0.127.1
  - @cat-factory/prompt-fragments@0.15.65

## 0.29.0

### Minor Changes

- 2c7d17d: Deleting a task now releases its tracker ticket

  A ticket filed as a board task recorded that on `tasks.linked_block_id`, and deleting the block left
  the column naming a block that no longer existed. Three readers take a non-null value there to mean
  "this issue is spoken for", and none of them checks whether the block is still live: the bug-intake
  sweep excluded the ticket from every future search, `claimBlockLink` refused every future filing of
  it (naming a task nobody could open), and a comment reply on the ticket routed to the dead block and
  bailed. So deleting a filed task took its ticket out of circulation permanently.

  The block-delete cascade now clears the link over the whole doomed subtree, through a new batched
  `TaskRepository.unlinkAllFromBlocks` implemented on both runtimes. This is the tracker half of the
  same fix the document half took: same seam (`removal-cascade.ts`), same rule.

  Two visible behaviour changes, both intended:

  - **A deleted task's issue returns to the bug-intake candidate pool.** A workspace that has been
    deleting filed tasks will see those issues re-appear as candidates on the next sweep.
  - **Re-filing a previously-deleted ticket succeeds** instead of answering `409`
    `ticket_already_linked`.

  Nothing is deleted, only unlinked: issue rows, their bodies and their history are untouched, which
  is what makes re-filing the right outcome. Rows already carrying a stale link are not healed
  retroactively (no migration); they clear on the next delete of the block they name.

- aa62acf: Warn about spend BEFORE the safeguard starts pausing runs. The budget gate was purely reactive:
  `isOverBudget` paused a run at the ceiling and a `budget_paused` card appeared, so the first
  signal a team got that their budget was running out was a pipeline stopping halfway through. The
  new forecast layer measures a trailing-window burn rate, projects the period total, and raises a
  `budget_threshold` notification once metered spend crosses 80% of the workspace or account budget,
  or is projected to overrun it before the period ends. Gating is untouched: the forecast is
  advisory, so a projection bug can cost a wrong card and never a paused or unpaused run.

  The burn rate divides by the span the ledger was actually OBSERVED over, not the nominal window.
  Without that, a workspace that started spending two hours ago is divided by seven days and reads
  as 1/84th of its real pace, which is exactly the runaway the alert exists to catch. Below six
  hours of history the projection is withheld rather than published as a number nobody should act
  on, and `insufficient-history` is reported as its own state rather than rendered as a calm zero.

  The card notifies once per crossing per period and re-arms at the period rollover. Its persisted
  state IS the card row, read back through a new `listLatestByType` that ignores card status
  deliberately: a crossed threshold stays crossed for the rest of the month, so reading only OPEN
  cards would re-alert every fifteen minutes the moment somebody tidied their inbox. Its title and
  body therefore name only stable facts (the threshold, the limit), never the live spend or burn
  rate, which would re-toast the inbox on every sweep. The sweep runs on both facades from the same
  shared driver and cadence; it is not behind an opt-in flag, because having configured a budget is
  the opt-in. The USER budget tier is deliberately not alerted on: a personal budget is not a fact a
  workspace-visible card may state, and there is no per-user inbox to raise it in.

  `budget_threshold` is Slack-routable (unlike `budget_paused`, which arrives too late to act on).

  Also adds two TCO axes to the Reports spend rollup: `repo` and `ticket`, grouping spend by the
  run's linked repository and by the tracker issue linked to the run's block. Both are one grouped
  query rather than a hand-written join against the database. A block legitimately linked to several
  tickets is attributed to one deterministically (the lowest `source:externalId` ref) rather than
  fanned out, which would have multiplied that block's cost by the number of tickets pointing at it
  and left the breakdown disagreeing with the window totals.

  The public API's notification-type enum gains `budget_threshold` (an additive change; OpenAPI
  `info.version` 1.3.0 → 1.4.0, SDK clients regenerated). It is NOT in
  `DEFAULT_NOTIFICATION_WEBHOOK_TYPES`: like the other operator-concern cards it ships only to
  webhooks that name it in their `types` filter.

### Patch Changes

- Updated dependencies [2c7d17d]
- Updated dependencies [aa62acf]
  - @cat-factory/kernel@0.237.0
  - @cat-factory/orchestration@0.205.0
  - @cat-factory/contracts@0.238.0
  - @cat-factory/integrations@0.127.0
  - @cat-factory/server@0.217.0
  - @cat-factory/agents@0.110.9
  - @cat-factory/gates@0.8.74
  - @cat-factory/prompt-fragments@0.15.64

## 0.28.1

### Patch Changes

- Updated dependencies [99be350]
  - @cat-factory/contracts@0.237.0
  - @cat-factory/orchestration@0.204.0
  - @cat-factory/server@0.216.0
  - @cat-factory/agents@0.110.8
  - @cat-factory/gates@0.8.73
  - @cat-factory/integrations@0.126.3
  - @cat-factory/kernel@0.236.1
  - @cat-factory/prompt-fragments@0.15.63

## 0.28.0

### Minor Changes

- c9c1dd3: Persist an agent's tool calls as a first-class trajectory: one row per invocation, in the order it
  made them, carrying the tool's arguments and result. The evidence standard for a merged PR is
  "how, not just the diff", and until now the tool loop survived a run only as metadata spans a
  trace sink had to be wired to see, so reconstructing what an agent actually did meant diffing
  consecutive prompt bodies against each other.

  The fourth telemetry sink (`agent_tool_calls`), beside the per-call cost rows and the dispatch
  context snapshots, in the same store and on the same retention window: D1 on Cloudflare, the
  `telemetry` Postgres schema on Node, `node:sqlite` on a mothership-mode node, with the same
  cross-runtime conformance assertions and the same local-first routing as its siblings. Readable
  through a new `GET /api/v1/debug/runs/:runId/tool-calls` (additive; the spec's `info.version`
  takes a minor and the four SDK clients plus the MCP facade gain the operation), and exported on
  the OTel and Langfuse tool spans alongside the dispatch and ordinal a trajectory orders by.

  The endpoint serves two orders, because the order is the product and a client cannot derive it
  from the rows: `recent` is the newest-first keyset every sibling debug list shares, and
  `order=trajectory` is the run's calls oldest-first as the agents made them, a bounded prefix that
  issues no cursor (pairing one with it is refused rather than quietly served in the other order).
  Both narrow to a single dispatch with `jobId`. The server orders by when each call STARTED, with
  `seq` separating the calls that share a millisecond: sorting by the job id instead would order a
  run's dispatches by agent-kind spelling and its re-runs `-10` before `-2`.

  Both harnesses produce it: the Pi runner pairs each `tool_execution_start` with its end, and the
  claude-code runner pairs each `tool_use` block with the `tool_result` that answers it — the CLI's
  own stream being the only place a subscription run's tool loop is visible at all. Bodies are
  capped and secret-scrubbed at capture, and ride the same `LLM_RECORD_PROMPTS` +
  `storeAgentContext` double gate as every other captured body; a withheld body is recorded AS
  withheld, so an opted-out workspace's trajectory never reads as a run whose every tool took no
  arguments.

  Breaks nothing, retains nothing new by default beyond a run's tool metadata, and requires the
  `1.91.0` runner image (an older image's calls still reach the trace sinks; their trajectory is
  skipped rather than persisted under colliding ids, and the skip is logged).

### Patch Changes

- Updated dependencies [8511a90]
- Updated dependencies [c9c1dd3]
  - @cat-factory/server@0.215.0
  - @cat-factory/contracts@0.236.0
  - @cat-factory/kernel@0.236.0
  - @cat-factory/orchestration@0.203.0
  - @cat-factory/agents@0.110.7
  - @cat-factory/gates@0.8.72
  - @cat-factory/integrations@0.126.2
  - @cat-factory/prompt-fragments@0.15.62

## 0.27.1

### Patch Changes

- Updated dependencies [6b9f696]
  - @cat-factory/kernel@0.235.1
  - @cat-factory/agents@0.110.6
  - @cat-factory/gates@0.8.71
  - @cat-factory/integrations@0.126.1
  - @cat-factory/orchestration@0.202.1
  - @cat-factory/server@0.214.1

## 0.27.0

### Minor Changes

- cec0c3e: Attach spec-sized requirements documents when creating a task over the public API.

  `/api/v1` had no way to give a run a specification. `description` caps at 2,000 characters because
  it is a task's own framing, echoed into every prompt; the 50,000-character `POST /jobs` brief drives
  inline pipelines that never touch a repository; and the app's own attach-a-document flow is
  session-authed. A headless caller holding a PRD could only paste a truncated version of it into a
  field and hope. `POST /api/v1/services/:serviceId/tasks` now takes an ordered `documents` list, each
  entry either NAMING a page in a connected document source (imported and attached, as `ticket`
  already does for a tracker issue) or CARRYING the text itself. The full body reaches agents exactly
  as a document a human attached does: materialised under `.cat-context/` for a container agent,
  folded into the prompt for an inline one.

  Carrying the text needed a document with no source behind it, so `DocumentOrigin` (`DocumentSourceKind`
  plus `upload`) is now what a stored row and its block/role links are keyed by, while everything a
  provider does stays typed against the narrow union. That keeps the missing `upload` provider a
  compile error rather than an `undefined` at whichever call site reaches for it first. An uploaded
  document has no origin URL, and every reader now renders that absence as nothing rather than as
  `Title ()` or a bare `Source:` line.

  One fix rode along, found by the cross-runtime assertion for the new origin rather than by
  reasoning: `urlMatchCandidates` used to hand back `['', '/']` for an empty needle, so `getByUrl`
  would match every row whose stored `url` is empty. Nothing produced such a row before uploads, and
  no caller passes an empty URL today, but "a lookup for nothing resolves to an arbitrary uploaded
  document, which the caller then hands an agent as the page a description pointed at" is not a trap
  to leave armed. It now returns null, and the four repositories that call it answer "no match".

  A document is now attached to at most ONE block, enforced where the link is written rather than at
  the new endpoint. `linkedBlockId` is a single column, so attaching a document another task already
  holds MOVED the link instead of copying it: the earlier task silently lost a document it was created
  with, and nothing in its next run reported the absence. That was reachable from the app's own
  picker too, which offers already-attached documents for re-use. `linkToBlock` now refuses with
  `document_already_linked` and the holder's id, the same rule and shape as one-task-per-ticket, with
  translated SPA copy. Two things keep it from wedging anything: a link naming a DELETED block is not
  a holder (so the guard heals rows left by past deletes), and `removeBlock` now detaches a doomed
  block's documents through the removal cascade, so new ones are not made. Only the link goes; the
  document survives its task.

  Attaching a list is one unit of work rather than a loop: `linkManyToBlock` asserts the block once,
  resolves the whole list through a new batched `DocumentRepository.listByRefs` and writes the links
  through a new `linkBlockMany` (both mirrored D1 ⇄ Drizzle, with cross-runtime assertions, plus
  `detachBlocks` for the cascade). The point method in a loop was three round-trips per document, ten
  of which re-read the same block.

  Worth watching in review: the creation is all-or-nothing. Everything refusable (an unconfigured
  source, an unparseable ref, a page the provider will not serve, an upload that renders to no
  readable text, a document another task holds) is refused before the board changes, and an
  attachment that fails after the task exists takes the task back off the board, because a task
  silently missing part of its spec is the failure this whole surface exists to prevent. Two ordering
  details carry that: uploads are written only after the whole list resolves (an import is idempotent
  on its ref, but every upload mints an id, so an eager write would leave one orphan per retry), and
  the rollback detaches by BLOCK rather than by the refs it resolved (a rollback can be running
  because one of those refs belongs to another task, and clearing it by ref would commit the very
  loss the guard just refused). The attach runs before the ticket claim so that rollback can never
  orphan a claimed ticket. Naming `documents` does not work in mothership mode yet, for the same
  reason `ticket` does not: the document write surface is still `pending` on the persistence
  allow-list, which the new `linkBlockMany`/`detachBlocks` join rather than widen.

### Patch Changes

- Updated dependencies [cec0c3e]
  - @cat-factory/contracts@0.235.0
  - @cat-factory/kernel@0.235.0
  - @cat-factory/integrations@0.126.0
  - @cat-factory/orchestration@0.202.0
  - @cat-factory/server@0.214.0
  - @cat-factory/agents@0.110.5
  - @cat-factory/gates@0.8.70
  - @cat-factory/prompt-fragments@0.15.61

## 0.26.0

### Minor Changes

- 8cbf1a7: Manage the outbound notification webhook over `/api/v1`, so the whole integration surface is
  headless.

  `GET|PUT|DELETE /api/v1/notification-webhook` (`admin` scope) register, read and remove the one
  HTTPS endpoint a workspace pushes its notifications, run-lifecycle events and platform-health
  alerts to. Until now that endpoint could only be registered over the session-authed
  `/workspaces/:ws/notification-webhook`, so a deployment driven entirely by API keys had to put a
  human in a browser to switch on the very channel that exists because there is no browser: the
  delivery contract was headless and its enrolment was not.

  The routes delegate to the same `NotificationWebhookService` the session controller calls, so the
  SSRF guard on the endpoint, the keep-on-omit rule for every field and the one-row-per-workspace
  invariant are identical whichever surface writes. The signing secret stays write-only: `PUT`
  accepts one and the read reports only `hasSecret`, so an `admin` key can rotate it and can never
  learn the stored one.

  `PUT`'s `url` becomes optional, on both surfaces, so keep-on-omit is uniform across every field
  rather than every field but one. A mandatory re-send made the routine edit (subscribe to a family)
  carry a value the caller never meant to change, and a client re-sending a URL it cached before
  someone else rotated the receiver would silently redirect the workspace's deliveries back to the
  old endpoint while appearing to add a subscription. `url` is still required on the first `PUT`
  against a workspace with nothing registered, refused with `details.reason: "webhook_url_required"`.
  Relaxing a required field is additive, so no live caller changes.

  Additive on `/api/v1` (OpenAPI `info.version` 1.5.0; main took 1.4.0 for its own additive change
  while this branch was open). The four SDK clients gain a `webhook` resource
  (`get` / `set` / `delete`) and the MCP facade the matching `webhook_*` tools.

### Patch Changes

- Updated dependencies [8cbf1a7]
  - @cat-factory/contracts@0.234.0
  - @cat-factory/integrations@0.125.0
  - @cat-factory/server@0.213.0
  - @cat-factory/agents@0.110.4
  - @cat-factory/gates@0.8.69
  - @cat-factory/kernel@0.234.2
  - @cat-factory/orchestration@0.201.2
  - @cat-factory/prompt-fragments@0.15.60

## 0.25.4

### Patch Changes

- ee6601e: Post a parked requirements review's questions to the ticket for webhook-dispatched runs too.

  A run started by a per-ticket issue-intake schedule recorded no intake origin, so it read back as
  UI-started and the clarification writeback refused it: the review parked, and the person who filed
  the ticket was never told. The answer channel was already open (ticket-comment replies are ungated
  by intake), but the finding ids an answer has to name are only ever rendered by the question
  comment, so a ticket-driven run could park and stay parked with nothing pointing at the cause.

  Such a run now carries `intakeOrigin: 'tracker'`, and the writeback gate asks the classification
  (`isHeadlessIntake`) rather than comparing against the one origin that shipped first.

  The vocabulary also gains `schedule` for cadence fires and the queue-drain push, so `ui` stops
  being a catch-all for "nothing said" and becomes a positive claim that a human is watching in the
  app. Every unattended start path now names itself; only the in-app start takes the default. The
  field must stay optional for that one caller, so the rule is held by a coverage spec that
  classifies each start path rather than by a typecheck.

  `schedule` is classified NOT headless even though it is unattended. A fire works the schedule's
  reused block, and queue-mode intake replace-links each pick onto it, so a question posted there
  loses its reply channel on the next fire. The classification asks whether the run has a stable
  place to hold a conversation, not whether a human was present.

  No change to runs started in the app or through `/api/v1`. The workspace opt-in
  (`writebackQuestionsOnPark`, off by default) and its per-task override still gate every post; their
  copy now says "outside the app" rather than "through the API".

- Updated dependencies [ee6601e]
  - @cat-factory/contracts@0.233.0
  - @cat-factory/orchestration@0.201.1
  - @cat-factory/server@0.212.1
  - @cat-factory/agents@0.110.3
  - @cat-factory/gates@0.8.68
  - @cat-factory/integrations@0.124.1
  - @cat-factory/kernel@0.234.1
  - @cat-factory/prompt-fragments@0.15.59

## 0.25.3

### Patch Changes

- Updated dependencies [937d4af]
  - @cat-factory/contracts@0.232.0
  - @cat-factory/kernel@0.234.0
  - @cat-factory/orchestration@0.201.0
  - @cat-factory/server@0.212.0
  - @cat-factory/integrations@0.124.0
  - @cat-factory/agents@0.110.2
  - @cat-factory/gates@0.8.67
  - @cat-factory/prompt-fragments@0.15.58

## 0.25.2

### Patch Changes

- Updated dependencies [2580fee]
- Updated dependencies [eb4ca17]
  - @cat-factory/kernel@0.233.0
  - @cat-factory/server@0.211.0
  - @cat-factory/contracts@0.231.0
  - @cat-factory/orchestration@0.200.0
  - @cat-factory/agents@0.110.1
  - @cat-factory/gates@0.8.66
  - @cat-factory/integrations@0.123.6
  - @cat-factory/prompt-fragments@0.15.57

## 0.25.1

### Patch Changes

- 1f14793: Documentation cleanup and consistency: neutral naming across docs, code comments,
  example fixtures and historical changelog entries, with the OpenAPI spec and
  generated SDK clients regenerated so their description strings match. No behaviour
  or API change.
- Updated dependencies [1f14793]
- Updated dependencies [2619d79]
  - @cat-factory/contracts@0.230.1
  - @cat-factory/kernel@0.232.0
  - @cat-factory/agents@0.110.0
  - @cat-factory/server@0.210.0
  - @cat-factory/orchestration@0.199.0
  - @cat-factory/integrations@0.123.5
  - @cat-factory/gates@0.8.65
  - @cat-factory/prompt-fragments@0.15.56

## 0.25.0

### Minor Changes

- e7e4404: Reusable operations, slice 2: one descriptor-driven form vocabulary behind both surfaces that have
  one, and a custom task type's collected values are now checked against what it declares.

  An initiative preset and a custom task type had grown the same feature twice, and the task type was
  the poorer copy: four input types against eight, no defaults, no conditional visibility, no shared
  validation, and two near-identical Vue renderers. So a form an org could express as a preset was
  unexpressible as an operation, and nothing but the create form enforced a `required` marker or an
  option list. `contracts/src/form-fields.ts` is now the union both draw on (the field shape, the
  filled-value bag, and the pure visibility / validation / sanitization / prose-rendering rules), with
  each surface declaring only which input types it admits. `password` is excluded for a task type by
  construction rather than by convention: a collected value is folded into prompts, projected onto the
  board snapshot and captured in telemetry, so a secret belongs in the capability-credential store.

  `taskTypeFields.custom` widens from `string | number` to the shared bag (adding booleans and
  multi-select `string[]`), and the prompt fold renders the new shapes through the same renderer the
  form review uses, so a multi-select reads as its option captions rather than its stored enum values.
  Rows are read back through an unvalidated JSON parse, so nothing existing breaks and there is nothing
  to migrate. Two INTERNAL breaks ride along, in the bounds the shared bag carries that the old
  untyped record did not: a bag KEY is now capped at 80 characters and a string VALUE at 2000, so a
  value longer than that (only reachable through a bespoke `formPanel`, since a declared `maxLength`
  cannot exceed the same bound) is refused on the way in.

  `BoardService.addTask` now validates a registered type's bag against its descriptor and freezes only
  the declared, currently-visible answers, so one rule covers the SPA, the internal API and (from the
  public-API slice) a headless caller. An ABSENT bag is checked against an empty one, because a
  required field is unanswered whether the caller sent `custom: {}` or no `custom` key at all: a check
  the caller can opt out of by sending nothing is not a check. **Behaviour change for a deployment
  that registers an operation with required fields**: any path creating such a task without its
  parameters (an initiative item's `spawn`, a script) now gets a 422 where it previously created a
  task whose operation brief was empty. Three cases still deliberately pass through unchecked: a
  built-in type (schema-typed fields, already validated), a type this process does not register (a
  supported row, since task types are node-local by design and degrading data must not brick
  creation), and a descriptor declaring a bespoke `formPanel`, which owns its own bag.

  The richer vocabulary brings new ways for a descriptor to break itself, so boot validation now
  refuses a create form that structurally cannot be filled: a duplicate field key, an optionless
  `select`/`checkbox-group`, or a `showWhen` gating a field on a key the type does not declare (which
  would hide that field forever). Each is fully known from the registration and silent at run time,
  unlike a `defaultFragmentIds` id, which stays a warning because a tenant-tier fragment is invisible
  at boot. Both surfaces are held to that bar by one checker, so an initiative preset's create form is
  validated at boot for the first time (all three facades pass the registry).

  Behaviour change worth reviewing: a custom task type's `select` field renders as a dropdown rather
  than a button row, since it is now the shared renderer, and a form with many options needed that
  anyway. The path-invalid message moved from `initiative.create.pathInvalid` to `common.pathInvalid`,
  carrying each locale's existing translation.

  One unfilled value is now dropped rather than frozen, on both surfaces. Validation short-circuits on
  a value that says nothing, so a `false` on a text field, a blank string or an empty multi-select
  reached the freeze having passed no type check; sanitization now drops them, which stops a
  wrong-typed answer reaching agents as the operation's own brief (`notes: false` rendered as
  `Notes: No`). The one exception is an explicit `false` on a `checkbox`, which is the opt-OUT of a
  default-ON toggle and the one unfilled value that is an answer.

### Patch Changes

- Updated dependencies [e7e4404]
  - @cat-factory/contracts@0.230.0
  - @cat-factory/kernel@0.231.0
  - @cat-factory/orchestration@0.198.0
  - @cat-factory/agents@0.109.2
  - @cat-factory/gates@0.8.64
  - @cat-factory/integrations@0.123.4
  - @cat-factory/prompt-fragments@0.15.55
  - @cat-factory/server@0.209.1

## 0.24.0

### Minor Changes

- 10e0341: Answer the pre-dispatch input gate over the public API, and stop it judging blocks that carry no
  authored task input.

  The gate is the one park that turns on the shape of the TASK rather than the pipeline, so the
  public surface's park enumeration (which reads the step chain) could not see it: a `write`-scope
  key could start a title-only task on a pipeline that parks nowhere and get a run stopped before
  its first dispatch, with `GET /api/v1/runs/:runId/decisions` reporting `parked: true`, nothing to
  answer, and cancel as the only exit. The verdict is now a parked decision of its own, resolvable
  at `POST /api/v1/runs/:runId/decisions/input-gate/resolve` with the same `recheck` / `proceed`
  choices the app offers, and admission composes it in, so a key that cannot answer the park is
  refused up front with a message naming it. Additive on `/api/v1`: OpenAPI `info.version` 1.2.0,
  and the four SDK clients gain `decisions.resolveInputGate`.

  `not_applicable` now covers any block whose description is not authored task input, which is the
  block LEVEL plus the recurring task type rather than a task-type list alone. A run started against
  a frame, module, epic or initiative ANCHOR reads the entity it stands for, not the caption on the
  card, so judging that caption parked every initiative planning run on a field the flow never fills
  in. A task the platform merely CREATED with a real brief (an initiative-spawned item, a ticket
  import) is deliberately still judged.

  Advisory findings are also visible at last: they were recorded on the run and reported over the
  API while rendering nowhere, which left `advisory` mode with nothing to watch.

- 10e0341: Add the pre-dispatch input gate: a deterministic structural check of a task's own authored fields,
  run before a run's first agent step is dispatched. A task that states nothing an agent could act
  on now parks having spent nothing, where the cheapest refusal previously cost one requirements-
  review call to report an absence a string comparison already knew about.

  Six V1 findings, three of them blocking: no description, a placeholder-only description
  (`TBD`/`n/a`/`fix it`), a `bug` with no reproduction context, and a `review` task naming no pull
  request; a very short description and a `spike` with no success criteria ride as advisories. The
  check never judges quality or infers intent, which is the reviewer's job.

  **Behaviour change on upgrade.** The gate ships ON (`inputGateMode: 'standard'`), so a run
  started against a title-only task parks on a notice instead of dispatching. Every blocking
  finding names an input a model could not have acted on either, so the gate only replaces a call
  that would have reported the same gap. A workspace can turn it down to `advisory` (record the
  findings, never park) or `off` in Workspace settings. Resolve a parked run by fixing the task and
  re-checking (the fix is re-evaluated, not taken on trust) or by proceeding anyway, which records
  an `overridden` verdict that keeps the waived findings on the run.

  Persistence: a new `input_gate_mode` column on `workspace_settings` (D1 migration `0080` and the
  matching Drizzle migration); the verdict itself rides the run's existing `detail` JSON.

### Patch Changes

- Updated dependencies [10e0341]
- Updated dependencies [10e0341]
  - @cat-factory/contracts@0.229.0
  - @cat-factory/kernel@0.230.0
  - @cat-factory/orchestration@0.197.0
  - @cat-factory/server@0.209.0
  - @cat-factory/agents@0.109.1
  - @cat-factory/gates@0.8.63
  - @cat-factory/integrations@0.123.3
  - @cat-factory/prompt-fragments@0.15.54

## 0.23.0

### Minor Changes

- fccb1df: Reusable operations, slice 1: a registered custom task type can now carry its whole bundle, and the
  per-case values a user fills reach the agents that act on them.

  A custom task type's collected `taskTypeFields.custom` bag previously reached ZERO prompts: it rode
  the run context and nothing rendered it, so an operation's brief ("expose CRUD for Order", "auth:
  service-to-service") was invisible to every step in the pipeline. The engine now resolves a labelled
  projection once per dispatch (`AgentRunContext.customTaskType`, joined from the registered
  descriptor by kernel's `describeCustomTaskType`) and the agents package renders it as a
  `## Task parameters` section at all three prompt-assembly points, including the prepend a registered
  kind that authors its own user prompt gets.

  The descriptor gains two optional fields: `defaultFragmentIds`, the operation's standing context,
  unioned onto every new task's own fragment selection at creation, and `presentation.category`, the
  picker grouping axis a later slice renders. Boot validation warns (never refuses) on a
  `defaultFragmentIds` entry the code pool cannot resolve, because an account/workspace-tier fragment
  merges per workspace at run time and is invisible at boot.

  Every existing prompt is byte-identical: the projection is absent whenever a block collected no
  custom values, which is every run of a built-in task type. It is also absent for an un-namespaced
  type, so a built-in carrying a stray `custom` bag renders no section: a custom type is namespaced by
  construction, so the raw-id fallback that honestly names a withdrawn operation would otherwise invent
  one. Seeding the standing context STATES a namespaced type this process does not register, since only
  the id set freezes at creation and that task never gains the operation's fragments later.

### Patch Changes

- Updated dependencies [fccb1df]
  - @cat-factory/contracts@0.228.0
  - @cat-factory/kernel@0.229.0
  - @cat-factory/agents@0.109.0
  - @cat-factory/orchestration@0.196.0
  - @cat-factory/gates@0.8.62
  - @cat-factory/integrations@0.123.2
  - @cat-factory/prompt-fragments@0.15.53
  - @cat-factory/server@0.208.2

## 0.22.3

### Patch Changes

- Updated dependencies [437a0c6]
  - @cat-factory/contracts@0.227.0
  - @cat-factory/integrations@0.123.1
  - @cat-factory/agents@0.108.3
  - @cat-factory/gates@0.8.61
  - @cat-factory/kernel@0.228.1
  - @cat-factory/orchestration@0.195.3
  - @cat-factory/prompt-fragments@0.15.52
  - @cat-factory/server@0.208.1

## 0.22.2

### Patch Changes

- Updated dependencies [43fd5c0]
  - @cat-factory/kernel@0.228.0
  - @cat-factory/contracts@0.226.0
  - @cat-factory/integrations@0.123.0
  - @cat-factory/server@0.208.0
  - @cat-factory/agents@0.108.2
  - @cat-factory/gates@0.8.60
  - @cat-factory/orchestration@0.195.2
  - @cat-factory/prompt-fragments@0.15.51

## 0.22.1

### Patch Changes

- Updated dependencies [0456066]
  - @cat-factory/contracts@0.225.0
  - @cat-factory/kernel@0.227.0
  - @cat-factory/agents@0.108.1
  - @cat-factory/gates@0.8.59
  - @cat-factory/integrations@0.122.2
  - @cat-factory/orchestration@0.195.1
  - @cat-factory/prompt-fragments@0.15.50
  - @cat-factory/server@0.207.1

## 0.22.0

### Minor Changes

- 889a497: Couple workspace RBAC to the per-class merge rules, and add a sandboxed run mode.

  A merge preset now carries `classRulesByRole` — the per-change-class auto-merge rules narrowed by
  the workspace role the run's initiator held — and `dryRunRoles`, the roles whose runs are forced
  into dry-run mode: the pipeline runs in full and opens its pull request, but nothing merges. A run
  can also request `mode: 'dry_run'` at start. Both settings default empty, so every existing preset
  resolves to exactly its previous behaviour.

  Narrowing is subtractive by construction: a role entry can make a class stricter than the base
  rules but can never widen one, so a role allowlist is reviewable on its own and no preset edit can
  turn one into a privilege grant. A role that authored nothing for a class, and a run with no role to
  pin at all (a schedule fire, a public-API start, auth-disabled dev), both fall through to the base
  rules rather than being treated as a tier.

  The initiator's role and the run's mode are PINNED on the run at admission rather than re-resolved
  at merge time: the merge settles on the durable driver's path, which has no request context to
  resolve a role from, and a preset edited mid-run must not retroactively re-govern a run already in
  flight. The sandbox is enforced at both exits — the auto-merge and the manual merge endpoint, which
  refuses a dry run's PR with a new `dry_run_not_mergeable` conflict reason, since the review card the
  first one raises is itself a merge button.

  Two new `MergeDecision` reasons ship with it, kept apart from the existing ones because each points
  at a different fix: `role_requires_review` (a teammate on a higher tier can merge this PR as it
  stands) and `dry_run` (the scores were never consulted, so no threshold explains this outcome).

  Wire and schema changes: `RiskPolicy` gains two required fields, `ExecutionInstance` gains optional
  `initiatedByRole` and `mode`, and `merge_threshold_presets` gains a `class_rules_by_role` and a
  `dry_run_roles` column on both runtimes (both with empty defaults, so existing rows need no
  backfill).

  Not yet built: the SPA controls for AUTHORING either preset field and for choosing a dry run on the
  start-run button. Both are already writable over `/workspaces/:ws/risk-policies` and the start
  endpoint respectively, so the capability is reachable today through the API.

- 3605630: Finish the in-app-tutorial initiative (now [ADR 0036](backend/docs/adr/0036-in-app-tutorials.md)):
  make the walkthroughs reach the user who needs one, and measure whether they do.

  The catalogue already made every tour REACHABLE; nothing brought one up. Starting any tour saves the
  launch-prompt answer, which is what stops that prompt returning, so after a user's first tour the
  product never mentioned the tutorial again unless they went looking, and the two tours whose windows
  are transient (answer a parked run, review and merge) were the least likely to be found while they
  applied. So: the finish card now hands off to the one walkthrough the user's own last action
  unlocked, and a contextual offer catches a tour's declared requirements flipping from blocked to
  ready. Four new tours ship with it, the first of which closes the biggest hole in the arc: reading a
  FAILED run (the state a first run reaches most often, and the only one that had no walkthrough),
  plus where runs execute, review-by-panel, and the shared-services catalog.

  Progress now follows the USER rather than the browser, through a new per-user `tutorial_progress`
  table on both facades (`remote` in mothership mode, self-scoped). The browser-persisted store stays
  what the SPA reads and stays fully functional with no accounts, no store wired, or offline; the
  server row is a best-effort mirror. Both id lists are grow-only sets, UNIONED on both sides, because
  two browsers signed in as one person each hold a full copy and each write it back: a
  last-writer-wins replace on either side silently drops what the other learned. "Reset progress" is
  therefore a DELETE. Each push carries the whole local state and reconciles the merged row it gets
  back, so a merge that lost a concurrent writer's ids re-pushes instead of waiting for a local change
  that may never come; a merge whose RESULT would exceed `MAX_TUTORIAL_TOUR_IDS` is refused with
  `details.reason: 'tutorial_progress_too_large'` rather than truncated, since the row rides every
  workspace snapshot.

  Three new operational counters (`tutorial.tour_started` / `_completed` / `_abandoned`, dimensioned
  by tour) answer the question the initiative could not answer about itself. They ride the existing
  `OperationalMetrics` port because there is deliberately only one counter seam; the tour dimension is
  bounded twice, by the wire schema's shape rule and by a per-process distinct-value cap that folds
  the rest onto a visible `other` bucket, since a dimension whose values come from a browser is
  otherwise an unbounded-cardinality hole in an operator's metrics backend.

  New internal routes (not `/api/v1`, so no SDK surface): `GET|PUT|DELETE /tutorial/progress` and
  `POST /tutorial/events`, root-mounted beside `/user-settings`. Root-mounted specifically so they sit
  outside the workspace-RBAC viewer write floor, which a read-only viewer taking a walkthrough would
  otherwise trip. The workspace snapshot gains an optional `tutorialProgress`, and `NavGates` gains
  `boardHasFailedRun`; a deployment that builds its own gates object must add that field.

### Patch Changes

- Updated dependencies [f1a6cb3]
- Updated dependencies [cc17221]
- Updated dependencies [889a497]
- Updated dependencies [3605630]
  - @cat-factory/orchestration@0.195.0
  - @cat-factory/contracts@0.224.0
  - @cat-factory/kernel@0.226.0
  - @cat-factory/agents@0.108.0
  - @cat-factory/server@0.207.0
  - @cat-factory/gates@0.8.58
  - @cat-factory/integrations@0.122.1
  - @cat-factory/prompt-fragments@0.15.49

## 0.21.2

### Patch Changes

- Updated dependencies [bbc51fa]
- Updated dependencies [36b1853]
  - @cat-factory/orchestration@0.194.0
  - @cat-factory/integrations@0.122.0
  - @cat-factory/server@0.206.0
  - @cat-factory/contracts@0.223.0
  - @cat-factory/kernel@0.225.0
  - @cat-factory/agents@0.107.1
  - @cat-factory/gates@0.8.57
  - @cat-factory/prompt-fragments@0.15.48

## 0.21.1

### Patch Changes

- 413095f: Let a model preset choose the ORDER a model's routes are preferred in, instead of one order compiled into the resolver.

  Which route a model takes was a deployment-wide constant, so a workspace could not have both a compliance preset pinned to a residency-guaranteed route (AWS Bedrock, whose selectability landed in the previous slice) and an everyday preset riding a flat-rate subscription. It is a per-WORKLOAD choice, so the knob is the preset row (`ModelPreset.providerPreference`) rather than a new env var, and it needs no migration of behaviour: a preset stating nothing resolves exactly as before.

  **A preference REORDERS, it never filters.** Routes a preset omits are appended in default order and tried last, so naming three routes cannot make a model whose only route is the fourth unresolvable. That is structural rather than a rule to remember: `orderedModelFlavorPreference` returns a total order over every route, which is also why the editor offers no way to REMOVE one. The write boundary refuses a repeated route (an order cannot say two things about one route) but accepts a partial list.

  **The order rides `ProviderCapabilities`, and it reaches a run by two paths because a capability set is resolved at two different times.** The START GUARD resolves one per run, so it now resolves under the block's own preset and walks each model's routes in the order the dispatch will. A DISPATCH has no capability set of its own — the facade's `resolveBlockModel` closes over the boot-time one — so the order arrives on `AgentRunContext.providerPreference`, resolved ONCE by the engine exactly like the prompt override and the output budget, and the facade folds it onto its captured capabilities per call. Folding rather than replacing is the point: which routes EXIST is a deployment fact (keys, the Bedrock allow-list, the Workers AI binding) and only the ORDER is per preset. Both ends read one preset row, so the guard, the container path, the inline path and the consensus panel cannot disagree about which provider a step ran on.

  **Eight inline callers each carried a byte-identical copy of the step precedence**, which is how a fact like this gets forgotten in seven places. The judge, the fork-decision chat, the iterative reviewers (with their brainstorm and clarity subclasses), the doc and initiative interviewers, the tester QC companion, the bug-hunt assessor and the Kaizen grader now share one `resolveInlineBlockModelRef`, and it takes the model and the route order as ONE dependency rather than two wired side by side. Kaizen is why: it resolved through a seam with no route-order parameter, so it would have taken the model half and silently ignored the other — a compliance preset getting its route for every inline call on a block except its grading.

  **The preset row is read on every dispatch, every inline call and every start guard, so it goes through the app cache seam.** `AppCaches.modelPreset` is the merge preset's `riskPolicy` slice one table over: same key shape (`picked:<id>` / `default`), same wrapped null so an unseeded workspace caches as a value, same invalidate-the-workspace-group on every `ModelPresetService` write, same pass-through on the Worker's isolate-safe profile. The model id and the route order are resolved from ONE read of that row (`resolvePresetRouting`), where asking two collaborators for them read it twice.

  **"Equals the default order" is stored as ABSENT, not as a copy of it.** Reordering back to the default clears the preference, so a preset keeps tracking the shipped order as the product changes it instead of pinning today's wording of it — which matters because that order is itself scheduled to change. For the same reason the default order now lives in ONE place, `DEFAULT_MODEL_FLAVOR_ORDER` in contracts: the preset editor renders the same fold the resolver walks, and a copy in the SPA would let the picker display an order the run does not take.

  Compatibility break to expect: none for existing rows (`provider_preference` is nullable and NULL means the default order), but a stored route the build no longer knows is DROPPED at the read boundary rather than named. That is the opposite disposition from a retired binary modality, and deliberate: the value names a route, so once the route is gone there is no current member a human could re-pick it as, and the surviving entries keep their relative order.

  One limit worth stating plainly: "subscriptions always win" is still applied ON TOP of this order, so on a workspace holding a subscription token a preset promoting AWS Bedrock is overruled for every dual-mode model. Folding that override into the order is the next slice; until then the preset editor warns rather than letting the copy promise a route a connected plan takes back.

- Updated dependencies [413095f]
  - @cat-factory/contracts@0.222.0
  - @cat-factory/kernel@0.224.0
  - @cat-factory/agents@0.107.0
  - @cat-factory/orchestration@0.193.0
  - @cat-factory/server@0.205.0
  - @cat-factory/gates@0.8.56
  - @cat-factory/integrations@0.121.2
  - @cat-factory/prompt-fragments@0.15.47

## 0.21.0

### Minor Changes

- 04e44f8: Finish the operator-observability initiative: gate/CI-fixer attempt statistics, a daily run
  rollup behind new 30d/90d dashboard windows, per-account alert-threshold settings, and a
  platform-health alert card that deep-links to the runs it aggregated.

  Three new main-store tables ship with it: `gate_outcomes` (one row per polling gate that reaches a
  terminal verdict), `platform_run_days` (the daily rollup, materialised by the retention sweep) and
  `platform_rollup_state` (how far that sweep has covered, which is a fact about the sweep and so
  cannot be derived from the rolled-up rows). The first two are pruned on their own retention
  windows, `GATE_OUTCOME_RETENTION_DAYS` (90) and `PLATFORM_RUN_DAY_RETENTION_DAYS` (400); the third
  is a single forward-only marker row and is not pruned.

  Breaking (pre-1.0, no migration path offered): the `PlatformObservability` wire shape gains
  required `source`, `rolledUpThrough` and `gates` fields, and `platformObservabilityWindowSchema`
  gains `30d` / `90d`. A `platform_health` notification's `platformWindow` narrows to the
  live-scanned windows only. Any stored projection or client pinned to the old shape must be
  re-read rather than migrated.

  Also breaking for a deployment that assembles its own container: `CoreDependencies.gateOutcomeRepository`
  is REQUIRED, like `logger` and `operationalMetrics` and for the same reason. The engine WRITES this
  projection, and an un-wired writer reads downstream as "no gate on this deployment ever escalated",
  which is indistinguishable from a healthy one. A deployment with no such store passes the new
  `noopGateOutcomeRepository`, which says so in code.

### Patch Changes

- Updated dependencies [04e44f8]
  - @cat-factory/contracts@0.221.0
  - @cat-factory/kernel@0.223.0
  - @cat-factory/orchestration@0.192.0
  - @cat-factory/server@0.204.0
  - @cat-factory/agents@0.106.8
  - @cat-factory/gates@0.8.55
  - @cat-factory/integrations@0.121.1
  - @cat-factory/prompt-fragments@0.15.46

## 0.20.19

### Patch Changes

- Updated dependencies [c8ba2cd]
- Updated dependencies [807e442]
- Updated dependencies [807e442]
- Updated dependencies [175f78f]
- Updated dependencies [807e442]
  - @cat-factory/orchestration@0.191.0
  - @cat-factory/contracts@0.220.0
  - @cat-factory/kernel@0.222.0
  - @cat-factory/integrations@0.121.0
  - @cat-factory/server@0.203.0
  - @cat-factory/agents@0.106.7
  - @cat-factory/gates@0.8.54
  - @cat-factory/prompt-fragments@0.15.45

## 0.20.18

### Patch Changes

- Updated dependencies [1106c93]
  - @cat-factory/contracts@0.219.0
  - @cat-factory/orchestration@0.190.0
  - @cat-factory/server@0.202.0
  - @cat-factory/agents@0.106.6
  - @cat-factory/kernel@0.221.1
  - @cat-factory/gates@0.8.53
  - @cat-factory/integrations@0.120.1
  - @cat-factory/prompt-fragments@0.15.44

## 0.20.17

### Patch Changes

- Updated dependencies [f63145d]
- Updated dependencies [3b88f66]
  - @cat-factory/contracts@0.218.0
  - @cat-factory/server@0.201.0
  - @cat-factory/orchestration@0.189.0
  - @cat-factory/integrations@0.120.0
  - @cat-factory/kernel@0.221.0
  - @cat-factory/agents@0.106.5
  - @cat-factory/gates@0.8.52
  - @cat-factory/prompt-fragments@0.15.43

## 0.20.16

### Patch Changes

- Updated dependencies [7f86f07]
- Updated dependencies [7f86f07]
  - @cat-factory/contracts@0.217.0
  - @cat-factory/integrations@0.119.0
  - @cat-factory/server@0.200.0
  - @cat-factory/kernel@0.220.0
  - @cat-factory/agents@0.106.4
  - @cat-factory/gates@0.8.51
  - @cat-factory/orchestration@0.188.3
  - @cat-factory/prompt-fragments@0.15.42

## 0.20.15

### Patch Changes

- Updated dependencies [87161e8]
  - @cat-factory/contracts@0.216.0
  - @cat-factory/kernel@0.219.0
  - @cat-factory/server@0.199.0
  - @cat-factory/agents@0.106.3
  - @cat-factory/gates@0.8.50
  - @cat-factory/integrations@0.118.1
  - @cat-factory/orchestration@0.188.2
  - @cat-factory/prompt-fragments@0.15.41

## 0.20.14

### Patch Changes

- Updated dependencies [96ad850]
- Updated dependencies [96ad850]
  - @cat-factory/contracts@0.215.0
  - @cat-factory/kernel@0.218.0
  - @cat-factory/integrations@0.118.0
  - @cat-factory/server@0.198.0
  - @cat-factory/agents@0.106.2
  - @cat-factory/orchestration@0.188.1
  - @cat-factory/gates@0.8.49
  - @cat-factory/prompt-fragments@0.15.40

## 0.20.13

### Patch Changes

- Updated dependencies [4c26c01]
  - @cat-factory/contracts@0.214.0
  - @cat-factory/kernel@0.217.0
  - @cat-factory/orchestration@0.188.0
  - @cat-factory/server@0.197.0
  - @cat-factory/agents@0.106.1
  - @cat-factory/gates@0.8.48
  - @cat-factory/integrations@0.117.2
  - @cat-factory/prompt-fragments@0.15.39

## 0.20.12

### Patch Changes

- Updated dependencies [924c6f9]
  - @cat-factory/contracts@0.213.0
  - @cat-factory/kernel@0.216.0
  - @cat-factory/agents@0.106.0
  - @cat-factory/orchestration@0.187.0
  - @cat-factory/server@0.196.0
  - @cat-factory/gates@0.8.47
  - @cat-factory/integrations@0.117.1
  - @cat-factory/prompt-fragments@0.15.38

## 0.20.11

### Patch Changes

- 54d531d: Count the deployment's operational EVENTS, and let the health alerts see a dead one.

  The platform-observability projection answers "how are the runs doing" by aggregating
  `agent_runs`. It structurally cannot answer what an operator asks during an incident — how often
  container dispatch is failing, whether the sweeper is re-driving more than it was, whether a queue
  is draining — because none of those are rows in a table. A new kernel `OperationalMetrics` port
  counts them, and the OTLP platform exporter ships them as delta sums beside the existing gauges.
  Wired at the sweepers, the container seam, the trace sinks, the notification webhook and every
  app-cache read; `agent_runs` gained a persisted `redrive_count`, so "was this run re-driven three
  times?" is answerable after the process (or the isolate) that did it is gone.

  `platform_health` gained three conditions. The important one is zero-throughput: every existing
  condition divides by runs and goes silent at zero, so a deployment that stopped accepting work
  read identically to a quiet healthy one. Alongside it, a dominant-failure-kind condition (100%
  `evicted` and 100% `agent` produce the same failure rate and need opposite fixes) and one that
  alerts on the sweepers themselves, since a wedged sweeper makes every other signal stale without
  making any of them fire. A sweep pass reports its rate and its failure streak through ONE call
  (`SweepHealthTracker.recordFailure`), and the Worker drives its crons through a `SweepTick` that
  is the facade-symmetric twin of Node's `startSweeper` — so both runtimes cover the same set of
  sweepers, and the tick's counters are flushed after its passes have settled rather than before.

  Also: retention pruning is now isolated per table (one sick table used to abort the whole pass,
  indefinitely, and report zeroes indistinguishable from an empty table); `/ready` round-trips
  pg-boss's own connection instead of trusting a process-local boolean, and the Worker gained a
  bindings-probing `/ready`; and every pg-boss queue is created with a dead-letter sibling whose
  depth rides the `queue.depth` gauge under `state: dead_letter`, with an hourly sweep logging the
  source queue to go and look at.

- Updated dependencies [233e279]
- Updated dependencies [54d531d]
  - @cat-factory/contracts@0.212.0
  - @cat-factory/kernel@0.215.0
  - @cat-factory/agents@0.105.0
  - @cat-factory/orchestration@0.186.0
  - @cat-factory/server@0.195.0
  - @cat-factory/integrations@0.117.0
  - @cat-factory/gates@0.8.46
  - @cat-factory/prompt-fragments@0.15.37

## 0.20.10

### Patch Changes

- Updated dependencies [87ed4f9]
  - @cat-factory/contracts@0.211.0
  - @cat-factory/server@0.194.0
  - @cat-factory/agents@0.104.3
  - @cat-factory/gates@0.8.45
  - @cat-factory/integrations@0.116.4
  - @cat-factory/kernel@0.214.1
  - @cat-factory/orchestration@0.185.2
  - @cat-factory/prompt-fragments@0.15.36

## 0.20.9

### Patch Changes

- Updated dependencies [3435bd1]
  - @cat-factory/kernel@0.214.0
  - @cat-factory/agents@0.104.2
  - @cat-factory/gates@0.8.44
  - @cat-factory/integrations@0.116.3
  - @cat-factory/orchestration@0.185.1
  - @cat-factory/server@0.193.1

## 0.20.8

### Patch Changes

- 70b4339: Serve a mothership-mode node's run telemetry back down from the mothership when its own store holds
  none. Telemetry is local-first, captured on the laptop and pruned there on a short window, with a
  finished run's rows carried up by the ingest sweep — both halves of which are about the WRITE
  direction. What that left was a node rendering two kinds of run blank: one whose local rows had been
  pruned, and (the larger case the plan under-stated) one that was never local at all. A mothership-mode
  SPA shows the whole org's board, so most runs a developer opens were driven by a hosted teammate or
  another laptop, and every one of them showed an empty observability panel, a zero token rollup and no
  web-search log — with nothing anywhere reporting a problem, because that is exactly what a run which
  spent nothing looks like.

  `POST /internal/telemetry/read` is the ingest's dual: a machine-authed, account-scoped endpoint
  serving a CLOSED table of per-method-bounded, run-scoped reads. It is its own endpoint rather than
  allow-listed persistence-RPC methods for ADR 0009's reason plus a sharper one — the persistence
  registry resolves a repository WHOLE, so admitting a telemetry repo's reads there would route its
  hot-path writes over the network, which is the entire thing the local-first bucket exists to prevent.
  `listByExecution` is deliberately absent from the table on all three sinks (no cursor, so it is the
  un-resumable bulk read the bucket forbids); the node drains the paged reads instead, which is what
  the two new kernel port methods are for. An over-cap limit is refused, never clamped, and the
  scope-bound workspace is stamped as the call's first argument rather than trusted from the caller.

  On the laptop the rule is local-wins where local is WHOLE — not merely where it is non-empty. The
  distinction is a third blank-run case: the prune deletes by capture time, so a run straddling the
  cutoff keeps its newer rows and loses its older ones, and the store then answers, with nothing
  looking missing, with a strict subset. A short list is bad and the rollup is worse, because a token
  total that is simply too low carries no hint that it is short. A subset is undetectable after the
  fact, so the prune records it as it happens and that record is what makes a local answer
  authoritative: lists stitch across the two stores on the shared keyset, while counts and the rollup
  come wholly from the mothership, since a partial local aggregate and a complete remote one cannot be
  merged. Capture is not decorated at all. A failed fallback throws rather than degrading back into the
  empty answer it was called to replace — the one hot-path caller already treats a metrics read as
  best-effort, so an outage costs a board counter and never a run, and the aggregate reads carry a
  short round-trip budget precisely because that caller awaits them on the emit path.

  A page inside its row cap can still serialize past the response backstop, so that is treated as
  routine rather than as a fault: the mothership still refuses rather than shortening (a truncated page
  is one the node would treat as complete), but under its own code, and the drain re-asks smaller on
  the same cursor, losing nothing. It terminates because the backstop is derived from the two capture
  ceilings rather than picked — a one-row page can never be refused for size.

  Compatibility break: `LlmCallMetricRepository` and `AgentContextSnapshotRepository` each gain a
  required `listRunPage` method, so an out-of-tree implementation of either port must add it. The local
  telemetry store gains a `telemetry_pruned_runs` table, created on open; an existing store simply
  starts recording from its next prune, and until then reports itself complete, which is the same
  answer it gave before.

- Updated dependencies [70b4339]
  - @cat-factory/kernel@0.213.0
  - @cat-factory/orchestration@0.185.0
  - @cat-factory/server@0.193.0
  - @cat-factory/agents@0.104.1
  - @cat-factory/gates@0.8.43
  - @cat-factory/integrations@0.116.2

## 0.20.7

### Patch Changes

- f31c644: Serve the foundational-service catalog's `builtin` tier over the mothership machine API. A
  mothership deployment is two processes, so a code-registered estate had to be registered on both
  entry points and the copies matched only while both ran the same build — with a local node one
  build behind being the normal case, and the skew silent (a run's catalog simply omits a service,
  which reads like an Architect judging it irrelevant).

  The tier is now read through the kernel `FoundationalBuiltinSource` port: the in-process registry by
  default, `GET /internal/foundational-services` (+ the batched
  `POST /internal/foundational-services/contracts`) on a mothership-mode node, which no longer consults
  its own registry and warns at boot naming any ids it ignores. The remote read throws rather than
  answering with an empty tier — on the 404 from a mothership older than the node, and on a 200 whose
  payload it cannot read — and the injected context files STATE that outage rather than being omitted
  (`FoundationalCatalogRead` / `FoundationalIndexRead` gain an `unavailable` variant), so a best-effort
  dispatch cannot turn the throw back into "no shared services are registered".

  Compatibility break (pre-1.0, no shim): `FoundationalServiceCatalogService` takes `builtins`
  (a `FoundationalBuiltinSource`) in place of `registry`; wrap a registry with
  `registryBuiltinSource(registry)`. `CoreDependencies.foundationalServiceRegistry` and the facade
  options are unchanged.

- Updated dependencies [f31c644]
- Updated dependencies [4ac6960]
- Updated dependencies [4ac6960]
- Updated dependencies [874d684]
  - @cat-factory/kernel@0.212.0
  - @cat-factory/agents@0.104.0
  - @cat-factory/orchestration@0.184.0
  - @cat-factory/server@0.192.0
  - @cat-factory/integrations@0.116.1
  - @cat-factory/contracts@0.210.1
  - @cat-factory/gates@0.8.42
  - @cat-factory/prompt-fragments@0.15.35

## 0.20.6

### Patch Changes

- Updated dependencies [769a3d9]
  - @cat-factory/kernel@0.211.0
  - @cat-factory/agents@0.103.0
  - @cat-factory/integrations@0.116.0
  - @cat-factory/server@0.191.2
  - @cat-factory/gates@0.8.41
  - @cat-factory/orchestration@0.183.1

## 0.20.5

### Patch Changes

- Updated dependencies [be7135c]
  - @cat-factory/server@0.191.1

## 0.20.4

### Patch Changes

- Updated dependencies [73708cf]
- Updated dependencies [876ee2d]
  - @cat-factory/contracts@0.210.0
  - @cat-factory/kernel@0.210.0
  - @cat-factory/integrations@0.115.0
  - @cat-factory/orchestration@0.183.0
  - @cat-factory/server@0.191.0
  - @cat-factory/agents@0.102.0
  - @cat-factory/gates@0.8.40
  - @cat-factory/prompt-fragments@0.15.34

## 0.20.3

### Patch Changes

- Updated dependencies [0a1170e]
  - @cat-factory/contracts@0.209.0
  - @cat-factory/kernel@0.209.0
  - @cat-factory/agents@0.101.0
  - @cat-factory/gates@0.8.39
  - @cat-factory/integrations@0.114.4
  - @cat-factory/orchestration@0.182.2
  - @cat-factory/prompt-fragments@0.15.33
  - @cat-factory/server@0.190.3

## 0.20.2

### Patch Changes

- Updated dependencies [d320539]
  - @cat-factory/contracts@0.208.0
  - @cat-factory/kernel@0.208.0
  - @cat-factory/agents@0.100.0
  - @cat-factory/gates@0.8.38
  - @cat-factory/integrations@0.114.3
  - @cat-factory/orchestration@0.182.1
  - @cat-factory/prompt-fragments@0.15.32
  - @cat-factory/server@0.190.2

## 0.20.1

### Patch Changes

- Updated dependencies [9e5f785]
  - @cat-factory/contracts@0.207.0
  - @cat-factory/kernel@0.207.0
  - @cat-factory/agents@0.99.0
  - @cat-factory/orchestration@0.182.0
  - @cat-factory/gates@0.8.37
  - @cat-factory/integrations@0.114.2
  - @cat-factory/prompt-fragments@0.15.31
  - @cat-factory/server@0.190.1

## 0.20.0

### Minor Changes

- 8fbc0b5: Serve the repo-sourced Claude Skills library (ADR 0024) over the mothership-mode persistence RPC —
  catalog reads and the repo-sync surface alike — so a local node with no main database can list,
  sync and RUN a skill.

  This was not a blank panel. `skillResolver` is a hard dependency for a `skill` step (and for the
  declared `{ catalogSkillId }` capabilities of ADR 0029), so an un-routed skill catalog failed the
  dispatch, and it failed partially: a skill with no sibling resources resolved from the catalog
  alone while one with resources threw out of the resource fetch, so the feature read as wired. The
  sync half went remote too — unlike the prompt-fragment library, whose sync stays mothership-owned
  because "a mothership node has no GitHub client", a mothership node now reaches GitHub by token
  delegation, so its skill link/sync/unlink routes were live and broken rather than absent.

  Adds a `skillSource` scope rule: the sync methods carry a source id and nothing else, so nothing
  positional binds them; it resolves the source's owning account server-side (memoised, sharing its
  read with the dispatched call). The global `skillSourceRepository.listByRepo` — the push-webhook
  reverse lookup across every account — stays mothership-internal.

  Adds `accountFieldUpsert` alongside it, for a record-keyed write whose conflict key is the record's
  `id` rather than its `accountId`. `accountField` binds only the account a record DECLARES, which is
  sufficient only while the row is stored under that account — an `ON CONFLICT (id) DO UPDATE` that
  does not re-`SET account_id` instead writes whichever row already holds that id, under its own
  account. The new rule binds the stored row too, so a token scoped to one account can no longer name
  another's source id and repoint their link at a repo it controls (whose `SKILL.md` bodies the other
  tenant's next sync would fold into their catalog as agent instructions); an absent row is a create
  and still passes.

  A misconfiguration now also reports itself correctly: the persistence controller's per-request memo
  overrides are applied only for repositories the deployment actually wires, so a mothership without
  the library answers `... is not wired` instead of a scope 404 that reads as a missing row.

  `GitHubInstallationRepository` gains `listActiveForAccount`, the account-scoped form of the cron
  `listActive`. The account-tier installation lookup every repo-sourced library resolves its GitHub
  credential through read EVERY tenant's installations and filtered in JS — unexposable over an
  account-scoped machine API, and unbindable by any scope rule since the method takes no arguments.
  The narrowing ("bound to the account directly, or to one of its own boards") now runs in SQL on
  both runtimes, ordered so they pick the same row, and the resolver makes one query where it made
  two.

  Both ends of a mothership deployment must have the skill/fragment library enabled: the mothership
  reflects the skill repositories into its machine-API registry only when its own library is
  configured, exactly as it does for fragments.

### Patch Changes

- Updated dependencies [8fbc0b5]
  - @cat-factory/kernel@0.206.0
  - @cat-factory/agents@0.98.0
  - @cat-factory/server@0.190.0
  - @cat-factory/integrations@0.114.1
  - @cat-factory/orchestration@0.181.1
  - @cat-factory/contracts@0.206.1
  - @cat-factory/gates@0.8.36
  - @cat-factory/prompt-fragments@0.15.30

## 0.19.0

### Minor Changes

- 5511cdc: Finish the foundational-services catalog: it now has a management surface, a way for a board to opt
  out of an inherited service, and push-driven freshness.

  The SPA gains an account-settings tab and an advanced-tier board panel: register a service with its
  uploaded API contracts, link a repo of service definitions (a folder of them, or an explicit file
  list for one named service), and — on a board — review the merged catalog an Architect is actually
  handed, expanding a contract document through the same lazy read a consumer dispatch makes. Opening
  the catalog still transfers no document body.

  A board opts out of an inherited account service through a new suppression sub-resource
  (`POST`/`DELETE /workspaces/:ws/foundational-services/:id/suppression`, plus a
  `GET /workspaces/:ws/foundational-service-suppressions` list read). It is
  deliberately not a delete: deleting removes the board's own registration and its documents, where a
  suppression destroys nothing and is reversible. Suppressing an id the catalog does not carry, or one
  the board registered itself, is refused rather than silently written.

  Repo sources now also refresh on a GitHub push webhook, alongside the periodic sweep — the same
  fan-out the skill library uses, cutting worst-case staleness from the sweep window to seconds. That
  matters more here than for skills: a stale API contract is handed to a coder as the interface to
  write against.

  Breaking: adds a `hardDelete` method to `FoundationalServiceRepository` and a `listByRepo` to
  `FoundationalServiceSourceRepository`, so an out-of-tree implementation of either port must
  implement them; `GitHubWebhookIngest` likewise gains `queueFoundationalResync`.

### Patch Changes

- Updated dependencies [5511cdc]
  - @cat-factory/contracts@0.206.0
  - @cat-factory/kernel@0.205.0
  - @cat-factory/agents@0.97.0
  - @cat-factory/integrations@0.114.0
  - @cat-factory/orchestration@0.181.0
  - @cat-factory/server@0.189.0
  - @cat-factory/gates@0.8.35
  - @cat-factory/prompt-fragments@0.15.29

## 0.18.0

### Minor Changes

- 1441041: Let a deployment register its own EXTERNAL TOOLS into the sidebar, opened already scoped to the
  workspace through deployment-declared custom metadata fields.

  Two new data-only `registerAppModule` slots, which only mean anything together:

  - **`externalTools`** — a deployment's own web applications (a map editor, an asset pipeline, an
    admin console) in a new "External tools" sidebar section and the command palette. A tool declares
    a RESOLVER, `(context) => url`, not a link: the context carries the acting user, the open
    workspace and that workspace's custom metadata, so clicking lands on the right state rather than
    the tool's front door. That is the whole point — a static bookmark needs no registration.
  - **`workspaceMetadataFields`** — the custom fields the resolver reads. Declared in CODE (so a
    deployment adds, renames and retires them with no migration); the VALUES are per workspace, typed
    in on a new Metadata tab of Workspace settings and persisted in a `metadata` JSON column on the
    workspace settings row, mirrored across D1 and Postgres.

  The worked example is `deploy/frontend`'s `acme:security` module: a `gameId` field, and a map editor
  that opens on that game.

  Four decisions worth knowing when reading this:

  - **A tool that cannot resolve stays LISTED and explains itself on click**, with `missing-metadata`
    (naming the unfilled fields), `unresolved`, `resolver-failed` and `unsafe-url` as four separate
    causes. Hiding it would make an unconfigured workspace look identical to a deployment that never
    registered the tool — and the person reading the sidebar is usually the one who can fix it.
  - **The resolved URL must be `http(s)`.** It reaches `window.open`, so a `javascript:` URL from a
    mis-built resolver would execute in the SPA's own origin; the scheme allow-list is a boundary,
    not hygiene. Values are operator-typed, so a resolver sets them as query parameters or encoded
    path segments and never builds the ORIGIN from one — a value like `evil.com/x?a=` spliced into a
    host resolves to somebody else's site and still passes the allow-list.
  - **Resolution is TOTAL: a resolver that throws costs its own item and nothing else.** Registered
    tools are projected inside the computed the sidebar, the command palette and the board toolbar
    all render from, so an uncaught throw in a deployment's own resolver would blank all three at
    once. It is caught, reported as `resolver-failed` and the cause logged.
  - **The metadata bag is REPLACED wholesale on save, and a cleared field drops its key** rather than
    storing `''` — otherwise "nobody filled this in" and "somebody entered nothing" both resolve to a
    tool URL with an empty parameter. The editor carries any key it does not render back into the
    patch, so a value written under a retired field survives an unrelated save.

  The backend deliberately validates only the SHAPE of the bag (identifier-shaped keys, bounded values
  and entry count), never the field list: the definitions are code-shipped, so a server-side list would
  disagree with the app the moment either side is deployed alone. The key pattern bars a leading `_`,
  which keeps `__proto__` out — but `constructor` and `toString` are legal field keys, so every read of
  the bag goes through `metadataValue` / `toMetadataBag` and an unfilled field named after an
  `Object.prototype` member reads `undefined` rather than an inherited function.

### Patch Changes

- Updated dependencies [1441041]
  - @cat-factory/contracts@0.205.0
  - @cat-factory/kernel@0.204.0
  - @cat-factory/orchestration@0.180.0
  - @cat-factory/agents@0.96.1
  - @cat-factory/gates@0.8.34
  - @cat-factory/integrations@0.113.9
  - @cat-factory/prompt-fragments@0.15.28
  - @cat-factory/server@0.188.1

## 0.17.0

### Minor Changes

- 0b52df7: Add foundational services: a tiered (account ⊕ workspace) catalog of the shared capabilities an
  organisation already runs — file storage, notifications, audit — each with a description and its
  API contracts (OpenAPI 3.x, `@toad-contracts/core` or `@lokalise/api-contract`), supplied either by
  direct upload or by linking files/folders in a git repo that is cached and auto-refreshed on both
  runtimes.

  The Architect is folded the catalog (identity, capability tags and indexed operation names — never a
  document body) and must declare the service ids its design consumes; the Researcher and Coder are
  then handed the full API contracts of exactly those services, plus an explicit statement of anything
  the design named that the catalog does not contain.

### Patch Changes

- Updated dependencies [0b52df7]
  - @cat-factory/contracts@0.204.0
  - @cat-factory/kernel@0.203.0
  - @cat-factory/agents@0.96.0
  - @cat-factory/orchestration@0.179.0
  - @cat-factory/server@0.188.0
  - @cat-factory/gates@0.8.33
  - @cat-factory/integrations@0.113.8
  - @cat-factory/prompt-fragments@0.15.27

## 0.16.13

### Patch Changes

- Updated dependencies [9c6ce7a]
  - @cat-factory/kernel@0.202.0
  - @cat-factory/server@0.187.0
  - @cat-factory/agents@0.95.1
  - @cat-factory/gates@0.8.32
  - @cat-factory/integrations@0.113.7
  - @cat-factory/orchestration@0.178.1

## 0.16.12

### Patch Changes

- a7aae8a: Finish the `/api/v1` external surface: a workspace usage read, and an outbound run-lifecycle push
  so an integration stops polling.

  `GET /api/v1/usage` (a `read`-scope key) serves the current billing period as ONE resource: the
  METERED budget position the spend safeguard itself acts on — including `exceeded`, which is what
  pauses runs — plus the per-`(billing, vendor, provider, model)` breakdown behind it. Splitting it
  into two endpoints would let a caller render a breakdown against a budget read a period-roll apart.
  It reads through a new `SpendService.periodUsage`, which resolves ONE `periodStart` for both
  aggregates and still issues them concurrently: composing the response from `status()` +
  `usageBreakdown()` would have reintroduced the same skew inside one request, since each derives its
  own period from the clock.
  Rows keep their `billing` discriminator and are never summed for the caller: a `subscription` row's
  `costEstimate` is illustrative (a flat-rate plan bills nothing per token), so adding it to metered
  spend would report money nobody is billed for. Workspace tier only — the account and user budgets
  are cross-workspace, and a workspace-scoped key must never learn a sibling workspace's spend.

  The workspace's ONE registered outbound endpoint now also delivers run-lifecycle events —
  `run.started`, `run.completed`, `run.failed` — beside the notification cards it already carried,
  reaching the transport through a new kernel `RunLifecycleSink` port. This exists because the HAPPY
  path raises no notification at all: a pipeline whose `merger` merges its own PR settles with an
  empty inbox, which is exactly the outcome a CI system wants to hear about. Same row, same sealed
  secret, same SSRF guard, same retry budget: the retry/signature/redirect core moved to a shared
  `signedDelivery.ts` that both families drive, because everything interesting about a delivery is a
  property of the endpoint rather than the payload.

  **Subscribing is opt-in and empty means NONE**, deliberately the opposite of the sibling
  notification `types` filter — an endpoint registered for parked decisions must not silently start
  receiving an event per run — so an existing webhook keeps byte-for-byte its current behaviour until
  someone sets `runEvents`.

  Worth knowing when reviewing: the two edges hook different places on purpose. `run.started` fires
  from `handOffLiveRun`, the one funnel every start path ends with, and is announced LAST — after the
  block is committed and the durable runner has the run — so a slow or black-holing receiver costs the
  announcement and never the run. It is still exactly once, because the claim that precedes the
  hand-off (`insertLiveRunOrConflict`) is what mints a live run, and a start path added later inherits
  it since skipping the funnel would also skip `startRun`. The terminal edges fire from the engine's
  terminal-emit funnel, because a run reaches `done` from four independent sites and a hook at each
  would compile, pass, and drift the day a fifth is added — the cost is that a durable replay can
  re-emit a settled run, so delivery is **at-least-once** with a `<runId>:<event>` dedupe id in the
  body. **Dedupe on that id, not on the body**: a replay re-stamps `sentAt`/`occurredAt`, so two
  deliveries of one transition are not byte-identical even though everything a receiver routes on is.
  That is a considered departure from the platform's atomic-claim rule: unlike a merge or a posted
  review, a repeat here is collapsed by one id comparison, so it does not earn a claim table and the
  sweeper that would come with it.

  `docs/openapi.json` shrinks by ~17k lines in the same change, with no semantic difference beyond
  the new endpoint. The generator copied every component definition into a `$defs` block on each
  schema it inlined, so the whole component set was duplicated across ten operations and every new
  public DTO cost roughly ten times its size in the committed file. Those `$defs` resolved nothing —
  the refs are rewritten into `#/components/schemas` — and generation now asserts that every `$ref`
  names an emitted component, so a DTO that actually needs hoisting fails the build instead of
  shipping a dangling pointer.

  Schema: `notification_webhooks` gains a `run_events` JSON column (D1 migration 0072 ⇄ Drizzle),
  defaulting to `'[]'`. The webhook repository is now read on the run's terminal path, so it is
  allow-listed for mothership mode (`get`/`put`/`delete`, workspace-scoped) — an un-routed method
  there would have surfaced only as a webhook that silently never fires, since both delivery paths
  are best-effort by contract.

- Updated dependencies [54e6a45]
- Updated dependencies [08e9bcc]
- Updated dependencies [a7aae8a]
  - @cat-factory/agents@0.95.0
  - @cat-factory/contracts@0.203.0
  - @cat-factory/orchestration@0.178.0
  - @cat-factory/server@0.186.0
  - @cat-factory/kernel@0.201.1
  - @cat-factory/integrations@0.113.6
  - @cat-factory/gates@0.8.31
  - @cat-factory/prompt-fragments@0.15.26

## 0.16.11

### Patch Changes

- Updated dependencies [16fd126]
  - @cat-factory/orchestration@0.177.1
  - @cat-factory/integrations@0.113.5
  - @cat-factory/server@0.185.2

## 0.16.10

### Patch Changes

- Updated dependencies [8c40f33]
  - @cat-factory/orchestration@0.177.0
  - @cat-factory/agents@0.94.0
  - @cat-factory/kernel@0.201.0
  - @cat-factory/server@0.185.1
  - @cat-factory/gates@0.8.30
  - @cat-factory/integrations@0.113.4

## 0.16.9

### Patch Changes

- Updated dependencies [9d303f0]
  - @cat-factory/contracts@0.202.0
  - @cat-factory/kernel@0.200.0
  - @cat-factory/orchestration@0.176.0
  - @cat-factory/server@0.185.0
  - @cat-factory/agents@0.93.0
  - @cat-factory/gates@0.8.29
  - @cat-factory/integrations@0.113.3
  - @cat-factory/prompt-fragments@0.15.25

## 0.16.8

### Patch Changes

- Updated dependencies [0bffe55]
- Updated dependencies [1cd9d73]
  - @cat-factory/contracts@0.201.0
  - @cat-factory/kernel@0.199.0
  - @cat-factory/orchestration@0.175.0
  - @cat-factory/server@0.184.0
  - @cat-factory/agents@0.92.0
  - @cat-factory/gates@0.8.28
  - @cat-factory/integrations@0.113.2
  - @cat-factory/prompt-fragments@0.15.24

## 0.16.7

### Patch Changes

- Updated dependencies [d9789f9]
  - @cat-factory/kernel@0.198.0
  - @cat-factory/agents@0.91.0
  - @cat-factory/orchestration@0.174.0
  - @cat-factory/contracts@0.200.0
  - @cat-factory/gates@0.8.27
  - @cat-factory/integrations@0.113.1
  - @cat-factory/server@0.183.1
  - @cat-factory/prompt-fragments@0.15.23

## 0.16.6

### Patch Changes

- Updated dependencies [123ac6f]
  - @cat-factory/agents@0.90.0
  - @cat-factory/contracts@0.199.0
  - @cat-factory/integrations@0.113.0
  - @cat-factory/kernel@0.197.0
  - @cat-factory/orchestration@0.173.0
  - @cat-factory/server@0.183.0
  - @cat-factory/gates@0.8.26
  - @cat-factory/prompt-fragments@0.15.22

## 0.16.5

### Patch Changes

- Updated dependencies [550a7fe]
  - @cat-factory/server@0.182.0

## 0.16.4

### Patch Changes

- Updated dependencies [99412e2]
  - @cat-factory/contracts@0.198.0
  - @cat-factory/kernel@0.196.0
  - @cat-factory/integrations@0.112.0
  - @cat-factory/server@0.181.0
  - @cat-factory/agents@0.89.1
  - @cat-factory/gates@0.8.25
  - @cat-factory/orchestration@0.172.1
  - @cat-factory/prompt-fragments@0.15.21

## 0.16.3

### Patch Changes

- Updated dependencies [1904eb8]
  - @cat-factory/kernel@0.195.0
  - @cat-factory/agents@0.89.0
  - @cat-factory/orchestration@0.172.0
  - @cat-factory/server@0.180.0
  - @cat-factory/gates@0.8.24
  - @cat-factory/integrations@0.111.2

## 0.16.2

### Patch Changes

- Updated dependencies [f9db6a6]
  - @cat-factory/server@0.179.0
  - @cat-factory/agents@0.88.0
  - @cat-factory/kernel@0.194.0
  - @cat-factory/orchestration@0.171.1
  - @cat-factory/gates@0.8.23
  - @cat-factory/integrations@0.111.1

## 0.16.1

### Patch Changes

- Updated dependencies [be7fe66]
  - @cat-factory/contracts@0.197.0
  - @cat-factory/kernel@0.193.0
  - @cat-factory/integrations@0.111.0
  - @cat-factory/orchestration@0.171.0
  - @cat-factory/agents@0.87.2
  - @cat-factory/gates@0.8.22
  - @cat-factory/prompt-fragments@0.15.20
  - @cat-factory/server@0.178.2

## 0.16.0

### Minor Changes

- 83fd037: Retire built-in pipelines: remove ones that are no longer relevant through the reseed lifecycle

  A built-in pipeline is copied into every workspace at creation, so withdrawing one from the catalog
  in code did nothing for boards that already had it — `reseed` had no definition left to resolve and
  `remove` refused every built-in, leaving an obsolete pipeline in each existing library permanently
  (and still startable). Retirement closes that gap.

  - Kernel gains a tombstone list (`buildRetiredPipelines` in `domain/seed.ts`, exposed as
    `retiredPipelines()`). Retiring a built-in is TWO edits — delete its definition from the builder
    AND name its id in the tombstone list — and they do different jobs: the deletion is what takes the
    pipeline out of `seedPipelines()` (so it stops being seeded into new workspaces, drops out of the
    catalog versions, and stops being reseedable, with no change at any of its call sites), while the
    tombstone is the separate positive assertion that the id used to be ours and is now obsolete, which
    is what reaches a board that already stored it. Doing only the deletion is the silent no-op this
    release fixes; doing only the tombstone is caught by a kernel unit test and a boot check.
  - `PipelineRegistry` gains `retire(id, { replacedBy })` / `retired()` / `mergeRetired()`, so a
    deployment can withdraw its OWN registered pipelines. `register` and `retire` are inverses for an
    id, and a live catalog entry always wins, so the live and retired sets stay disjoint. A deployment
    cannot withdraw a BUILT-IN this way (that would be a route to emptying the curated palette), and
    `validateRegistrations` now raises `retirement_of_live_pipeline` at boot when a `retire()` call
    names a still-live pipeline, rather than leaving the ignored call to be discovered as a cleanup
    that never appeared.
  - `PipelineService.remove` accepts a built-in only while it is retired (a pipeline the catalog still
    ships stays read-only), and the workspace snapshot ships `retiredPipelines` beside
    `pipelineCatalogVersions`.
  - The SPA's pipeline-health advisory grows a "Retired pipelines" section offering a per-row removal,
    naming the replacement when the catalog declares one — resolved from the stored row when the board
    has one and from the catalog otherwise, since the usual retirement is superseded-by-a-newly-shipped
    built-in, which has no row until someone adds it. A retired pipeline is excluded from every reseed
    offer, including the "new built-ins available" list.

  Also fixes an adjacent gap: deleting a pipeline that a recurring schedule still points at is now
  refused with a 409 naming the fix, for custom pipelines as much as retired built-ins. Previously the
  delete succeeded and every subsequent fire of that schedule failed silently. A paused (`enabled:
false`) schedule blocks the delete too — pausing is not detaching, and the breakage would otherwise
  surface when someone re-enabled it. That refusal and the two pre-existing schedule refusals on
  `update` now carry machine-readable `details.reason` codes (`pipeline_schedule_attached` /
  `pipeline_schedule_requires_recurring` / `pipeline_schedule_intake_unconfigured`), so the SPA words
  them in the user's language instead of surfacing the raw English message.

### Patch Changes

- Updated dependencies [83fd037]
  - @cat-factory/kernel@0.192.0
  - @cat-factory/contracts@0.196.0
  - @cat-factory/orchestration@0.170.0
  - @cat-factory/agents@0.87.1
  - @cat-factory/gates@0.8.21
  - @cat-factory/integrations@0.110.5
  - @cat-factory/server@0.178.1
  - @cat-factory/prompt-fragments@0.15.19

## 0.15.5

### Patch Changes

- Updated dependencies [7248b72]
- Updated dependencies [449d856]
  - @cat-factory/contracts@0.195.0
  - @cat-factory/kernel@0.191.0
  - @cat-factory/agents@0.87.0
  - @cat-factory/orchestration@0.169.0
  - @cat-factory/server@0.178.0
  - @cat-factory/gates@0.8.20
  - @cat-factory/integrations@0.110.4
  - @cat-factory/prompt-fragments@0.15.18

## 0.15.4

### Patch Changes

- Updated dependencies [4ecb25c]
  - @cat-factory/kernel@0.190.0
  - @cat-factory/agents@0.86.0
  - @cat-factory/orchestration@0.168.0
  - @cat-factory/server@0.177.0
  - @cat-factory/gates@0.8.19
  - @cat-factory/integrations@0.110.3

## 0.15.3

### Patch Changes

- Updated dependencies [7ed2bc0]
  - @cat-factory/contracts@0.194.0
  - @cat-factory/kernel@0.189.0
  - @cat-factory/agents@0.85.0
  - @cat-factory/prompt-fragments@0.15.17
  - @cat-factory/orchestration@0.167.0
  - @cat-factory/server@0.176.0
  - @cat-factory/gates@0.8.18
  - @cat-factory/integrations@0.110.2

## 0.15.2

### Patch Changes

- 85efc27: Review the initiative plan as a document, not a wall of sections.

  #1498 gave the planner's parked gate a board affordance and an approve / request-changes rail in
  the tracker window. This is the other half: what that rail actually reviews.

  The planner emits its plan as JSON and returns a transcript summary ("Initiative plan drafted.")
  as `step.output`, so the gate parked on a **one-line proposal**. Three consequences, none of them
  visible from the rail itself: there was no document to read (the plan was only ever the tracker's
  structured sections beneath the rail), no way to navigate a long plan, no way to say WHICH part
  needed changing — and, worst, "request changes" handed the planner back that sentence as its
  previous proposal, so the re-plan was near-blind.

  The gate now parks on a markdown rendering of the plan (`renderInitiativePlanForReview`). Its
  headings are load-bearing rather than decorative: the reader's outline parser splits the document
  at each one, which is what makes the rest possible. The tracker's rail renders that document with
  an outline to navigate by and GitHub-style click-to-comment on any block, and sends the anchored
  comments with the feedback — so a re-plan is quoted the planner's own text back at it.

  **What gets rendered is the INGESTED plan, and that is the part worth a reviewer's attention.**
  The obvious home for this was the existing `reviewableArtifactOutput` seam, beside the spec doc
  and the blueprint tree. It is the wrong one: that seam renders the agent's RAW result, which is
  sound only while the committed artifact IS that result — true for those two (the harness commits
  the files; the engine only validates them), false for the plan, which the engine derives at
  ingest. A preset's phase template reorders phases and forces checkpoints, its `seedPlan` hook adds
  and drops items (the tech-migration preset caps coverage items and seeds a confidence case), and a
  re-plan carries over items a previous plan already materialised. Rendering the raw draft would
  show the reviewer a document their approval does not govern — and nothing would fail; they would
  simply approve work they were never shown. So the `initiative-planner`'s post-completion resolver
  authors the rendering off the entity it just committed, and publishes it through the new
  `StepResolution.outputIsRendered`. The renderer takes the shape the draft and the entity share,
  and drops nothing it is handed: an item naming a phase the plan never declared gets its own
  section rather than disappearing between the phases.

  Both review tools are the SAME ones the step reader gives the architect's prose, shared rather
  than re-implemented: `useStepProse` for the outline, the new `useProseComments` for the anchoring
  (the per-block half of `useStepApproval`, which now builds on it), and one global `.reader-prose`
  stylesheet. The stylesheet absorbs the near-identical scoped copies the clarity, requirements and
  brainstorm windows each carried, so all five reader surfaces now share one presentation — those
  three pick up small cosmetic changes (the step reader's spacing and its code/blockquote styling)
  in exchange for no longer being able to drift.

  `useStepProse` also gained an explicit `leadAnchorId`. Its scroll-spy walks anchors in document
  order and stops at the first one it cannot measure, so a consumer that renders the document alone
  — this rail — had its active-section highlight silently pinned to the step reader's details card.

  **Behaviour change worth knowing about at review time:** "approve with corrections" is now REFUSED
  for any step whose output is a rendering of an artifact it already produced — the new
  `PipelineStep.outputIsRendered`, which today covers the initiative plan, the spec doc and the
  blueprint tree. `approveStep` answers 422 with `details.reason: 'proposal_not_editable'` and the
  SPA replaces the button with a note. This looks like a removal but is the opposite: those edits
  were already being silently discarded, because the committed artifact is the ingested one and never
  the text typed over its rendering. It only bites a deployment that gates a `spec-writer` or
  `blueprints` step, where the affordance was accepting corrections and dropping them. Requesting
  changes is the route for a correction. The `task-estimator`'s summary deliberately stays editable
  and the resolver now says why: the flag marks an output an edit cannot REACH, and that summary is
  itself what downstream steps read via `priorOutputs`.

  An alternative considered and rejected: routing the planner step to the generic step reader (by
  dropping its `resultView`), which would have delivered the same tools with no new UI at all. It was
  withdrawn once #1498 landed — that PR deliberately makes the tracker the window the park routes to,
  and two review surfaces for one gate is worse than a slightly larger frontend diff.

  One guard is new and worth keeping in mind when touching enum→i18n lookup tables: a key held in a
  `Record<SomeEnum, string>` is invisible to BOTH i18n drift guards (typed message keys and
  `i18n:check` only see a literal `t('a.b.c')`, and the exhaustive `Record` only proves every enum
  member has an entry, never that the entry still names a live key). `test/i18nKeys` resolves such
  values against the base catalog, and the initiative label tables now assert against it.

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

- Updated dependencies [85efc27]
- Updated dependencies [9794c19]
  - @cat-factory/contracts@0.193.0
  - @cat-factory/kernel@0.188.0
  - @cat-factory/orchestration@0.166.0
  - @cat-factory/server@0.175.0
  - @cat-factory/agents@0.84.2
  - @cat-factory/gates@0.8.17
  - @cat-factory/integrations@0.110.1
  - @cat-factory/prompt-fragments@0.15.16

## 0.15.1

### Patch Changes

- Updated dependencies [57e1195]
- Updated dependencies [5b19dab]
  - @cat-factory/contracts@0.192.0
  - @cat-factory/kernel@0.187.0
  - @cat-factory/integrations@0.110.0
  - @cat-factory/orchestration@0.165.0
  - @cat-factory/server@0.174.0
  - @cat-factory/agents@0.84.1
  - @cat-factory/gates@0.8.16
  - @cat-factory/prompt-fragments@0.15.15

## 0.15.0

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
  - @cat-factory/orchestration@0.164.0
  - @cat-factory/server@0.173.0
  - @cat-factory/gates@0.8.15
  - @cat-factory/integrations@0.109.6
  - @cat-factory/prompt-fragments@0.15.14

## 0.14.9

### Patch Changes

- 0eacaa2: Move private package registries into the Infrastructure window, and stop requiring package scopes.

  The registries a checkout installs from are part of where agent containers RUN, not an optional
  external system a workspace links in, so they are now a tab of the Infrastructure window
  (alongside Agent containers / Test environments / Shared stacks) rather than an Integrations-hub
  row with a modal of its own. The tab still gates on the module's own probe, so an unconfigured
  backend shows no dead tab. `ui.infrastructureTab` is typed against the window's full tab
  vocabulary rather than the two provider-connection kinds, so the non-connection tabs (shared
  stacks, package registries) are reachable by deep link instead of only by opening the window and
  clicking across.

  Package scopes are now OPTIONAL on an entry, and leaving them empty is often the right answer: an
  npmrc scope mapping is all-or-nothing, so routing `@org` to a private registry makes every
  `@org/*` package resolve from it — which breaks an organisation that publishes part of that scope
  publicly. A scope-less entry still emits the registry host's `_authToken` line, which is all a
  checkout needs whenever the ROUTING is already settled elsewhere: the repository commits its own
  `.npmrc` (project config wins over the user config the harness writes), single dependencies carry
  a named-registry prefix (`"@acme/private": "gh:^1.0.0"` — pnpm >= 11.1.0, pnpm/pnpm#11324), or the
  vendor simply IS the default registry, where a scope mapping back to `registry.npmjs.org` was
  always a no-op and only the credential was missing. The form explains this next to the field and
  previews the scopes it parsed, so an empty save reads as deliberate rather than as a field that
  silently swallowed what was typed.

  Compatibility: a scope-less entry needs harness image `1.73.0` or newer. Note the blast radius —
  an older image does not skip the entry, it fails `parseJob`, so EVERY container dispatch in that
  workspace dies (`packageRegistries[i].scopes must be a non-empty array`), not just dependency
  installs. The backend has no signal for what image a pool pins, so this cannot be gated
  server-side: a self-hosted runner pool must be updated before a workspace configures a scope-less
  entry. Deployments on the managed image are carried by the pin bump in this release.

  Also: a package-registries read that fails for any reason OTHER than the module being
  unconfigured now propagates instead of being swallowed, so the panel reports it. Previously a
  `503` (no module) and an unreachable backend both rendered as an empty, silent surface — and with
  the panel behind an availability-gated tab, the second case had no surface at all.

- Updated dependencies [0eacaa2]
  - @cat-factory/contracts@0.190.0
  - @cat-factory/orchestration@0.163.1
  - @cat-factory/agents@0.83.1
  - @cat-factory/gates@0.8.14
  - @cat-factory/integrations@0.109.5
  - @cat-factory/kernel@0.185.1
  - @cat-factory/prompt-fragments@0.15.13
  - @cat-factory/server@0.172.2

## 0.14.8

### Patch Changes

- Updated dependencies [1fa8ef7]
  - @cat-factory/orchestration@0.163.0
  - @cat-factory/kernel@0.185.0
  - @cat-factory/agents@0.83.0
  - @cat-factory/server@0.172.1
  - @cat-factory/gates@0.8.13
  - @cat-factory/integrations@0.109.4

## 0.14.7

### Patch Changes

- 8251a99: Give every request and every container job a correlation id.

  Both facades now mount a shared request middleware as their FIRST middleware — ahead of CORS and
  the per-request container build, so a CORS denial and the Worker's misconfiguration fallback are
  covered too. It adopts a bounded, safe `X-Request-Id` from the caller or mints one, echoes it on
  the response, puts it in **every error envelope**, binds `{ requestId, method, path }` on a
  request-scoped child logger, and emits one line per request: `info` on success, `warn` on a 4xx
  (naming the mapped error code), `error` on a 5xx. Previously only unexpected 500s were logged at
  all, so a 4xx spike — a validation regression, an RBAC denial, a conflict loop — left no
  server-side trace and a user report had nothing to join against. `/health` and `/ready` drop to
  `debug` when they succeed, so an orchestrator's probes don't bury the request stream.

  `X-Request-Id` is allow-listed inbound (so a caller that already has an id propagates it rather
  than the backend minting a second one for the same request) and newly EXPOSED outbound, so a
  browser can read it off the response.

  The **misconfiguration fallback backend** is covered on every facade. The Worker inherits the
  middleware because it serves the fallback from inside `createApp`, but Node/local swap in the
  whole `createMisconfiguredApp` — so that app mounts it itself, or the one deployment shape an
  operator is actively debugging is the only one serving requests with no id and no request line.

  Across the workflow↔container seam, `workspaceId` and `executionId` now ride the agent job body
  and the harness binds them onto its per-job logger beside `jobId` — the two halves of a run
  previously shared no id and were stitched only by a job-id naming convention. This covers EVERY
  dispatcher of the `agent` kind, not just the execution path: `ContainerRepoBootstrapper` and
  `ContainerEnvConfigRepairer` hand-build their bodies, and a bootstrap is a first-class agent run
  (same table, same retry surface), so leaving them out would have left their containers' logs
  joinable to nothing. Neither has a separate execution row, so the job id doubles as the run id.

  `ContainerAgentExecutor` gained a bound logger and logs the seam's transitions (dispatched /
  dispatch-failed / poll-failed / running at `debug` / settled). A dispatch OR poll that throws is
  now reported: those are the failure classes nothing downstream can account for, because the job
  either never gets a handle or the transport fault is recorded against no job at all.

  Only the request PATHNAME is ever logged, never the raw URL, and a client-supplied id is refused
  unless it is short and `[\w\-=]+` — both are untrusted text going straight into a log stream, and
  query strings carry the WebSocket `?ticket=` and OAuth `?code=`. An unexpected fault's STACK is
  scrubbed with `redactSecrets` in its own right, not just its message: a stack's first line is
  `Error: <message>` verbatim, so attaching it raw beside the scrubbed `err` would republish
  exactly what the scrub just removed.

- Updated dependencies [8251a99]
  - @cat-factory/server@0.172.0

## 0.14.6

### Patch Changes

- Updated dependencies [f0be8a7]
  - @cat-factory/kernel@0.184.0
  - @cat-factory/server@0.171.0
  - @cat-factory/agents@0.82.4
  - @cat-factory/orchestration@0.162.0
  - @cat-factory/gates@0.8.12
  - @cat-factory/integrations@0.109.3

## 0.14.5

### Patch Changes

- Updated dependencies [a8cc6b2]
  - @cat-factory/contracts@0.189.0
  - @cat-factory/kernel@0.183.0
  - @cat-factory/orchestration@0.161.0
  - @cat-factory/agents@0.82.3
  - @cat-factory/gates@0.8.11
  - @cat-factory/integrations@0.109.2
  - @cat-factory/prompt-fragments@0.15.12
  - @cat-factory/server@0.170.1

## 0.14.4

### Patch Changes

- Updated dependencies [ac832b9]
  - @cat-factory/contracts@0.188.0
  - @cat-factory/kernel@0.182.0
  - @cat-factory/orchestration@0.160.0
  - @cat-factory/server@0.170.0
  - @cat-factory/agents@0.82.2
  - @cat-factory/gates@0.8.10
  - @cat-factory/integrations@0.109.1
  - @cat-factory/prompt-fragments@0.15.11

## 0.14.3

### Patch Changes

- Updated dependencies [22d82ac]
  - @cat-factory/contracts@0.187.0
  - @cat-factory/kernel@0.181.0
  - @cat-factory/integrations@0.109.0
  - @cat-factory/server@0.169.0
  - @cat-factory/agents@0.82.1
  - @cat-factory/gates@0.8.9
  - @cat-factory/orchestration@0.159.2
  - @cat-factory/prompt-fragments@0.15.10

## 0.14.2

### Patch Changes

- Updated dependencies [e18cfa2]
- Updated dependencies [01d4b6c]
  - @cat-factory/kernel@0.180.0
  - @cat-factory/server@0.168.0
  - @cat-factory/agents@0.82.0
  - @cat-factory/orchestration@0.159.1
  - @cat-factory/gates@0.8.8
  - @cat-factory/integrations@0.108.1

## 0.14.1

### Patch Changes

- Updated dependencies [b75a08a]
- Updated dependencies [56128e2]
- Updated dependencies [3057db1]
  - @cat-factory/contracts@0.186.0
  - @cat-factory/kernel@0.179.0
  - @cat-factory/integrations@0.108.0
  - @cat-factory/orchestration@0.159.0
  - @cat-factory/server@0.167.0
  - @cat-factory/agents@0.81.1
  - @cat-factory/gates@0.8.7
  - @cat-factory/prompt-fragments@0.15.9

## 0.14.0

### Minor Changes

- 9d965c9: Make linking living fragments from GitHub work from a pasted URL end to end, and explain the
  link button whenever it is inert.

  Three field-reported failures on one surface, fixed together:

  - **Pasting a full GitHub URL into the repo picker found nothing** ("no repositories found
    for <url>"): the picker's realtime search feeds the provider's tokenized name search, which a
    URL never matches. Contracts gains a pure `parseRepoWebUrl` (GitHub `tree`/`blob`/`raw` and
    GitLab `/-/` shapes, subgroups included), and `GitHubSyncService.listAvailableRepos` now
    collapses a pasted URL to its `owner/name` slug AND resolves that slug with a direct
    `getRepo` point-read merged ahead of the search results — a reachable repo resolves even when
    the provider's search misses it.
  - **Bulk-import by directory URL**: the Documents tab takes a pasted GitHub file or folder URL,
    resolves the repo by slug (no search dependency), opens the tree browser at that folder, and
    the browser's multi-file mode gains per-file checkboxes plus a select-all row — so a whole
    directory of documents can be checked and linked as living fragments in one action.
  - **"Link as living fragment" disabled with no explanation**: the button now states, beside it,
    exactly what is missing (no source chosen / no repository / no files ticked / empty ref).
  - **Account-tier repo sources failed with "No GitHub installation is available for this
    scope"** even when the repo was browsable: the account-scope resolver matched only
    `installation.accountId`, which is null for a per-workspace PAT connect and a GitHub account
    id for local PAT mode's synthetic rows. The shared `createTierInstallationResolvers`
    (`@cat-factory/agents`, wired by both facades for fragments AND skills) now falls back
    through the account's own boards, via the new `WorkspaceRepository.listByAccount` (D1 ⇄
    Drizzle, conformance-asserted, and proxied in mothership mode under the `account` scope rule).

### Patch Changes

- Updated dependencies [9d965c9]
- Updated dependencies [8a9f311]
  - @cat-factory/contracts@0.185.0
  - @cat-factory/kernel@0.178.0
  - @cat-factory/agents@0.81.0
  - @cat-factory/integrations@0.107.3
  - @cat-factory/server@0.166.2
  - @cat-factory/orchestration@0.158.0
  - @cat-factory/gates@0.8.6
  - @cat-factory/prompt-fragments@0.15.8

## 0.13.1

### Patch Changes

- Updated dependencies [58e06a2]
  - @cat-factory/contracts@0.184.0
  - @cat-factory/kernel@0.177.0
  - @cat-factory/orchestration@0.157.0
  - @cat-factory/agents@0.80.1
  - @cat-factory/gates@0.8.5
  - @cat-factory/integrations@0.107.2
  - @cat-factory/prompt-fragments@0.15.7
  - @cat-factory/server@0.166.1

## 0.13.0

### Minor Changes

- df48cb0: Close five gaps in the Ralph loop, of which two silently changed what a run actually did.

  A re-run un-looped the step. `retry.logic.resetStep` rebuilds a step from an explicit field list
  and so DROPPED `step.ralph`. Unlike `step.test` — seeded lazily when the tester's report arrives
  — the loop state is needed BEFORE the dispatch: it is what puts the `validation` block on the job
  body. So a retried or restarted ralph run dispatched a plain coding pass, got no verdict back,
  never fired the `ralph-verdict` interceptor, and finished as an ungated one-shot coder. The
  loop-back reset (`StepGraph.resetStepForRerun`) had the mirror-image bug: it preserved the state
  with `attempts` still at the spent budget, so the re-run's first verdict went straight to
  `exhausted`. Both now go through the pure `restartRalphState` — frozen config kept, counters
  zeroed.

  The validation command starved the inactivity watchdog. `JOB_INACTIVITY_MS` (10 min) is tighter
  than the command's own watchdog (15 min), and a harness-spawned command emits no activity of its
  own, so any validation past ten minutes aborted the iteration as a wedge and made the 15-minute
  watchdog unreachable at stock settings. It now heartbeats at 30s like the two sibling harness-run
  phases.

  `runRalphValidation` was a third copy of what `captured-command.ts` exists to prevent, and had
  drifted in both ways that seam guards: it scrubbed secrets AFTER the rolling truncation with no
  margin (a credential straddling the cut lost its `KEY=` prefix and survived redaction as an
  unrecognised partial — on a tail that reaches the step, the notification and the SPA), and it
  published the full 16k in-container capture where both siblings bound the wire tail. It now runs
  through `runCapturedCommand` at a 4k report budget.

  The loop also gains the no-progress early abort the design had deferred: the harness stamps the
  work branch's HEAD onto the verdict, and two consecutive failing iterations against an unchanged
  head end the loop instead of burning the rest of the budget. It fails open on an unknown head (an
  older harness image never trips it) and is reported distinctly from a spent budget, since only one
  of the two is fixed by raising the budget. Finally, the per-iteration attempt log — which rides
  the run `detail` blob re-serialized on every progress write — is capped, with the dropped count
  recorded and surfaced rather than silently truncated.

  Image-affecting: bumps the runner image to 1.67.0.

### Patch Changes

- Updated dependencies [65b87c1]
- Updated dependencies [df48cb0]
  - @cat-factory/orchestration@0.156.0
  - @cat-factory/contracts@0.183.0
  - @cat-factory/agents@0.80.0
  - @cat-factory/kernel@0.176.0
  - @cat-factory/server@0.166.0
  - @cat-factory/gates@0.8.4
  - @cat-factory/integrations@0.107.1
  - @cat-factory/prompt-fragments@0.15.6

## 0.12.21

### Patch Changes

- Updated dependencies [b30cc6e]
  - @cat-factory/contracts@0.182.0
  - @cat-factory/kernel@0.175.0
  - @cat-factory/agents@0.79.0
  - @cat-factory/integrations@0.107.0
  - @cat-factory/orchestration@0.155.0
  - @cat-factory/server@0.165.0
  - @cat-factory/gates@0.8.3
  - @cat-factory/prompt-fragments@0.15.5

## 0.12.20

### Patch Changes

- Updated dependencies [c47eb66]
- Updated dependencies [5abcb9e]
  - @cat-factory/integrations@0.106.0
  - @cat-factory/contracts@0.181.0
  - @cat-factory/kernel@0.174.0
  - @cat-factory/server@0.164.0
  - @cat-factory/agents@0.78.0
  - @cat-factory/orchestration@0.154.0
  - @cat-factory/gates@0.8.2
  - @cat-factory/prompt-fragments@0.15.4

## 0.12.19

### Patch Changes

- Updated dependencies [bead6df]
  - @cat-factory/integrations@0.105.0
  - @cat-factory/contracts@0.180.0
  - @cat-factory/kernel@0.173.0
  - @cat-factory/orchestration@0.153.1
  - @cat-factory/server@0.163.2
  - @cat-factory/agents@0.77.1
  - @cat-factory/gates@0.8.1
  - @cat-factory/prompt-fragments@0.15.3

## 0.12.18

### Patch Changes

- Updated dependencies [a04f609]
  - @cat-factory/agents@0.77.0
  - @cat-factory/orchestration@0.153.0
  - @cat-factory/server@0.163.1

## 0.12.17

### Patch Changes

- Updated dependencies [71ea4ec]
- Updated dependencies [68f0edd]
- Updated dependencies [71ea4ec]
- Updated dependencies [6dbd864]
  - @cat-factory/orchestration@0.152.0
  - @cat-factory/contracts@0.179.0
  - @cat-factory/kernel@0.172.0
  - @cat-factory/agents@0.76.0
  - @cat-factory/integrations@0.104.0
  - @cat-factory/server@0.163.0
  - @cat-factory/gates@0.8.0
  - @cat-factory/prompt-fragments@0.15.2

## 0.12.16

### Patch Changes

- Updated dependencies [3260f2d]
  - @cat-factory/agents@0.75.2
  - @cat-factory/orchestration@0.151.1
  - @cat-factory/server@0.162.1

## 0.12.15

### Patch Changes

- Updated dependencies [15905ab]
- Updated dependencies [9d8fe9b]
  - @cat-factory/agents@0.75.1
  - @cat-factory/contracts@0.178.0
  - @cat-factory/kernel@0.171.0
  - @cat-factory/orchestration@0.151.0
  - @cat-factory/server@0.162.0
  - @cat-factory/gates@0.7.43
  - @cat-factory/integrations@0.103.3
  - @cat-factory/prompt-fragments@0.15.1

## 0.12.14

### Patch Changes

- Updated dependencies [2ed7b50]
  - @cat-factory/server@0.161.0

## 0.12.13

### Patch Changes

- Updated dependencies [cf2779a]
- Updated dependencies [5e5d409]
  - @cat-factory/contracts@0.177.0
  - @cat-factory/prompt-fragments@0.15.0
  - @cat-factory/agents@0.75.0
  - @cat-factory/server@0.160.0
  - @cat-factory/kernel@0.170.0
  - @cat-factory/orchestration@0.150.1
  - @cat-factory/gates@0.7.42
  - @cat-factory/integrations@0.103.2

## 0.12.12

### Patch Changes

- Updated dependencies [1947062]
  - @cat-factory/contracts@0.176.0
  - @cat-factory/kernel@0.169.0
  - @cat-factory/orchestration@0.150.0
  - @cat-factory/server@0.159.0
  - @cat-factory/agents@0.74.1
  - @cat-factory/gates@0.7.41
  - @cat-factory/integrations@0.103.1
  - @cat-factory/prompt-fragments@0.14.24

## 0.12.11

### Patch Changes

- Updated dependencies [fb71506]
  - @cat-factory/agents@0.74.0
  - @cat-factory/server@0.158.0
  - @cat-factory/orchestration@0.149.2

## 0.12.10

### Patch Changes

- Updated dependencies [1c12289]
  - @cat-factory/contracts@0.175.0
  - @cat-factory/kernel@0.168.0
  - @cat-factory/integrations@0.103.0
  - @cat-factory/agents@0.73.2
  - @cat-factory/gates@0.7.40
  - @cat-factory/orchestration@0.149.1
  - @cat-factory/prompt-fragments@0.14.23
  - @cat-factory/server@0.157.3

## 0.12.9

### Patch Changes

- Updated dependencies [55747c5]
  - @cat-factory/contracts@0.174.0
  - @cat-factory/orchestration@0.149.0
  - @cat-factory/agents@0.73.1
  - @cat-factory/gates@0.7.39
  - @cat-factory/integrations@0.102.2
  - @cat-factory/kernel@0.167.1
  - @cat-factory/prompt-fragments@0.14.22
  - @cat-factory/server@0.157.2

## 0.12.8

### Patch Changes

- Updated dependencies [cab85c5]
  - @cat-factory/contracts@0.173.0
  - @cat-factory/agents@0.73.0
  - @cat-factory/kernel@0.167.0
  - @cat-factory/orchestration@0.148.0
  - @cat-factory/server@0.157.1
  - @cat-factory/gates@0.7.38
  - @cat-factory/integrations@0.102.1
  - @cat-factory/prompt-fragments@0.14.21

## 0.12.7

### Patch Changes

- 8afa4ae: Inbound tracker webhooks: push-driven issue intake, and answering a parked requirements review
  from the ticket.

  Two asymmetries in the task-source layer close together, because they share a transport.

  **1. Intake was pull-only.** An issue entered the system when a recurring `bug-intake` schedule
  fired or a human imported it, so intake latency was the schedule interval and every idle poll cost
  a tracker API call. A new receiver — `POST /webhooks/tasks/:source/:workspaceId` — copies the
  GitHub VCS webhook path step for step: verify HMAC over the RAW body before any parse, ack 202
  fast, hand the parsed event to the facade's queue (a Cloudflare Queue on the Worker ⇄ the pg-boss
  `tracker.sync` queue on Node), and fall back to inline handling when neither is bound.

  **2. The question loop was half-duplex.** `postReviewQuestions` already posted a parked review's
  findings onto the linked issue, each with its stable id — but answers could only arrive in-app or
  over `/api/v1/runs/:runId/decisions`, so a reporter who lives in Jira had to switch surfaces.
  Those ids were designed for exactly this reply path; it is now built. This completes slice 2b of
  `docs/initiatives/headless-clarification-loop.md`.

  **A qualifying issue event FIRES the matching schedule; it does not re-implement intake.** The
  tempting shape — "the event names an issue, so import and link it" — forks a second intake path
  that would drift from `BugIntakeService`'s predicate handling, batched dedup, replace-link, pickup
  mark and block seeding. Instead a pure `issueEventMatchesIntake` predicate decides whether the
  event qualifies for a schedule's `issueIntake` config, and a match calls the same `fire` the cron
  sweeper calls. Consequences, all deliberate: the fired run may pick a **different, older** issue
  than the one that triggered it (intake is oldest-first fair queueing — the webhook drains the queue
  promptly, it does not reorder it); overlap protection is inherited, so a burst of deliveries cannot
  start a second run over a parked one; and the trigger is **non-forced**, so an on-demand schedule is
  never webhook-fired and an individual-usage model still refuses — `force` is the human run-now lever
  and a webhook has no human present. The predicate deliberately **fails open** on a field the payload
  omits: a false positive costs one no-op run, a false negative costs silent intake latency.

  **The recurring schedule is unchanged and stays on** as the reconciliation sweep for missed
  deliveries — the same webhook + sweeper duality as GitHub sync + `sweepStuckRuns`. Push is the fast
  path, never the only path.

  **Ticket replies use an explicit grammar, never natural-language guessing:**

  ```
  @cat-factory answer <itemId> <free text to end of line>
  @cat-factory dismiss <itemId>
  @cat-factory proceed | stop | extra-round
  ```

  Only lines whose first token is the trigger are interpreted, so a human can answer and discuss in
  one comment; an `answer` continues onto following lines until the next trigger. A comment with no
  trigger line is ignored entirely. Every mutation routes through the SAME service methods the SPA
  and `PublicDecisionController` call (`RequirementReviewService.replyToItem` / `setItemStatus`, then
  `executionService.requirementsReview.{incorporate,proceed,resolveExceeded}`), so the park's
  CAS/approval-id arbitration and the task's merge-preset knobs apply identically — there is no
  parallel mutation path into the engine. A reply that leaves nothing open auto-incorporates, and the
  issue gets a follow-up comment naming what was applied, what is still outstanding, and what was
  rejected and why.

  **Configuration is per connection and needs no new table.** The webhook secret rides the
  connection's existing sealed credential bag, managed through
  `GET|POST|PATCH|DELETE /workspaces/:ws/task-sources/:source/webhook` (behind `integrations.manage`)
  and returned exactly once. `POST` mints or rotates; `PATCH` edits the reply allow-list WITHOUT
  rotating, because tightening that list is what an operator does when a tracker turns out to be more
  public than they thought and answering it with a silently rotated secret would take deliveries down
  until they re-pasted it into the vendor. The workspace rides the URL path because a tracker delivery carries no
  installation id to resolve one from, and scanning every workspace's connections for one whose
  secret verifies would be a deployment-wide N+1 on every unauthenticated POST. **An unconfigured
  secret fails closed** — an empty HMAC key is one an attacker also has.

  Reply text is untrusted third-party input, and on a public repo anyone can write it. Three layers:
  the platform's own comments are refused first — by the vendor bot flag where there is one, and by
  a structural marker check everywhere, since Linear flags no bots and the default allow-list admits
  any author (an acknowledgement that could re-enter its own ingest is an unbounded comment loop, not
  a duplicate: each carries a fresh comment id, so the ingest claim cannot stop it). Then the
  connection's optional `webhookReplyAllow` list — an
  unauthorized reply is dropped **silently**, with no follow-up, because replying would confirm the
  hook exists and hand an attacker an oracle. Reply text becomes `item.reply`, the same field the SPA
  writes, capped and `redactSecrets`-scrubbed before it persists; the grammar has no verb reaching
  outside the review. Everything rendered back crosses kernel's `hostMarkdown` boundary, exactly like
  the PR verification report.

  Idempotency is an atomic claim on a new `tracker_comment_ingests` table
  (`(workspace, source, externalId, commentId)`, D1 ⇄ Drizzle), taken **before** anything is applied
  — every tracker redelivers and every queue retries, so without it one reporter comment would answer
  the same finding twice. It copies the `review_question_posts` design verbatim, including its answer
  to "what if the claimer dies": a `failed` row is re-claimable, `applied` is terminal, and a
  `pending` one is re-claimable once abandoned. A claim that ERRORS propagates rather than being read
  as "already ingested" — the apply is idempotent precisely so the queue can retry it, and swallowing
  the error would drop a reporter's answer while reporting a successful dedup. Both stores are pinned
  by a new cross-runtime parity
  suite, alongside conformance assertions that drive the whole receiver → gateway → service chain on
  each facade.

  Providers own their vendor parsing behind a new optional `TaskSourceProvider.webhook` capability
  (Jira, Linear and GitHub Issues ship one), exactly as VCS providers own theirs; a source without it
  never receives deliveries. Design, decisions and the per-slice checklist:
  `docs/initiatives/tracker-webhook-intake.md`.

- Updated dependencies [8afa4ae]
  - @cat-factory/contracts@0.172.0
  - @cat-factory/kernel@0.166.0
  - @cat-factory/integrations@0.102.0
  - @cat-factory/orchestration@0.147.0
  - @cat-factory/server@0.157.0
  - @cat-factory/agents@0.72.3
  - @cat-factory/gates@0.7.37
  - @cat-factory/prompt-fragments@0.14.20

## 0.12.6

### Patch Changes

- Updated dependencies [200fb4d]
  - @cat-factory/kernel@0.165.1
  - @cat-factory/server@0.156.2
  - @cat-factory/agents@0.72.2
  - @cat-factory/gates@0.7.36
  - @cat-factory/integrations@0.101.4
  - @cat-factory/orchestration@0.146.2

## 0.12.5

### Patch Changes

- Updated dependencies [323b6cf]
  - @cat-factory/integrations@0.101.3
  - @cat-factory/orchestration@0.146.1
  - @cat-factory/server@0.156.1

## 0.12.4

### Patch Changes

- f0e9bab: Public API (`/api/v1`) Tier 2: a new `GET /jobs` list, and bounded keyset pagination + filters on
  the service-task list.

  - **`GET /api/v1/jobs`** (new, `read`-scoped) lists the workspace's headless initiative jobs,
    newest first, with `?limit=` / `?cursor=` / `?status=` / `?since=`. It closes the gap where an
    integration that lost its stored job ids — a restart, a redeploy — could never re-discover its
    own in-flight runs, since `GET /jobs/:id` needs an id it no longer has. Scoped exactly like the
    single-job read: the `internal`-anchor predicate is applied **in SQL** (a join to the anchor
    block), so an external key can never enumerate the workspace's ordinary board runs.
  - **`GET /api/v1/services/:serviceId/tasks`** gains `?limit=` / `?cursor=` / `?status=`. It was
    previously unbounded: it read the ENTIRE board and filtered the service subtree in JS, so a
    large service returned every task in one response and paid a full board read per request. The
    bound, the subtree and the status filter now all live in SQL.

  **Breaking wire change:** `GET /api/v1/services/:serviceId/tasks` now returns **at most 50 tasks
  per response** (previously: all of them) and carries a new required `nextCursor` field. A caller
  that relied on one response containing every task must now page until `nextCursor` is null.
  `GET /api/v1/jobs`'s default page is 25; both accept `?limit=` up to a hard ceiling of 100.

  Pagination is **keyset, not offset** — an external caller polls, so an offset page shifts under
  concurrent inserts and a row created between two pages either repeats or is skipped and never
  seen again. The cursor is opaque on the wire and carries the `(sortKey, id)` composite, so a burst
  of runs sharing a millisecond pages correctly instead of losing the ties. A malformed cursor is a
  `400 invalid_cursor`, never a silent re-serve of page 1.

  Job ordering is chronological (`created_at DESC`). **Task ordering is by the stable block id, not
  chronological**, and there is deliberately no `since` filter on the task list: the `blocks` table
  carries no creation timestamp, so a time filter would have to be faked. See
  `docs/initiatives/public-api-expansion.md` for what adding one would cost.

  Backed by two new repository port methods — `ExecutionRepository.listInternal` and
  `BlockRepository.listServiceTasks` — implemented on **both** the D1 and Drizzle stores and pinned
  by new cross-runtime conformance assertions, so a store that ordered differently, dropped the
  `internal` join, or mishandled the keyset fails a test rather than silently mis-serving an
  integration. Each resolves its scope in ONE query (the `internal` anchor join; the frame's modules
  as a subquery rather than a bound id list, which D1's 100-parameter ceiling would reject on a
  service with ~96 modules).

  Two adjacent fixes the lists depend on:

  - `ExecutionInstance.createdAt` is now projected from the `agent_runs.created_at` COLUMN instead of
    the run's `detail` JSON, and an insert adopts the instance's own stamp. The two used to be
    separate `clock.now()` calls milliseconds apart, so a keyset cursor minted from the entity named
    a position slightly ahead of the row it pointed at — silently skipping any run inserted in that
    window whenever two starts landed in the same millisecond. The redundant `detail.createdAt` is
    gone (stale copies on existing rows are simply ignored, then dropped on the next write).
  - `BoardService.addTask` now enforces the same containment rule `canReparent` applies on a move: a
    task may only be created under a service frame or a module. A task parented to an `epic` /
    `initiative` grouping node was structurally orphaned — invisible to any reader that resolves a
    service subtree, including this task list.

  The `human-test` / `visual-confirmation` gate step-state schemas moved out of
  `contracts/src/execution.ts` into their own `human-verdict-gates.ts` module (re-exported from the
  package root, so no import path changes): merging `main` pushed `execution.ts` past the file-size
  budget, and the two human-verdict gates are the cohesive seam — they share a `rounds` history and a
  transient `pendingAction` that the polling gates' `GateStepState` does not have.

- Updated dependencies [0f7cba1]
- Updated dependencies [f0e9bab]
  - @cat-factory/orchestration@0.146.0
  - @cat-factory/contracts@0.171.0
  - @cat-factory/kernel@0.165.0
  - @cat-factory/server@0.156.0
  - @cat-factory/agents@0.72.1
  - @cat-factory/gates@0.7.35
  - @cat-factory/integrations@0.101.2
  - @cat-factory/prompt-fragments@0.14.19

## 0.12.3

### Patch Changes

- Updated dependencies [45fddb6]
  - @cat-factory/orchestration@0.145.1
  - @cat-factory/server@0.155.1

## 0.12.2

### Patch Changes

- Updated dependencies [583fc80]
- Updated dependencies [640cadd]
  - @cat-factory/orchestration@0.145.0
  - @cat-factory/contracts@0.170.0
  - @cat-factory/kernel@0.164.0
  - @cat-factory/agents@0.72.0
  - @cat-factory/integrations@0.101.1
  - @cat-factory/server@0.155.0
  - @cat-factory/gates@0.7.34
  - @cat-factory/prompt-fragments@0.14.18

## 0.12.1

### Patch Changes

- Updated dependencies [968a214]
  - @cat-factory/integrations@0.101.0
  - @cat-factory/contracts@0.169.0
  - @cat-factory/server@0.154.0
  - @cat-factory/orchestration@0.144.0
  - @cat-factory/agents@0.71.0
  - @cat-factory/gates@0.7.33
  - @cat-factory/kernel@0.163.1
  - @cat-factory/prompt-fragments@0.14.17

## 0.12.0

### Minor Changes

- 829a905: Add Claude Opus 5 support: the `claude-opus` catalog entry rolls forward from Opus 4.8 to
  Opus 5, with its own spend pricing and an updated OpenRouter recommended slug.

  - `@cat-factory/kernel`: `MODEL_CATALOG`'s `claude-opus` entry now resolves to Anthropic's
    **Claude Opus 5** — subscription ref `anthropic:claude-opus-5` (Claude Code harness, 1M
    context, previously left implicit) and OpenRouter ref `anthropic/claude-opus-5`. This
    mirrors how the entry already tracked the current Opus across 4.6 → 4.7 → 4.8, so a block
    pinned to `claude-opus` picks up Opus 5 with no migration. **Breaking (pre-1.0,
    acceptable):** Opus 4.8 is no longer a curated catalog entry — a workspace that wants it
    specifically reaches it through the dynamic per-workspace OpenRouter catalog.
  - `@cat-factory/kernel`: the built-in `mdp_claude` model preset is renamed to "Claude
    Opus 5" and its catalog `version` bumped to `2`, so existing workspaces get the usual
    reseed advisory for the built-in they still hold under the old name.
  - `@cat-factory/spend`: adds `anthropic:claude-opus-5` and
    `openrouter:anthropic/claude-opus-5` price entries at Opus-tier list price ($5 in / $25
    out per 1M, ~4.6 / 23 EUR). The Opus 4.8 entries are kept so historical spend rows and
    OpenRouter passthroughs still cost correctly.
  - `@cat-factory/app`: "Enable recommended" in the OpenRouter catalog panel now offers
    `anthropic/claude-opus-5` instead of `anthropic/claude-opus-4.8`, matching the curated
    backend refs.
  - `@cat-factory/cli` / `@cat-factory/local-server` / `@cat-factory/orchestration`: picker
    label and doc comments follow the catalog ("Claude Opus 5").
  - `@cat-factory/conformance`: the model-preset suite asserts the new `mdp_claude` catalog
    version.

### Patch Changes

- Updated dependencies [143e6bb]
- Updated dependencies [829a905]
- Updated dependencies [829a905]
  - @cat-factory/orchestration@0.143.1
  - @cat-factory/agents@0.70.1
  - @cat-factory/integrations@0.100.2
  - @cat-factory/kernel@0.163.0
  - @cat-factory/server@0.153.1
  - @cat-factory/gates@0.7.32

## 0.11.76

### Patch Changes

- Updated dependencies [c95600b]
  - @cat-factory/orchestration@0.143.0
  - @cat-factory/contracts@0.168.0
  - @cat-factory/agents@0.70.0
  - @cat-factory/kernel@0.162.0
  - @cat-factory/server@0.153.0
  - @cat-factory/gates@0.7.31
  - @cat-factory/integrations@0.100.1
  - @cat-factory/prompt-fragments@0.14.16

## 0.11.75

### Patch Changes

- df9ca7d: Merge track record: reviewer-effort tags, deterministic change-class classification, and
  per-class auto-merge rules on merge presets.

  The merge decision no longer runs purely on the `merger` agent's self-assessment. Every merge
  decision now persists one row in a new `merge_track_records` table (full D1 ⇄ Drizzle parity)
  carrying the run's **change class**, the merger's scores, the outcome (`pending_review` →
  `auto_merged` / `human_merged` / `external_merged` / `rejected`), and a nullable **reviewer-effort
  tag** (`none` / `minor` / `major`). Per-class rollups are single SQL aggregates behind
  `GET /workspaces/:ws/merge-track-records/rollups`.

  - **Classification** is deterministic backend TypeScript over ONE VCS call (`RepoFiles.listChangedFiles`
    → the pure `classifyChangedFiles`), so it needs no harness change or runner-image bump and works
    identically on a GitLab deployment. Classes are risk-ranked (`docs` < `test` < `dependency` <
    `config` < `source` < `schema`) and a mixed diff takes the highest-ranked class present. An
    unreadable diff yields `unknown`, which never matches a per-class rule.
  - **Per-class rules** on a merge preset: `always` auto-merge, `never` auto-merge, or fall back to the
    score ceilings — resolved with `autoMergeEnabled: false` as the master switch a rule can never
    override.
  - **Effort capture** at the existing decision points: `POST /notifications/:id/act` takes an optional
    `reviewEffort` (one-tap confirm-and-tag, preselected from whether the run's PR review recorded
    findings), `POST /workspaces/:ws/merge-track-records/:id/effort` tags out of band, and a PR merged
    directly on the provider is detected from the webhook ingest and nudged with a dismissible
    `merge_tag_request` card. Tagging is never mandatory: an untagged merge records a null tag.
  - Classification and record writes are **best-effort side channels** — a failure in any part of this
    feature can never fail or block a merge.

  A merge decision's record carries the run's **provider-neutral repo identity** (`repoId` +
  `provider`), captured from the run-repo resolution the classification already performs. That is what
  makes a record attributable: external-merge detection can only look a record up by
  `(repoId, prNumber)`, since a webhook delivery knows nothing else about the run.

  **BREAKING (backend API):** `RepoTarget` (`@cat-factory/server`) and `RunRepoContext`
  (`@cat-factory/kernel`) gain a required `repoId` plus an optional `provider`, in the neutral
  `VcsRepoRef` vocabulary. Both are produced in exactly one place each, so a deployment that builds
  its own `ResolveRepoTarget` / `ResolveRunRepoContext` must supply the id; the compiler points at
  every site.

  A contract route whose request body is ALL-optional now mounts the new `optionalJsonBody`
  middleware (`@cat-factory/server`). A declared `requestBodySchema` otherwise makes the transport
  REQUIRE a body — the validator reads `c.req.json()` before the schema is consulted — so a route that
  merely gained an optional field would start rejecting the body-less calls it had always accepted.
  `POST /blocks/:blockId/merge` and `POST /notifications/:id/act` keep working with no body at all.

  **BREAKING (wire shape):** `RiskPolicy` gains a required `classRules` field (a partial map from
  change class to `thresholds` / `always` / `never`). Per the pre-1.0 policy there is no dual-read
  shim: persisted rows take the `'{}'` column default, which resolves to "use the score ceilings" for
  every class — i.e. byte-for-byte the previous behaviour — but any external consumer of the preset
  wire shape must account for the new field. The built-in preset seeds bump to version 4, so existing
  workspaces are offered a reseed. `notificationTypeSchema` also gains `merge_tag_request`, and
  `MergeDecision.reason` gains `class_auto_merge` / `class_requires_review`; both are closed unions a
  consumer may be switching on exhaustively.

- Updated dependencies [df9ca7d]
  - @cat-factory/contracts@0.167.0
  - @cat-factory/kernel@0.161.0
  - @cat-factory/orchestration@0.142.0
  - @cat-factory/integrations@0.100.0
  - @cat-factory/server@0.152.0
  - @cat-factory/agents@0.69.10
  - @cat-factory/gates@0.7.30
  - @cat-factory/prompt-fragments@0.14.15

## 0.11.74

### Patch Changes

- 600a8ad: Headless clarification loop: questions out to the linked tracker issue (slice 2a). When a run
  started through `/api/v1` parks its requirements review on open findings, its questions can now
  be posted onto the task's linked GitHub/Jira/Linear issue — each rendered with the stable finding
  id that `POST /api/v1/runs/:runId/decisions/requirements/items/:itemId/reply` takes — so the
  clarification reaches whoever requested the work instead of waiting in an inbox nobody headless
  can see.

  Opt-in per workspace via the new `writebackQuestionsOnPark` tracker setting, with the usual
  per-task `trackerQuestionsOnPark` override; both are exposed in the issue-tracker settings panel
  and the task inspector alongside the existing PR-open/PR-merge writeback toggles. Tasks started in
  the app are deliberately unaffected: the echo fires only for runs whose recorded intake origin is
  `public-api`, and their clarification surface remains the in-app review window.

  The post is driven from the durable execution driver, whose steps replay, so it is made idempotent
  by an atomic claim on a new workspace-scoped `review_question_posts` table keyed by
  `(workspace, review, iteration, issue)` — taken before the comment is attempted, so neither a
  replay nor a crash mid-post can double-post onto an issue a human is reading. A failed post is
  recorded with its error and retried on the next replay rather than being swallowed, and a claim
  abandoned by a poster that died mid-post is re-takeable after `REVIEW_QUESTION_POST_CLAIM_TTL_MS`
  so that iteration's questions are not silently lost. The park is committed before the outbound
  call, so a slow or unavailable tracker can never delay the state change that makes the run
  answerable.

  The comment body is model-authored text landing on a host-parsed (often public) surface, so it is
  rendered through the same untrusted-text boundary as the PR verification report — auto-link
  triggers defused so a finding cannot notify a real account or cross-link an unrelated issue, code
  fences balanced, and secrets scrubbed. That boundary moved from `@cat-factory/orchestration` into
  `@cat-factory/kernel` as the `hostMarkdown` namespace to serve both consumers.

  Breaking (pre-1.0, no migration): `TrackerSettings` gains a required `writebackQuestionsOnPark`
  field and `IssueWritebackProvider` gains a required `postReviewQuestions` method, so a deployment
  with its own implementation of either must add them; `ReviewQuestionPostRepository.claim` takes a
  claim window rather than a bare timestamp; and the `commentOnGitHubIssue` writeback seam must now
  THROW when it cannot resolve the target issue instead of returning quietly (returning is the
  seam's promise that the comment landed). New tables/columns are created by the Cloudflare D1
  migration `0062` and the generated Node Drizzle migration.

- Updated dependencies [600a8ad]
  - @cat-factory/kernel@0.160.0
  - @cat-factory/contracts@0.166.0
  - @cat-factory/integrations@0.99.0
  - @cat-factory/orchestration@0.141.0
  - @cat-factory/server@0.151.0
  - @cat-factory/agents@0.69.9
  - @cat-factory/gates@0.7.29
  - @cat-factory/prompt-fragments@0.14.14

## 0.11.73

### Patch Changes

- Updated dependencies [3949f82]
  - @cat-factory/contracts@0.165.0
  - @cat-factory/integrations@0.98.0
  - @cat-factory/server@0.150.0
  - @cat-factory/agents@0.69.8
  - @cat-factory/gates@0.7.28
  - @cat-factory/kernel@0.159.1
  - @cat-factory/orchestration@0.140.1
  - @cat-factory/prompt-fragments@0.14.13

## 0.11.72

### Patch Changes

- Updated dependencies [1f8ca48]
  - @cat-factory/kernel@0.159.0
  - @cat-factory/integrations@0.97.0
  - @cat-factory/orchestration@0.140.0
  - @cat-factory/agents@0.69.7
  - @cat-factory/gates@0.7.27
  - @cat-factory/server@0.149.1

## 0.11.71

### Patch Changes

- Updated dependencies [5a58b9d]
  - @cat-factory/contracts@0.164.0
  - @cat-factory/kernel@0.158.0
  - @cat-factory/integrations@0.96.0
  - @cat-factory/orchestration@0.139.0
  - @cat-factory/server@0.149.0
  - @cat-factory/agents@0.69.6
  - @cat-factory/gates@0.7.26
  - @cat-factory/prompt-fragments@0.14.12

## 0.11.70

### Patch Changes

- 55e0a85: Headless clarification loop over the public API (slice 1). A run started through `/api/v1`
  can now include the requirements-review loop instead of being refused at admission: a new
  `/api/v1/runs/:runId/decisions` surface lists a run's parked human decisions (review findings
  with stable item ids, iteration/cap, the incorporated document; the proposed implementation
  forks) and answers them — reply, dismiss, incorporate, re-review, proceed, resolve-exceeded,
  choose a fork. Every route delegates to the SAME service methods the SPA controllers call, so
  the park's optimistic-concurrency arbitration and the task's merge-preset knobs apply
  identically whichever surface answers first.

  **Breaking:** the public-API scope ladder gains a `decide` rung between `write` and `admin`
  (`read ⊂ write ⊂ decide ⊂ admin`). Answering a parked decision — and starting a headless run
  on a pipeline that can park at all — requires it; a `write` key sees exactly the previous
  behaviour, refusal included. Existing keys keep their stored scope, so a `write` key that
  should now answer decisions must be re-minted as `decide`.

  Also in this slice: `POST /api/v1/jobs/:id/cancel` (an abandoned park can always be cleared,
  so the in-flight cap stays recoverable — there is deliberately no run-killing park timeout);
  a `decision` frame on both public SSE streams, which now stay open across a park; a new
  per-workspace outbound **notification webhook** (`GET|PUT|DELETE
/workspaces/:ws/notification-webhook`) delivered HMAC-signed as a `NotificationChannel`
  alongside in-app and Slack, so a headless caller learns of a park by push rather than
  polling; and `ExecutionInstance.intakeOrigin` (`ui` | `public-api`), recorded so slice 2 can
  push clarification questions to a tracker issue for headless-origin runs only. A UI-started
  task's behaviour is unchanged throughout.

  The webhook endpoint is held to the same SSRF guard as the other operator-supplied-URL
  integrations, at both boundaries: registration rejects a private/internal/cloud-metadata host,
  and delivery goes through the shared `safeFetch` so the guard re-runs on every redirect hop
  (a public endpoint cannot 302 the signed body at an internal target). Two new optional env
  vars, `NOTIFICATION_WEBHOOK_ALLOW_URL_HOSTS` / `NOTIFICATION_WEBHOOK_ALLOW_HTTP_URLS`, widen
  it for a receiver on an internal host or a developer's `localhost`; they are scoped to
  webhooks alone, so they never widen the runner-pool or environment guard. One delivery is
  bounded by a total wall-clock budget rather than an attempt count, because the notification
  fan-out is awaited by the engine step that raises it. The webhook counts as an EXTERNAL
  notification channel, so under mothership mode the mothership — which holds the key its
  signing secret is sealed with — is the side that delivers it.

  Also exported: `assertSafePublicUrl`, the provider-neutral URL guard now shared by the
  environment, runner-pool and notification-webhook integrations (previously an
  environment-labelled private function), so an SSRF bypass is fixed in one place for all of
  them.

  See `docs/initiatives/headless-clarification-loop.md`.

- Updated dependencies [ddcdcd8]
- Updated dependencies [55e0a85]
  - @cat-factory/orchestration@0.138.0
  - @cat-factory/kernel@0.157.0
  - @cat-factory/contracts@0.163.0
  - @cat-factory/integrations@0.95.0
  - @cat-factory/server@0.148.0
  - @cat-factory/agents@0.69.5
  - @cat-factory/gates@0.7.25
  - @cat-factory/prompt-fragments@0.14.11

## 0.11.69

### Patch Changes

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

- Updated dependencies [ecd68c5]
  - @cat-factory/contracts@0.162.0
  - @cat-factory/kernel@0.156.0
  - @cat-factory/orchestration@0.137.0
  - @cat-factory/server@0.147.0
  - @cat-factory/agents@0.69.4
  - @cat-factory/gates@0.7.24
  - @cat-factory/integrations@0.94.1
  - @cat-factory/prompt-fragments@0.14.10

## 0.11.68

### Patch Changes

- Updated dependencies [16c98f3]
  - @cat-factory/server@0.146.0

## 0.11.67

### Patch Changes

- Updated dependencies [1ffa4fe]
  - @cat-factory/orchestration@0.136.1
  - @cat-factory/server@0.145.1

## 0.11.66

### Patch Changes

- 7c6bd77: Per-workspace GitLab PAT connect flow (backend, GitLab UI-parity slice 2a). A hosted
  deployment can now connect a workspace to GitLab by pasting a personal access token: the
  token is validated against the account's identity, sealed at rest (a new `access_token`
  column on `github_installations`, mirrored across D1 + Drizzle), and the workspace's repos
  are browsed / linked / synced through the SAME GitHub-shaped projection surface. A new
  `ProviderRoutingGitHubClient` routes each installation-keyed call to the App or GitLab client
  by the connection's stored provider, so a deployment can serve GitHub App and GitLab PAT
  workspaces side by side. New endpoints: `GET|POST|DELETE /workspaces/:ws/gitlab/connection`
  (503 until GitLab connect is wired). The connect UI is a follow-up slice.
- Updated dependencies [7c6bd77]
  - @cat-factory/kernel@0.155.0
  - @cat-factory/contracts@0.161.0
  - @cat-factory/integrations@0.94.0
  - @cat-factory/server@0.145.0
  - @cat-factory/orchestration@0.136.0
  - @cat-factory/agents@0.69.3
  - @cat-factory/gates@0.7.23
  - @cat-factory/prompt-fragments@0.14.9

## 0.11.65

### Patch Changes

- Updated dependencies [0e2799e]
- Updated dependencies [696da88]
- Updated dependencies [239788a]
  - @cat-factory/kernel@0.154.2
  - @cat-factory/server@0.144.6
  - @cat-factory/gates@0.7.22
  - @cat-factory/integrations@0.93.0
  - @cat-factory/agents@0.69.2
  - @cat-factory/contracts@0.160.1
  - @cat-factory/orchestration@0.135.5
  - @cat-factory/prompt-fragments@0.14.8

## 0.11.64

### Patch Changes

- Updated dependencies [770f926]
  - @cat-factory/agents@0.69.1
  - @cat-factory/integrations@0.92.1
  - @cat-factory/kernel@0.154.1
  - @cat-factory/orchestration@0.135.4
  - @cat-factory/server@0.144.5
  - @cat-factory/gates@0.7.21

## 0.11.63

### Patch Changes

- Updated dependencies [ad4c999]
  - @cat-factory/server@0.144.4

## 0.11.62

### Patch Changes

- Updated dependencies [4ceb622]
  - @cat-factory/orchestration@0.135.3
  - @cat-factory/server@0.144.3

## 0.11.61

### Patch Changes

- Updated dependencies [45f21eb]
  - @cat-factory/orchestration@0.135.2
  - @cat-factory/server@0.144.2

## 0.11.60

### Patch Changes

- Updated dependencies [ce1ce11]
  - @cat-factory/agents@0.69.0
  - @cat-factory/server@0.144.1
  - @cat-factory/orchestration@0.135.1

## 0.11.59

### Patch Changes

- Updated dependencies [93496b0]
  - @cat-factory/kernel@0.154.0
  - @cat-factory/contracts@0.160.0
  - @cat-factory/orchestration@0.135.0
  - @cat-factory/integrations@0.92.0
  - @cat-factory/server@0.144.0
  - @cat-factory/agents@0.68.4
  - @cat-factory/gates@0.7.20
  - @cat-factory/prompt-fragments@0.14.7

## 0.11.58

### Patch Changes

- Updated dependencies [15249df]
  - @cat-factory/contracts@0.159.0
  - @cat-factory/kernel@0.153.0
  - @cat-factory/orchestration@0.134.0
  - @cat-factory/agents@0.68.3
  - @cat-factory/gates@0.7.19
  - @cat-factory/integrations@0.91.2
  - @cat-factory/prompt-fragments@0.14.6
  - @cat-factory/server@0.143.2

## 0.11.57

### Patch Changes

- Updated dependencies [8254367]
  - @cat-factory/orchestration@0.133.2
  - @cat-factory/integrations@0.91.1
  - @cat-factory/server@0.143.1
  - @cat-factory/agents@0.68.2

## 0.11.56

### Patch Changes

- Updated dependencies [2323df1]
  - @cat-factory/contracts@0.158.0
  - @cat-factory/kernel@0.152.0
  - @cat-factory/integrations@0.91.0
  - @cat-factory/server@0.143.0
  - @cat-factory/agents@0.68.1
  - @cat-factory/gates@0.7.18
  - @cat-factory/orchestration@0.133.1
  - @cat-factory/prompt-fragments@0.14.5

## 0.11.55

### Patch Changes

- Updated dependencies [71bd63f]
  - @cat-factory/contracts@0.157.0
  - @cat-factory/kernel@0.151.0
  - @cat-factory/agents@0.68.0
  - @cat-factory/orchestration@0.133.0
  - @cat-factory/server@0.142.0
  - @cat-factory/integrations@0.90.0
  - @cat-factory/prompt-fragments@0.14.4
  - @cat-factory/gates@0.7.17

## 0.11.54

### Patch Changes

- Updated dependencies [da0b83b]
  - @cat-factory/agents@0.67.9
  - @cat-factory/orchestration@0.132.3
  - @cat-factory/server@0.141.3

## 0.11.53

### Patch Changes

- Updated dependencies [2cfae1e]
  - @cat-factory/server@0.141.2
  - @cat-factory/orchestration@0.132.2
  - @cat-factory/agents@0.67.8

## 0.11.52

### Patch Changes

- Updated dependencies [3c7d62b]
- Updated dependencies [3c7d62b]
- Updated dependencies [3c7d62b]
  - @cat-factory/contracts@0.156.0
  - @cat-factory/integrations@0.89.0
  - @cat-factory/kernel@0.150.0
  - @cat-factory/agents@0.67.7
  - @cat-factory/gates@0.7.16
  - @cat-factory/orchestration@0.132.1
  - @cat-factory/prompt-fragments@0.14.3
  - @cat-factory/server@0.141.1

## 0.11.51

### Patch Changes

- Updated dependencies [916278b]
  - @cat-factory/contracts@0.155.0
  - @cat-factory/kernel@0.149.0
  - @cat-factory/orchestration@0.132.0
  - @cat-factory/server@0.141.0
  - @cat-factory/agents@0.67.6
  - @cat-factory/gates@0.7.15
  - @cat-factory/integrations@0.88.18
  - @cat-factory/prompt-fragments@0.14.2

## 0.11.50

### Patch Changes

- Updated dependencies [1bcb223]
  - @cat-factory/kernel@0.148.5
  - @cat-factory/server@0.140.7
  - @cat-factory/agents@0.67.5
  - @cat-factory/gates@0.7.14
  - @cat-factory/integrations@0.88.17
  - @cat-factory/orchestration@0.131.7

## 0.11.49

### Patch Changes

- Updated dependencies [e86e95b]
  - @cat-factory/orchestration@0.131.6
  - @cat-factory/server@0.140.6

## 0.11.48

### Patch Changes

- Updated dependencies [91ea6b7]
  - @cat-factory/contracts@0.154.2
  - @cat-factory/kernel@0.148.4
  - @cat-factory/server@0.140.5
  - @cat-factory/orchestration@0.131.5
  - @cat-factory/integrations@0.88.16
  - @cat-factory/agents@0.67.4
  - @cat-factory/gates@0.7.13
  - @cat-factory/prompt-fragments@0.14.1

## 0.11.47

### Patch Changes

- Updated dependencies [3999941]
  - @cat-factory/kernel@0.148.3
  - @cat-factory/agents@0.67.3
  - @cat-factory/server@0.140.4
  - @cat-factory/gates@0.7.12
  - @cat-factory/integrations@0.88.15
  - @cat-factory/orchestration@0.131.4

## 0.11.46

### Patch Changes

- Updated dependencies [b1d1e2c]
  - @cat-factory/prompt-fragments@0.14.0
  - @cat-factory/orchestration@0.131.3
  - @cat-factory/agents@0.67.2
  - @cat-factory/server@0.140.3

## 0.11.45

### Patch Changes

- Updated dependencies [021f2a0]
- Updated dependencies [021f2a0]
  - @cat-factory/contracts@0.154.1
  - @cat-factory/kernel@0.148.2
  - @cat-factory/server@0.140.2
  - @cat-factory/integrations@0.88.14
  - @cat-factory/agents@0.67.1
  - @cat-factory/gates@0.7.11
  - @cat-factory/orchestration@0.131.2
  - @cat-factory/prompt-fragments@0.13.48

## 0.11.44

### Patch Changes

- Updated dependencies [90a0c1b]
  - @cat-factory/orchestration@0.131.1
  - @cat-factory/server@0.140.1

## 0.11.43

### Patch Changes

- Updated dependencies [a14fe03]
  - @cat-factory/contracts@0.154.0
  - @cat-factory/agents@0.67.0
  - @cat-factory/orchestration@0.131.0
  - @cat-factory/server@0.140.0
  - @cat-factory/gates@0.7.10
  - @cat-factory/integrations@0.88.13
  - @cat-factory/kernel@0.148.1
  - @cat-factory/prompt-fragments@0.13.47

## 0.11.42

### Patch Changes

- Updated dependencies [8053837]
  - @cat-factory/orchestration@0.130.0
  - @cat-factory/contracts@0.153.0
  - @cat-factory/kernel@0.148.0
  - @cat-factory/server@0.139.0
  - @cat-factory/agents@0.66.7
  - @cat-factory/gates@0.7.9
  - @cat-factory/integrations@0.88.12
  - @cat-factory/prompt-fragments@0.13.46

## 0.11.41

### Patch Changes

- Updated dependencies [511076d]
  - @cat-factory/kernel@0.147.3
  - @cat-factory/server@0.138.16
  - @cat-factory/agents@0.66.6
  - @cat-factory/gates@0.7.8
  - @cat-factory/integrations@0.88.11
  - @cat-factory/orchestration@0.129.11

## 0.11.40

### Patch Changes

- Updated dependencies [1614e62]
  - @cat-factory/agents@0.66.5
  - @cat-factory/orchestration@0.129.10
  - @cat-factory/server@0.138.15

## 0.11.39

### Patch Changes

- Updated dependencies [7f54858]
  - @cat-factory/contracts@0.152.2
  - @cat-factory/kernel@0.147.2
  - @cat-factory/server@0.138.14
  - @cat-factory/orchestration@0.129.9
  - @cat-factory/agents@0.66.4
  - @cat-factory/gates@0.7.7
  - @cat-factory/integrations@0.88.10
  - @cat-factory/prompt-fragments@0.13.45

## 0.11.38

### Patch Changes

- Updated dependencies [26f7c18]
  - @cat-factory/server@0.138.13
  - @cat-factory/orchestration@0.129.8
  - @cat-factory/integrations@0.88.9

## 0.11.37

### Patch Changes

- Updated dependencies [e4efb5f]
  - @cat-factory/server@0.138.12
  - @cat-factory/orchestration@0.129.7

## 0.11.36

### Patch Changes

- Updated dependencies [972a1bd]
  - @cat-factory/orchestration@0.129.6
  - @cat-factory/integrations@0.88.8
  - @cat-factory/agents@0.66.3
  - @cat-factory/server@0.138.11

## 0.11.35

### Patch Changes

- Updated dependencies [492d0a2]
  - @cat-factory/kernel@0.147.1
  - @cat-factory/integrations@0.88.7
  - @cat-factory/agents@0.66.2
  - @cat-factory/gates@0.7.6
  - @cat-factory/orchestration@0.129.5
  - @cat-factory/server@0.138.10

## 0.11.34

### Patch Changes

- Updated dependencies [2d97b16]
  - @cat-factory/orchestration@0.129.4
  - @cat-factory/agents@0.66.1
  - @cat-factory/server@0.138.9

## 0.11.33

### Patch Changes

- Updated dependencies [8b6fa53]
  - @cat-factory/orchestration@0.129.3
  - @cat-factory/server@0.138.8

## 0.11.32

### Patch Changes

- Updated dependencies [a10bfdf]
- Updated dependencies [a10bfdf]
  - @cat-factory/server@0.138.7
  - @cat-factory/kernel@0.147.0
  - @cat-factory/agents@0.66.0
  - @cat-factory/orchestration@0.129.2
  - @cat-factory/gates@0.7.5
  - @cat-factory/integrations@0.88.6

## 0.11.31

### Patch Changes

- Updated dependencies [7aab031]
  - @cat-factory/orchestration@0.129.1
  - @cat-factory/agents@0.65.5
  - @cat-factory/server@0.138.6

## 0.11.30

### Patch Changes

- Updated dependencies [f2b25ba]
  - @cat-factory/orchestration@0.129.0
  - @cat-factory/kernel@0.146.0
  - @cat-factory/contracts@0.152.1
  - @cat-factory/server@0.138.5
  - @cat-factory/agents@0.65.4
  - @cat-factory/gates@0.7.4
  - @cat-factory/integrations@0.88.5
  - @cat-factory/prompt-fragments@0.13.44

## 0.11.29

### Patch Changes

- Updated dependencies [e679977]
  - @cat-factory/contracts@0.152.0
  - @cat-factory/orchestration@0.128.0
  - @cat-factory/agents@0.65.3
  - @cat-factory/gates@0.7.3
  - @cat-factory/integrations@0.88.4
  - @cat-factory/kernel@0.145.1
  - @cat-factory/prompt-fragments@0.13.43
  - @cat-factory/server@0.138.4

## 0.11.28

### Patch Changes

- Updated dependencies [9450415]
  - @cat-factory/contracts@0.151.0
  - @cat-factory/kernel@0.145.0
  - @cat-factory/orchestration@0.127.0
  - @cat-factory/agents@0.65.2
  - @cat-factory/gates@0.7.2
  - @cat-factory/integrations@0.88.3
  - @cat-factory/prompt-fragments@0.13.42
  - @cat-factory/server@0.138.3

## 0.11.27

### Patch Changes

- Updated dependencies [2138e45]
  - @cat-factory/integrations@0.88.2
  - @cat-factory/orchestration@0.126.1
  - @cat-factory/server@0.138.2

## 0.11.26

### Patch Changes

- Updated dependencies [54c44bb]
  - @cat-factory/contracts@0.150.0
  - @cat-factory/kernel@0.144.0
  - @cat-factory/orchestration@0.126.0
  - @cat-factory/server@0.138.1
  - @cat-factory/agents@0.65.1
  - @cat-factory/gates@0.7.1
  - @cat-factory/integrations@0.88.1
  - @cat-factory/prompt-fragments@0.13.41

## 0.11.25

### Patch Changes

- 0abcf31: Add an authored `description` to pipelines and preview a pipeline's steps + description when
  selecting one.

  Pipelines now carry an optional prose `description` (seeded for every built-in, editable on custom
  pipelines in the builder), persisted alongside the step list on both runtimes (D1 + Postgres). The
  pipeline pickers — in the add-task modal and the inspector run settings — are replaced with a rich
  master–detail picker: hovering an option reveals that pipeline's description and its ordered agent
  steps (with human-gated steps flagged), so you can see exactly what a pipeline does before choosing
  it.

  Every built-in pipeline's catalog `version` is bumped by one so existing workspaces are offered a
  reseed that adopts the new descriptions (fresh workspaces get them on seed).

- Updated dependencies [009bc97]
- Updated dependencies [0abcf31]
- Updated dependencies [6709dc4]
- Updated dependencies [a53bbf7]
  - @cat-factory/integrations@0.88.0
  - @cat-factory/server@0.138.0
  - @cat-factory/contracts@0.149.0
  - @cat-factory/kernel@0.143.0
  - @cat-factory/orchestration@0.125.0
  - @cat-factory/agents@0.65.0
  - @cat-factory/gates@0.7.0
  - @cat-factory/prompt-fragments@0.13.40

## 0.11.24

### Patch Changes

- Updated dependencies [4dbf0fc]
  - @cat-factory/orchestration@0.124.2
  - @cat-factory/server@0.137.10

## 0.11.23

### Patch Changes

- Updated dependencies [5771e05]
  - @cat-factory/kernel@0.142.0
  - @cat-factory/integrations@0.87.0
  - @cat-factory/agents@0.64.2
  - @cat-factory/gates@0.6.1
  - @cat-factory/orchestration@0.124.1
  - @cat-factory/server@0.137.9

## 0.11.22

### Patch Changes

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0
  - @cat-factory/gates@0.6.0
  - @cat-factory/orchestration@0.124.0
  - @cat-factory/agents@0.64.1
  - @cat-factory/integrations@0.86.6
  - @cat-factory/server@0.137.8

## 0.11.21

### Patch Changes

- Updated dependencies [37c642f]
  - @cat-factory/agents@0.64.0
  - @cat-factory/server@0.137.7
  - @cat-factory/orchestration@0.123.8

## 0.11.20

### Patch Changes

- Updated dependencies [ea64461]
  - @cat-factory/agents@0.63.0
  - @cat-factory/server@0.137.6
  - @cat-factory/orchestration@0.123.7

## 0.11.19

### Patch Changes

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1
  - @cat-factory/integrations@0.86.5
  - @cat-factory/orchestration@0.123.6
  - @cat-factory/server@0.137.5
  - @cat-factory/agents@0.62.13
  - @cat-factory/gates@0.5.58

## 0.11.18

### Patch Changes

- Updated dependencies [edfd2f8]
- Updated dependencies [d675cc5]
  - @cat-factory/orchestration@0.123.5
  - @cat-factory/server@0.137.4

## 0.11.17

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0
  - @cat-factory/orchestration@0.123.4
  - @cat-factory/contracts@0.148.1
  - @cat-factory/agents@0.62.12
  - @cat-factory/gates@0.5.57
  - @cat-factory/integrations@0.86.4
  - @cat-factory/server@0.137.3
  - @cat-factory/prompt-fragments@0.13.39

## 0.11.16

### Patch Changes

- Updated dependencies [efa3345]
  - @cat-factory/agents@0.62.11
  - @cat-factory/integrations@0.86.3
  - @cat-factory/kernel@0.139.3
  - @cat-factory/orchestration@0.123.3
  - @cat-factory/server@0.137.2
  - @cat-factory/gates@0.5.56

## 0.11.15

### Patch Changes

- Updated dependencies [1f5f5bc]
  - @cat-factory/contracts@0.148.0
  - @cat-factory/orchestration@0.123.2
  - @cat-factory/agents@0.62.10
  - @cat-factory/gates@0.5.55
  - @cat-factory/integrations@0.86.2
  - @cat-factory/kernel@0.139.2
  - @cat-factory/prompt-fragments@0.13.38
  - @cat-factory/server@0.137.1

## 0.11.14

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/server@0.137.0
  - @cat-factory/contracts@0.147.1
  - @cat-factory/kernel@0.139.1
  - @cat-factory/integrations@0.86.1
  - @cat-factory/agents@0.62.9
  - @cat-factory/gates@0.5.54
  - @cat-factory/orchestration@0.123.1
  - @cat-factory/prompt-fragments@0.13.37

## 0.11.13

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/contracts@0.147.0
  - @cat-factory/kernel@0.139.0
  - @cat-factory/orchestration@0.123.0
  - @cat-factory/integrations@0.86.0
  - @cat-factory/server@0.136.0
  - @cat-factory/agents@0.62.8
  - @cat-factory/gates@0.5.53
  - @cat-factory/prompt-fragments@0.13.36

## 0.11.12

### Patch Changes

- Updated dependencies [60c0a1e]
- Updated dependencies [f444062]
  - @cat-factory/contracts@0.146.0
  - @cat-factory/orchestration@0.122.0
  - @cat-factory/integrations@0.85.4
  - @cat-factory/server@0.135.0
  - @cat-factory/agents@0.62.7
  - @cat-factory/gates@0.5.52
  - @cat-factory/kernel@0.138.1
  - @cat-factory/prompt-fragments@0.13.35

## 0.11.11

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/contracts@0.145.0
  - @cat-factory/orchestration@0.121.0
  - @cat-factory/server@0.134.0
  - @cat-factory/kernel@0.138.0
  - @cat-factory/agents@0.62.6
  - @cat-factory/gates@0.5.51
  - @cat-factory/integrations@0.85.3
  - @cat-factory/prompt-fragments@0.13.34

## 0.11.10

### Patch Changes

- Updated dependencies [5924903]
  - @cat-factory/contracts@0.144.0
  - @cat-factory/server@0.133.0
  - @cat-factory/agents@0.62.5
  - @cat-factory/gates@0.5.50
  - @cat-factory/integrations@0.85.2
  - @cat-factory/kernel@0.137.1
  - @cat-factory/orchestration@0.120.2
  - @cat-factory/prompt-fragments@0.13.33

## 0.11.9

### Patch Changes

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0
  - @cat-factory/server@0.132.0
  - @cat-factory/agents@0.62.4
  - @cat-factory/integrations@0.85.1
  - @cat-factory/orchestration@0.120.1
  - @cat-factory/gates@0.5.49

## 0.11.8

### Patch Changes

- Updated dependencies [27f0ea2]
  - @cat-factory/orchestration@0.120.0
  - @cat-factory/server@0.131.0

## 0.11.7

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/contracts@0.143.0
  - @cat-factory/kernel@0.136.0
  - @cat-factory/integrations@0.85.0
  - @cat-factory/server@0.130.0
  - @cat-factory/orchestration@0.119.0
  - @cat-factory/agents@0.62.3
  - @cat-factory/gates@0.5.48
  - @cat-factory/prompt-fragments@0.13.32

## 0.11.6

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0
  - @cat-factory/contracts@0.142.0
  - @cat-factory/orchestration@0.118.0
  - @cat-factory/agents@0.62.2
  - @cat-factory/gates@0.5.47
  - @cat-factory/integrations@0.84.12
  - @cat-factory/server@0.129.2
  - @cat-factory/prompt-fragments@0.13.31

## 0.11.5

### Patch Changes

- Updated dependencies [e618bf5]
  - @cat-factory/contracts@0.141.0
  - @cat-factory/server@0.129.1
  - @cat-factory/agents@0.62.1
  - @cat-factory/gates@0.5.46
  - @cat-factory/integrations@0.84.11
  - @cat-factory/kernel@0.134.1
  - @cat-factory/orchestration@0.117.1
  - @cat-factory/prompt-fragments@0.13.30

## 0.11.4

### Patch Changes

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/contracts@0.140.0
  - @cat-factory/kernel@0.134.0
  - @cat-factory/agents@0.62.0
  - @cat-factory/orchestration@0.117.0
  - @cat-factory/server@0.129.0
  - @cat-factory/integrations@0.84.10
  - @cat-factory/gates@0.5.45
  - @cat-factory/prompt-fragments@0.13.29

## 0.11.3

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0
  - @cat-factory/contracts@0.139.0
  - @cat-factory/orchestration@0.116.0
  - @cat-factory/server@0.128.0
  - @cat-factory/agents@0.61.2
  - @cat-factory/gates@0.5.44
  - @cat-factory/integrations@0.84.9
  - @cat-factory/prompt-fragments@0.13.28

## 0.11.2

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/contracts@0.138.0
  - @cat-factory/kernel@0.132.0
  - @cat-factory/server@0.127.1
  - @cat-factory/agents@0.61.1
  - @cat-factory/gates@0.5.43
  - @cat-factory/integrations@0.84.8
  - @cat-factory/orchestration@0.115.1
  - @cat-factory/prompt-fragments@0.13.27

## 0.11.1

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/kernel@0.131.0
  - @cat-factory/contracts@0.137.0
  - @cat-factory/agents@0.61.0
  - @cat-factory/orchestration@0.115.0
  - @cat-factory/server@0.127.0
  - @cat-factory/gates@0.5.42
  - @cat-factory/integrations@0.84.7
  - @cat-factory/prompt-fragments@0.13.26

## 0.11.0

### Minor Changes

- 1869ad3: Add a "Ralph loop" task type: a persistent retry-until-done coding loop whose exit condition is
  a programmatic validation command the harness runs against the checkout (exit 0 = done), bounded
  by a per-task iteration budget and surviving restarts.

  Each iteration is a fresh-context container-coding run that works the task spec; the harness then
  runs the task's configured `ralph.validationCommand` (bounded timeout, redacted output tail) and
  reports the verdict on the run result — never a model self-report. The engine (`RalphController` +
  a `ralph-verdict` step-completion interceptor, modelled on the Tester→Fixer loop) re-dispatches a
  fresh iteration on a failing verdict until it passes or the `ralph.maxIterations` budget (default 10) is spent, then hands off to a human. Loop state rides the persisted `step.ralph` (no
  migration), so a mid-loop run is re-driven from where it was by both durable drivers + sweepers.

  - New `ralph` agent kind (the reusable loop-body primitive) + the `pl_ralph` pipeline
    (`ralph → conflicts → ci → merger`) + a `ralph` task type (a one-click creation entry point).
  - The validation command + iteration budget are per-task agent config; `AgentConfigDescriptor`
    gained `text`/`number` control types for them.
  - Cross-runtime conformance coverage (loop completes / exhausts / refuses to start unconfigured)
    and pure-logic unit tests.

  Breaking: none (pre-1.0; `taskType` / `step.ralph` / the descriptor types are additive). The
  executor-harness image is bumped for the new in-container validation capability.

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/contracts@0.136.0
  - @cat-factory/kernel@0.130.0
  - @cat-factory/agents@0.60.0
  - @cat-factory/server@0.126.0
  - @cat-factory/orchestration@0.114.0
  - @cat-factory/gates@0.5.41
  - @cat-factory/integrations@0.84.6
  - @cat-factory/prompt-fragments@0.13.25

## 0.10.134

### Patch Changes

- Updated dependencies [06a094a]
  - @cat-factory/contracts@0.135.0
  - @cat-factory/server@0.125.0
  - @cat-factory/agents@0.59.2
  - @cat-factory/gates@0.5.40
  - @cat-factory/integrations@0.84.5
  - @cat-factory/kernel@0.129.2
  - @cat-factory/orchestration@0.113.2
  - @cat-factory/prompt-fragments@0.13.24

## 0.10.133

### Patch Changes

- Updated dependencies [6dc444e]
  - @cat-factory/server@0.124.0

## 0.10.132

### Patch Changes

- Updated dependencies [bd0a42a]
  - @cat-factory/server@0.123.1

## 0.10.131

### Patch Changes

- Updated dependencies [745de02]
- Updated dependencies [6108525]
  - @cat-factory/server@0.123.0
  - @cat-factory/orchestration@0.113.1
  - @cat-factory/kernel@0.129.1
  - @cat-factory/agents@0.59.1
  - @cat-factory/gates@0.5.39
  - @cat-factory/integrations@0.84.4

## 0.10.130

### Patch Changes

- Updated dependencies [1b90387]
  - @cat-factory/server@0.122.0

## 0.10.129

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/agents@0.59.0
  - @cat-factory/kernel@0.129.0
  - @cat-factory/contracts@0.134.0
  - @cat-factory/orchestration@0.113.0
  - @cat-factory/server@0.121.0
  - @cat-factory/gates@0.5.38
  - @cat-factory/integrations@0.84.3
  - @cat-factory/prompt-fragments@0.13.23

## 0.10.128

### Patch Changes

- Updated dependencies [9e9127f]
  - @cat-factory/contracts@0.133.0
  - @cat-factory/orchestration@0.112.0
  - @cat-factory/server@0.120.0
  - @cat-factory/agents@0.58.1
  - @cat-factory/gates@0.5.37
  - @cat-factory/integrations@0.84.2
  - @cat-factory/kernel@0.128.1
  - @cat-factory/prompt-fragments@0.13.22

## 0.10.127

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0
  - @cat-factory/server@0.119.0
  - @cat-factory/contracts@0.132.0
  - @cat-factory/agents@0.58.0
  - @cat-factory/orchestration@0.111.0
  - @cat-factory/gates@0.5.36
  - @cat-factory/integrations@0.84.1
  - @cat-factory/prompt-fragments@0.13.21

## 0.10.126

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/contracts@0.131.0
  - @cat-factory/kernel@0.127.0
  - @cat-factory/agents@0.57.0
  - @cat-factory/orchestration@0.110.0
  - @cat-factory/integrations@0.84.0
  - @cat-factory/server@0.118.0
  - @cat-factory/gates@0.5.35
  - @cat-factory/prompt-fragments@0.13.20

## 0.10.125

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/contracts@0.130.0
  - @cat-factory/kernel@0.126.0
  - @cat-factory/agents@0.56.0
  - @cat-factory/orchestration@0.109.0
  - @cat-factory/server@0.117.0
  - @cat-factory/gates@0.5.34
  - @cat-factory/integrations@0.83.3
  - @cat-factory/prompt-fragments@0.13.19

## 0.10.124

### Patch Changes

- Updated dependencies [d38d6c2]
  - @cat-factory/integrations@0.83.2
  - @cat-factory/orchestration@0.108.1
  - @cat-factory/server@0.116.1

## 0.10.123

### Patch Changes

- Updated dependencies [f7e7139]
- Updated dependencies [5fa0a8e]
  - @cat-factory/contracts@0.129.0
  - @cat-factory/kernel@0.125.0
  - @cat-factory/agents@0.55.0
  - @cat-factory/orchestration@0.108.0
  - @cat-factory/server@0.116.0
  - @cat-factory/integrations@0.83.1
  - @cat-factory/gates@0.5.33
  - @cat-factory/prompt-fragments@0.13.18

## 0.10.122

### Patch Changes

- Updated dependencies [3f3031a]
  - @cat-factory/orchestration@0.107.10
  - @cat-factory/server@0.115.1

## 0.10.121

### Patch Changes

- Updated dependencies [ca9ea20]
  - @cat-factory/integrations@0.83.0
  - @cat-factory/server@0.115.0
  - @cat-factory/orchestration@0.107.9

## 0.10.120

### Patch Changes

- Updated dependencies [e5cd022]
  - @cat-factory/kernel@0.124.0
  - @cat-factory/integrations@0.82.0
  - @cat-factory/server@0.114.0
  - @cat-factory/orchestration@0.107.8
  - @cat-factory/agents@0.54.12
  - @cat-factory/gates@0.5.32

## 0.10.119

### Patch Changes

- Updated dependencies [6c4bcef]
- Updated dependencies [6c4bcef]
  - @cat-factory/contracts@0.128.2
  - @cat-factory/kernel@0.123.3
  - @cat-factory/integrations@0.81.20
  - @cat-factory/server@0.113.9
  - @cat-factory/agents@0.54.11
  - @cat-factory/gates@0.5.31
  - @cat-factory/orchestration@0.107.7
  - @cat-factory/prompt-fragments@0.13.17

## 0.10.118

### Patch Changes

- Updated dependencies [b34ab46]
  - @cat-factory/server@0.113.8
  - @cat-factory/orchestration@0.107.6

## 0.10.117

### Patch Changes

- Updated dependencies [90a7fb3]
  - @cat-factory/integrations@0.81.19
  - @cat-factory/server@0.113.7
  - @cat-factory/orchestration@0.107.5

## 0.10.116

### Patch Changes

- Updated dependencies [c1028cc]
  - @cat-factory/orchestration@0.107.4
  - @cat-factory/server@0.113.6

## 0.10.115

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/kernel@0.123.2
  - @cat-factory/contracts@0.128.1
  - @cat-factory/agents@0.54.10
  - @cat-factory/gates@0.5.30
  - @cat-factory/integrations@0.81.18
  - @cat-factory/orchestration@0.107.3
  - @cat-factory/server@0.113.5
  - @cat-factory/prompt-fragments@0.13.16

## 0.10.114

### Patch Changes

- Updated dependencies [2c7ca2e]
  - @cat-factory/orchestration@0.107.2
  - @cat-factory/kernel@0.123.1
  - @cat-factory/server@0.113.4
  - @cat-factory/agents@0.54.9
  - @cat-factory/gates@0.5.29
  - @cat-factory/integrations@0.81.17

## 0.10.113

### Patch Changes

- Updated dependencies [85bf0ef]
  - @cat-factory/server@0.113.3

## 0.10.112

### Patch Changes

- Updated dependencies [17c6808]
  - @cat-factory/server@0.113.2

## 0.10.111

### Patch Changes

- e4c5abe: Type the harness failure-cause wire and consolidate its classifiers (error-message initiative I4).
  The kernel now owns the structured cause vocabulary — `HARNESS_FAILURE_CAUSES` /
  `HarnessFailureCause` / `isHarnessFailureCause` / `failureKindFromHarnessCause`
  (`kernel/src/domain/harness-failure.ts`), kept in step by hand with the dependency-free container
  payloads (executor-harness `FailureCause` plus deploy-harness `DeployFailureCause`, hence the
  `deploy` member) — and the three job-view ports carry the union instead of a bare string
  (`RunnerJobView.failureCause`, the failed `AgentJobUpdate` variant, `PreviewView.failureCause`).
  The mapper's internal `Record<HarnessFailureCause, 'timeout' | 'agent'>` is the drift guard: a new
  union member without a mapping fails the typecheck.

  The three per-flow copies of the cause switch are deleted in favour of that one kernel mapper:
  orchestration's `agentFailureKindFromCause` (a module export of `job.logic.ts`, now removed —
  `RunDispatcher` calls the kernel mapper), the bootstrapper's `bootstrapFailureKindFromCause`, and
  the repairer's `repairFailureKindFromCause`. Each flow keeps its own error-string regex purely as
  the no-cause fallback. `HttpRunnerPoolProvider` now narrows the pool's dot-path-mapped cause
  through `isHarnessFailureCause` (an unknown free-form value degrades to the regex fallback instead
  of riding the wire untyped), and the conformance `FakeAgentExecutor.pollFailCause` option is typed
  to the union. Container eviction stays outside the union (a transport signal —
  `RunnerJobView.evicted`). No executor-harness image bump: the harness sources are untouched.

- Updated dependencies [e4c5abe]
- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0
  - @cat-factory/orchestration@0.107.1
  - @cat-factory/server@0.113.1
  - @cat-factory/integrations@0.81.16
  - @cat-factory/agents@0.54.8
  - @cat-factory/gates@0.5.28

## 0.10.110

### Patch Changes

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/contracts@0.128.0
  - @cat-factory/kernel@0.122.0
  - @cat-factory/orchestration@0.107.0
  - @cat-factory/integrations@0.81.15
  - @cat-factory/server@0.113.0
  - @cat-factory/agents@0.54.7
  - @cat-factory/gates@0.5.27
  - @cat-factory/prompt-fragments@0.13.15

## 0.10.109

### Patch Changes

- Updated dependencies [5a3fe5d]
- Updated dependencies [2a13ece]
  - @cat-factory/server@0.112.10
  - @cat-factory/kernel@0.121.8
  - @cat-factory/integrations@0.81.14
  - @cat-factory/agents@0.54.6
  - @cat-factory/gates@0.5.26
  - @cat-factory/orchestration@0.106.8

## 0.10.108

### Patch Changes

- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7
  - @cat-factory/orchestration@0.106.7
  - @cat-factory/server@0.112.9
  - @cat-factory/integrations@0.81.13
  - @cat-factory/agents@0.54.5
  - @cat-factory/gates@0.5.25

## 0.10.107

### Patch Changes

- Updated dependencies [67dccb6]
  - @cat-factory/kernel@0.121.6
  - @cat-factory/orchestration@0.106.6
  - @cat-factory/server@0.112.8
  - @cat-factory/agents@0.54.4
  - @cat-factory/gates@0.5.24
  - @cat-factory/integrations@0.81.12

## 0.10.106

### Patch Changes

- Updated dependencies [f8f1aa8]
  - @cat-factory/agents@0.54.3
  - @cat-factory/contracts@0.127.1
  - @cat-factory/gates@0.5.23
  - @cat-factory/integrations@0.81.11
  - @cat-factory/kernel@0.121.5
  - @cat-factory/orchestration@0.106.5
  - @cat-factory/prompt-fragments@0.13.14
  - @cat-factory/server@0.112.7

## 0.10.105

### Patch Changes

- Updated dependencies [e68c958]
  - @cat-factory/integrations@0.81.10
  - @cat-factory/server@0.112.6
  - @cat-factory/orchestration@0.106.4

## 0.10.104

### Patch Changes

- Updated dependencies [e61c980]
  - @cat-factory/server@0.112.5

## 0.10.103

### Patch Changes

- Updated dependencies [4810353]
  - @cat-factory/kernel@0.121.4
  - @cat-factory/orchestration@0.106.3
  - @cat-factory/integrations@0.81.9
  - @cat-factory/agents@0.54.2
  - @cat-factory/gates@0.5.22
  - @cat-factory/server@0.112.4

## 0.10.102

### Patch Changes

- Updated dependencies [6fc42ed]
  - @cat-factory/server@0.112.3

## 0.10.101

### Patch Changes

- Updated dependencies [edad6e6]
  - @cat-factory/kernel@0.121.3
  - @cat-factory/orchestration@0.106.2
  - @cat-factory/server@0.112.2
  - @cat-factory/agents@0.54.1
  - @cat-factory/gates@0.5.21
  - @cat-factory/integrations@0.81.8

## 0.10.100

### Patch Changes

- Updated dependencies [3b3bdc8]
  - @cat-factory/server@0.112.1
  - @cat-factory/integrations@0.81.7
  - @cat-factory/orchestration@0.106.1

## 0.10.99

### Patch Changes

- Updated dependencies [d1a4129]
  - @cat-factory/contracts@0.127.0
  - @cat-factory/agents@0.54.0
  - @cat-factory/orchestration@0.106.0
  - @cat-factory/server@0.112.0
  - @cat-factory/gates@0.5.20
  - @cat-factory/integrations@0.81.6
  - @cat-factory/kernel@0.121.2
  - @cat-factory/prompt-fragments@0.13.13

## 0.10.98

### Patch Changes

- Updated dependencies [df7a489]
  - @cat-factory/server@0.111.0

## 0.10.97

### Patch Changes

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1
  - @cat-factory/server@0.110.5
  - @cat-factory/orchestration@0.105.6
  - @cat-factory/agents@0.53.6
  - @cat-factory/gates@0.5.19
  - @cat-factory/integrations@0.81.5

## 0.10.96

### Patch Changes

- Updated dependencies [f4482c7]
  - @cat-factory/kernel@0.121.0
  - @cat-factory/server@0.110.4
  - @cat-factory/agents@0.53.5
  - @cat-factory/gates@0.5.18
  - @cat-factory/integrations@0.81.4
  - @cat-factory/orchestration@0.105.5

## 0.10.95

### Patch Changes

- Updated dependencies [cc6d554]
  - @cat-factory/agents@0.53.4
  - @cat-factory/server@0.110.3
  - @cat-factory/orchestration@0.105.4

## 0.10.94

### Patch Changes

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0
  - @cat-factory/agents@0.53.3
  - @cat-factory/gates@0.5.17
  - @cat-factory/integrations@0.81.3
  - @cat-factory/orchestration@0.105.3
  - @cat-factory/server@0.110.2

## 0.10.93

### Patch Changes

- Updated dependencies [dbfe2e8]
  - @cat-factory/server@0.110.1

## 0.10.92

### Patch Changes

- Updated dependencies [8d65179]
- Updated dependencies [a5dcf7d]
  - @cat-factory/server@0.110.0
  - @cat-factory/kernel@0.119.0
  - @cat-factory/agents@0.53.2
  - @cat-factory/gates@0.5.16
  - @cat-factory/integrations@0.81.2
  - @cat-factory/orchestration@0.105.2

## 0.10.91

### Patch Changes

- Updated dependencies [5072999]
  - @cat-factory/contracts@0.126.0
  - @cat-factory/server@0.109.0
  - @cat-factory/agents@0.53.1
  - @cat-factory/gates@0.5.15
  - @cat-factory/integrations@0.81.1
  - @cat-factory/kernel@0.118.1
  - @cat-factory/orchestration@0.105.1
  - @cat-factory/prompt-fragments@0.13.12

## 0.10.90

### Patch Changes

- Updated dependencies [4f936de]
  - @cat-factory/contracts@0.125.0
  - @cat-factory/kernel@0.118.0
  - @cat-factory/agents@0.53.0
  - @cat-factory/orchestration@0.105.0
  - @cat-factory/integrations@0.81.0
  - @cat-factory/server@0.108.0
  - @cat-factory/gates@0.5.14
  - @cat-factory/prompt-fragments@0.13.11

## 0.10.89

### Patch Changes

- Updated dependencies [4b8fc5f]
  - @cat-factory/server@0.107.10

## 0.10.88

### Patch Changes

- Updated dependencies [e254ef5]
  - @cat-factory/orchestration@0.104.1
  - @cat-factory/server@0.107.9

## 0.10.87

### Patch Changes

- 127fe3e: Apriori branches (slice 2): working mode.

  A task's single optional `working` apriori branch now drives the run — the agents start from
  and keep committing into that pre-existing branch instead of minting `cat-factory/<blockId>`,
  and the PR opens from it, the CI gate polls it, and the merger merges it. See
  `docs/initiatives/apriori-branches.md`.

  - **Context**: the engine lifts the block's `aprioriBranches` verbatim onto the agent run
    context (`AgentRunContext.aprioriBranches`), a pure projection like `referenceRepos`.
  - **Work-branch swap**: `ContainerAgentExecutor.buildJobBody` and the two `RunDispatcher`
    repo-op sites (`resolveRepoOpBranch` + the spec-writer `builtInRepoOpBranch`) resolve the
    work branch as `resolveAprioriWorkingBranch(...) ?? cat-factory/<blockId>`, so every
    downstream builder (`newBranch` / `pushBranch` / explore fallback / PR head) rides the
    user's branch. The base-branch rejection is a single shared `resolveAprioriWorkingBranch`
    helper (`@cat-factory/contracts`) so the executor and dispatcher rejections can't drift.
  - **Probe, never create**: an apriori working branch must already exist — it is probed
    (`ensureWorkBranch(..., { create: false })`, or a checkout-free `headSha`), and a missing
    branch fails the dispatch loudly rather than being silently created off base. A working
    branch equal to the repo base is rejected.
  - **Merge teardown guard**: `GitHubPullRequestMerger` only deletes a merged head branch when
    it is a platform `cat-factory/*` branch — a user-provided apriori branch is never torn down
    (reusing a merged apriori branch on a later task intentionally resumes it).
  - **Conformance**: a cross-runtime assertion that a custom kind's post-op commits onto the
    task's apriori working branch instead of `cat-factory/<blockId>` on both stores.

- Updated dependencies [127fe3e]
  - @cat-factory/orchestration@0.104.0
  - @cat-factory/contracts@0.124.1
  - @cat-factory/kernel@0.117.6
  - @cat-factory/server@0.107.8
  - @cat-factory/agents@0.52.9
  - @cat-factory/gates@0.5.13
  - @cat-factory/integrations@0.80.6
  - @cat-factory/prompt-fragments@0.13.10

## 0.10.86

### Patch Changes

- Updated dependencies [774908c]
  - @cat-factory/kernel@0.117.5
  - @cat-factory/server@0.107.7
  - @cat-factory/orchestration@0.103.1
  - @cat-factory/agents@0.52.8
  - @cat-factory/gates@0.5.12
  - @cat-factory/integrations@0.80.5

## 0.10.85

### Patch Changes

- 08a7da2: Apriori branches (slice 1): data model + write-boundary + persistence.

  A task (`Block`) can now name pre-existing branches of its primary target repo via a new
  optional `aprioriBranches` field — an array of `{ name, mode: 'reference' | 'working' }`.
  `reference` branches are read-only context; the single optional `working` branch is the one
  the run keeps building inside (later slices). See `docs/initiatives/apriori-branches.md`.

  - **Contracts**: `aprioriBranchSchema` + `AprioriBranch`, the `aprioriWorkingBranch` /
    `aprioriReferenceBranches` helpers, an `isSafeGitBranchName` git-ref-safety check, the new
    `blockSchema` field, and `aprioriBranches` on `updateBlockSchema` (capped at 20). Re-exported
    from `@cat-factory/kernel`.
  - **Persistence**: a shared `apriori_branches` JSON text column mirroring `reference_repos`
    (empty-array-is-NULL) — D1 migration `0048_apriori_branches.sql` ⇄ Drizzle schema column +
    generated migration, picked up by both stores through the shared `blockFields` mapper.
  - **Write boundary**: `BoardService.updateBlock` drops the field on non-task blocks and enforces
    the cross-entry invariants via `aprioriBranchesError` — at most one `working` entry, no
    duplicate names, the working entry frozen once a PR exists, and no working entry on a
    multi-repo (`involvedServiceIds`) task.
  - **Conformance**: a cross-runtime round-trip asserting the column survives PATCH + snapshot
    read on both stores, clears to absent, and rejects the invalid shapes.

- Updated dependencies [08a7da2]
  - @cat-factory/contracts@0.124.0
  - @cat-factory/orchestration@0.103.0
  - @cat-factory/kernel@0.117.4
  - @cat-factory/server@0.107.6
  - @cat-factory/agents@0.52.7
  - @cat-factory/gates@0.5.11
  - @cat-factory/integrations@0.80.4
  - @cat-factory/prompt-fragments@0.13.9

## 0.10.84

### Patch Changes

- 5a4d356: test(conformance): reusable fake gate providers + an on-call assessment channel on the fake agent

  Extract the inline `ci` / `doc-quality` fake gate providers into a shared
  `fakeGateProviders` module (`makeFakeCi` / `makeFakeMergeability` / `makeFakeReleaseHealth` /
  `makeFakeDocQuality`), exported from the package index so both the cross-runtime conformance
  suite and the e2e test backend reuse one implementation instead of copy-pasting per-probe
  verdict queues. `FakeAgentExecutor` gains an `onCallAssessment` option and an `on-call` branch
  so the post-release-health gate's INVESTIGATE-don't-fix helper returns a structured assessment
  (the generic prose fall-through left it null). These back the new operational-gate + agent-loop
  e2e specs (CI→ci-fixer, conflicts→conflict-resolver, post-release-health→on-call, Tester→Fixer,
  companion rework, follow-up gate).

  Adds a cross-runtime conformance assertion for the post-release-health gate: a merged release
  (merger auto-merges → block `done`) whose observability signal probes `regressed` escalates the
  `on-call` helper and raises a `release_regression` notification, driven over the shared
  `makeFakeReleaseHealth`. Both facades enable the observability integration in their test env so the
  gate + its wire-handle + the on-call assessment channel can't drift on only one runtime.

- Updated dependencies [87f835a]
  - @cat-factory/server@0.107.5

## 0.10.83

### Patch Changes

- Updated dependencies [6b968bb]
  - @cat-factory/kernel@0.117.3
  - @cat-factory/orchestration@0.102.8
  - @cat-factory/server@0.107.4
  - @cat-factory/agents@0.52.6
  - @cat-factory/gates@0.5.10
  - @cat-factory/integrations@0.80.3

## 0.10.82

### Patch Changes

- Updated dependencies [a650396]
  - @cat-factory/orchestration@0.102.7
  - @cat-factory/server@0.107.3

## 0.10.81

### Patch Changes

- Updated dependencies [eeadc97]
  - @cat-factory/kernel@0.117.2
  - @cat-factory/contracts@0.123.1
  - @cat-factory/orchestration@0.102.6
  - @cat-factory/server@0.107.2
  - @cat-factory/agents@0.52.5
  - @cat-factory/gates@0.5.9
  - @cat-factory/integrations@0.80.2
  - @cat-factory/prompt-fragments@0.13.8

## 0.10.80

### Patch Changes

- Updated dependencies [cb7fd14]
  - @cat-factory/server@0.107.1
  - @cat-factory/integrations@0.80.1
  - @cat-factory/kernel@0.117.1
  - @cat-factory/orchestration@0.102.5
  - @cat-factory/agents@0.52.4
  - @cat-factory/gates@0.5.8

## 0.10.79

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0
  - @cat-factory/integrations@0.80.0
  - @cat-factory/server@0.107.0
  - @cat-factory/agents@0.52.3
  - @cat-factory/gates@0.5.7
  - @cat-factory/orchestration@0.102.4

## 0.10.78

### Patch Changes

- Updated dependencies [51869b8]
- Updated dependencies [2924e32]
  - @cat-factory/kernel@0.116.0
  - @cat-factory/orchestration@0.102.3
  - @cat-factory/agents@0.52.2
  - @cat-factory/gates@0.5.6
  - @cat-factory/integrations@0.79.3
  - @cat-factory/server@0.106.3

## 0.10.77

### Patch Changes

- @cat-factory/orchestration@0.102.2
- @cat-factory/server@0.106.2

## 0.10.76

### Patch Changes

- Updated dependencies [a51a498]
  - @cat-factory/orchestration@0.102.1
  - @cat-factory/kernel@0.115.1
  - @cat-factory/server@0.106.1
  - @cat-factory/agents@0.52.1
  - @cat-factory/gates@0.5.5
  - @cat-factory/integrations@0.79.2

## 0.10.75

### Patch Changes

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/contracts@0.123.0
  - @cat-factory/kernel@0.115.0
  - @cat-factory/agents@0.52.0
  - @cat-factory/orchestration@0.102.0
  - @cat-factory/server@0.106.0
  - @cat-factory/gates@0.5.4
  - @cat-factory/integrations@0.79.1
  - @cat-factory/prompt-fragments@0.13.7

## 0.10.74

### Patch Changes

- Updated dependencies [0f3c88b]
  - @cat-factory/contracts@0.122.0
  - @cat-factory/kernel@0.114.0
  - @cat-factory/agents@0.51.0
  - @cat-factory/integrations@0.79.0
  - @cat-factory/orchestration@0.101.0
  - @cat-factory/server@0.105.0
  - @cat-factory/gates@0.5.3
  - @cat-factory/prompt-fragments@0.13.6

## 0.10.73

### Patch Changes

- Updated dependencies [ed77be6]
  - @cat-factory/kernel@0.113.0
  - @cat-factory/agents@0.50.0
  - @cat-factory/orchestration@0.100.2
  - @cat-factory/server@0.104.2
  - @cat-factory/contracts@0.121.2
  - @cat-factory/gates@0.5.2
  - @cat-factory/integrations@0.78.8
  - @cat-factory/prompt-fragments@0.13.5

## 0.10.72

### Patch Changes

- Updated dependencies [7ee2530]
  - @cat-factory/agents@0.49.3
  - @cat-factory/gates@0.5.1
  - @cat-factory/integrations@0.78.7
  - @cat-factory/kernel@0.112.1
  - @cat-factory/orchestration@0.100.1
  - @cat-factory/server@0.104.1

## 0.10.71

### Patch Changes

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0
  - @cat-factory/gates@0.5.0
  - @cat-factory/orchestration@0.100.0
  - @cat-factory/server@0.104.0
  - @cat-factory/agents@0.49.2
  - @cat-factory/integrations@0.78.6

## 0.10.70

### Patch Changes

- Updated dependencies [9aa9e19]
  - @cat-factory/contracts@0.121.1
  - @cat-factory/orchestration@0.99.1
  - @cat-factory/agents@0.49.1
  - @cat-factory/gates@0.4.34
  - @cat-factory/integrations@0.78.5
  - @cat-factory/kernel@0.111.1
  - @cat-factory/prompt-fragments@0.13.4
  - @cat-factory/server@0.103.1

## 0.10.69

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/kernel@0.111.0
  - @cat-factory/agents@0.49.0
  - @cat-factory/server@0.103.0
  - @cat-factory/orchestration@0.99.0
  - @cat-factory/contracts@0.121.0
  - @cat-factory/gates@0.4.33
  - @cat-factory/integrations@0.78.4
  - @cat-factory/prompt-fragments@0.13.3

## 0.10.68

### Patch Changes

- Updated dependencies [bcc843d]
  - @cat-factory/orchestration@0.98.1
  - @cat-factory/agents@0.48.5
  - @cat-factory/server@0.102.1
  - @cat-factory/kernel@0.110.1
  - @cat-factory/gates@0.4.32
  - @cat-factory/integrations@0.78.3

## 0.10.67

### Patch Changes

- Updated dependencies [a2db337]
- Updated dependencies [a2db337]
  - @cat-factory/orchestration@0.98.0
  - @cat-factory/agents@0.48.4
  - @cat-factory/contracts@0.120.0
  - @cat-factory/kernel@0.110.0
  - @cat-factory/server@0.102.0
  - @cat-factory/gates@0.4.31
  - @cat-factory/integrations@0.78.2
  - @cat-factory/prompt-fragments@0.13.2

## 0.10.66

### Patch Changes

- Updated dependencies [35636d5]
  - @cat-factory/agents@0.48.3
  - @cat-factory/orchestration@0.97.2
  - @cat-factory/server@0.101.2

## 0.10.65

### Patch Changes

- 8319e52: Fix a first-sign-in race in `AccountService.ensurePersonalAccount` that 500'd
  `GET /accounts` ("cannot reach backend") on a fresh DB.

  The method was a non-atomic check-then-act: concurrent first-load requests all read
  "no personal account yet", then all `INSERT`, so all but one failed with a duplicate-key
  violation on the personal-account partial unique index (`idx_accounts_personal`) and the
  error surfaced as an unhandled 500.

  The create path is now atomic. A new `AccountRepository.ensurePersonal(account)` port
  inserts-or-returns the surviving row — D1 via `INSERT OR IGNORE`, Postgres via
  `ON CONFLICT DO NOTHING` — so concurrent first-sign-in callers all converge on the same
  account with no rejection. Both runtimes implement it and a cross-runtime conformance
  assertion fires the concurrent resolution and asserts a single account results.

  The sibling paths are unaffected: `createOrg` is a deliberate non-idempotent create (org
  accounts have no such unique index), and `ensureMembership` already writes through an
  idempotent `upsert`.

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1
  - @cat-factory/agents@0.48.2
  - @cat-factory/gates@0.4.30
  - @cat-factory/integrations@0.78.1
  - @cat-factory/orchestration@0.97.1
  - @cat-factory/server@0.101.1

## 0.10.64

### Patch Changes

- 7157908: Model presets now support reseeding, mirroring pipelines and merge presets, plus a new
  built-in "Claude Opus 4.8" preset (everything `claude-opus`).

  - Built-in model presets carry stable catalog ids (`mdp_kimi` / `mdp_glm` / `mdp_claude`)
    and a monotonic `version`. The workspace snapshot ships `modelPresetCatalogVersions`, and
    `POST /workspaces/:ws/model-presets/:id/reseed` restores a built-in to the current catalog
    (adopt an update, repair drift, or materialise a new built-in that appeared). The SPA gains
    a once-per-session "model preset updates" advisory (reseed / add) like the pipeline and
    merge-preset ones.
  - The seeded workspace DEFAULT preset is now a deployment fact: Cloudflare and Node default to
    Kimi K2.7 (Cloudflare-runnable on the bare baseline), local mode defaults to Claude Opus 4.8
    (local runs subscription models via the ambient CLI / a leased personal credential). The
    deployment default is applied only at first seed, so a user's later manual default choice is
    always preserved.

  Breaking (pre-1.0, no migration): model presets gain a nullable `version` column
  (D1 `0043_model_preset_versioning`; Drizzle migration). Workspaces seeded before this change
  hold the old index-based preset ids (`mdp-seed-0/1`); they are treated as custom presets, and
  the three stable built-ins are offered via the reseed advisory rather than migrated in place.

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
  - @cat-factory/contracts@0.119.0
  - @cat-factory/kernel@0.109.0
  - @cat-factory/server@0.101.0
  - @cat-factory/orchestration@0.97.0
  - @cat-factory/integrations@0.78.0
  - @cat-factory/agents@0.48.1
  - @cat-factory/gates@0.4.29
  - @cat-factory/prompt-fragments@0.13.1

## 0.10.63

### Patch Changes

- 629cf90: Initiative presets slice 9: the E2E baseline + a worked-example deployment preset.

  - `@cat-factory/conformance`: `FakeAgentExecutor` gains an `initiativePlan` option so a
    fake-driven initiative-planner step returns a plan draft (the planner otherwise faults a
    planning run) — the seam an e2e/integration test uses to drive create-with-preset → auto-plan
    → spawn.
  - `@cat-factory/node-server`: the initiative-loop sweep interval is now overridable via
    `INITIATIVE_LOOP_INTERVAL_MS` (default 60s unchanged).
  - `@cat-factory/app`: `TaskCard` exposes a behaviour-neutral `data-task-type` attribute (the e2e
    asserts a spawned document task carries its preset decoration).
  - `@cat-factory/example-custom-agent`: adds `preset_org_audit`, a worked-example initiative preset
    registered through the public `registerInitiativePreset` seam.

## 0.10.62

### Patch Changes

- Updated dependencies [4775c40]
  - @cat-factory/agents@0.48.0
  - @cat-factory/orchestration@0.96.3
  - @cat-factory/server@0.100.2

## 0.10.61

### Patch Changes

- Updated dependencies [f97d5d3]
  - @cat-factory/agents@0.47.0
  - @cat-factory/prompt-fragments@0.13.0
  - @cat-factory/orchestration@0.96.2
  - @cat-factory/server@0.100.1

## 0.10.60

### Patch Changes

- Updated dependencies [cb088c7]
- Updated dependencies [b3bd653]
  - @cat-factory/agents@0.46.0
  - @cat-factory/server@0.100.0
  - @cat-factory/orchestration@0.96.1

## 0.10.59

### Patch Changes

- Updated dependencies [09a1c85]
  - @cat-factory/agents@0.45.0
  - @cat-factory/orchestration@0.96.0
  - @cat-factory/server@0.99.8

## 0.10.58

### Patch Changes

- Updated dependencies [785576b]
  - @cat-factory/agents@0.44.1
  - @cat-factory/orchestration@0.95.3
  - @cat-factory/server@0.99.7

## 0.10.57

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/agents@0.44.0
  - @cat-factory/kernel@0.108.0
  - @cat-factory/prompt-fragments@0.12.0
  - @cat-factory/orchestration@0.95.2
  - @cat-factory/server@0.99.6
  - @cat-factory/gates@0.4.28
  - @cat-factory/integrations@0.77.8

## 0.10.56

### Patch Changes

- Updated dependencies [4a7fca0]
  - @cat-factory/prompt-fragments@0.11.0
  - @cat-factory/agents@0.43.1
  - @cat-factory/orchestration@0.95.1
  - @cat-factory/server@0.99.5

## 0.10.55

### Patch Changes

- Updated dependencies [44fafa4]
  - @cat-factory/orchestration@0.95.0
  - @cat-factory/kernel@0.107.0
  - @cat-factory/agents@0.43.0
  - @cat-factory/server@0.99.4
  - @cat-factory/gates@0.4.27
  - @cat-factory/integrations@0.77.7

## 0.10.54

### Patch Changes

- Updated dependencies [cd60892]
  - @cat-factory/orchestration@0.94.0
  - @cat-factory/server@0.99.3

## 0.10.53

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/agents@0.42.0
  - @cat-factory/kernel@0.106.0
  - @cat-factory/orchestration@0.93.1
  - @cat-factory/server@0.99.2
  - @cat-factory/gates@0.4.26
  - @cat-factory/integrations@0.77.6

## 0.10.52

### Patch Changes

- f7f9a9e: Technological-migration initiative — slice T2: phase-template ingest normalization.

  The generic counterpart to T1's planner prompt fold: when an initiative preset declares a
  `phaseTemplate`, the plan draft is now normalized against it at ingest, BEFORE the preset's own
  `seedPlan` hook. This is plan-SHAPE enforcement only (which phases the plan presents, and in what
  order) and stays deliberately separate from `seedPlan`'s per-item decoration.

  - **orchestration**: new pure `normalizeDraftAgainstPhaseTemplate(template, draft)`
    (`initiative.logic.ts`) — matches planned phases to template phases by `id` VERBATIM, reorders
    them into template order (preserving the planner's `title`/`goal`), appends any extra phases
    after the template ones when `allowAdditionalPhases` is set, and throws `ValidationError` on a
    missing `required` phase or a disallowed extra (an id-less phase counts as an extra). Wired into
    `InitiativeService.seedPlanDraft` ahead of the `seedPlan` hook and gated on the resolved preset's
    `phaseTemplate`, so a preset with no template (including `preset_generic`) ingests byte-for-byte
    as before. Pure + deterministic, so re-ingesting the same draft stays idempotent.
  - **orchestration**: `validatePlanDraft` now also rejects a dependency that points FORWARD into a
    later phase. Phases execute in declared order, so an earlier-phase item depending on a
    later-phase one can never resolve and deadlocks the loop — a general invariant, but the T2 phase
    reorder can turn a planner-consistent draft into a violating one, so it's caught loudly at the
    ingest trust boundary instead of stalling silently at run time.
  - **orchestration**: `seedPlanDraft` now RE-NORMALIZES the `seedPlan` hook's output against the
    template (idempotent), symmetric with the existing re-parse-for-path-safety: a hook that touched
    phases can no longer bypass the template's shape enforcement.
  - **conformance**: `defineInitiativeSuite` now drives `InitiativeService.ingestPlan` over each
    facade's real store — asserting an out-of-order plan is reordered into template order and
    persisted, and a plan missing a required phase is rejected with nothing written — so the two
    stores can't drift on a template-shaped plan.

- Updated dependencies [f7f9a9e]
  - @cat-factory/orchestration@0.93.0
  - @cat-factory/server@0.99.1

## 0.10.51

### Patch Changes

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/agents@0.41.0
  - @cat-factory/kernel@0.105.0
  - @cat-factory/integrations@0.77.5
  - @cat-factory/contracts@0.118.0
  - @cat-factory/orchestration@0.92.0
  - @cat-factory/server@0.99.0
  - @cat-factory/gates@0.4.25
  - @cat-factory/prompt-fragments@0.10.27

## 0.10.50

### Patch Changes

- Updated dependencies [8f7af8e]
- Updated dependencies [8f7af8e]
  - @cat-factory/integrations@0.77.4
  - @cat-factory/server@0.98.3
  - @cat-factory/orchestration@0.91.1

## 0.10.49

### Patch Changes

- 4a3e536: Initiative presets — slice 5: loop/ingest glue (spawn decoration + `seedPlan` at ingest).

  - **contracts** (`initiativeItemSpawnSchema`): the spawn bag now carries an optional `taskType`, so
    a preset's `seedPlan` can declare a spawned item's kind (`document`/`bug`/`spike`/…) exactly as
    the create-task form does.
  - **orchestration** (`InitiativeLoopService.buildTaskBlock`): a spawned item's preset-authored
    `spawn` bag is now folded onto the task block, so a planned item comes out as a first-class
    TYPED task rather than a bare description block — its `taskType` (so a doc task classifies as
    `document`, not the default `feature` — `taskType`-keyed per-type task limits and the SPA's
    document affordances now apply), the doc task's `taskTypeFields` (`docKind`/`targetPath`/…),
    best-practice `fragmentIds`, and per-agent `agentConfig`. Each is additive + sparse (an empty bag
    is omitted), mirroring `BoardService.addTask`, so a decoration-less item (the generic / no-preset
    case) spawns a block byte-identical to before. A `document`-typed spawn with no explicit
    `fragmentIds` inherits the default writing-style fragments, exactly as `BoardService.addTask`
    seeds them for a board-created document task. The per-run gate override (`spawn.gates`, slice 2)
    is unchanged.
  - **orchestration** (`applyPlanDraft`): the draft item's `spawn` decoration is now carried onto the
    persisted item (it follows the draft like the other content fields), so `buildTaskBlock` can read
    it. A re-plan refreshing an already-materialised item is harmless — its block was decorated when
    it spawned.
  - **orchestration** (`InitiativeService.ingestPlan`): runs the resolved initiative preset's
    `seedPlan` post-processor over the parsed draft BEFORE `applyPlanDraft`. The preset is resolved
    from the entity's FROZEN `presetId`/`presetInputs`, so reading it outside the CAS `mutate` is
    race-free and (being pure) replay-safe. The hook's output is RE-PARSED through the strict schema:
    a `seedPlan` bug can't persist a malformed draft, and an unsafe spawn `targetPath` (from a hook OR
    the planner) is rejected by `taskTypeFieldsSchema`'s `isSafeDocPath` check — it can never escape
    the repo. Absent preset / no `seedPlan` ⇒ the draft is applied unchanged (byte-for-byte the
    pre-slice-5 path).
  - **conformance**: asserts a preset-authored item `spawn` bag (task type, typed-task fields,
    fragments, agent config, gate override) round-trips through the initiative store intact on both
    runtimes — a store that dropped it would silently spawn a bare block instead of a first-class doc
    task.

- Updated dependencies [4a3e536]
  - @cat-factory/orchestration@0.91.0
  - @cat-factory/contracts@0.117.0
  - @cat-factory/server@0.98.2
  - @cat-factory/agents@0.40.13
  - @cat-factory/gates@0.4.24
  - @cat-factory/integrations@0.77.3
  - @cat-factory/kernel@0.104.4
  - @cat-factory/prompt-fragments@0.10.26

## 0.10.48

### Patch Changes

- Updated dependencies [18a9cb5]
  - @cat-factory/contracts@0.116.1
  - @cat-factory/agents@0.40.12
  - @cat-factory/gates@0.4.23
  - @cat-factory/integrations@0.77.2
  - @cat-factory/kernel@0.104.3
  - @cat-factory/orchestration@0.90.1
  - @cat-factory/prompt-fragments@0.10.25
  - @cat-factory/server@0.98.1

## 0.10.47

### Patch Changes

- bc77f89: Initiative presets — slice 3: create/planning integration.

  - **contracts**: `createInitiativeSchema` gains optional `presetId` + `presetInputs` (validated
    against the resolved descriptor at create and frozen on the entity). New
    `probeInitiativePresetContract` (`POST /workspaces/:ws/initiative-presets/:presetId/probe`,
    body `{ frameId }` → the detected `InitiativePresetInputs`). The workspace snapshot gains
    `initiativePresets: InitiativePresetDescriptor[]`. New pure helpers
    `sanitizeInitiativePresetInputs` (reduce a form to its known, visible fields) and
    `renderInitiativePresetValue` (option-label-aware value rendering), shared by the create flow.
  - **orchestration** (`InitiativeService.create`): resolves + validates the preset (an unknown id
    or an invalid form is a create-time `ValidationError`, so nothing is written), and — only when a
    preset resolves — persists `presetId` + the SANITIZED `presetInputs` (known, currently-visible
    fields only, so a hidden field's unvalidated value can never freeze, and a form posted with no
    `presetId` is dropped). For a `skip`-interview preset it seeds the `qa` digest from the filled
    form (one answered exchange per visible, filled field via the new pure `seedPresetInterviewQa`)
    and templates the goal (the human's description wins, else the preset's stated purpose). Absent
    `presetId` ⇒ today's behaviour byte-for-byte.
  - **orchestration** (`AgentContextBuilder`): an initiative planning step's context now folds in the
    preset `{ label, promptAddition }` resolved for the RUNNING kind — set ONLY when that kind has
    steering — so the analyst/planner prompts carry the preset's per-kind steering. The generic
    preset registers no steering, so the generic planning prompt is unchanged.
  - **kernel**: `AgentRunContext.initiative` gains an optional `preset` sub-object carrying the
    preset `label` + the per-kind `promptAddition` (the frozen form reaches the prompt via `qa`).
  - **server**: the shared `WorkspaceController` attaches `initiativePresets`
    (`initiativePresetDescriptors()`) to the snapshot on both the create + read handlers (so both
    facades advertise it), and `InitiativeController` serves the probe endpoint — resolving the
    frame's repo through the existing `resolveRunRepoContext` seam and running the preset's `detect`
    hook, returning `{}` (descriptor defaults) whenever GitHub is unwired / the frame has no linked
    repo / the preset has no probe hook, so it never blocks create. The initiative planning prompts
    render the folded-in preset steering.
  - **app**: the SPA hydrates `initiativePresets` from the snapshot and starts planning with the
    initiative's preset descriptor's `planningPipelineId` (the generic/absent preset keeps
    `pl_initiative`) instead of a hardcoded id. A NAMED preset that hasn't hydrated resolves to
    `null` (not the generic pipeline), so "Run planning" stays disabled rather than silently
    launching the interviewer over an already-seeded skip-interview initiative.

  Conformance: a shared assertion that both facades advertise the built-in generic preset on the
  snapshot (create + read), binding `pl_initiative` and the interviewer.

- Updated dependencies [bc77f89]
  - @cat-factory/contracts@0.116.0
  - @cat-factory/orchestration@0.90.0
  - @cat-factory/server@0.98.0
  - @cat-factory/kernel@0.104.2
  - @cat-factory/agents@0.40.11
  - @cat-factory/gates@0.4.22
  - @cat-factory/integrations@0.77.1
  - @cat-factory/prompt-fragments@0.10.24

## 0.10.46

### Patch Changes

- Updated dependencies [802fc05]
  - @cat-factory/orchestration@0.89.0
  - @cat-factory/integrations@0.77.0
  - @cat-factory/contracts@0.115.0
  - @cat-factory/server@0.97.2
  - @cat-factory/agents@0.40.10
  - @cat-factory/gates@0.4.21
  - @cat-factory/kernel@0.104.1
  - @cat-factory/prompt-fragments@0.10.23

## 0.10.45

### Patch Changes

- a869ae9: Initiative presets — slice 2: the per-run gate-override engine seam.

  - **orchestration** (`ExecutionService.start`): a new optional `gatesOverride` argument — one
    boolean per pipeline step, indexed by the pipeline's ORIGINAL step index exactly like
    `pipeline.gates` — that REPLACES the pipeline's declared approval gates for a single run. It is
    copied onto the run's steps (`requiresApproval`, `gatesOverride?.[i] ?? pipeline.gates?.[i]`), so
    a retry/restart — which re-drive the STORED steps — preserve it with no extra persistence. A
    length that doesn't match the pipeline's step count is rejected up front (a `ValidationError`)
    before any side effects. Absent ⇒ today's behaviour byte-for-byte.
  - **orchestration** (`InitiativeLoopService`): a spawned item's preset-authored `spawn.gates` is
    threaded straight into `ExecutionService.start` as that run's gate override, so a spawned task
    gates (or doesn't) per the preset's human-review mapping instead of the pipeline default.

  Conformance: a new `startExecution` harness probe (start a run through the real `ExecutionService`
  with an optional gate override — a path no HTTP route exposes) plus shared assertions that an
  override flips a step's approval gate on/off, round-trips `requiresApproval` through each store, and
  rejects a mismatched-length override — run identically on the Cloudflare (D1) and Node/local
  (Postgres) facades.

- Updated dependencies [a869ae9]
  - @cat-factory/orchestration@0.88.0
  - @cat-factory/server@0.97.1

## 0.10.44

### Patch Changes

- Updated dependencies [6198b08]
- Updated dependencies [37d1517]
  - @cat-factory/contracts@0.114.0
  - @cat-factory/server@0.97.0
  - @cat-factory/kernel@0.104.0
  - @cat-factory/integrations@0.76.0
  - @cat-factory/orchestration@0.87.0
  - @cat-factory/agents@0.40.9
  - @cat-factory/gates@0.4.20
  - @cat-factory/prompt-fragments@0.10.22

## 0.10.43

### Patch Changes

- Updated dependencies [14eac27]
  - @cat-factory/contracts@0.113.0
  - @cat-factory/kernel@0.103.0
  - @cat-factory/server@0.96.0
  - @cat-factory/orchestration@0.86.0
  - @cat-factory/agents@0.40.8
  - @cat-factory/gates@0.4.19
  - @cat-factory/integrations@0.75.1
  - @cat-factory/prompt-fragments@0.10.21

## 0.10.42

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/contracts@0.112.0
  - @cat-factory/kernel@0.102.0
  - @cat-factory/integrations@0.75.0
  - @cat-factory/orchestration@0.85.0
  - @cat-factory/server@0.95.0
  - @cat-factory/agents@0.40.7
  - @cat-factory/gates@0.4.18
  - @cat-factory/prompt-fragments@0.10.20

## 0.10.41

### Patch Changes

- Updated dependencies [fdba1ea]
  - @cat-factory/contracts@0.111.0
  - @cat-factory/integrations@0.74.0
  - @cat-factory/orchestration@0.84.0
  - @cat-factory/agents@0.40.6
  - @cat-factory/gates@0.4.17
  - @cat-factory/kernel@0.101.2
  - @cat-factory/prompt-fragments@0.10.19
  - @cat-factory/server@0.94.3

## 0.10.40

### Patch Changes

- Updated dependencies [6a701ef]
  - @cat-factory/integrations@0.73.6
  - @cat-factory/orchestration@0.83.2
  - @cat-factory/server@0.94.2

## 0.10.39

### Patch Changes

- Updated dependencies [10787c4]
  - @cat-factory/contracts@0.110.1
  - @cat-factory/kernel@0.101.1
  - @cat-factory/orchestration@0.83.1
  - @cat-factory/integrations@0.73.5
  - @cat-factory/agents@0.40.5
  - @cat-factory/gates@0.4.16
  - @cat-factory/prompt-fragments@0.10.18
  - @cat-factory/server@0.94.1

## 0.10.38

### Patch Changes

- Updated dependencies [c66362f]
  - @cat-factory/server@0.94.0

## 0.10.37

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/contracts@0.110.0
  - @cat-factory/kernel@0.101.0
  - @cat-factory/orchestration@0.83.0
  - @cat-factory/server@0.93.0
  - @cat-factory/agents@0.40.4
  - @cat-factory/gates@0.4.15
  - @cat-factory/integrations@0.73.4
  - @cat-factory/prompt-fragments@0.10.17

## 0.10.36

### Patch Changes

- Updated dependencies [9ea1e77]
  - @cat-factory/contracts@0.109.0
  - @cat-factory/kernel@0.100.0
  - @cat-factory/orchestration@0.82.0
  - @cat-factory/server@0.92.0
  - @cat-factory/agents@0.40.3
  - @cat-factory/gates@0.4.14
  - @cat-factory/integrations@0.73.3
  - @cat-factory/prompt-fragments@0.10.16

## 0.10.35

### Patch Changes

- Updated dependencies [e66accb]
  - @cat-factory/orchestration@0.81.0
  - @cat-factory/server@0.91.0
  - @cat-factory/contracts@0.108.1
  - @cat-factory/agents@0.40.2
  - @cat-factory/gates@0.4.13
  - @cat-factory/integrations@0.73.2
  - @cat-factory/kernel@0.99.1
  - @cat-factory/prompt-fragments@0.10.15

## 0.10.34

### Patch Changes

- Updated dependencies [9cc02a0]
  - @cat-factory/integrations@0.73.1
  - @cat-factory/orchestration@0.80.1
  - @cat-factory/server@0.90.3

## 0.10.33

### Patch Changes

- Updated dependencies [1afa003]
- Updated dependencies [f91b99d]
  - @cat-factory/kernel@0.99.0
  - @cat-factory/orchestration@0.80.0
  - @cat-factory/integrations@0.73.0
  - @cat-factory/contracts@0.108.0
  - @cat-factory/agents@0.40.1
  - @cat-factory/gates@0.4.12
  - @cat-factory/server@0.90.2
  - @cat-factory/prompt-fragments@0.10.14

## 0.10.32

### Patch Changes

- Updated dependencies [eef8612]
- Updated dependencies [bf31df7]
  - @cat-factory/integrations@0.72.1
  - @cat-factory/contracts@0.107.0
  - @cat-factory/agents@0.40.0
  - @cat-factory/kernel@0.98.0
  - @cat-factory/orchestration@0.79.1
  - @cat-factory/server@0.90.1
  - @cat-factory/gates@0.4.11
  - @cat-factory/prompt-fragments@0.10.13

## 0.10.31

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/contracts@0.106.0
  - @cat-factory/kernel@0.97.0
  - @cat-factory/integrations@0.72.0
  - @cat-factory/orchestration@0.79.0
  - @cat-factory/server@0.90.0
  - @cat-factory/agents@0.39.4
  - @cat-factory/gates@0.4.10
  - @cat-factory/prompt-fragments@0.10.12

## 0.10.30

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [e5b9462]
- Updated dependencies [dd6df12]
  - @cat-factory/contracts@0.105.0
  - @cat-factory/kernel@0.96.0
  - @cat-factory/server@0.89.0
  - @cat-factory/orchestration@0.78.0
  - @cat-factory/integrations@0.71.0
  - @cat-factory/agents@0.39.3
  - @cat-factory/gates@0.4.9
  - @cat-factory/prompt-fragments@0.10.11

## 0.10.29

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/contracts@0.104.0
  - @cat-factory/kernel@0.95.0
  - @cat-factory/server@0.88.0
  - @cat-factory/orchestration@0.77.0
  - @cat-factory/agents@0.39.2
  - @cat-factory/gates@0.4.8
  - @cat-factory/integrations@0.70.1
  - @cat-factory/prompt-fragments@0.10.10

## 0.10.28

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/contracts@0.103.0
  - @cat-factory/kernel@0.94.0
  - @cat-factory/integrations@0.70.0
  - @cat-factory/orchestration@0.76.0
  - @cat-factory/server@0.87.0
  - @cat-factory/agents@0.39.1
  - @cat-factory/gates@0.4.7
  - @cat-factory/prompt-fragments@0.10.9

## 0.10.27

### Patch Changes

- Updated dependencies [c435c09]
  - @cat-factory/server@0.86.0

## 0.10.26

### Patch Changes

- Updated dependencies [77bc73c]
- Updated dependencies [076d02f]
  - @cat-factory/agents@0.39.0
  - @cat-factory/integrations@0.69.1
  - @cat-factory/kernel@0.93.0
  - @cat-factory/orchestration@0.75.0
  - @cat-factory/server@0.85.0
  - @cat-factory/contracts@0.102.0
  - @cat-factory/gates@0.4.6
  - @cat-factory/prompt-fragments@0.10.8

## 0.10.25

### Patch Changes

- Updated dependencies [029a689]
- Updated dependencies [029a689]
  - @cat-factory/contracts@0.101.1
  - @cat-factory/integrations@0.69.0
  - @cat-factory/kernel@0.92.0
  - @cat-factory/agents@0.38.2
  - @cat-factory/gates@0.4.5
  - @cat-factory/orchestration@0.74.3
  - @cat-factory/prompt-fragments@0.10.7
  - @cat-factory/server@0.84.3

## 0.10.24

### Patch Changes

- Updated dependencies [f6399cf]
  - @cat-factory/integrations@0.68.0
  - @cat-factory/orchestration@0.74.2
  - @cat-factory/server@0.84.2

## 0.10.23

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/contracts@0.101.0
  - @cat-factory/kernel@0.91.0
  - @cat-factory/agents@0.38.1
  - @cat-factory/gates@0.4.4
  - @cat-factory/integrations@0.67.1
  - @cat-factory/orchestration@0.74.1
  - @cat-factory/prompt-fragments@0.10.6
  - @cat-factory/server@0.84.1

## 0.10.22

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/contracts@0.100.0
  - @cat-factory/kernel@0.90.0
  - @cat-factory/agents@0.38.0
  - @cat-factory/integrations@0.67.0
  - @cat-factory/orchestration@0.74.0
  - @cat-factory/server@0.84.0
  - @cat-factory/gates@0.4.3
  - @cat-factory/prompt-fragments@0.10.5

## 0.10.21

### Patch Changes

- Updated dependencies [3981bbb]
  - @cat-factory/contracts@0.99.0
  - @cat-factory/agents@0.37.2
  - @cat-factory/gates@0.4.2
  - @cat-factory/integrations@0.66.1
  - @cat-factory/kernel@0.89.1
  - @cat-factory/orchestration@0.73.1
  - @cat-factory/prompt-fragments@0.10.4
  - @cat-factory/server@0.83.2

## 0.10.20

### Patch Changes

- Updated dependencies [cfcb6c7]
- Updated dependencies [48f9d97]
  - @cat-factory/kernel@0.89.0
  - @cat-factory/contracts@0.98.0
  - @cat-factory/orchestration@0.73.0
  - @cat-factory/integrations@0.66.0
  - @cat-factory/agents@0.37.1
  - @cat-factory/gates@0.4.1
  - @cat-factory/server@0.83.1
  - @cat-factory/prompt-fragments@0.10.3

## 0.10.19

### Patch Changes

- Updated dependencies [f4c321e]
  - @cat-factory/kernel@0.88.0
  - @cat-factory/agents@0.37.0
  - @cat-factory/gates@0.4.0
  - @cat-factory/server@0.83.0
  - @cat-factory/integrations@0.65.3
  - @cat-factory/orchestration@0.72.1

## 0.10.18

### Patch Changes

- Updated dependencies [13a284f]
  - @cat-factory/kernel@0.87.0
  - @cat-factory/agents@0.36.0
  - @cat-factory/orchestration@0.72.0
  - @cat-factory/server@0.82.0
  - @cat-factory/gates@0.3.2
  - @cat-factory/integrations@0.65.2

## 0.10.17

### Patch Changes

- Updated dependencies [102c049]
  - @cat-factory/contracts@0.97.0
  - @cat-factory/agents@0.35.0
  - @cat-factory/gates@0.3.1
  - @cat-factory/integrations@0.65.1
  - @cat-factory/kernel@0.86.1
  - @cat-factory/orchestration@0.71.1
  - @cat-factory/prompt-fragments@0.10.2
  - @cat-factory/server@0.81.1

## 0.10.16

### Patch Changes

- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/contracts@0.96.0
  - @cat-factory/kernel@0.86.0
  - @cat-factory/integrations@0.65.0
  - @cat-factory/orchestration@0.71.0
  - @cat-factory/server@0.81.0
  - @cat-factory/agents@0.34.0
  - @cat-factory/gates@0.3.0
  - @cat-factory/prompt-fragments@0.10.1

## 0.10.15

### Patch Changes

- Updated dependencies [1f6d9fc]
  - @cat-factory/kernel@0.85.0
  - @cat-factory/server@0.80.0
  - @cat-factory/integrations@0.64.0
  - @cat-factory/orchestration@0.70.1
  - @cat-factory/agents@0.33.1
  - @cat-factory/gates@0.2.88

## 0.10.14

### Patch Changes

- Updated dependencies [8eaa3f2]
  - @cat-factory/prompt-fragments@0.10.0
  - @cat-factory/agents@0.33.0
  - @cat-factory/orchestration@0.70.0
  - @cat-factory/server@0.79.4

## 0.10.13

### Patch Changes

- Updated dependencies [e5ddaa4]
- Updated dependencies [6213771]
  - @cat-factory/kernel@0.84.0
  - @cat-factory/integrations@0.63.0
  - @cat-factory/agents@0.32.0
  - @cat-factory/orchestration@0.69.1
  - @cat-factory/gates@0.2.87
  - @cat-factory/server@0.79.3

## 0.10.12

### Patch Changes

- 9bac054: Caching initiative pilot (docs/initiatives/caching-layer.md, rows 0-1): introduce the
  app-level caching seam and adopt it for the per-dispatch fragment-catalog resolve.

  - New published package `@cat-factory/caching`: `createAppCaches(options)` builds the
    named, typed in-memory read-through caches (layered-loader `GroupLoader`, LRU + TTL)
    behind the new kernel `AppCaches`/`GroupCacheHandle` port. Redis is only ever an
    invalidation bus, never a data tier; with no notification factory injected the
    loaders are bare in-memory. The package deep-imports only layered-loader's in-memory
    machinery so ioredis never enters the module graph outside the Node facade's
    REDIS_URL-gated wiring.
  - `FragmentLibraryService.resolveCatalog` now reads through the fragment-catalog cache
    (group = workspace id), and every fragment write path — create / update / remove /
    createFromDocument / refresh / the run-time document-body re-resolve / fragment-source
    sync + unlink — invalidates it after commit (`invalidateCatalogTier`). The
    `ResolvedCatalogEntry` type moved to `@cat-factory/kernel` so the port can name it.
  - Node facade: `start()` builds the process-wide cache bag; when `REDIS_URL` is set,
    each cache gets its own `cat-factory:cache:<name>` notification channel (prefix
    overridable via the new `REDIS_CACHE_CHANNEL_PREFIX` env var) over dedicated
    ioredis publisher/subscriber clients, so peers drop their in-memory entries on every
    write — the same gating and resilience pattern as the realtime propagator. Local
    mode stays bare in-memory (single-node by construction).
  - Cloudflare Worker: wired with the ISOLATE-SAFE profile — the fragment catalog (mutable
    cross-instance state) is pass-through, since an isolate has no cross-isolate
    invalidation bus. Documented in the caching package README.
  - Conformance: new `defineCacheSuite` asserts write-then-read coherence of the resolved
    catalog on all three runtimes (Worker/Node/local).
  - Staleness probes for the upcoming git-backed slices, on layered-loader 14.5.3's new
    in-memory `isEntryStillCurrentFn` support: a cache profile may set
    `ttlLeftBeforeRefreshInMsecs`, and `GroupCacheHandle.get` accepts an optional per-read
    `isStillCurrent` probe — entries entering the refresh window get their TTL bumped when
    the probe reports the source unmoved, and fall back to a full background reload
    otherwise. `layered-loader` (maintainer-owned) is now excluded unversioned from the
    `minimumReleaseAge` supply-chain gate, like the `@cat-factory/*` namespace.

- Updated dependencies [9bac054]
  - @cat-factory/kernel@0.83.0
  - @cat-factory/agents@0.31.0
  - @cat-factory/orchestration@0.69.0
  - @cat-factory/gates@0.2.86
  - @cat-factory/integrations@0.62.1
  - @cat-factory/server@0.79.2

## 0.10.11

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/contracts@0.95.0
  - @cat-factory/kernel@0.82.0
  - @cat-factory/integrations@0.62.0
  - @cat-factory/agents@0.30.5
  - @cat-factory/gates@0.2.85
  - @cat-factory/orchestration@0.68.1
  - @cat-factory/prompt-fragments@0.9.55
  - @cat-factory/server@0.79.1

## 0.10.10

### Patch Changes

- Updated dependencies [6edcce0]
  - @cat-factory/contracts@0.94.0
  - @cat-factory/kernel@0.81.0
  - @cat-factory/integrations@0.61.0
  - @cat-factory/server@0.79.0
  - @cat-factory/orchestration@0.68.0
  - @cat-factory/agents@0.30.4
  - @cat-factory/gates@0.2.84
  - @cat-factory/prompt-fragments@0.9.54

## 0.10.9

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/contracts@0.93.0
  - @cat-factory/kernel@0.80.0
  - @cat-factory/orchestration@0.67.0
  - @cat-factory/server@0.78.0
  - @cat-factory/agents@0.30.3
  - @cat-factory/gates@0.2.83
  - @cat-factory/integrations@0.60.2
  - @cat-factory/prompt-fragments@0.9.53

## 0.10.8

### Patch Changes

- Updated dependencies [1d738f7]
  - @cat-factory/contracts@0.92.0
  - @cat-factory/orchestration@0.66.0
  - @cat-factory/server@0.77.0
  - @cat-factory/agents@0.30.2
  - @cat-factory/gates@0.2.82
  - @cat-factory/integrations@0.60.1
  - @cat-factory/kernel@0.79.1
  - @cat-factory/prompt-fragments@0.9.52

## 0.10.7

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/contracts@0.91.0
  - @cat-factory/kernel@0.79.0
  - @cat-factory/integrations@0.60.0
  - @cat-factory/orchestration@0.65.0
  - @cat-factory/server@0.76.0
  - @cat-factory/agents@0.30.1
  - @cat-factory/gates@0.2.81
  - @cat-factory/prompt-fragments@0.9.51

## 0.10.6

### Patch Changes

- Updated dependencies [0477068]
  - @cat-factory/server@0.75.2

## 0.10.5

### Patch Changes

- Updated dependencies [4a59f45]
  - @cat-factory/server@0.75.1

## 0.10.4

### Patch Changes

- Updated dependencies [b928904]
  - @cat-factory/orchestration@0.64.0
  - @cat-factory/contracts@0.90.0
  - @cat-factory/kernel@0.78.0
  - @cat-factory/integrations@0.59.0
  - @cat-factory/agents@0.30.0
  - @cat-factory/server@0.75.0
  - @cat-factory/gates@0.2.80
  - @cat-factory/prompt-fragments@0.9.50

## 0.10.3

### Patch Changes

- Updated dependencies [7fa7578]
- Updated dependencies [f372f4e]
  - @cat-factory/contracts@0.89.0
  - @cat-factory/kernel@0.77.0
  - @cat-factory/orchestration@0.63.0
  - @cat-factory/server@0.74.0
  - @cat-factory/agents@0.29.1
  - @cat-factory/gates@0.2.79
  - @cat-factory/integrations@0.58.1
  - @cat-factory/prompt-fragments@0.9.49

## 0.10.2

### Patch Changes

- Updated dependencies [6917962]
  - @cat-factory/server@0.73.1

## 0.10.1

### Patch Changes

- Updated dependencies [55661f4]
  - @cat-factory/contracts@0.88.0
  - @cat-factory/kernel@0.76.0
  - @cat-factory/agents@0.29.0
  - @cat-factory/integrations@0.58.0
  - @cat-factory/server@0.73.0
  - @cat-factory/orchestration@0.62.0
  - @cat-factory/gates@0.2.78
  - @cat-factory/prompt-fragments@0.9.48

## 0.10.0

### Minor Changes

- ca5c3e8: Initiatives (slice 1 of 4): the long-running, multi-task counterpart to a task — see
  `docs/initiatives/initiatives-feature.md` for the full multi-slice plan.

  - **New `initiative` block level** — a container block under a service frame (created via the
    new "Create initiative" button in the frame header, next to add-task/import-task). Tasks a
    later slice's execution loop spawns link back via the new `blocks.initiative_id` membership
    column (epic-style). D1 migration `0035_initiatives.sql` ⇄ Drizzle schema, shared mapper.
  - **New `initiatives` entity + store** — the DB row is the source of truth (phases, items with
    planner-authored estimates + dependencies, the execution policy with estimate→pipeline rules,
    decisions / deviations / follow-ups / caveats), guarded by a `rev` compare-and-swap so the
    loop has a single logical writer. Mirrored D1 ⇄ Drizzle repositories with a cross-runtime
    conformance suite (CRUD, doc round-trip, CAS conflict, `blocks.initiative_id`).
  - **Initiative Planning pipeline skeleton (`pl_initiative`)** — `initiative-planner` (a
    read-only structured container explore that drafts the multi-phase plan, gated for human
    approval) + `initiative-committer` (a deterministic engine step that flips the entity to
    `executing` and commits the rendered tracker to `docs/initiatives/<slug>/` — canonical
    `initiative.json` + human `tracker.md` + `version.json`, hash-short-circuited and
    replay-safe, following the blueprint artifact pattern). A bidirectional guard in the
    engine's shared `assertRunnable` makes `pl_initiative` the ONLY pipeline runnable on an
    initiative block (and vice versa), across start/retry/restart.
  - **API + snapshot + realtime** — `POST/GET /workspaces/:ws/initiatives` (+ by-block read),
    the snapshot's optional `initiatives` field, and a new `initiative` WorkspaceEvent pushed
    from both runtimes' publishers.
  - **Frontend** — the Create Initiative modal + frame-header button, the initiative board card,
    an inspector body (run planning / open tracker) and the read-only Initiative Tracker window
    (`initiative-tracker` result view), with the `initiative.*` i18n namespace across all 8
    locales.

  Later slices add the interactive planning interview, the execution loop (just-in-time task
  spawning with estimate-gated pipeline selection), and follow-up/deviation harvesting.

### Patch Changes

- Updated dependencies [ca5c3e8]
  - @cat-factory/contracts@0.87.0
  - @cat-factory/kernel@0.75.0
  - @cat-factory/agents@0.28.0
  - @cat-factory/orchestration@0.61.0
  - @cat-factory/server@0.72.0
  - @cat-factory/gates@0.2.77
  - @cat-factory/integrations@0.57.2
  - @cat-factory/prompt-fragments@0.9.47

## 0.9.102

### Patch Changes

- Updated dependencies [cc924a9]
  - @cat-factory/agents@0.27.1
  - @cat-factory/orchestration@0.60.4
  - @cat-factory/server@0.71.2

## 0.9.101

### Patch Changes

- Updated dependencies [803fa76]
  - @cat-factory/server@0.71.1

## 0.9.100

### Patch Changes

- Updated dependencies [b216fdc]
  - @cat-factory/kernel@0.74.0
  - @cat-factory/contracts@0.86.0
  - @cat-factory/agents@0.27.0
  - @cat-factory/server@0.71.0
  - @cat-factory/gates@0.2.76
  - @cat-factory/integrations@0.57.1
  - @cat-factory/orchestration@0.60.3
  - @cat-factory/prompt-fragments@0.9.46

## 0.9.99

### Patch Changes

- Updated dependencies [7fd6a19]
  - @cat-factory/kernel@0.73.0
  - @cat-factory/server@0.70.0
  - @cat-factory/integrations@0.57.0
  - @cat-factory/agents@0.26.18
  - @cat-factory/gates@0.2.75
  - @cat-factory/orchestration@0.60.2

## 0.9.98

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/contracts@0.85.0
  - @cat-factory/kernel@0.72.0
  - @cat-factory/gates@0.2.74
  - @cat-factory/orchestration@0.60.1
  - @cat-factory/agents@0.26.17
  - @cat-factory/integrations@0.56.5
  - @cat-factory/prompt-fragments@0.9.45
  - @cat-factory/server@0.69.1

## 0.9.97

### Patch Changes

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
  - @cat-factory/contracts@0.84.0
  - @cat-factory/orchestration@0.60.0
  - @cat-factory/kernel@0.71.0
  - @cat-factory/server@0.69.0
  - @cat-factory/agents@0.26.16
  - @cat-factory/gates@0.2.73
  - @cat-factory/integrations@0.56.4
  - @cat-factory/prompt-fragments@0.9.44

## 0.9.96

### Patch Changes

- Updated dependencies [e0aab3f]
  - @cat-factory/contracts@0.83.0
  - @cat-factory/kernel@0.70.2
  - @cat-factory/orchestration@0.59.2
  - @cat-factory/server@0.68.2
  - @cat-factory/agents@0.26.15
  - @cat-factory/gates@0.2.72
  - @cat-factory/integrations@0.56.3
  - @cat-factory/prompt-fragments@0.9.43

## 0.9.95

### Patch Changes

- Updated dependencies [0d51638]
- Updated dependencies [0d51638]
- Updated dependencies [0d51638]
  - @cat-factory/integrations@0.56.2
  - @cat-factory/server@0.68.1
  - @cat-factory/kernel@0.70.1
  - @cat-factory/orchestration@0.59.1
  - @cat-factory/agents@0.26.14
  - @cat-factory/gates@0.2.71

## 0.9.94

### Patch Changes

- Updated dependencies [eb67d40]
  - @cat-factory/kernel@0.70.0
  - @cat-factory/orchestration@0.59.0
  - @cat-factory/server@0.68.0
  - @cat-factory/agents@0.26.13
  - @cat-factory/gates@0.2.70
  - @cat-factory/integrations@0.56.1

## 0.9.93

### Patch Changes

- Updated dependencies [5ce03c6]
  - @cat-factory/contracts@0.82.0
  - @cat-factory/integrations@0.56.0
  - @cat-factory/server@0.67.0
  - @cat-factory/agents@0.26.12
  - @cat-factory/gates@0.2.69
  - @cat-factory/kernel@0.69.8
  - @cat-factory/orchestration@0.58.1
  - @cat-factory/prompt-fragments@0.9.42

## 0.9.92

### Patch Changes

- Updated dependencies [7f9d215]
- Updated dependencies [05d1b08]
  - @cat-factory/kernel@0.69.7
  - @cat-factory/orchestration@0.58.0
  - @cat-factory/server@0.66.7
  - @cat-factory/integrations@0.55.0
  - @cat-factory/agents@0.26.11
  - @cat-factory/gates@0.2.68

## 0.9.91

### Patch Changes

- Updated dependencies [4955639]
  - @cat-factory/agents@0.26.10
  - @cat-factory/orchestration@0.57.7
  - @cat-factory/server@0.66.6

## 0.9.90

### Patch Changes

- Updated dependencies [4a7a3f1]
  - @cat-factory/contracts@0.81.3
  - @cat-factory/server@0.66.5
  - @cat-factory/orchestration@0.57.6
  - @cat-factory/agents@0.26.9
  - @cat-factory/gates@0.2.67
  - @cat-factory/integrations@0.54.3
  - @cat-factory/kernel@0.69.6
  - @cat-factory/prompt-fragments@0.9.41

## 0.9.89

### Patch Changes

- Updated dependencies [6347d0e]
- Updated dependencies [6439181]
  - @cat-factory/server@0.66.4

## 0.9.88

### Patch Changes

- Updated dependencies [6243bea]
  - @cat-factory/contracts@0.81.2
  - @cat-factory/integrations@0.54.2
  - @cat-factory/server@0.66.3
  - @cat-factory/agents@0.26.8
  - @cat-factory/gates@0.2.66
  - @cat-factory/kernel@0.69.5
  - @cat-factory/orchestration@0.57.5
  - @cat-factory/prompt-fragments@0.9.40

## 0.9.87

### Patch Changes

- Updated dependencies [fc8df61]
  - @cat-factory/agents@0.26.7
  - @cat-factory/server@0.66.2
  - @cat-factory/orchestration@0.57.4

## 0.9.86

### Patch Changes

- Updated dependencies [2a91615]
  - @cat-factory/contracts@0.81.1
  - @cat-factory/orchestration@0.57.3
  - @cat-factory/integrations@0.54.1
  - @cat-factory/server@0.66.1
  - @cat-factory/agents@0.26.6
  - @cat-factory/gates@0.2.65
  - @cat-factory/kernel@0.69.4
  - @cat-factory/prompt-fragments@0.9.39

## 0.9.85

### Patch Changes

- Updated dependencies [67d3876]
  - @cat-factory/contracts@0.81.0
  - @cat-factory/integrations@0.54.0
  - @cat-factory/server@0.66.0
  - @cat-factory/agents@0.26.5
  - @cat-factory/gates@0.2.64
  - @cat-factory/kernel@0.69.3
  - @cat-factory/orchestration@0.57.2
  - @cat-factory/prompt-fragments@0.9.38

## 0.9.84

### Patch Changes

- d7f6e1c: Correctness fixes across the engine, the Node facade, and the SPA stores:

  - **Engine:** `finalizeMerge` and the merger resolver are now idempotent under
    durable-driver replays — a re-resolved merger step on an already-`done` (= merged)
    block is a no-op instead of re-merging, downgrading the block to `pr_ready`, and
    raising a spurious `merge_review` notification. `approveStep` now runs under the same
    optimistic-concurrency write as its siblings (`resolveDecision`/`requestStepChanges`),
    so an approve holding a stale snapshot can no longer resurrect a run a racing reject
    already failed (it now returns 409).
  - **CI gate (behavior change):** a check run concluding `stale` (superseded by GitHub)
    no longer fails the CI gate — previously it looped the `ci-fixer` against a check it
    could never fix until the attempt budget failed the run. `cancelled`/`timed_out`/
    `action_required` still fail the gate.
  - **Node facade parity:** the retention sweep now prunes the `github_commits`
    projection to `retention.commitMs` (previously it grew without bound; the Worker
    already pruned it), and a new every-2-min GitHub reconcile sweeper re-syncs stale
    repo projections and tombstones uninstalled installations — the backstop for missed
    webhooks the Worker's `github-reconcile` cron already provided.
  - **SPA stores:** the execution store now reconciles snapshots/events monotonically by
    the run's `rev` (a lagging refresh can no longer revert a just-terminal run to
    `running`), the requirements/clarity/brainstorm stores guard live-event upserts by
    `updatedAt` (out-of-order events no longer revert just-submitted answers), and
    `board.moveBlock`/`updateBlock` roll their optimistic mutation back on API failure.

- Updated dependencies [d7f6e1c]
- Updated dependencies [63cf6de]
  - @cat-factory/kernel@0.69.2
  - @cat-factory/orchestration@0.57.1
  - @cat-factory/contracts@0.80.1
  - @cat-factory/integrations@0.53.2
  - @cat-factory/server@0.65.2
  - @cat-factory/agents@0.26.4
  - @cat-factory/gates@0.2.63
  - @cat-factory/prompt-fragments@0.9.37

## 0.9.83

### Patch Changes

- Updated dependencies [120de05]
  - @cat-factory/contracts@0.80.0
  - @cat-factory/orchestration@0.57.0
  - @cat-factory/kernel@0.69.1
  - @cat-factory/agents@0.26.3
  - @cat-factory/gates@0.2.62
  - @cat-factory/integrations@0.53.1
  - @cat-factory/prompt-fragments@0.9.36
  - @cat-factory/server@0.65.1

## 0.9.82

### Patch Changes

- Updated dependencies [dcc8b32]
  - @cat-factory/orchestration@0.56.0
  - @cat-factory/integrations@0.53.0
  - @cat-factory/contracts@0.79.0
  - @cat-factory/kernel@0.69.0
  - @cat-factory/server@0.65.0
  - @cat-factory/agents@0.26.2
  - @cat-factory/gates@0.2.61
  - @cat-factory/prompt-fragments@0.9.35

## 0.9.81

### Patch Changes

- Updated dependencies [16ee6cc]
- Updated dependencies [16ee6cc]
  - @cat-factory/orchestration@0.55.1
  - @cat-factory/contracts@0.78.1
  - @cat-factory/kernel@0.68.1
  - @cat-factory/server@0.64.4
  - @cat-factory/agents@0.26.1
  - @cat-factory/gates@0.2.60
  - @cat-factory/integrations@0.52.2
  - @cat-factory/prompt-fragments@0.9.34

## 0.9.80

### Patch Changes

- Updated dependencies [6da6637]
  - @cat-factory/server@0.64.3

## 0.9.79

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/contracts@0.78.0
  - @cat-factory/kernel@0.68.0
  - @cat-factory/agents@0.26.0
  - @cat-factory/orchestration@0.55.0
  - @cat-factory/gates@0.2.59
  - @cat-factory/integrations@0.52.1
  - @cat-factory/prompt-fragments@0.9.33
  - @cat-factory/server@0.64.2

## 0.9.78

### Patch Changes

- Updated dependencies [08be94c]
  - @cat-factory/orchestration@0.54.1
  - @cat-factory/server@0.64.1

## 0.9.77

### Patch Changes

- Updated dependencies [9e93fe8]
- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [edf4e69]
- Updated dependencies [f21279e]
- Updated dependencies [ab7d589]
- Updated dependencies [6c51e31]
- Updated dependencies [456a992]
- Updated dependencies [1d2684f]
- Updated dependencies [33687cf]
  - @cat-factory/contracts@0.77.0
  - @cat-factory/server@0.64.0
  - @cat-factory/kernel@0.67.0
  - @cat-factory/integrations@0.52.0
  - @cat-factory/orchestration@0.54.0
  - @cat-factory/agents@0.25.0
  - @cat-factory/gates@0.2.58
  - @cat-factory/prompt-fragments@0.9.32

## 0.9.76

### Patch Changes

- Updated dependencies [3135ae8]
  - @cat-factory/server@0.63.3

## 0.9.75

### Patch Changes

- Updated dependencies [39534d6]
  - @cat-factory/server@0.63.2

## 0.9.74

### Patch Changes

- Updated dependencies [eab2b60]
  - @cat-factory/server@0.63.1

## 0.9.73

### Patch Changes

- Updated dependencies [762fe66]
  - @cat-factory/contracts@0.76.0
  - @cat-factory/server@0.63.0
  - @cat-factory/agents@0.24.16
  - @cat-factory/gates@0.2.57
  - @cat-factory/integrations@0.51.4
  - @cat-factory/kernel@0.66.1
  - @cat-factory/orchestration@0.53.2
  - @cat-factory/prompt-fragments@0.9.31

## 0.9.72

### Patch Changes

- Updated dependencies [fb53662]
  - @cat-factory/kernel@0.66.0
  - @cat-factory/contracts@0.75.0
  - @cat-factory/orchestration@0.53.1
  - @cat-factory/agents@0.24.15
  - @cat-factory/gates@0.2.56
  - @cat-factory/integrations@0.51.3
  - @cat-factory/server@0.62.3
  - @cat-factory/prompt-fragments@0.9.30

## 0.9.71

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/contracts@0.74.0
  - @cat-factory/kernel@0.65.0
  - @cat-factory/orchestration@0.53.0
  - @cat-factory/agents@0.24.14
  - @cat-factory/gates@0.2.55
  - @cat-factory/integrations@0.51.2
  - @cat-factory/prompt-fragments@0.9.29
  - @cat-factory/server@0.62.2

## 0.9.70

### Patch Changes

- Updated dependencies [d4d4cbc]
  - @cat-factory/server@0.62.1
  - @cat-factory/integrations@0.51.1
  - @cat-factory/orchestration@0.52.1

## 0.9.69

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/contracts@0.73.0
  - @cat-factory/kernel@0.64.0
  - @cat-factory/integrations@0.51.0
  - @cat-factory/server@0.62.0
  - @cat-factory/orchestration@0.52.0
  - @cat-factory/agents@0.24.13
  - @cat-factory/gates@0.2.54
  - @cat-factory/prompt-fragments@0.9.28

## 0.9.68

### Patch Changes

- Updated dependencies [70e321b]
  - @cat-factory/contracts@0.72.0
  - @cat-factory/server@0.61.0
  - @cat-factory/agents@0.24.12
  - @cat-factory/gates@0.2.53
  - @cat-factory/integrations@0.50.2
  - @cat-factory/kernel@0.63.4
  - @cat-factory/orchestration@0.51.7
  - @cat-factory/prompt-fragments@0.9.27

## 0.9.67

### Patch Changes

- Updated dependencies [37c488f]
  - @cat-factory/server@0.60.3

## 0.9.66

### Patch Changes

- Updated dependencies [b744822]
- Updated dependencies [c40736e]
  - @cat-factory/integrations@0.50.1
  - @cat-factory/orchestration@0.51.6
  - @cat-factory/server@0.60.2

## 0.9.65

### Patch Changes

- Updated dependencies [77c6842]
  - @cat-factory/contracts@0.71.0
  - @cat-factory/integrations@0.50.0
  - @cat-factory/agents@0.24.11
  - @cat-factory/gates@0.2.52
  - @cat-factory/kernel@0.63.3
  - @cat-factory/orchestration@0.51.5
  - @cat-factory/prompt-fragments@0.9.26
  - @cat-factory/server@0.60.1

## 0.9.64

### Patch Changes

- Updated dependencies [79a0f48]
- Updated dependencies [91f876b]
  - @cat-factory/integrations@0.49.0
  - @cat-factory/server@0.60.0
  - @cat-factory/orchestration@0.51.4

## 0.9.63

### Patch Changes

- Updated dependencies [2e1354f]
  - @cat-factory/contracts@0.70.1
  - @cat-factory/kernel@0.63.2
  - @cat-factory/integrations@0.48.2
  - @cat-factory/server@0.59.2
  - @cat-factory/agents@0.24.10
  - @cat-factory/gates@0.2.51
  - @cat-factory/orchestration@0.51.3
  - @cat-factory/prompt-fragments@0.9.25

## 0.9.62

### Patch Changes

- Updated dependencies [66a8c71]
  - @cat-factory/integrations@0.48.1
  - @cat-factory/orchestration@0.51.2
  - @cat-factory/server@0.59.1

## 0.9.61

### Patch Changes

- Updated dependencies [b4c7e60]
  - @cat-factory/contracts@0.70.0
  - @cat-factory/integrations@0.48.0
  - @cat-factory/server@0.59.0
  - @cat-factory/agents@0.24.9
  - @cat-factory/gates@0.2.50
  - @cat-factory/kernel@0.63.1
  - @cat-factory/orchestration@0.51.1
  - @cat-factory/prompt-fragments@0.9.24

## 0.9.60

### Patch Changes

- Updated dependencies [f568a8c]
  - @cat-factory/kernel@0.63.0
  - @cat-factory/contracts@0.69.0
  - @cat-factory/orchestration@0.51.0
  - @cat-factory/server@0.58.0
  - @cat-factory/agents@0.24.8
  - @cat-factory/gates@0.2.49
  - @cat-factory/integrations@0.47.1
  - @cat-factory/prompt-fragments@0.9.23

## 0.9.59

### Patch Changes

- Updated dependencies [41203db]
  - @cat-factory/contracts@0.68.0
  - @cat-factory/integrations@0.47.0
  - @cat-factory/server@0.57.0
  - @cat-factory/agents@0.24.7
  - @cat-factory/gates@0.2.48
  - @cat-factory/kernel@0.62.4
  - @cat-factory/orchestration@0.50.1
  - @cat-factory/prompt-fragments@0.9.22

## 0.9.58

### Patch Changes

- Updated dependencies [3ec9c90]
  - @cat-factory/server@0.56.1

## 0.9.57

### Patch Changes

- Updated dependencies [cb9e2e3]
  - @cat-factory/contracts@0.67.0
  - @cat-factory/integrations@0.46.0
  - @cat-factory/orchestration@0.50.0
  - @cat-factory/server@0.56.0
  - @cat-factory/agents@0.24.6
  - @cat-factory/gates@0.2.47
  - @cat-factory/kernel@0.62.3
  - @cat-factory/prompt-fragments@0.9.21

## 0.9.56

### Patch Changes

- Updated dependencies [1e55e77]
  - @cat-factory/contracts@0.66.1
  - @cat-factory/integrations@0.45.0
  - @cat-factory/orchestration@0.49.0
  - @cat-factory/agents@0.24.5
  - @cat-factory/gates@0.2.46
  - @cat-factory/kernel@0.62.2
  - @cat-factory/prompt-fragments@0.9.20
  - @cat-factory/server@0.55.2

## 0.9.55

### Patch Changes

- Updated dependencies [ecf4cc1]
  - @cat-factory/contracts@0.66.0
  - @cat-factory/orchestration@0.48.2
  - @cat-factory/agents@0.24.4
  - @cat-factory/gates@0.2.45
  - @cat-factory/integrations@0.44.1
  - @cat-factory/kernel@0.62.1
  - @cat-factory/prompt-fragments@0.9.19
  - @cat-factory/server@0.55.1

## 0.9.54

### Patch Changes

- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [858799e]
  - @cat-factory/server@0.55.0
  - @cat-factory/contracts@0.65.0
  - @cat-factory/orchestration@0.48.1
  - @cat-factory/kernel@0.62.0
  - @cat-factory/integrations@0.44.0
  - @cat-factory/agents@0.24.3
  - @cat-factory/gates@0.2.44
  - @cat-factory/prompt-fragments@0.9.18

## 0.9.53

### Patch Changes

- Updated dependencies [9bb75b0]
  - @cat-factory/contracts@0.64.0
  - @cat-factory/integrations@0.43.0
  - @cat-factory/orchestration@0.48.0
  - @cat-factory/server@0.54.0
  - @cat-factory/agents@0.24.2
  - @cat-factory/gates@0.2.43
  - @cat-factory/kernel@0.61.1
  - @cat-factory/prompt-fragments@0.9.17

## 0.9.52

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/server@0.53.0
  - @cat-factory/contracts@0.63.0
  - @cat-factory/kernel@0.61.0
  - @cat-factory/agents@0.24.1
  - @cat-factory/gates@0.2.42
  - @cat-factory/integrations@0.42.1
  - @cat-factory/orchestration@0.47.1
  - @cat-factory/prompt-fragments@0.9.16

## 0.9.51

### Patch Changes

- Updated dependencies [f383515]
  - @cat-factory/kernel@0.60.0
  - @cat-factory/contracts@0.62.0
  - @cat-factory/agents@0.24.0
  - @cat-factory/orchestration@0.47.0
  - @cat-factory/integrations@0.42.0
  - @cat-factory/server@0.52.0
  - @cat-factory/gates@0.2.41
  - @cat-factory/prompt-fragments@0.9.15

## 0.9.50

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/kernel@0.59.0
  - @cat-factory/contracts@0.61.0
  - @cat-factory/agents@0.23.4
  - @cat-factory/gates@0.2.40
  - @cat-factory/integrations@0.41.1
  - @cat-factory/orchestration@0.46.1
  - @cat-factory/server@0.51.3
  - @cat-factory/prompt-fragments@0.9.14

## 0.9.49

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/kernel@0.58.0
  - @cat-factory/integrations@0.41.0
  - @cat-factory/orchestration@0.46.0
  - @cat-factory/agents@0.23.3
  - @cat-factory/gates@0.2.39
  - @cat-factory/server@0.51.2
  - @cat-factory/prompt-fragments@0.9.13

## 0.9.48

### Patch Changes

- Updated dependencies [6009266]
  - @cat-factory/agents@0.23.2
  - @cat-factory/integrations@0.40.1
  - @cat-factory/kernel@0.57.1
  - @cat-factory/orchestration@0.45.3
  - @cat-factory/server@0.51.1
  - @cat-factory/gates@0.2.38

## 0.9.47

### Patch Changes

- Updated dependencies [bd23c46]
- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/server@0.51.0
  - @cat-factory/kernel@0.57.0
  - @cat-factory/integrations@0.40.0
  - @cat-factory/agents@0.23.1
  - @cat-factory/gates@0.2.37
  - @cat-factory/orchestration@0.45.2
  - @cat-factory/prompt-fragments@0.9.12

## 0.9.46

### Patch Changes

- Updated dependencies [2ac148d]
  - @cat-factory/integrations@0.39.0
  - @cat-factory/orchestration@0.45.1
  - @cat-factory/server@0.50.3

## 0.9.45

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/orchestration@0.45.0
  - @cat-factory/agents@0.23.0
  - @cat-factory/server@0.50.2
  - @cat-factory/gates@0.2.36
  - @cat-factory/integrations@0.38.1
  - @cat-factory/kernel@0.56.1
  - @cat-factory/prompt-fragments@0.9.11

## 0.9.44

### Patch Changes

- Updated dependencies [1ff013f]
  - @cat-factory/server@0.50.1
  - @cat-factory/orchestration@0.44.1
  - @cat-factory/gates@0.2.35

## 0.9.43

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/kernel@0.56.0
  - @cat-factory/server@0.50.0
  - @cat-factory/orchestration@0.44.0
  - @cat-factory/integrations@0.38.0
  - @cat-factory/agents@0.22.6
  - @cat-factory/gates@0.2.34
  - @cat-factory/prompt-fragments@0.9.10

## 0.9.42

### Patch Changes

- Updated dependencies [fdeb466]
  - @cat-factory/kernel@0.55.4
  - @cat-factory/orchestration@0.43.4
  - @cat-factory/integrations@0.37.1
  - @cat-factory/agents@0.22.5
  - @cat-factory/gates@0.2.33
  - @cat-factory/server@0.49.6

## 0.9.41

### Patch Changes

- Updated dependencies [0dd9532]
  - @cat-factory/server@0.49.5

## 0.9.40

### Patch Changes

- Updated dependencies [21b2096]
  - @cat-factory/integrations@0.37.0
  - @cat-factory/orchestration@0.43.3
  - @cat-factory/server@0.49.4
  - @cat-factory/agents@0.22.4
  - @cat-factory/gates@0.2.32
  - @cat-factory/kernel@0.55.3
  - @cat-factory/prompt-fragments@0.9.9

## 0.9.39

### Patch Changes

- Updated dependencies [123336c]
  - @cat-factory/server@0.49.3

## 0.9.38

### Patch Changes

- Updated dependencies [4ec514a]
  - @cat-factory/server@0.49.2

## 0.9.37

### Patch Changes

- Updated dependencies [ad5d3e0]
  - @cat-factory/server@0.49.1
  - @cat-factory/agents@0.22.3
  - @cat-factory/gates@0.2.31
  - @cat-factory/integrations@0.36.1
  - @cat-factory/kernel@0.55.2
  - @cat-factory/orchestration@0.43.2
  - @cat-factory/prompt-fragments@0.9.8

## 0.9.36

### Patch Changes

- Updated dependencies [4897078]
  - @cat-factory/integrations@0.36.0
  - @cat-factory/server@0.49.0
  - @cat-factory/agents@0.22.2
  - @cat-factory/gates@0.2.30
  - @cat-factory/kernel@0.55.1
  - @cat-factory/orchestration@0.43.1
  - @cat-factory/prompt-fragments@0.9.7

## 0.9.35

### Patch Changes

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

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/kernel@0.55.0
  - @cat-factory/server@0.48.4
  - @cat-factory/orchestration@0.43.0
  - @cat-factory/agents@0.22.1
  - @cat-factory/gates@0.2.29
  - @cat-factory/integrations@0.35.4
  - @cat-factory/prompt-fragments@0.9.6

## 0.9.34

### Patch Changes

- Updated dependencies [b76f303]
  - @cat-factory/orchestration@0.42.1
  - @cat-factory/server@0.48.3

## 0.9.33

### Patch Changes

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/kernel@0.54.0
  - @cat-factory/orchestration@0.42.0
  - @cat-factory/server@0.48.2
  - @cat-factory/agents@0.22.0
  - @cat-factory/gates@0.2.28
  - @cat-factory/integrations@0.35.3
  - @cat-factory/prompt-fragments@0.9.5

## 0.9.32

### Patch Changes

- Updated dependencies [614e985]
  - @cat-factory/integrations@0.35.2
  - @cat-factory/orchestration@0.41.4
  - @cat-factory/server@0.48.1

## 0.9.31

### Patch Changes

- Updated dependencies [0577404]
  - @cat-factory/server@0.48.0
  - @cat-factory/agents@0.21.17
  - @cat-factory/gates@0.2.27
  - @cat-factory/integrations@0.35.1
  - @cat-factory/kernel@0.53.1
  - @cat-factory/orchestration@0.41.3
  - @cat-factory/prompt-fragments@0.9.4

## 0.9.30

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/kernel@0.53.0
  - @cat-factory/integrations@0.35.0
  - @cat-factory/server@0.47.0
  - @cat-factory/orchestration@0.41.2
  - @cat-factory/agents@0.21.16
  - @cat-factory/gates@0.2.26
  - @cat-factory/prompt-fragments@0.9.3

## 0.9.29

### Patch Changes

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0
  - @cat-factory/server@0.46.3
  - @cat-factory/orchestration@0.41.1
  - @cat-factory/integrations@0.34.1
  - @cat-factory/agents@0.21.15
  - @cat-factory/gates@0.2.25
  - @cat-factory/prompt-fragments@0.9.2

## 0.9.28

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/kernel@0.51.0
  - @cat-factory/integrations@0.34.0
  - @cat-factory/orchestration@0.41.0
  - @cat-factory/agents@0.21.14
  - @cat-factory/gates@0.2.24
  - @cat-factory/prompt-fragments@0.9.1
  - @cat-factory/server@0.46.2

## 0.9.27

### Patch Changes

- Updated dependencies [e0f1149]
  - @cat-factory/kernel@0.50.0
  - @cat-factory/integrations@0.33.0
  - @cat-factory/prompt-fragments@0.9.0
  - @cat-factory/server@0.46.1
  - @cat-factory/orchestration@0.40.2
  - @cat-factory/agents@0.21.13
  - @cat-factory/gates@0.2.23

## 0.9.26

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/kernel@0.49.0
  - @cat-factory/integrations@0.32.0
  - @cat-factory/server@0.46.0
  - @cat-factory/orchestration@0.40.1
  - @cat-factory/agents@0.21.12
  - @cat-factory/gates@0.2.22
  - @cat-factory/prompt-fragments@0.8.9

## 0.9.25

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/kernel@0.48.0
  - @cat-factory/server@0.45.0
  - @cat-factory/integrations@0.31.0
  - @cat-factory/orchestration@0.40.0
  - @cat-factory/agents@0.21.11
  - @cat-factory/gates@0.2.21
  - @cat-factory/prompt-fragments@0.8.8

## 0.9.24

### Patch Changes

- Updated dependencies [704c99e]
  - @cat-factory/integrations@0.30.0
  - @cat-factory/server@0.44.0
  - @cat-factory/orchestration@0.39.2
  - @cat-factory/agents@0.21.10
  - @cat-factory/gates@0.2.20
  - @cat-factory/kernel@0.47.2
  - @cat-factory/prompt-fragments@0.8.7

## 0.9.23

### Patch Changes

- Updated dependencies [2961b05]
  - @cat-factory/server@0.43.0

## 0.9.22

### Patch Changes

- Updated dependencies [5ad45de]
  - @cat-factory/orchestration@0.39.1
  - @cat-factory/server@0.42.1

## 0.9.21

### Patch Changes

- Updated dependencies [3d0b85c]
  - @cat-factory/server@0.42.0
  - @cat-factory/integrations@0.29.0
  - @cat-factory/orchestration@0.39.0

## 0.9.20

### Patch Changes

- Updated dependencies [c2ec53b]
  - @cat-factory/server@0.41.1
  - @cat-factory/agents@0.21.9
  - @cat-factory/gates@0.2.19
  - @cat-factory/integrations@0.28.1
  - @cat-factory/kernel@0.47.1
  - @cat-factory/orchestration@0.38.1
  - @cat-factory/prompt-fragments@0.8.6

## 0.9.19

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0
  - @cat-factory/integrations@0.28.0
  - @cat-factory/server@0.41.0
  - @cat-factory/orchestration@0.38.0
  - @cat-factory/agents@0.21.8
  - @cat-factory/gates@0.2.18
  - @cat-factory/prompt-fragments@0.8.5

## 0.9.18

### Patch Changes

- Updated dependencies [0784fe0]
- Updated dependencies [0784fe0]
  - @cat-factory/orchestration@0.37.3
  - @cat-factory/server@0.40.3

## 0.9.17

### Patch Changes

- Updated dependencies [5e54936]
- Updated dependencies [5e54936]
  - @cat-factory/orchestration@0.37.2
  - @cat-factory/server@0.40.2

## 0.9.16

### Patch Changes

- Updated dependencies [cc101a7]
  - @cat-factory/orchestration@0.37.1
  - @cat-factory/server@0.40.1

## 0.9.15

### Patch Changes

- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/orchestration@0.37.0
  - @cat-factory/kernel@0.46.0
  - @cat-factory/integrations@0.27.0
  - @cat-factory/server@0.40.0
  - @cat-factory/agents@0.21.7
  - @cat-factory/gates@0.2.17
  - @cat-factory/prompt-fragments@0.8.4

## 0.9.14

### Patch Changes

- Updated dependencies [8fad695]
  - @cat-factory/integrations@0.26.5
  - @cat-factory/orchestration@0.36.5
  - @cat-factory/kernel@0.45.5
  - @cat-factory/agents@0.21.6
  - @cat-factory/gates@0.2.16
  - @cat-factory/prompt-fragments@0.8.3

## 0.9.13

### Patch Changes

- @cat-factory/agents@0.21.5
- @cat-factory/gates@0.2.15
- @cat-factory/integrations@0.26.4
- @cat-factory/kernel@0.45.4
- @cat-factory/orchestration@0.36.4
- @cat-factory/prompt-fragments@0.8.2

## 0.9.12

### Patch Changes

- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3
  - @cat-factory/orchestration@0.36.3
  - @cat-factory/agents@0.21.4
  - @cat-factory/gates@0.2.14
  - @cat-factory/integrations@0.26.3

## 0.9.11

### Patch Changes

- Updated dependencies [c11a0cc]
  - @cat-factory/agents@0.21.3
  - @cat-factory/gates@0.2.13
  - @cat-factory/integrations@0.26.2
  - @cat-factory/kernel@0.45.2
  - @cat-factory/orchestration@0.36.2
  - @cat-factory/prompt-fragments@0.8.1

## 0.9.10

### Patch Changes

- Updated dependencies [5363166]
- Updated dependencies [5363166]
  - @cat-factory/orchestration@0.36.1
  - @cat-factory/kernel@0.45.1
  - @cat-factory/agents@0.21.2
  - @cat-factory/gates@0.2.12
  - @cat-factory/integrations@0.26.1

## 0.9.9

### Patch Changes

- Updated dependencies [eab73b8]
- Updated dependencies [eab73b8]
  - @cat-factory/kernel@0.45.0
  - @cat-factory/integrations@0.26.0
  - @cat-factory/orchestration@0.36.0
  - @cat-factory/prompt-fragments@0.8.0
  - @cat-factory/agents@0.21.1
  - @cat-factory/gates@0.2.11

## 0.9.8

### Patch Changes

- Updated dependencies [67c7196]
  - @cat-factory/orchestration@0.35.1

## 0.9.7

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/kernel@0.44.0
  - @cat-factory/agents@0.21.0
  - @cat-factory/orchestration@0.35.0
  - @cat-factory/gates@0.2.10
  - @cat-factory/integrations@0.25.2
  - @cat-factory/prompt-fragments@0.7.41

## 0.9.6

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/kernel@0.43.0
  - @cat-factory/agents@0.20.3
  - @cat-factory/gates@0.2.9
  - @cat-factory/integrations@0.25.1
  - @cat-factory/orchestration@0.34.1

## 0.9.5

### Patch Changes

- Updated dependencies [63e2177]
  - @cat-factory/integrations@0.25.0
  - @cat-factory/orchestration@0.34.0
  - @cat-factory/agents@0.20.2
  - @cat-factory/gates@0.2.8
  - @cat-factory/kernel@0.42.2
  - @cat-factory/prompt-fragments@0.7.40

## 0.9.4

### Patch Changes

- Updated dependencies [6903cd7]
  - @cat-factory/orchestration@0.33.0

## 0.9.3

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/kernel@0.42.1
  - @cat-factory/agents@0.20.1
  - @cat-factory/gates@0.2.7
  - @cat-factory/integrations@0.24.1
  - @cat-factory/orchestration@0.32.1
  - @cat-factory/prompt-fragments@0.7.39

## 0.9.2

### Patch Changes

- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
  - @cat-factory/kernel@0.42.0
  - @cat-factory/agents@0.20.0
  - @cat-factory/orchestration@0.32.0
  - @cat-factory/integrations@0.24.0
  - @cat-factory/gates@0.2.6
  - @cat-factory/prompt-fragments@0.7.38

## 0.9.1

### Patch Changes

- Updated dependencies [b5231b0]
  - @cat-factory/kernel@0.41.0
  - @cat-factory/agents@0.19.0
  - @cat-factory/orchestration@0.31.0
  - @cat-factory/gates@0.2.5
  - @cat-factory/integrations@0.23.5
  - @cat-factory/prompt-fragments@0.7.37

## 0.9.0

### Minor Changes

- 6d829bb: Make invalid-state pipelines more robust. On app open, a startup advisory surfaces pipelines that
  reference a nonexistent agent kind or have an invalid shape (delete a custom one, reseed a built-in)
  and built-in pipelines whose seeded definition is newer than the stored copy (reseed to adopt it).

  Built-in pipelines now carry a per-pipeline `version` (persisted on both runtimes via a new D1
  migration and a Drizzle column), the snapshot ships the current catalog versions
  (`pipelineCatalogVersions`), and a new `POST /workspaces/:ws/pipelines/:id/reseed` endpoint restores a
  built-in's canonical definition while preserving its labels/archive state.

  BREAKING: existing workspaces' persisted built-in pipelines have no stored `version`, so they read as
  "update available" once until reseeded — intentional adoption of the now-versioned definitions.

### Patch Changes

- Updated dependencies [6d829bb]
  - @cat-factory/kernel@0.40.0
  - @cat-factory/orchestration@0.30.0
  - @cat-factory/agents@0.18.5
  - @cat-factory/gates@0.2.4
  - @cat-factory/integrations@0.23.4
  - @cat-factory/prompt-fragments@0.7.36

## 0.8.7

### Patch Changes

- Updated dependencies [714b7c9]
  - @cat-factory/kernel@0.39.0
  - @cat-factory/orchestration@0.29.0
  - @cat-factory/agents@0.18.4
  - @cat-factory/gates@0.2.3
  - @cat-factory/integrations@0.23.3
  - @cat-factory/prompt-fragments@0.7.35

## 0.8.6

### Patch Changes

- @cat-factory/agents@0.18.3
- @cat-factory/gates@0.2.2
- @cat-factory/integrations@0.23.2
- @cat-factory/kernel@0.38.1
- @cat-factory/orchestration@0.28.3
- @cat-factory/prompt-fragments@0.7.34

## 0.8.5

### Patch Changes

- Updated dependencies [692ccb4]
  - @cat-factory/agents@0.18.2
  - @cat-factory/orchestration@0.28.2

## 0.8.4

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/kernel@0.38.0
  - @cat-factory/agents@0.18.1
  - @cat-factory/gates@0.2.1
  - @cat-factory/integrations@0.23.1
  - @cat-factory/orchestration@0.28.1
  - @cat-factory/prompt-fragments@0.7.33

## 0.8.3

### Patch Changes

- Updated dependencies [76543fa]
  - @cat-factory/kernel@0.37.0
  - @cat-factory/gates@0.2.0
  - @cat-factory/agents@0.18.0
  - @cat-factory/orchestration@0.28.0
  - @cat-factory/integrations@0.23.0
  - @cat-factory/prompt-fragments@0.7.32

## 0.8.2

### Patch Changes

- Updated dependencies [17adf4c]
  - @cat-factory/integrations@0.22.0
  - @cat-factory/kernel@0.36.0
  - @cat-factory/orchestration@0.27.1
  - @cat-factory/agents@0.17.2
  - @cat-factory/gates@0.1.13
  - @cat-factory/prompt-fragments@0.7.31

## 0.8.1

### Patch Changes

- Updated dependencies [eb48652]
  - @cat-factory/kernel@0.35.0
  - @cat-factory/orchestration@0.27.0
  - @cat-factory/agents@0.17.1
  - @cat-factory/gates@0.1.12
  - @cat-factory/integrations@0.21.7
  - @cat-factory/prompt-fragments@0.7.30

## 0.8.0

### Minor Changes

- 9f7ee39: Add "Requirements brainstorm" and "Architecture brainstorm" agents — structured-dialogue
  gates that PROPOSE options with explicit trade-offs and let a human converge on a direction,
  rather than doing all the work themselves or expecting the work done upfront.

  - One shared, stage-discriminated engine (`BrainstormService` over the existing
    `IterativeReviewService`), driven through the generic `ReviewGateController`. Two agent kinds
    (`requirements-brainstorm`, `architecture-brainstorm`) reuse it via a stage-bound repository
    adapter.
  - Persistence: a new `brainstorm_sessions` table keyed per (block, **stage**) — a block may hold
    a live requirements AND a live architecture session at once — mirrored across both runtimes
    (D1 + Drizzle/Postgres) with a cross-runtime conformance suite.
  - Handoffs (DB session state → next stage's prompt): `requirements-brainstorm` → the
    requirements review (its converged direction becomes the reviewed subject);
    `architecture-brainstorm` → the architect (surfaced additively as a prior output).
  - Pipelines: both steps are added to `pl_full` and `pl_fullstack` but **disabled by default**
    (opt-in per pipeline) — existing runs are unchanged.
  - Frontend: a shared brainstorm window (option cards with trade-offs → choose/steer/dismiss →
    incorporate → re-run), wired through the result-view seam, the workspace stream, and the
    palette catalog.

  Breaking: adds a new required table on both runtimes (`brainstorm_sessions` D1 migration +
  Drizzle migration) and a new optional `ExecutionEventPublisher.brainstormSessionChanged` event.
  No data migration — pre-1.0, stale state is acceptable.

  The brainstorm iteration cap reuses the merge preset's `maxRequirementIterations` /
  `maxRequirementConcernAllowed` knobs (no new preset field).

### Patch Changes

- Updated dependencies [9f7ee39]
- Updated dependencies [81b60d4]
  - @cat-factory/kernel@0.34.0
  - @cat-factory/agents@0.17.0
  - @cat-factory/orchestration@0.26.0
  - @cat-factory/integrations@0.21.6
  - @cat-factory/gates@0.1.11
  - @cat-factory/prompt-fragments@0.7.29

## 0.7.44

### Patch Changes

- Updated dependencies [4dd6e97]
  - @cat-factory/agents@0.16.1
  - @cat-factory/orchestration@0.25.1

## 0.7.43

### Patch Changes

- Updated dependencies [ea59e91]
  - @cat-factory/kernel@0.33.0
  - @cat-factory/agents@0.16.0
  - @cat-factory/orchestration@0.25.0
  - @cat-factory/gates@0.1.10
  - @cat-factory/integrations@0.21.5
  - @cat-factory/prompt-fragments@0.7.28

## 0.7.42

### Patch Changes

- Updated dependencies [18f6b3b]
  - @cat-factory/integrations@0.21.4
  - @cat-factory/orchestration@0.24.2

## 0.7.41

### Patch Changes

- Updated dependencies [b82304e]
  - @cat-factory/kernel@0.32.0
  - @cat-factory/orchestration@0.24.1
  - @cat-factory/agents@0.15.2
  - @cat-factory/gates@0.1.9
  - @cat-factory/integrations@0.21.3
  - @cat-factory/prompt-fragments@0.7.27

## 0.7.40

### Patch Changes

- Updated dependencies [765cc42]
  - @cat-factory/kernel@0.31.0
  - @cat-factory/orchestration@0.24.0
  - @cat-factory/agents@0.15.1
  - @cat-factory/gates@0.1.8
  - @cat-factory/integrations@0.21.2
  - @cat-factory/prompt-fragments@0.7.26

## 0.7.39

### Patch Changes

- Updated dependencies [52d886a]
  - @cat-factory/kernel@0.30.0
  - @cat-factory/agents@0.15.0
  - @cat-factory/orchestration@0.23.0
  - @cat-factory/gates@0.1.7
  - @cat-factory/integrations@0.21.1
  - @cat-factory/prompt-fragments@0.7.25

## 0.7.38

### Patch Changes

- Updated dependencies [a639189]
  - @cat-factory/kernel@0.29.0
  - @cat-factory/integrations@0.21.0
  - @cat-factory/orchestration@0.22.0
  - @cat-factory/agents@0.14.9
  - @cat-factory/gates@0.1.6
  - @cat-factory/prompt-fragments@0.7.24

## 0.7.37

### Patch Changes

- Updated dependencies [ed3a673]
  - @cat-factory/orchestration@0.21.1
  - @cat-factory/agents@0.14.8
  - @cat-factory/gates@0.1.5
  - @cat-factory/integrations@0.20.1
  - @cat-factory/kernel@0.28.1
  - @cat-factory/prompt-fragments@0.7.23

## 0.7.36

### Patch Changes

- Updated dependencies [69d2270]
  - @cat-factory/orchestration@0.21.0
  - @cat-factory/kernel@0.28.0
  - @cat-factory/integrations@0.20.0
  - @cat-factory/agents@0.14.7
  - @cat-factory/gates@0.1.4
  - @cat-factory/prompt-fragments@0.7.22

## 0.7.35

### Patch Changes

- Updated dependencies [3546e3d]
  - @cat-factory/kernel@0.27.0
  - @cat-factory/integrations@0.19.0
  - @cat-factory/orchestration@0.20.0
  - @cat-factory/agents@0.14.6
  - @cat-factory/gates@0.1.3
  - @cat-factory/prompt-fragments@0.7.21

## 0.7.34

### Patch Changes

- Updated dependencies [a62044d]
  - @cat-factory/kernel@0.26.1
  - @cat-factory/orchestration@0.19.2
  - @cat-factory/agents@0.14.5
  - @cat-factory/gates@0.1.2
  - @cat-factory/integrations@0.18.3

## 0.7.33

### Patch Changes

- Updated dependencies [2aae8bc]
  - @cat-factory/kernel@0.26.0
  - @cat-factory/agents@0.14.4
  - @cat-factory/gates@0.1.1
  - @cat-factory/integrations@0.18.2
  - @cat-factory/orchestration@0.19.1

## 0.7.32

### Patch Changes

- f4f954b: Dogfood the extensible-gates seam: the built-in polling-gate suite (`ci`, `conflicts`,
  `post-release-health` + the `on-call` escalation) is no longer hard-coded in the engine —
  it ships as a new **`@cat-factory/gates`** package authored ENTIRELY through the public
  `registerGate` seam, depending only on kernel + contracts. If the platform's own gates can
  be expressed as an external package, so can any deployment's.

  **Breaking (pre-1.0, no migration):** the `ci` / `conflicts` / `post-release-health`
  providers leave the engine. `ciStatusProvider`, `mergeabilityProvider`,
  `releaseHealthProvider` and `incidentEnrichment` are removed from
  `ExecutionServiceDependencies` / `CoreDependencies`; a deployment now wires them into the
  gate suite via the exported `wireCiStatusProvider` / `wireMergeabilityProvider` /
  `wireReleaseHealthProvider` / `wireIncidentEnrichment` handles after
  `import '@cat-factory/gates'`. The merge collaborators (`pullRequestMerger`,
  `branchUpdater`) stay on the engine.

  - **gates (new)**: the three gate factories + the four provider wire-handles +
    `registerBuiltinGates()`, registered as an import side effect. Each gate is a
    pass-through until its provider is wired, so a bare import is always safe. Also exports
    `applyGateProviders(overrides)` + the `GateProviderOverrides` bag: a facade build resets
    the deployment-global providers up-front then re-wires from config, and this is the seam
    that re-applies explicit/faked providers AFTER that wiring (so they survive the Worker's
    per-request rebuild and override a config-wired provider) — used by the cross-runtime
    conformance suite to drive the externalized `ci` gate over a controlled verdict.
  - **kernel**: the pure gate logic (`aggregateCi`/`classifyReleaseHealth`/… +
    `renderReleaseEvidence`) and the gate/helper agent-kind constants move into
    `domain/gate-logic.ts` so a gate package can author a gate without depending on the
    engine. New `GateDefinition.resolveHelperCompletion` hook (+ `GateHelperJobResult` /
    `GateHelperCompletionArgs`): the seam an INVESTIGATE-don't-fix helper (`on-call`) needs
    to settle a gate without re-probing — the real gap the dogfood surfaced.
  - **orchestration**: the three inline gates + the bespoke `resolveOnCallStep` /
    `raiseReleaseRegression` / `enrichIncident` / `raiseCiFailed` branches are deleted; the
    engine builds its gate registry purely from what's registered, and drives an on-call-style
    helper completion through the generic `resolveHelperCompletion` hook. The **`merger`**
    step resolver stays a privileged built-in (reclassified): it owns terminal block status
    and executes a policy-gated real merge — a different archetype from the light, externally
    authorable resolvers, so it keeps its engine-internal access rather than the public seam.
  - **worker / node-server**: each facade `import`s `@cat-factory/gates` and wires its
    existing provider impls (`GitHubCiStatusProvider`, `RegistryReleaseHealthProvider`, …)
    via the `wireX` handles instead of threading them through the engine. `local-server`
    inherits this through `buildNodeContainer`.
  - **conformance**: a new cross-runtime assertion drives the externalized built-in `ci`
    gate (green pass-through, red → ci-fixer → re-probe) over a faked provider on both
    runtimes; the registered-gate test now restores the built-ins after clearing the shared
    registry.

- Updated dependencies [f4f954b]
  - @cat-factory/gates@0.1.0
  - @cat-factory/kernel@0.25.0
  - @cat-factory/orchestration@0.19.0
  - @cat-factory/agents@0.14.3
  - @cat-factory/integrations@0.18.1

## 0.7.31

### Patch Changes

- Updated dependencies [ce81233]
  - @cat-factory/kernel@0.24.0
  - @cat-factory/integrations@0.18.0
  - @cat-factory/agents@0.14.2
  - @cat-factory/orchestration@0.18.1
  - @cat-factory/prompt-fragments@0.7.20

## 0.7.30

### Patch Changes

- 7346a4f: Make the polling **Gate** and **StepCompletionResolver** mechanisms externally
  extensible, so a company-authored deployment package can register its OWN full-blown gate
  (deterministic probe + helper/companion agent + exhaustion handling) or step resolver
  purely via an import side effect — exactly the way it already registers a custom agent
  kind. No fork, no engine patch, and no executor-harness image change (pure backend TS).

  - **kernel**: new `domain/gate-registry.ts` (`registerGate(kind, factory)` +
    `GateDefinition`/`GateContext`/`GateProbe`/`recordGateAttempt`/…) and
    `domain/step-resolver-registry.ts` (`registerStepResolver(kind, factory)` +
    `StepCompletionResolver`/`ResolverContext`/…), moved out of orchestration so an
    extension package depends only on kernel + agents. `RaiseNotificationInput` moved to
    `ports/notification-channel.ts` so the runtime-neutral `GateContext` can build one. A
    registered gate/resolver is a `(ctx) => Definition` factory the engine invokes once at
    registry-build time — solving the `this`-capture the built-in gates rely on while
    keeping them inline and unchanged.
  - **orchestration**: `ExecutionService.buildGateRegistry()` /
    `buildStepResolverRegistry()` now merge the deployment-registered factories with the
    built-ins (registered replaces built-in of the same kind, last-wins) via new
    `makeGateContext()`/`makeResolverContext()` seams; the gate/resolver types are
    re-exported from the package index for discovery.
  - **example-custom-agent**: registers a `license-check` gate (escalating to a new
    `license-fixer` agent kind) + an auditor step resolver + a `wireLicenseProvider` seam,
    proving a custom gate ships with zero engine changes.
  - **conformance**: a new cross-runtime assertion drives a registered custom gate
    (pass-through, escalate-then-pass) and a registered step resolver on both runtimes.

- Updated dependencies [7346a4f]
  - @cat-factory/kernel@0.23.0
  - @cat-factory/orchestration@0.18.0
  - @cat-factory/agents@0.14.1
  - @cat-factory/integrations@0.17.1

## 0.7.29

### Patch Changes

- Updated dependencies [6ff1f10]
  - @cat-factory/kernel@0.22.0
  - @cat-factory/agents@0.14.0
  - @cat-factory/integrations@0.17.0
  - @cat-factory/orchestration@0.17.0
  - @cat-factory/prompt-fragments@0.7.19

## 0.7.28

### Patch Changes

- Updated dependencies [04befe8]
  - @cat-factory/kernel@0.21.0
  - @cat-factory/agents@0.13.0
  - @cat-factory/orchestration@0.16.0
  - @cat-factory/integrations@0.16.1
  - @cat-factory/prompt-fragments@0.7.18

## 0.7.27

### Patch Changes

- Updated dependencies [be182e8]
  - @cat-factory/kernel@0.20.0
  - @cat-factory/agents@0.12.0
  - @cat-factory/integrations@0.16.0
  - @cat-factory/orchestration@0.15.0

## 0.7.26

### Patch Changes

- Updated dependencies [2c24da8]
  - @cat-factory/kernel@0.19.0
  - @cat-factory/orchestration@0.14.0
  - @cat-factory/integrations@0.15.0
  - @cat-factory/agents@0.11.16
  - @cat-factory/prompt-fragments@0.7.17

## 0.7.25

### Patch Changes

- Updated dependencies [4120ac5]
  - @cat-factory/kernel@0.18.0
  - @cat-factory/orchestration@0.13.0
  - @cat-factory/integrations@0.14.0
  - @cat-factory/agents@0.11.15
  - @cat-factory/prompt-fragments@0.7.16

## 0.7.24

### Patch Changes

- Updated dependencies [25efe48]
  - @cat-factory/kernel@0.17.0
  - @cat-factory/integrations@0.13.0
  - @cat-factory/orchestration@0.12.0
  - @cat-factory/agents@0.11.14
  - @cat-factory/prompt-fragments@0.7.15

## 0.7.23

### Patch Changes

- Updated dependencies [c7b8012]
  - @cat-factory/kernel@0.16.2
  - @cat-factory/agents@0.11.13
  - @cat-factory/orchestration@0.11.1
  - @cat-factory/integrations@0.12.4
  - @cat-factory/prompt-fragments@0.7.14

## 0.7.22

### Patch Changes

- Updated dependencies [aa06003]
  - @cat-factory/orchestration@0.11.0
  - @cat-factory/kernel@0.16.1
  - @cat-factory/agents@0.11.12
  - @cat-factory/integrations@0.12.3
  - @cat-factory/prompt-fragments@0.7.13

## 0.7.21

### Patch Changes

- Updated dependencies [208c933]
  - @cat-factory/kernel@0.16.0
  - @cat-factory/agents@0.11.11
  - @cat-factory/integrations@0.12.2
  - @cat-factory/orchestration@0.10.9

## 0.7.20

### Patch Changes

- Updated dependencies [494fb34]
  - @cat-factory/kernel@0.15.1
  - @cat-factory/integrations@0.12.1
  - @cat-factory/agents@0.11.10
  - @cat-factory/orchestration@0.10.8

## 0.7.19

### Patch Changes

- Updated dependencies [0ac64b8]
  - @cat-factory/kernel@0.15.0
  - @cat-factory/integrations@0.12.0
  - @cat-factory/agents@0.11.9
  - @cat-factory/orchestration@0.10.7
  - @cat-factory/prompt-fragments@0.7.12

## 0.7.18

### Patch Changes

- Updated dependencies [7d1f829]
  - @cat-factory/agents@0.11.8
  - @cat-factory/orchestration@0.10.6

## 0.7.17

### Patch Changes

- Updated dependencies [fde0437]
  - @cat-factory/kernel@0.14.0
  - @cat-factory/integrations@0.11.0
  - @cat-factory/agents@0.11.7
  - @cat-factory/orchestration@0.10.5
  - @cat-factory/prompt-fragments@0.7.11

## 0.7.16

### Patch Changes

- Updated dependencies [77b7d31]
  - @cat-factory/agents@0.11.6
  - @cat-factory/orchestration@0.10.4
  - @cat-factory/kernel@0.13.4
  - @cat-factory/integrations@0.10.4

## 0.7.15

### Patch Changes

- @cat-factory/agents@0.11.5
- @cat-factory/integrations@0.10.3
- @cat-factory/kernel@0.13.3
- @cat-factory/orchestration@0.10.3
- @cat-factory/prompt-fragments@0.7.10

## 0.7.14

### Patch Changes

- Updated dependencies [ce27690]
  - @cat-factory/kernel@0.13.2
  - @cat-factory/agents@0.11.4
  - @cat-factory/orchestration@0.10.2
  - @cat-factory/integrations@0.10.2
  - @cat-factory/prompt-fragments@0.7.9

## 0.7.13

### Patch Changes

- Updated dependencies [c8bd144]
  - @cat-factory/orchestration@0.10.1
  - @cat-factory/kernel@0.13.1
  - @cat-factory/agents@0.11.3
  - @cat-factory/integrations@0.10.1

## 0.7.12

### Patch Changes

- Updated dependencies [5c915fd]
  - @cat-factory/kernel@0.13.0
  - @cat-factory/integrations@0.10.0
  - @cat-factory/orchestration@0.10.0
  - @cat-factory/agents@0.11.2
  - @cat-factory/prompt-fragments@0.7.8

## 0.7.11

### Patch Changes

- Updated dependencies [22d7fff]
  - @cat-factory/agents@0.11.1
  - @cat-factory/orchestration@0.9.1

## 0.7.10

### Patch Changes

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
- Updated dependencies [4de2f5f]
  - @cat-factory/kernel@0.12.0
  - @cat-factory/agents@0.11.0
  - @cat-factory/orchestration@0.9.0
  - @cat-factory/integrations@0.9.0
  - @cat-factory/prompt-fragments@0.7.7

## 0.7.9

### Patch Changes

- Updated dependencies [f8a24e0]
  - @cat-factory/agents@0.10.1
  - @cat-factory/integrations@0.8.3
  - @cat-factory/kernel@0.11.1
  - @cat-factory/orchestration@0.8.1

## 0.7.8

### Patch Changes

- Updated dependencies [1e31cbc]
  - @cat-factory/kernel@0.11.0
  - @cat-factory/orchestration@0.8.0
  - @cat-factory/agents@0.10.0
  - @cat-factory/integrations@0.8.2
  - @cat-factory/prompt-fragments@0.7.6

## 0.7.7

### Patch Changes

- Updated dependencies [d0081e1]
  - @cat-factory/agents@0.9.0
  - @cat-factory/integrations@0.8.1
  - @cat-factory/kernel@0.10.1
  - @cat-factory/orchestration@0.7.7
  - @cat-factory/prompt-fragments@0.7.5

## 0.7.6

### Patch Changes

- Updated dependencies [ae29687]
  - @cat-factory/kernel@0.10.0
  - @cat-factory/integrations@0.8.0
  - @cat-factory/agents@0.8.2
  - @cat-factory/orchestration@0.7.6
  - @cat-factory/prompt-fragments@0.7.4

## 0.7.5

### Patch Changes

- Updated dependencies [5c20968]
  - @cat-factory/kernel@0.9.0
  - @cat-factory/agents@0.8.1
  - @cat-factory/integrations@0.7.5
  - @cat-factory/orchestration@0.7.5

## 0.7.4

### Patch Changes

- Updated dependencies [c70df09]
  - @cat-factory/agents@0.8.0
  - @cat-factory/kernel@0.8.0
  - @cat-factory/orchestration@0.7.4
  - @cat-factory/integrations@0.7.4
  - @cat-factory/prompt-fragments@0.7.3

## 0.7.3

### Patch Changes

- Updated dependencies [a0a1bcc]
  - @cat-factory/kernel@0.7.3
  - @cat-factory/agents@0.7.3
  - @cat-factory/integrations@0.7.3
  - @cat-factory/orchestration@0.7.3

## 0.7.2

### Patch Changes

- Updated dependencies [4fa5ed9]
  - @cat-factory/agents@0.7.2
  - @cat-factory/integrations@0.7.2
  - @cat-factory/kernel@0.7.2
  - @cat-factory/orchestration@0.7.2
  - @cat-factory/prompt-fragments@0.7.2

## 0.7.1

### Patch Changes

- Updated dependencies [7463cf2]
  - @cat-factory/agents@0.7.1
  - @cat-factory/integrations@0.7.1
  - @cat-factory/kernel@0.7.1
  - @cat-factory/orchestration@0.7.1
  - @cat-factory/prompt-fragments@0.7.1

## 0.7.0

### Minor Changes

- 7cf2a2d: Improve the pipeline builder experience:

  - **Grouped, collapsible agent palette** — archetypes are now organized into
    meaningful categories (Review & triage, Design & research, Implementation,
    Testing, Documentation, Gates & observability) that collapse/expand, with the
    collapsed state remembered across builder opens.
  - **Pipeline labels + archive/unarchive** — pipelines (built-in and custom) carry
    free-form labels and an archived flag for organizing the library: filter by
    label, hide archived behind a toggle, and archive without deleting. Exposed via
    a new `PATCH /workspaces/:ws/pipelines/:id/organize` endpoint (the only mutation
    a read-only built-in accepts). New `pipelines.labels` / `pipelines.archived`
    columns mirror across D1 and Drizzle/Postgres.
  - **Dependent companions are now gated toggles on their producer** — the three
    companions (reviewer→coder, architect-companion→architect, spec-companion→
    spec-writer) leave the free palette and are attached to their producer step in
    the builder. Each can be optionally **gated on the task estimate** (run only when
    complexity/risk/impact ≥ a threshold, OR across axes) via a new per-step
    `gating` array; a gated step is transparently skipped at runtime when the
    estimate falls below the bar. A pipeline with any enabled gating **requires a
    `task-estimator` earlier in the chain** or it refuses to save/start. Gating is
    additionally restricted to **companion steps** (skipping a producer would starve
    its downstream steps) and **requires at least one axis threshold** (an enabled gate
    with none would always skip); both are enforced by the shared `validatePipelineShape`
    at save, clone, and run start. A companion must now run **immediately after** an
    enabled producer it can review — `validatePipelineShape` enforces strict adjacency
    (over the enabled subset) on every facade, matching the builder, which surfaces
    companions as toggles attached to their producer. A pipeline that slips another step
    between a producer and its companion is rejected at save / clone / run start.

  **Breaking (pre-1.0, no migration):** the `Pipeline` wire shape gains optional
  `gating`, `labels`, and `archived` fields, and `PipelineStep` gains `gating` /
  `skipped`. The built-in pipelines are unchanged in behaviour.

### Patch Changes

- 7d5e060: Bridge the Cloudflare ⇄ Node/local runtime feature-parity gaps: seven product
  features that worked on the Worker but `503`'d on the Node + local facades (their
  repositories were never wired) now work identically on all three, each landed with
  a cross-runtime conformance assertion.

  - **Merge threshold presets** — `merge_threshold_presets` + `DrizzleMergePresetRepository`.
  - **Board-scan repository blueprints** — `repo_blueprints` + `DrizzleRepoBlueprintRepository`
    (the blueprint reads; the `blueprints` pipeline step already ran on Node).
  - **Document sources** — `document_connections`/`documents` + repos; the Confluence /
    Notion / GitHub-docs provider shells are promoted into `@cat-factory/integrations`
    so both facades compose the same providers.
  - **Ephemeral environments** — `environment_connections`/`environments` + repos;
    `HttpEnvironmentProvider` promoted into `@cat-factory/integrations`; a Node
    `setInterval` TTL-teardown sweeper mirrors the Worker's expiry cron.
  - **GitHub projections + inline sync** — `github_branches`/`github_pull_requests`/
    `github_issues`/`github_commits`/`github_check_runs` + `github_sync_cursors` and the
    full read/write projection repos, so the runtime-neutral `GitHubSyncService`'s inline
    webhook/backfill ingest persists on Node; `WebCryptoWebhookVerifier` promoted into
    `@cat-factory/server`.
  - **Repo bootstrap** — `reference_architectures` + bootstrap runs stored as
    `kind='bootstrap'` rows of `agent_runs`; `ContainerRepoBootstrapper` promoted into
    `@cat-factory/server`; a **pg-boss durable bootstrap driver** (the analogue of the
    Worker's `BootstrapWorkflow`) replaces the previous "bootstrap isn't durable on Node
    yet" gap, and the stale-run sweeper now re-drives orphaned bootstrap runs too. The
    self-hosted runner pool (`RunnerPoolTransport`) now accepts the `bootstrap` dispatch
    kind — the harness `/bootstrap` route needs no Cloudflare primitive, so a pool runner
    serves it just like the local Docker transport — so a real bootstrap run dispatches +
    pushes for real on Node, not just on local.
  - **Prompt-fragment library (ADR 0006)** — `prompt_fragments`/`fragment_sources` +
    `DrizzlePromptFragmentRepository`/`DrizzleFragmentSourceRepository`; the runtime-neutral
    `LlmFragmentSelector` promoted into `@cat-factory/agents`. Opt-in via
    `PROMPT_LIBRARY_ENABLED`/`PROMPT_LIBRARY_SELECTOR`, wired exactly like the Worker's
    `selectFragmentLibraryDeps` (repos + installation resolver + selector), so the managed
    tenant fragment catalog feeding every agent run works identically on all three.

  The Worker keeps the same behaviour (it gains the new conformance assertions and the
  shared promoted classes). **Breaking on Node/local:** these features now require their
  new tables — boot-time `migrate()` applies them; there is no data to preserve.

  The Node/local Drizzle migration lineage was re-baselined to a single fresh
  `drizzle-kit generate` migration off the current `schema.ts` (the prior hand-authored
  folders had no snapshots, which blocked `db:generate`); `db:generate`/`db:check` are
  green again. Safe because no deployed database depends on the old lineage.

  Deferred (still Worker-only, flagged for follow-up): real-time push (Node `realtime`
  gateway still `501`s — needs a WebSocket hub over Postgres `LISTEN/NOTIFY`),
  queue-backed async GitHub ingest (Node ingests inline rather than via a pg-boss queue),
  and GitHub rate-limit telemetry (Node keeps the no-op repository).

- Updated dependencies [fe53445]
- Updated dependencies [8eed38c]
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
- Updated dependencies [3e7ab89]
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
- Updated dependencies [ec0c416]
- Updated dependencies [8eed38c]
- Updated dependencies [084bf43]
- Updated dependencies [14840ec]
- Updated dependencies [4030da2]
- Updated dependencies [268c15d]
- Updated dependencies [c9d3f49]
- Updated dependencies [8eed38c]
- Updated dependencies [157cd02]
- Updated dependencies [794b628]
- Updated dependencies [7c37653]
- Updated dependencies [db77061]
- Updated dependencies [f49fa30]
- Updated dependencies [6406c8c]
- Updated dependencies [57d70fa]
- Updated dependencies [1a0686f]
- Updated dependencies [6406c8c]
- Updated dependencies [918764f]
- Updated dependencies [918764f]
- Updated dependencies [88b3170]
- Updated dependencies [fe0b7f8]
- Updated dependencies [f73652c]
- Updated dependencies [db336b1]
- Updated dependencies [f9d3647]
- Updated dependencies [8807f5c]
- Updated dependencies [9be11e1]
- Updated dependencies [5ec0d25]
- Updated dependencies [197264e]
- Updated dependencies [a691853]
- Updated dependencies [c664fe6]
- Updated dependencies [7d5e060]
- Updated dependencies [4a08935]
- Updated dependencies [2796a42]
- Updated dependencies [6406c8c]
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
- Updated dependencies [ba1c0cf]
- Updated dependencies [36018cb]
- Updated dependencies [799be66]
- Updated dependencies [cc39497]
- Updated dependencies [d65c979]
- Updated dependencies [75a0441]
- Updated dependencies [7157fd7]
- Updated dependencies [2ab06b5]
- Updated dependencies [21ca647]
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
- Updated dependencies [e0230a0]
- Updated dependencies [0090313]
- Updated dependencies [7dc8e57]
- Updated dependencies [cc8d96a]
- Updated dependencies [7c37653]
- Updated dependencies [43f2443]
- Updated dependencies [acac735]
- Updated dependencies [b98923c]
- Updated dependencies [3841315]
- Updated dependencies [48d2f0d]
- Updated dependencies [3e6a844]
  - @cat-factory/integrations@0.7.0
  - @cat-factory/orchestration@0.7.0
  - @cat-factory/kernel@0.7.0
  - @cat-factory/agents@0.7.0
  - @cat-factory/prompt-fragments@0.7.0
