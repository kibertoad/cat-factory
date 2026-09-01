# @cat-factory/acceptance-kit

## 0.6.7

### Patch Changes

- Updated dependencies [0f426b3]
  - @cat-factory/kernel@0.323.2

## 0.6.6

### Patch Changes

- Updated dependencies [332ef26]
  - @cat-factory/kernel@0.323.1

## 0.6.5

### Patch Changes

- Updated dependencies [4b1c76f]
  - @cat-factory/contracts@0.334.0
  - @cat-factory/kernel@0.323.0
  - @cat-factory/sdk@0.48.1

## 0.6.4

### Patch Changes

- Updated dependencies [6d4b02a]
  - @cat-factory/kernel@0.322.2

## 0.6.3

### Patch Changes

- be0b953: Refresh the dependency tree, the base images and the agent CLIs.
  
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
- Updated dependencies [be0b953]
  - @cat-factory/kernel@0.322.1
  - @cat-factory/sdk@0.48.1

## 0.6.2

### Patch Changes

- Updated dependencies [27b22a3]
  - @cat-factory/contracts@0.333.0
  - @cat-factory/kernel@0.322.0
  - @cat-factory/sdk@0.48.0

## 0.6.1

### Patch Changes

- Updated dependencies [e1f6325]
- Updated dependencies [90a915e]
  - @cat-factory/contracts@0.332.0
  - @cat-factory/kernel@0.321.3
  - @cat-factory/sdk@0.48.0

## 0.6.0

### Minor Changes

- e8be41b: Publish the reset plan/apply machinery, so a suite does not re-derive the rules that fail quietly.
  
  The kit shipped every small seam a `reset` command needs (`SuiteIdentity.resetCommand`, `listPasses`,
  `readLatestPointer`, `scrubbed`) and not the reset itself, so a deployment building its own suite
  copied roughly 1,360 lines to get one. `planReset`, `applyReset`, `parseResetArgs`,
  `formatResetPlan`, `formatResetReport`, `resetSucceeded` and the `ResetClient` port are now exported,
  generic over a suite's own ledger fact type.
  
  The kit owns the four decisions that go wrong silently: unfinished tasks are deleted before their
  frame (the frame delete refuses over them) while finished ones ride its cascade, a pass's ledger is
  never removed while a frame it names is still standing, the `latest` pointer goes both when it names
  a pass being removed and when it names nothing, and the apply consumes the plan the preview showed. A
  `404` counts as an outcome.
  
  A suite supplies what only it knows, as three callbacks on `ResetInput`: `target` (which frames this
  configuration asks about, in its own words, plus anything it could not free or read),
  `ledgerServiceIds`, and `leftovers`. `parseResetArgs` takes a suite's extra flags and hands them back
  un-interpreted.
  
  Two rules read directly rather than through a proxy. The `latest` pointer rule no longer carries an
  `--all` clause: that scope plans every pass in the state directory, so a pointer under it either
  names one of them or names none, and reading the rule itself also removes the dangling pointer a
  CONFIGURED reset used to leave behind. Which half put it there rides the plan and the report as a
  `PointerReason`, so the two sentences never borrow each other's words. And `parseResetArgs` throws on
  a `flags` declaration it could not hand back (a name it acts on itself, or one spelled without its
  dashes, which it would match ahead of the positional) rather than shadowing the suite's meaning with
  its own on every invocation.
  
  Internal break for anyone who copied the private version: `FrameReason` no longer carries
  suite-specific members (a suite's reason is a phrase the kit prints), `ResetPlan.stuck` /
  `ResetPlan.unlinked` are now `blockers` / `notes`, `ResetReport.pointerRemoved` is now `pointer`
  (the removed file and why, or null), and `ResetClient` has four calls rather than five.
  Design record: `backend/docs/adr/0061-acceptance-kit-reset-machinery.md`.

## 0.5.5

### Patch Changes

- Updated dependencies [e0eed49]
  - @cat-factory/kernel@0.321.2

## 0.5.4

### Patch Changes

- 7d899c4: Stop publishing an ephemeral-environment URL nothing can serve, and make a containerized tester
  able to reach one that can.
  
  An acceptance pass deployed a healthy pod, published `http://cf-acc-pr8.127.0.0.1.nip.io`, reported
  the environment `ready`, and then spent fourteen minutes in the tester on curl code 000 before
  failing the run at forty-three minutes. Two independent faults, both of which PR #2075 named and
  left open:
  
  - **The Ingress was claimed by nothing.** It declared `ingressClassName: nginx` on a cluster
    running Traefik. The apiserver accepts that, no controller watches it, `status.loadBalancer`
    stays empty, and readiness (which was the Deployments' rollout and nothing else) still said
    `ready`. The Kubernetes provider now grades a template-derived URL against the cluster's own
    `IngressClass` catalog and reports `failed` / `config_incomplete` naming both the requested class
    and the available ones. It fails only on POSITIVE evidence that no controller can claim the
    Ingress; a missing address is `pending`, never a refusal, and a cluster that will not answer the
    cluster-scoped read passes through byte-for-byte as before. `cat-factory k3s` grants the
    `ingressclasses` read so a cluster it provisions can answer.
  - **A loopback URL is unreachable from an agent container**, whose `127.0.0.1` is its own network
    namespace. The local facade now maps the environment's host to the container's host gateway, so
    one URL means the right thing to the operator's browser and to the agent alike. A container that
    predates its environment is replaced, and a bridged job never takes a warm-pool member (a member
    is re-leased across runs, so one run's per-PR entry would leak into the next). It covers every
    environment a job is handed, not just the frame's own: a live peer service's environment for a
    cross-service test and a frontend flow's resolved backend binding fail identically without it.
    The URLs ride the dispatch OPTIONS as a declared, typed list rather than being dug back out of
    the job body, where they sit three levels down under a wire shape the harness owns.
  
    A URL naming this machine that NO bridge can re-point is reported rather than bridged: a hosts
    entry cannot displace the `127.0.0.1 localhost` line an image ships with, and it is never
    consulted for a bare IP literal. A compose environment publishes `http://localhost:<port>`, so
    bridging it bought nothing while costing every such run its warm-pool member and a container
    replacement. Those runs are pooled again, and the log now says the environment is out of the
    agent's reach instead of leaving it to be discovered as a dead cluster.
  
  Also: the acceptance suite refuses a pass up front when the cluster runs no ingress controller or
  publishes no host port into it, reusing `cat-factory k3s`' probe; its scaffold briefs tell agents to
  leave `ingressClassName` unset so the cluster's default class claims the Ingress; and the run driver
  reports step TRANSITIONS instead of only sampling `currentStep`, so a step that starts and finishes
  between two polls is still named. That last one is why this failure was misread: the `deployer`
  finished in one second against a ten-second poll, so the pass jumped from `reviewer` to
  `tester-api` and the step that published the bad URL never appeared in the log at all.
  
  Alongside them, `/api/v1` serves `skipped` on a run's steps (an additive optional field, OpenAPI
  `1.62.0`). A skipped step's `state` is `done` with no output, which is byte-for-byte a step that
  ran and produced nothing, so following a run's chain could not tell the engine deciding a step was
  unnecessary from the step happening and having nothing to say. The acceptance kit's transition
  reducer already knew how to announce the difference and could not observe it.
- Updated dependencies [7d899c4]
  - @cat-factory/contracts@0.331.0
  - @cat-factory/sdk@0.48.0
  - @cat-factory/kernel@0.321.1

## 0.5.3

### Patch Changes

- Updated dependencies [dc12c82]
  - @cat-factory/contracts@0.330.0
  - @cat-factory/kernel@0.321.0
  - @cat-factory/sdk@0.47.0

## 0.5.2

### Patch Changes

- Updated dependencies [3ae3386]
  - @cat-factory/contracts@0.329.0
  - @cat-factory/kernel@0.320.0
  - @cat-factory/sdk@0.47.0

## 0.5.1

### Patch Changes

- Updated dependencies [c030a23]
  - @cat-factory/kernel@0.319.1

## 0.5.0

### Minor Changes

- 69b9ed4: Read the SDK's composed transport account once, and split it between the two readers of a failed
  poll. The published clients now assemble a connection failure's message from a verdict, the origin
  history only that client holds, and the runtime's chain verbatim, so walking the chain again under it
  printed the errno twice, and a 200-character observation of it cut the chain off entirely: against a
  deployment URL of any real length an expiry that used to end in `connect ECONNREFUSED 203.0.113.42:443`
  named neither the errno nor the host. A prerequisite refusal now relays the account whole,
  `transportChainText` gives a per-poll observation the runtime's chain alone, and both are pinned by
  fixtures driven through a real client rather than written by hand.
  
  `fileAndDrive` also names what a create that never completed left behind: a failure no origin
  accepted created nothing, while a reset, a timeout or an unreadable answer may have filed a task no
  ledger can name, and those need opposite actions from an operator before the next pass runs.
  
  The create-side classification is bounded by what the REQUEST was rather than by what the callback
  threw, which is two narrowings. Only a failure the SDK raised about a call it made is classified, so
  a brief over the description cap and a bug in the suite are reported as themselves instead of as a
  task that may be sitting on a board. And a body composed from an evidence read gets a `prepareTask`
  stage that runs before the window opens, keeping the laziness that put those reads in the create
  callback without the misreport. A 502 or a 504 is treated as unsettled rather than as a refusal the
  deployment stated: nobody at the deployment writes those, and a gateway that gave up on the upstream
  says nothing about whether the upstream had already acted. What the attached account PROVES is now
  said per cause, since an origin history is a claim only the connection error carries.
  
  kernel gains `errorChainDiagnosisText`: the chain read as a diagnosis, with undici's contentless
  `fetch failed` wrapper dropped so the real cause leads. `describeConnectionFailure` had that
  reduction inlined and now shares it, which is what lets a reader holding the cause class already
  take the chain alone.

### Patch Changes

- Updated dependencies [69b9ed4]
  - @cat-factory/kernel@0.319.0

## 0.4.1

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
  - @cat-factory/sdk@0.47.0
  - @cat-factory/kernel@0.318.1

## 0.4.0

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
  - @cat-factory/sdk@0.46.0

## 0.3.9

### Patch Changes

- Updated dependencies [da77447]
  - @cat-factory/contracts@0.326.0
  - @cat-factory/kernel@0.317.1
  - @cat-factory/sdk@0.45.1

## 0.3.8

### Patch Changes

- Updated dependencies [4125beb]
  - @cat-factory/contracts@0.325.0
  - @cat-factory/kernel@0.317.0
  - @cat-factory/sdk@0.45.1

## 0.3.7

### Patch Changes

- Updated dependencies [1d3c115]
  - @cat-factory/kernel@0.316.0

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
