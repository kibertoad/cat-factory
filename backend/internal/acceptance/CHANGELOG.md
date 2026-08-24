# @cat-factory/acceptance

## 0.4.31

### Patch Changes

- Updated dependencies [da77447]
  - @cat-factory/contracts@0.326.0
  - @cat-factory/acceptance-kit@0.3.9
  - @cat-factory/cli@0.13.1
  - @cat-factory/kernel@0.317.1
  - @cat-factory/sdk@0.45.1

## 0.4.30

### Patch Changes

- Updated dependencies [4125beb]
  - @cat-factory/contracts@0.325.0
  - @cat-factory/kernel@0.317.0
  - @cat-factory/acceptance-kit@0.3.8
  - @cat-factory/cli@0.13.1
  - @cat-factory/sdk@0.45.1

## 0.4.29

### Patch Changes

- Updated dependencies [1d3c115]
  - @cat-factory/kernel@0.316.0
  - @cat-factory/acceptance-kit@0.3.7
  - @cat-factory/cli@0.13.1

## 0.4.28

### Patch Changes

- Updated dependencies [432b4e4]
  - @cat-factory/contracts@0.324.0
  - @cat-factory/kernel@0.315.0
  - @cat-factory/acceptance-kit@0.3.6
  - @cat-factory/cli@0.13.1
  - @cat-factory/sdk@0.45.1

## 0.4.27

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
  - @cat-factory/acceptance-kit@0.3.5
  - @cat-factory/cli@0.13.1
  - @cat-factory/contracts@0.323.1
  - @cat-factory/kernel@0.314.1
  - @cat-factory/sdk@0.45.1

## 0.4.26

### Patch Changes

- Updated dependencies [72ecc7c]
  - @cat-factory/contracts@0.323.0
  - @cat-factory/kernel@0.314.0
  - @cat-factory/acceptance-kit@0.3.4
  - @cat-factory/cli@0.13.0
  - @cat-factory/sdk@0.45.0

## 0.4.25

### Patch Changes

- Updated dependencies [5b281a3]
  - @cat-factory/contracts@0.322.0
  - @cat-factory/kernel@0.313.0
  - @cat-factory/acceptance-kit@0.3.3
  - @cat-factory/cli@0.13.0
  - @cat-factory/sdk@0.45.0

## 0.4.24

### Patch Changes

- Updated dependencies [53a4c40]
  - @cat-factory/contracts@0.321.0
  - @cat-factory/kernel@0.312.0
  - @cat-factory/sdk@0.45.0
  - @cat-factory/acceptance-kit@0.3.2
  - @cat-factory/cli@0.13.0

## 0.4.23

### Patch Changes

- Updated dependencies [4a3af5a]
  - @cat-factory/kernel@0.311.0
  - @cat-factory/acceptance-kit@0.3.1
  - @cat-factory/cli@0.13.0

## 0.4.22

### Patch Changes

- Updated dependencies [302e05a]
- Updated dependencies [cda15b8]
  - @cat-factory/acceptance-kit@0.3.0
  - @cat-factory/contracts@0.320.0
  - @cat-factory/kernel@0.310.0
  - @cat-factory/cli@0.13.0
  - @cat-factory/sdk@0.44.0

## 0.4.21

### Patch Changes

- Updated dependencies [3afea3a]
  - @cat-factory/contracts@0.319.0
  - @cat-factory/kernel@0.309.0
  - @cat-factory/acceptance-kit@0.2.5
  - @cat-factory/cli@0.12.1
  - @cat-factory/sdk@0.43.0

## 0.4.20

### Patch Changes

- Updated dependencies [3f7d8b2]
  - @cat-factory/contracts@0.318.0
  - @cat-factory/kernel@0.308.0
  - @cat-factory/acceptance-kit@0.2.4
  - @cat-factory/cli@0.12.1
  - @cat-factory/sdk@0.43.0

## 0.4.19

### Patch Changes

- Updated dependencies [2a2b6ef]
  - @cat-factory/kernel@0.307.0
  - @cat-factory/acceptance-kit@0.2.3
  - @cat-factory/cli@0.12.1

## 0.4.18

### Patch Changes

- Updated dependencies [5333319]
  - @cat-factory/kernel@0.306.0
  - @cat-factory/acceptance-kit@0.2.2
  - @cat-factory/cli@0.12.1

## 0.4.17

### Patch Changes

- Updated dependencies [053aac8]
  - @cat-factory/contracts@0.317.0
  - @cat-factory/kernel@0.305.0
  - @cat-factory/acceptance-kit@0.2.1
  - @cat-factory/cli@0.12.1
  - @cat-factory/sdk@0.43.0

## 0.4.16

### Patch Changes

- Updated dependencies [f887604]
  - @cat-factory/acceptance-kit@0.2.0

## 0.4.15

### Patch Changes

- Updated dependencies [eb5fa75]
- Updated dependencies [9d8fdf6]
  - @cat-factory/contracts@0.316.0
  - @cat-factory/kernel@0.304.0
  - @cat-factory/cli@0.12.1
  - @cat-factory/sdk@0.43.0

## 0.4.14

### Patch Changes

- Updated dependencies [eb740be]
  - @cat-factory/contracts@0.315.0
  - @cat-factory/kernel@0.303.0
  - @cat-factory/cli@0.12.0
  - @cat-factory/sdk@0.43.0

## 0.4.13

### Patch Changes

- Updated dependencies [7f990ea]
  - @cat-factory/contracts@0.314.0
  - @cat-factory/kernel@0.302.0
  - @cat-factory/sdk@0.43.0
  - @cat-factory/cli@0.12.0

## 0.4.12

### Patch Changes

- cfdc6a8: Stop the acceptance suite dying on a deployment restart, and refuse a pass whose manifests could
  never name an image.

  Two independent failures from one pass, found in that order. The reported one was a scaffold run 41
  minutes in, coder and reviewer done and a pull request open, whose next `GET /tasks/:id/run` threw
  `connect ECONNREFUSED 127.0.0.1:8787` and took the scenario with it. Nothing was wrong with the run:
  the local deployment's `node --watch` had cycled the process between two polls, it was serving again
  seconds later, and the run went on to reach its deployer step with nobody watching. That is not an
  exceptional environment. The suite's own README points it at a stack run under `cat-factory
supervise`, a supervisor whose entire job is to restart the backend when it stops serving, in front
  of a watcher that cycles it on a file change, so over an afternoon a restart is ordinary and a wait
  that cannot sit through one is a wait that reports the watcher's death as the run's.

  So an unanswered poll is now an observation for two minutes rather than an immediate failure. The
  policy is injected into `waitFor` rather than built into it (the clock knows nothing about
  deployments) and classifies through the suite's existing `describeProbeFailure` rather than matching
  messages, so there is still one reading of a thrown probe. What it tolerates is the ABSENCE of an
  answer, for the four transport causes shaped like a restart (refused, reset, timeout, unreachable):
  an answered refusal ends the wait and is rethrown untouched, because a refusal is evidence and
  because callers read the SDK error's status and request id off it, and so does a DNS entry that
  stopped resolving or a certificate that expired, each of which is its own diagnosis rather than
  weather. The recovery is journalled as well as the outage, since an unexplained gap in a long
  observation log is how a restart becomes invisible, and an outage never becomes the LAST
  observation: "the deployment did not answer" says nothing about the run, so both expiry messages
  still print the last thing the deployment actually said, with the silence beside it rather than in
  its place.

  Between the waits, the same restart is absorbed by the SDK client's retry budget, raised where the
  client a SCENARIO drives is built. That covers every read a scenario makes one-shot, on the SDK's
  own rule about what may be replayed: a `GET` is retried, a `POST` never, so answering a decision
  stays exactly-once. Preflight keeps the SDK default, because the trade inverts before a pass has
  spent anything: a dozen checks run in sequence and none bails early, so a raised budget there
  multiplies across all of them and buries the report that a deployment is not running under minutes
  of silence, which is the failure the suite's probe classification exists to prevent.

  The second failure is why that pass would have failed anyway, and it had never been reached before:
  every previous attempt stopped in preflight, so the deployer step ran for the first time. It failed
  with `Deployment.apps "catalog-api" is invalid: spec.template.spec.containers[0].image: Required
value`. The manifest was correct. The briefs make `{{image}}` mandatory and the agent emitted it
  verbatim; the platform substitutes that hole from the workspace connection's `imageTemplate`, this
  suite set none, and an unfilled hole renders as the empty string, so `image: ""` went to the
  apiserver. The suite now configures the template (`ACCEPTANCE_K3S_IMAGE_TEMPLATE`, defaulting to
  GHCR under the repository's own owner), threads it into the briefs exactly as it already threads the
  ingress host, and grades it in a new required `image-template` prerequisite before anything is
  spent.

  The default tags by pull-request number rather than by commit sha, which is the interesting
  constraint: a provision carries no sha (`ProvisionContext` has branch, number, url, owner, name),
  and `{{branch}}` is `cat-factory/<taskId>`, which no image tag may contain. It also decides the
  workflow's trigger, since a number that does not exist until the pull request does cannot be built
  on `push`, and it makes the tag MUTABLE, which is why the manifests are now asked for
  `imagePullPolicy: Always`.

  The gate refuses the mistakes by name, `{{namespace}}` included: that hole is filled in the
  manifests and in the ingress host but NOT in the image, which the platform renders one step before
  the namespace exists, so a sample carrying it would have green-lit exactly the empty image this
  check was built to prevent. And the PASS states what it did not check: whether anything published
  that reference, whether the cluster may pull it (a GHCR package is private until someone says
  otherwise, and there is no registry credential on the connection to fix that with, so the README now
  names the one-time action), and whether the owner is spelled as the provider spells it, since the
  platform re-derives `{{repoOwner}}` from the pull request URL rather than from the variable this
  gate can read. Each of the three presents as an environment that provisions and never becomes ready.

## 0.4.11

### Patch Changes

- Updated dependencies [409238f]
  - @cat-factory/kernel@0.301.0
  - @cat-factory/contracts@0.313.0
  - @cat-factory/cli@0.12.0
  - @cat-factory/sdk@0.42.0

## 0.4.10

### Patch Changes

- 0ef48d1: Stop an agent's own cleanup command from killing the harness that supervises it, and report a
  harness that WAS stopped as what it is.

  A local acceptance run failed as "the container kept vanishing, treating as deterministic" after
  two full coder passes. Nothing evicted anything. The harness ran as PID 1 with the command line
  `node dist/server.js`, which is also where the Fastify service the coder was scaffolding built to;
  the agent started that service in the background to smoke-test it over a real socket, then ran
  `pkill -f 'node dist/server.js'` to stop it again. The image ships no `pkill`, so that failed with
  `command not found` and the next turn used something that works without procps, which matched PID 1
  and shut the harness down. The container exited 0, the engine could only see a backend that had
  stopped answering, so it called it an eviction, spent its crash-recovery budget re-running the same
  agent into the same wall, and blamed infrastructure churn.

  **The harness no longer answers to a pattern kill aimed at anything else.** It runs from
  `dist/harness-server.js` and sets `process.title = 'cat-factory-harness'`, which on Linux rewrites
  both `/proc/<pid>/cmdline` and (truncated) `/proc/<pid>/comm`, so neither `pkill -f 'node dist/…'`
  nor a bare `pkill node` nor a hand-rolled `/proc` sweep can name it. It is not a security boundary
  and is not claimed as one: the agent shares the harness's uid, and separating them needs a PID 1
  running as root, which this image deliberately does not have. What it removes is the accident.

  **`procps` + `psmisc` are now in the image**, which reads backwards until you look at what the
  absence caused: `pkill`/`pgrep`/`ps` are the narrow tools an agent reaches for first, and the
  fallback it writes when they are missing is the unbounded one that took the harness down.

  **A harness that exits cleanly mid-job is no longer an eviction.** Every transport that can read an
  exit code (the local container and native-process legs, the Cloudflare per-run container, and a
  Kubernetes runner pod's `state.terminated`) now distinguishes a workload that exited 0 with a job
  still in flight from one that crashed or was reclaimed, and reports `harnessShutdown` instead of
  `evicted`. The engine fails that run immediately with a new `harness_shutdown` failure kind
  (additive to the public failure-kind vocabulary; OpenAPI surface 1.54.0) and a hint that names the
  causes worth checking, rather than spending an automatic retry that walks back into whatever
  stopped it. A backend that reports no exit code (Apple `container`, a manifest-driven runner pool
  whose scheduler exposes only status words) keeps reporting an eviction, because an absent code is
  not a zero.

  The distinction is only ever drawn where NOTHING else explains the stop. Infrastructure churn is
  named and recovers on its own budget, and it stays named even after its attribution window passes:
  a rollout drain the harness answered by exiting 0, discovered minutes later by a re-driven poll, is
  still that drain rather than a shutdown. The same rule orders the engine's own reading: a killed
  job that some branch settles WITHOUT failing the run (a parked PR review's read-only Challenge
  Investigator) keeps that settlement, since losing a human's in-flight curation is worse than the
  retry this failure kind exists to prevent. `container.harness_shutdown` counts the class, kept out
  of `container.evicted` so the eviction rate an operator sizes infrastructure by is not inflated by
  deaths no infrastructure change prevents.

  **An aborted agent run says who aborted it.** The Claude Code / Codex runner rejected with a
  hard-coded "agent run aborted by watchdog" for every abort, including the shutdown handler's, so a
  job killed by something else filed its failure against a watchdog that never fired. It now carries
  the abort reason the caller supplied, the way the Pi runner already did, and an abort that supplied
  none falls back to saying so rather than quoting the platform's own contentless "This operation was
  aborted" (a reasonless `abort()` sets an `AbortError` that IS an `Error`, so the fallback was
  unreachable).

  The image moves to `cat-factory-executor:1.121.0` across the wrangler config, the publish script and
  `RECOMMENDED_HARNESS_IMAGE`: the entrypoint rename and `procps` are only in effect once a deployment
  runs a tag that contains them.

  **The acceptance suite stops blaming the merge threshold for a failed run.** Its "the merge was
  HELD" hint fired on "there is a pull request and the status is not done", which is also true of a
  run that died three phases before any merge was considered; it is now offered only where nothing
  else explains the stop.

- Updated dependencies [0ef48d1]
  - @cat-factory/kernel@0.300.0
  - @cat-factory/contracts@0.312.0
  - @cat-factory/sdk@0.42.0
  - @cat-factory/cli@0.12.0

## 0.4.9

### Patch Changes

- Updated dependencies [d5c1f1c]
- Updated dependencies [c67e924]
  - @cat-factory/kernel@0.299.1
  - @cat-factory/contracts@0.311.0
  - @cat-factory/cli@0.12.0
  - @cat-factory/sdk@0.41.0

## 0.4.8

### Patch Changes

- Updated dependencies [056e18d]
  - @cat-factory/contracts@0.310.0
  - @cat-factory/kernel@0.299.0
  - @cat-factory/cli@0.12.0
  - @cat-factory/sdk@0.41.0

## 0.4.7

### Patch Changes

- Updated dependencies [a81879b]
  - @cat-factory/contracts@0.309.0
  - @cat-factory/kernel@0.298.2
  - @cat-factory/cli@0.12.0
  - @cat-factory/sdk@0.41.0

## 0.4.6

### Patch Changes

- 7737735: Review findings on the standalone acceptance runner (#1983).

  These are the pass's own reporting, plus one documented decision about the personal-password ask. Every command now prints to stdout, refusals included, because a
  `tee`d afternoon-long pass captures one stream and the configuration refusal, the declined prompt and
  the suite-failure report were on the other. A `ScenarioFailure` carries its message and its location
  separately, so a suite bug's stack frames stop being folded into the one-line phase message `status`
  renders. The three startup boundaries pick their describer off a new `OperatorRefusal` marker rather than
  off which boundary they are, so a `TypeError` before the pass opens is no longer printed as a
  one-sentence refusal with no file and no line. The suite-failure exit gates its `resume:` line on the
  ledger the way the closing words already did. The preflight report scenario carries every red
  prerequisite's remedy instead of the first one's, which is rule 4 and what the terser gate behind it
  already did. And `status`'s no-argument default is back to "the pass that ran last": an
  `ACCEPTANCE_RUN_ID` line in the `.env` names the pass to report on, but a `latest` in that file no longer
  converts the bare form into the pointer question, which refuses where the bare form would have answered.

  The personal-password ask keeps HOLDING what it collects, and that is now argued for rather than
  incidental: the suite exists to be run headless, so an operator starts a pass and walks away, and once
  the pinned preset has confirmed the pass will spend their subscription there is nothing to gain by
  withholding the answer until a call is refused. Collecting-without-holding would narrow the exposure to
  a few reads against the one deployment the pass is pinned to (which consults the header only on the
  gated run calls) and would make "the pass has the credential" a rule each future call site remembers
  through `withPersonalUnlock` rather than a property of the client seam.

  Docs: the claim that a `.ts` entry point "does not load at all" below Node 24 was false (type stripping
  is on by default from 22.18 and 23.6, as CONTRIBUTING.md already said), so a successful run was never
  evidence of the floor.

## 0.4.5

### Patch Changes

- Updated dependencies [0e1e0fa]
  - @cat-factory/contracts@0.308.1
  - @cat-factory/kernel@0.298.1
  - @cat-factory/cli@0.12.0
  - @cat-factory/sdk@0.41.0

## 0.4.4

### Patch Changes

- Updated dependencies [7312e0a]
  - @cat-factory/kernel@0.298.0
  - @cat-factory/contracts@0.308.0
  - @cat-factory/sdk@0.41.0
  - @cat-factory/cli@0.12.0

## 0.4.3

### Patch Changes

- Updated dependencies [95408c2]
  - @cat-factory/contracts@0.307.0
  - @cat-factory/kernel@0.297.0
  - @cat-factory/cli@0.12.0
  - @cat-factory/sdk@0.40.0

## 0.4.2

### Patch Changes

- Updated dependencies [792ecde]
  - @cat-factory/kernel@0.296.1
  - @cat-factory/cli@0.12.0

## 0.4.1

### Patch Changes

- Updated dependencies [fc56d82]
- Updated dependencies [fc9afb4]
  - @cat-factory/contracts@0.306.0
  - @cat-factory/kernel@0.296.0
  - @cat-factory/cli@0.12.0
  - @cat-factory/sdk@0.40.0

## 0.4.0

### Minor Changes

- a565d05: Run the acceptance scenarios from a plain Node entry point instead of vitest.

  `pnpm run acceptance` is now `node src/runAcceptance.ts`: the five scenarios in one process, in the
  order `src/scenarios/index.ts` lists them, asserting with `node:assert/strict`, stopping at the first
  failure. The suite used vitest as a shell while switching off almost everything vitest does, and paid
  for the parts it could not switch off (a module graph per spec file, a reporter owning the console) in
  a `globalSetup` hook, an RPC channel and a custom sequencer, all of which are gone: the run id and the
  personal password are ordinary values, and the ask now fills the unlock holder rather than handing a
  password back.

  Nothing the scenarios assert changed. The pass prints its own report (each step as it starts, the
  failure in full, then a summary naming which scenario broke and that the ones after it did not run),
  records a `failure` line in the journal that `status` can read from another window, and exits 2 rather
  than 1 when it refused to start at all. `acceptance:watch` is gone with the vitest config, and the
  entry points target modern Node, so they no longer pass `--experimental-strip-types`.

  Design record: `backend/docs/adr/0057-acceptance-standalone-runner.md`.

### Patch Changes

- a565d05: Close the gaps review found in the standalone acceptance runner.

  `status` now reads the package `.env` the way every other command does, so the `watch:` and `report:`
  commands the pass prints resolve to the same state directory the pass wrote to; read off the shell
  alone it answered "No acceptance pass found" about a pass that was running right then. A base URL is
  scrubbed at the three sites that print one, including the preflight step name the journal persists on
  failure, since userinfo in a URL is legal and that file is meant to be shareable. The pass has an
  error boundary: a throw from a scenario factory or from the closing report is now named as a failure
  of the SUITE, with the run id, both file paths and the resume command, instead of an unhandled
  rejection that exits 1 with none of them.

  The preflight report's evaluation is handed to the gate that runs seconds behind it, so a fresh pass
  no longer evaluates all fourteen prerequisites twice; every later gate is unchanged and still fully
  re-evaluated. `recordsFacts` classifies each ledger slot rather than scanning the whole object, so a
  future non-record field on the ledger cannot silently make every pass claim it created something,
  and `thrownLocation` cuts the message off a stack by its content instead of scanning it for `at `,
  which was lifting indented lines of this suite's own multi-line refusals out as if they were frames.

  The scenario order has a test again (it lost one with `src/specOrder.ts`), pinned as a relation
  between each id's numeric prefix and its position so adding a scenario in the right place passes.
  Also: the package root is resolved in one place rather than four, the driver's gate and failure seams
  drop a scenario argument nothing could implement, and the up-front password ask uses the pass's own
  SDK client instead of building a second one.

## 0.3.0

### Minor Changes

- abb038e: Give `reset` a `--purge-repos` flag that reclaims the provider side: the issues a pass filed as the
  reporter, and the contents a scaffold run pushed.

  Both were previously stated as leftovers because an `admin` key structurally cannot reach either. The
  emptying is recoverable by construction: an ordinary commit on top of the current tip (so the previous
  tree stays in history and one `git revert` restores it), every ref tagged at the sha it held before it
  is touched, and the recovery command printed with the report.

  The flag asks more of `ACCEPTANCE_VCS_TOKEN` than filing an issue does: Contents and Workflows
  read+write on both repositories (classic GitHub: `repo` plus `workflow`), because a scaffolded
  repository holds an Actions workflow and the provider refuses a commit that removes one otherwise.

## 0.2.2

### Patch Changes

- 4adccbc: Pin the acceptance specs to file-name order.

  The five specs are one narrative passing facts through the on-disk ledger, but nothing enforced the
  order they ran in: `fileParallelism: false` prevents two running at once and vitest's default
  sequencer was still free to reorder them from its results cache. With `bail: 1`, the slowest spec of
  the previous pass ran first, failed on a ledger key nothing had written yet, and stopped the pass
  before the spec that writes it had started.

## 0.2.1

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
  - @cat-factory/cli@0.12.0
  - @cat-factory/sdk@0.40.0

## 0.2.0

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
  - @cat-factory/sdk@0.40.0
  - @cat-factory/cli@0.12.0
  - @cat-factory/kernel@0.294.1

## 0.1.13

### Patch Changes

- Updated dependencies [569181d]
  - @cat-factory/contracts@0.303.0
  - @cat-factory/kernel@0.294.0
  - @cat-factory/cli@0.12.0
  - @cat-factory/sdk@0.39.0

## 0.1.12

### Patch Changes

- 10737f4: Give an acceptance pass ONE run id and stop a refused attempt from hiding the pass worth resuming.

  The run id was resolved per module graph, which is per spec FILE: five specs opened five ledgers a
  second apart, so no fact spec 01 recorded reached spec 02. It is now settled once in `globalSetup`
  and injected, and a spec handed none refuses rather than minting its own. The `latest` pointer moves
  to the first FACT a pass records, so an attempt refused at preflight no longer overwrites the pointer
  to the half-built pass whose leftovers caused the refusal, and the two checks that refuse over
  leftover state name that pass's run id instead of offering `latest`.

- 10737f4: Let `status` reach a pass that recorded nothing, and give a pass one identity.

  Moving the `latest` pointer to a pass's first recorded FACT made the pass an operator most often
  asks about unreportable: an attempt a prerequisite refused writes a journal saying why and never
  opens a ledger, so `pnpm run status` with no run id followed a pointer that named an older pass, or
  none at all. It now reports the pass that WROTE last, and a pass that created nothing closes its
  report by naming the pass that did rather than offering to resume itself.

  A pass is also identified by its file name now: a ledger whose stored `runId` disagrees is a copied
  or renamed file, and both `WorldStore` and `status` refuse it instead of pointing `latest` at an id
  with no ledger. The leftover-state refusals name the owning pass per service, so leftovers spanning
  two passes say what resuming either one leaves behind, and the `status` command they offer names
  that pass instead of resolving to whichever ran last.

- Updated dependencies [1a0b593]
  - @cat-factory/contracts@0.302.0
  - @cat-factory/kernel@0.293.0
  - @cat-factory/sdk@0.39.0
  - @cat-factory/cli@0.12.0

## 0.1.11

### Patch Changes

- Updated dependencies [7d1477c]
  - @cat-factory/kernel@0.292.2
  - @cat-factory/cli@0.12.0

## 0.1.10

### Patch Changes

- Updated dependencies [c09ddbe]
  - @cat-factory/kernel@0.292.1
  - @cat-factory/cli@0.12.0

## 0.1.9

### Patch Changes

- Updated dependencies [fc4a1e4]
  - @cat-factory/contracts@0.301.0
  - @cat-factory/kernel@0.292.0
  - @cat-factory/sdk@0.38.0
  - @cat-factory/cli@0.12.0

## 0.1.8

### Patch Changes

- 0363eed: Ask for the personal password on Windows at all, and refuse by the RIGHT cause when it cannot.

  A pass pinned to an individual-usage model stops at its first dispatch to ask for the operator's
  personal password. On Windows it never asked: it failed with `Error: setRawMode EPERM`, errno -4048,
  naming neither the password it wanted nor anything to do about it.

  The cause is the OPEN, not the console. Turning echo off is `SetConsoleMode`, which WRITES to the
  console input buffer, so the handle needs `GENERIC_WRITE`; `\\.\CONIN$` was opened `r`, which reads
  perfectly well and then refuses raw mode with `EPERM` on a machine with a console right there.
  `consoleDevice()` now opens it `r+` and the prompt appears. Verified inside a vitest forked worker,
  the environment that makes this prompt awkward in the first place: `r` throws `EPERM`, `r+` enters
  raw mode and writes to `CONOUT$`.

  That also corrects what this file believed. The `EPERM` was read as evidence that a console-less
  process opens `CONIN$` happily, so the missing-terminal refusal was moved onto the raw-mode switch.
  A console-less process cannot open `CONIN$` at all (`EBADF`, the same fact as POSIX's `ENXIO` for
  `/dev/tty`), so that refusal belongs on the OPEN, where it started, and moving it there produced a
  confident refusal with the wrong cause: an operator in a JetBrains terminal was told to "run the
  suite from an interactive shell", which is what they were doing.

  So there are two refusals now, because they need two different actions. No device to reach:
  `noTerminal()`, unchanged. A device that reaches a terminal which will not stop echoing:
  `noHiddenInput()`, naming that cause and the way out FOR THE PLATFORM it is thrown on, since the
  second refusal is just as reachable on POSIX (a `docker exec` with no `-t`, a detached `screen`) as
  it is from the MSYS/mintty window `winpty` fixes. Named for Windows alone it would have been the
  same defect one platform over: a confident refusal with the wrong cause. `cmd.exe` is deliberately
  not among the terminals offered, though it implements console modes: this suite prints its Windows
  commands in PowerShell's dialect, so sending an operator there fixes one prompt and breaks every
  command printed afterwards. Raw mode is still entered by `openTerminal` rather than by the read,
  because being readable without echo is what that function promises and opening the device does not
  establish it.

  **And the verdict on that switch is the stream's own `isRaw`, not "the call did not throw".**
  `setRawMode` reports a failure by EMITTING `error`, which reaches a caller as a throw only because an
  unhandled `error` is what Node turns into one. On the `process.stdin` fallback path, where something
  else in the process is usually already listening, the identical failure arrives as a quiet return
  with echo still on, and a try/catch reads it as success: the prompt then takes the operator's
  password into the scrollback, which is the one thing this file exists to prevent, failing silently
  rather than refusing.

  Releasing them is `releaseTerminal`, and it encodes the one rule that cleanup has to get right: the
  descriptor a `ReadStream` is CONSTRUCTED with belongs to the stream, so `input.destroy()` is that
  descriptor's close and a `closeSync(fd)` beside it throws `EBADF` out of the cleanup. That cost both
  paths through this prompt. On the refusal path it came out of the `catch` and replaced the message
  naming the password and both ways out; on the ordinary path it came out of the `data` handler at the
  instant a typed password was accepted, leaving the promise unsettled and hanging a prompt that had
  already succeeded. Echo is now restored by the same function, guarded on the stream's own `isRaw`, so
  a prompt that could not be WRITTEN no longer returns the operator to a shell that echoes nothing. The
  end of the read obeys the same rule for the same reason: the promise settles BEFORE the trailing
  newline is written, because that write runs inside the `data` handler and a failing one would
  otherwise escape through `emit` and strand the promise, which is the identical hang by another route.

  The README now states the invocation together with what makes it work under vitest at all, which is
  the part that reads like it cannot: a worker is forked with piped stdio, so the prompt goes to the
  console devices directly rather than through the stdio the reporter owns.

  **And it is asked ONCE per pass, before the first spec, rather than once per spec file.** Vitest
  isolates every test file in its own module graph and its own worker process, so the holder in
  `fixtures.ts` cannot outlive the file that built it: asked lazily, a pass that starts and answers runs
  across four specs is asked four times, and each of those prompts is written while the reporter is
  redrawing test lines over it, which is how an operator ends up unsure whether their password was even
  accepted. `acceptance/globalSetup.ts` asks in the MAIN process before any worker exists and before a
  test line is printed, and hands the value to each worker through vitest's `provide`/`inject`, which is
  the RPC channel rather than a file.

  It asks only when it can tell one will be needed: the pinned preset's base model reporting
  `personalSubscription`, which is `personalSubscription` alone and never `available`, since a selectable
  personal-subscription model is exactly the case whose dispatch still answers `428`. A provider-key
  workspace is asked nothing. A catalog it could not read says so and leaves the ask at the first
  dispatch, so an unreachable deployment loses nothing and the preflight keeps ownership of diagnosing
  it.

  **That hook can only ever DELAY the ask, never end the pass.** It runs before the first prerequisite
  is evaluated and before a journal line exists, so anything it throws is the operator's whole output:
  no "your key is bound to another workspace", no "the pinned preset's model is unwired", no ledger, no
  journal, and no chance to fix the thing that was actually wrong. So a terminal it cannot ask on is
  PRINTED and continued from, and the dispatch that needs a password is what stops the pass, with
  everything the preflight found already on screen. The one refusal that does end it there is a person
  pressing Ctrl-C, which is a decision rather than a limit and would otherwise start an afternoon-long
  run that spends real money. All of that lives in `src/personalPasswordAsk.ts` with the hook reduced
  to wiring, because a degradation nothing tests is a degradation that quietly becomes an abort.

  Two consequences worth knowing. The password now sits in the main process's memory as well as each
  worker's, which is the cost of asking once; no copy is written down, which is the property the design
  protects. And `test.env` is not applied in the main process, so the `.env` reader moved to
  `src/envFile.ts` and is now read by the vitest config and the hook alike rather than existing twice.

  **Every command this suite prints with a variable in it is now rendered for the shell that will
  receive it.** The same session found the second half of the same problem: `VAR=value command` and
  `export VAR=value` are POSIX syntax, and between them they were hard-coded into the banner every spec
  file opens with, both prerequisite remedies that offer a resume, the line the status report ends with,
  the per-person prefix remedy, and the three remedies whose whole fix is one value (a workspace id, a
  repository owner, an ingress template). The banner is the most printed of them: it is where an
  operator whose pass died in spec 03 recovers the run id, and it has no other source. PowerShell has no inline environment prefix and no `export` at all, so it reads each as the
  command NAME and answers `CommandNotFoundException`. On the Windows machine this suite is documented
  to run a local deployment on, every one of those pasted into a failure. A remedy that does not parse
  is worse than no remedy, because it is offered as the thing to run, which is the rule `shellQuoted`
  already existed for.

  `operatorText.ts` (which owns how a value becomes text an operator pastes) now decides every dialect
  in ONE table, and the renderers above it say what they need rather than which shell is in play:
  `resumeInvocation` for a value scoped to one command, `envAssignment` for one that is kept, and
  `perPersonPrefixInvocation` for the one whose value is a live username substitution. That last one is
  also the one place a shell still expands what came from the environment, so the literal half is
  escaped per dialect: `ACCEPTANCE_NAME_PREFIX` is read verbatim from an operator's `.env`, and
  unescaped, a prefix holding `$(…)` was not a broken command but a command that RAN something else on
  paste.

  **The dialect follows the SHELL, not the platform.** Git Bash and MSYS are ordinary places to drive
  this suite from on Windows, and there the PowerShell form is worse than the POSIX one it would
  replace: bash expands `$env:ACCEPTANCE_RUN_ID` to nothing, answers `=: command not found`, and never
  reaches the command, so a printed RESUME silently starts a second pass. `SHELL`/`MSYSTEM` decide;
  `PSModulePath` deliberately does not, since Windows sets it machine-wide and Git Bash inherits it.
  `cmd.exe` reads as PowerShell, and that is a stated LIMIT rather than a decision: nothing in the
  environment separates the two (`ComSpec` is in both, and cmd's own `PROMPT` is inherited by a
  PowerShell started from a cmd window), while guessing the other way would hand `&&` to Windows
  PowerShell 5.1, which cannot parse it at all. What follows from the limit is that nothing may send an
  operator to cmd.exe, which is why the echo refusal above no longer does.

  **The PowerShell resume clears the variable it set.** `$env:` is the process environment: no block,
  function or child scope narrows it, so the form this suite printed set `ACCEPTANCE_RUN_ID` for the
  rest of that window and every later `run acceptance` in it silently resumed the finished pass. That
  is the exact cost `resumeInvocation` refuses to print a `.env` line for, and the POSIX prefix it
  replaces does not have it, so one "resume" meant two different things by dialect. It now renders
  `try { … } finally { Remove-Item Env:… }`: `finally` rather than a trailing `;`, because an
  interrupted pass is when a resume is likeliest to be wanted next.

  Each renderer is asserted for both dialects with an injected flavour rather than against
  `process.platform`, so the PowerShell form is covered by the Linux CI lane that would otherwise never
  execute it. The call-site tests compare against the renderer instead of restating a spelling, so
  shell knowledge lives in one place.

  The README documents both forms plus the `.env` line, which is the one form needing no dialect, and
  states what each costs: a line in the file persists until it is removed, and a hand-typed `$env:`
  without the clear persists for the session, so either one silently resumes a pass you meant to leave
  behind.

  Still POSIX-only, named as the exception in the README rather than left to be discovered: the `curl`
  remedies interpolate `$CAT_FACTORY_API_KEY`, which PowerShell expands as one of its own variables and
  sends as an empty bearer token. That is a sweep over every read and write command in
  `prerequisites.ts` and wants its own change.

## 0.1.7

### Patch Changes

- Updated dependencies [ee733ee]
  - @cat-factory/contracts@0.300.0
  - @cat-factory/kernel@0.291.0
  - @cat-factory/sdk@0.37.0
  - @cat-factory/cli@0.12.0

## 0.1.6

### Patch Changes

- 01086d8: `GET /api/v1/models` now says whether a model's subscription is actually CONNECTED for the person a
  key belongs to, and stops calling the commonest one unwired. Surface version 1.47.0, additive: two
  new response fields and no change to anything already published.

  **The bug.** `userScoped` was added so a caller could tell "your credential was never consulted" from
  "no provider is wired", and it was derived from the route IN FORCE. A model with more than one route
  resolves, when nothing is configured, to the most-preferred route it merely DECLARES, and
  `subscription` is last in that order, so `claude-opus`, the built-in Claude preset's own model, which
  also declares OpenRouter, answered `userScoped: false`. The flag shipped to remove that misreport
  never fired for the model every report of it has been about; the acceptance suite kept printing "no
  provider wired for it" at operators whose workspace runs Claude every day, and the fix it named (add
  a provider key) was for a deployment that was already correct.

  **Why a new field rather than a corrected one.** `userScoped` is published, and correcting it in
  place would have moved its meaning in two directions at once: true where a model merely declares a
  subscription route (right), and no longer true for a POOLED vendor whose subscription route is in
  force (also right, and also a change under any consumer branching on it). So `userScoped` keeps
  answering exactly what it always answered and is marked superseded, `personalSubscription` is served
  beside it, and dropping the old half is a later change. `personalSubscription` is true where a model
  declares a subscription route whose vendor is individual-usage only, read through kernel's own
  `individualVendorForModelId`, the same predicate the run path gates a personal credential on. The
  pooled exclusion matters: a Kimi or DeepSeek token belongs to the WORKSPACE, so every key can already
  see it, and reporting one as personal sent an operator to re-mint a token when the fix was a pooled
  token or a provider key.

  **The existence field.** `personalSubscription` alone still stops one step short of useful: told a
  row cannot be judged, an operator's next move is to re-mint the token bound and see what happens,
  which is exactly how the last person to hit this found the answer. Each row now carries
  `subscriptionConfigured`: whether a personal subscription for that vendor is stored for the person
  the key belongs to (`actsAsUserId` when bound, else its minter), and `null` when there was nobody to
  ask about. Existence is a row lookup, so the deployment answers it without the personal password that
  OPENS the credential.

  That is also the correction to 1.45.0's reasoning, which rejected reporting this on the grounds that
  "the server cannot know whether one exists without a user". An unbound key does have a user for
  DESCRIPTION purposes: its minter, who is exactly who the remedy names. Reading it changes nothing
  about admission: `available` is still resolved under `actsAsUserId` alone, so a system token reads
  `available: false` beside `subscriptionConfigured: true`, and both are true. `createdByUserId` rides
  `PublicApiKeyAuth` for that one reader and stays provenance; nothing authorizes off it. The
  disclosure this trades (an `admin`-scoped key learns one bit about its minter, who need not be its
  holder) is documented on the field and in `public-api.md`.

  **Three fixes underneath.** A LAPSED personal subscription reported as configured (`has` checked
  existence where `unlock` checks expiry), so the catalog offered a model whose run was then refused at
  its first dispatch, naming the model rather than the subscription. Both credential stores answered
  the vendor sweep one single-row question at a time; `PersonalSubscriptionService.liveVendors` and the
  new `ProviderSubscriptionService.liveVendors` each answer the whole vocabulary in one read, on a path
  both the catalog render and every run start take. The pooled half needed a new
  `ProviderSubscriptionTokenRepository.listByWorkspace`, mirrored across D1, Drizzle and the local
  sqlite credential store with a conformance assertion.

  The acceptance suite reads all of it: `configure`'s menu and the `model-preset` / `agent-model` gates
  now distinguish five states with five different fixes, with the account model-family policy ranked
  ahead of every credential state (it is the one cause no credential can undo) and the state that
  matters most saying the subscription is connected and naming the token as the only thing in the way.

- Updated dependencies [01086d8]
  - @cat-factory/contracts@0.299.1
  - @cat-factory/kernel@0.290.1
  - @cat-factory/sdk@0.36.1
  - @cat-factory/cli@0.12.0

## 0.1.5

### Patch Changes

- 1bcdacc: Name the cause when an acceptance prerequisite probe throws, instead of reporting `fetch failed` or
  a bare status.

  A probe fails in three fundamentally different ways and the gate rendered all of them as the same
  sentence, because the catch that turns a thrown probe into an `unknown` verdict read `error.message`.
  The verdict is now a discriminated one, so the reader cannot be conflated: nothing about a transport
  failure is representable on an answered one.

  It never got an answer: on Node a transport failure is a bare `TypeError: fetch failed` with the
  informative link (`connect ECONNREFUSED 127.0.0.1:8787`, a DNS miss, an untrusted certificate) one
  `.cause` down, so a deployment that was simply not started reported those two words under a remedy
  listing three causes it had not distinguished, two of them about a credential a refused connection
  never sent. The new `src/probeFailure.ts` classifies the chain through kernel's
  `describeConnectionFailure`, the platform's one producer of connection verdicts, and relays its
  per-cause remedy rather than paraphrasing it. One class the chain cannot reach is corrected: the SDK
  aborts its own deadline with a marker NAMED `AbortError` (that is how the transport tells its
  deadline from a caller's cancellation), so a hung or firewalled deployment classified as `aborted`
  and was told to run the test again instead of being pointed at dropped packets. Kernel gains
  `connectionFailureHint`, the same per-cause sentence for a cause the caller classified, so the fix is
  a relay and not a second copy.

  It got an answer and the answer was a refusal: the SDK throws a typed `CatFactoryApiError` carrying
  the status, the machine-readable `code` and the `X-Request-Id`, and reading it as `error.message`
  threw all three away. A prerequisite driving an operation the running deployment is too OLD to serve
  reported `the check threw: 404 unknown: HTTP 404`, whose fix nothing in the message pointed at. An
  envelope-less 404 is now read as an unmatched route (a deployment behind the suite, or a base URL
  naming the SPA, which answers the same shape), separately from a `not_found` that names a real
  resource, and the request id travels with every refusal. The two unauthenticated ROOT reads answer
  here too: `DeploymentApi` throws a typed `DeploymentAnswerError` carrying the status, where a plain
  `Error` fell through to the unclassified branch and reported "no HTTP status came back, so suspect the
  check itself" one line under a detail quoting the 404. Their remedy is its own, because neither route
  takes a credential: what a status narrows there is which LAYER answered.

  Something answered and it was not the deployment: a 2xx whose body is not the JSON the route
  documents is neither a refusal nor a transport fault, and it is the only answered failure that
  reopens the address. The SPA (which serves a `/health` of its own), a login portal and an intercepting
  gateway all land here, from either surface: the root reads, and the SDK's `CatFactoryDecodeError`.

  Three smaller corrections of the same kind. Every remedy states how to RESUME rather than claiming a
  re-run starts clean, since the gate runs in every spec's `beforeAll` and a resumed pass reaches it
  with services adopted. A step promising "the command below" or "the request id below" is emitted only
  when that line is. And the base URL is scrubbed and shell-quoted wherever a remedy prints it, because
  userinfo is legal in one and no URL policy rejects it.

  `issue-credential` is the one prerequisite whose calls leave the deployment, so it now describes its
  provider-facing failures where it makes them (through the same kernel describer, with the provider's
  own address named) and its body read no longer escapes the check; the runner's single probe context
  cannot be true for two hosts. `configure`, the journal and the deployment root reads share one
  `describeThrown` for the whole chain plus the one fallback for a chain that said nothing.

- Updated dependencies [1bcdacc]
  - @cat-factory/kernel@0.290.0
  - @cat-factory/cli@0.12.0

## 0.1.4

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
  - @cat-factory/sdk@0.36.0
  - @cat-factory/cli@0.12.0

## 0.1.3

### Patch Changes

- bc2478d: A public-API key now has an IDENTITY as well as a scope: a SYSTEM token (the default, unchanged) or
  a PERSONAL token its minter bound to themselves, which can run their own individual-usage
  subscription headlessly. Surface version 1.45.0, additive. Plus two bug fixes that made the old
  behaviour unreadable rather than merely limited.

  **The reported problem.** A workspace whose Claude runs come from a stored personal subscription was
  told by `GET /api/v1/models` that `claude-opus` was `available: false`, which the acceptance suite
  rendered as "no provider wired for it". Both statements are false, and the remedy they imply (add a
  provider key) is for a deployment that was already correct. The model was wired — as a credential
  belonging to a person, which a key-authenticated read is not allowed to see.

  **Two things were genuinely broken, independent of the feature.**

  `resolveWorkspaceCapabilities` did not know about NATIVE ambient execution. A vendor served by the
  host's own `claude`/`codex` CLI login (`LOCAL_NATIVE_AGENTS`) has no credential in either store, and
  the resolver consulted only those two stores, so the catalog and the pipeline-start guard called the
  model unconfigured on the very machine that would have run it. The personal-credential gate, reading
  the same allow-list, had already decided such a vendor needs no unlock: two halves of one decision,
  disagreeing. They now share `isAmbientNativeVendor`, which is where the executor's half already was.

  `GET /api/v1/models` could not say why a personal subscription's model was unavailable. The existing
  `excludesUserScopedModels` flag reports what an answer OMITS, and a subscription model is not omitted
  — it is listed, unjudged, because no user's credential store was consulted. Each row now carries
  `userScoped`, so the distinction is stated where it applies. Widening the response flag instead was
  tried and rejected: with no user resolved the server cannot know whether a personal subscription
  exists, so the honest predicate is "this deployment has `ENCRYPTION_KEY`", which is true nearly
  everywhere. A flag that is always true stops answering its question, and it would have re-pointed a
  published field at a new predicate under the same name.

  **The feature.** `POST /workspaces/:ws/public-api-keys` takes `actsAsSelf`, and the key row carries
  `actsAsUserId`. A personal token's runs record that person as initiator, `GET /api/v1/models`
  resolves under them, and a start/retry/decision call may unlock their subscription by sending
  `X-Personal-Password` — the same header, the same 428, and the same per-run activation the app uses.
  A system token behaves exactly as every key did before, including the `409
individual_model_unsupported` refusal, which is now reserved for the case no password could fix.

  Three properties bound it, and each is a shape rather than a rule to remember. The wire field is a
  BOOLEAN and the server reads the id off the session, so minting a key onto a colleague's
  subscription is unrepresentable rather than merely forbidden; a mint with no signed-in user is
  refused instead of quietly producing an unbound key. Headless provisioning (`POST /api/v1/keys`)
  can never bind, because a provisioning key holds nobody's consent to inherit. And the password is
  stored NOWHERE — not on the row, not in a session — so the binding alone spends nothing and a
  leaked personal token reaches that user's PAT (as a leaked session would) but not their
  subscription.

  A bound key attributes EVERY run it starts, not only the ones needing an unlock. The alternative
  makes one key produce runs under two identities depending on which model a task happened to pin,
  with two credential scopes and two merge-policy roles, and nothing in the request to say which.

  **And a bound run is that person's run all the way through, policy included.** The two public start
  routes resolve the bound user's workspace ROLE and pin it, so a headless start is admitted under the
  same role-scoped merge narrowing and the same dry-run sandbox its holder gets in the app: a key
  cannot land what the person behind it could not. An initiator with no role is not a lenient run, it
  is a run with no policy — which is what the bug-hunt adopt route once shipped, and why
  `runAdmission.coverage.spec.ts` makes every start route CLASSIFY itself. A retry deliberately keeps
  the ORIGINAL run's pinned authority instead (`buildResumedInstance`), because a re-drive is the same
  work under the authority it was first granted, and dropping it would launder a dry run into a live
  one via restart-from-step-0.

  `POST /api/v1/jobs` runs the same personal-credential gate as the board start. Being inline-only
  settles what a public run may DO (no container, no push) and says nothing about whose credential it
  needs: the inline harness leases a personal subscription for every individual-usage vendor, so
  skipping the gate there traded an actionable refusal for a run that dies at its first dispatch.

  Deliberately not lifted: `POST /api/v1/notifications/:id/act`. Its ci-/test-failure arm retries
  through a shared effect that mints no activation, so admitting a bound key there would trade a
  refusal the caller can act on for a run that dies at its first dispatch. Lifting it means threading
  the gate through that effect for the SPA and this surface at once.

  **Answering a park no longer re-derives a credential that is already fresh.** Each re-mint runs
  210k PBKDF2 iterations per vendor, which a human clicking through a run pays once and a headless
  driver answering eight follow-ups would pay eight times in a row — seconds of blocked event loop on
  Node, a CPU-limit kill on workerd. The interaction path now skips the whole gate while the run holds
  an activation with over half its life left, and both facades share one helper, so the SPA gets the
  same. The decision surface's refusal is returned as DATA (a `428` in that surface's own envelope,
  carrying the vendor and reason) rather than thrown, which is the invariant every other gate there
  already keeps.

  **`X-Personal-Password` is declared on the operations that read it**, so it reaches
  `docs/openapi.json` and the four generated clients instead of being discoverable only by getting a 428. Each client also gained a post-construction setter for it, since that is when a caller learns
  it is needed.

  **The acceptance suite** now runs on the operator's own subscription. It prompts for the personal
  password at the terminal on the first call that needs one — never at `configure` time, and never at
  all for a workspace on a provider API key — and holds it in memory only: not the `.env`, not the
  ledger, not the journal, because a copy beside `CAT_FACTORY_API_KEY` would put both halves of a
  two-factor credential in one file. The header then rides every request, since answering a park
  re-mints the run's activation server-side. `configure` and the `model-preset` gate now say "not
  visible to this system token" and name the fix, instead of the wrong one they used to name — read
  off the ROW, so a model that genuinely has no provider still reads as unwired, and an invisible
  workspace default stays SELECTED rather than being quietly swapped for a model nobody chose.

  The prompt opens the CONTROLLING TERMINAL rather than reading `process.stdin`. The suite runs under
  vitest, whose workers are forked with piped stdio, so a prompt built on stdin could never have asked
  anything: the one path this exists for would have thrown "stdin is not a terminal" on every pass. It
  is also stricter than the check it replaces, since a controlling terminal cannot be fed from a pipe
  or a file at all. And the entered password is no longer trimmed: a space is printable ASCII, so a
  legal password with one at either end was being silently altered and then reported as wrong.

- Updated dependencies [bc2478d]
  - @cat-factory/contracts@0.298.0
  - @cat-factory/sdk@0.35.0
  - @cat-factory/cli@0.12.0

## 0.1.2

### Patch Changes

- Updated dependencies [a634746]
  - @cat-factory/contracts@0.297.0
  - @cat-factory/cli@0.12.0
  - @cat-factory/sdk@0.34.0

## 0.1.1

### Patch Changes

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

- Updated dependencies [7893f35]
  - @cat-factory/contracts@0.296.0
  - @cat-factory/sdk@0.34.0
  - @cat-factory/cli@0.12.0

## 0.1.0

### Minor Changes

- c0412e9: The acceptance suite now ADOPTS two repositories the operator created instead of bootstrapping
  them, and ships a `configure` command that assembles its `.env`.

  Bootstrapping was the one prerequisite no configuration could satisfy: a PAT connection reports
  `canCreateRepos: false` for every workspace and the App creation path is org-scoped, so on the
  deployment shape the suite's own README offers first, spec 01 could not run at all. It now backs a
  board service with each named repository (`POST /api/v1/services` already takes a `repoId`) and
  scaffolds both through `pl_build` from the same briefs, which also makes an interrupted scaffold
  resume the way an interrupted feature run does. `vcs-connection` stops asking for repository
  creation, `target-repos` gates on both repositories being visible AND adoptable, and a new
  `model-preset` check joins the pinned preset against the model catalog so an undispatchable preset
  is named as one rather than found at the first dispatch. Every task the suite files pins
  `ACCEPTANCE_MODEL_PRESET`, so a pass runs on the model it says it ran on.

  Adoptable is the stricter half of that gate, and it reads `linkedElsewhere` rather than only
  `serviceId`: a whole-repo service homed on another board of the account has no id a
  workspace-scoped surface can return, so the repository row answers `serviceId: null` with the flag
  set, and `POST /api/v1/services` refuses it. An existing link on this board is compared against the
  LEDGER's own service ids, so a resumed pass holding one of the two services cannot silently adopt a
  colleague's other one. The two repository blockers, a monorepo and a foreign home, are refused
  identically by the gate and by the adopt itself.

  `pnpm --filter @cat-factory/acceptance run configure` resolves what the deployment and the
  kubeconfig already know (workspace, connected account, preset library, apiserver, ServiceAccount
  token), asks for the API token and the two repository names, and opens each repository's creation
  page prefilled. It never overwrites a value without naming it and prints neither token.

  `@cat-factory/cli` gains four exports (`readApiServerCommand`, `readTokenCommand`, `decodeToken`,
  `normalizeApiServerUrl`) so the new command asks a kubeconfig the same questions `cat-factory k3s`
  does, and normalises the answer the same way: k3d writes the undialable wildcard bind address
  `https://0.0.0.0:6443` into a kubeconfig, so the read and its rewrite travel together.

  Internal break, as pre-1.0 internals may: a ledger from an earlier pass is not read for its
  `bootstrapJobs`, so a pass interrupted mid-bootstrap under the old shape starts fresh rather than
  re-attaching to a job.

### Patch Changes

- Updated dependencies [c0412e9]
  - @cat-factory/cli@0.12.0

## 0.0.6

### Patch Changes

- Updated dependencies [07ff467]
  - @cat-factory/contracts@0.295.0
  - @cat-factory/sdk@0.33.0

## 0.0.5

### Patch Changes

- Updated dependencies [9b3473a]
  - @cat-factory/contracts@0.294.0
  - @cat-factory/sdk@0.32.0

## 0.0.4

### Patch Changes

- f6a1a87: Read the acceptance suite's configuration from a `.env` beside its vitest config. The file was
  already gitignored and referenced, but nothing loaded it, so a fully configured `.env` still
  refused with every variable reported as missing. A variable exported in the shell wins over the
  file, so a one-off `ACCEPTANCE_RUN_ID=latest` still resumes.

## 0.0.3

### Patch Changes

- Updated dependencies [b25732f]
  - @cat-factory/contracts@0.293.0
  - @cat-factory/sdk@0.32.0

## 0.0.2

### Patch Changes

- Updated dependencies [7119ca7]
  - @cat-factory/contracts@0.292.2
  - @cat-factory/sdk@0.31.0

## 0.0.1

### Patch Changes

- Updated dependencies [57a7ecd]
  - @cat-factory/contracts@0.292.1
  - @cat-factory/sdk@0.31.0
