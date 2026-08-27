# `@cat-factory/acceptance`

**Acceptance tests against a LIVE local deployment.** Real agents, real model spend, real
repositories, real pull requests, real issues, and a real k3s cluster. They adopt two empty
repositories you created, scaffold a working service into each, ship a feature across both onto an
ephemeral Kubernetes environment, file the defect that feature leaves behind and let the platform
investigate and fix it, and then file an issue as an OUTSIDE reporter and watch the platform deliver
it and close it.

**Never run in CI**, and structurally cannot be: `test:run` (the task CI runs) points at
`vitest.config.ts`, which collects `test/**/*.test.ts` only, this package's own unit tests. The
scenarios are not tests at all as far as any runner is concerned; they are modules a plain Node
entry point walks.

**There is no test framework here.** The pass is `node src/runAcceptance.ts`: five scenarios in one
process, in the order `src/scenarios/index.ts` lists them, stopping at the first failure, asserting
with `node:assert/strict`. It used to be five vitest spec files with almost everything vitest does
switched off, and the parts that could not be switched off (a module graph per file, a reporter that
owned the console) cost a `globalSetup` hook, an RPC channel and a custom sequencer. Design record:
[ADR 0057](../../docs/adr/0057-acceptance-standalone-runner.md).

```sh
pnpm --filter @cat-factory/acceptance run configure   # assemble the .env, once
pnpm --filter @cat-factory/acceptance run acceptance
pnpm --filter @cat-factory/acceptance run status      # where is it, from another window
pnpm --filter @cat-factory/acceptance run reset       # what starting over would delete
```

A pass runs for an afternoon, so it is usually piped to a file (`… run acceptance | tee pass.log`) and
read afterwards. **Every line every one of these commands prints goes to stdout, refusals included**,
which is what makes that log complete: `tee` captures one stream, and no command exits through
`process.exit`, which would not drain it. The exit code carries the verdict instead, and there are three:
`0` every scenario passed, `1` a scenario failed, `2` nothing ran (the configuration, the run id or the
ledger was refused, or a person declined the password prompt). **`1` says the pass ran, never that it
created anything**: the commonest failure of all is a prerequisite refusing a fresh attempt, and what
there is to inspect or resume is read off the ledger and stated in the pass's closing words.

## What it is for

The e2e suite ([`backend/internal/e2e`](../e2e)) proves the assembled product with every external
dependency faked, and the conformance suite proves the backend port by port. Neither can answer the
question this suite exists for: **does the whole thing work when nothing is faked?** A fake agent
executor cannot tell you that a real model, handed a real brief, produces a repository whose
manifests a real apiserver accepts, whose tests a real CI gate passes, and whose defect a real
investigation finds. Everything here is the part that only exists once nothing is a stub.

The trade is deliberate and worth stating: this suite is slow, costs money, and is not
deterministic. That is why it is a hand-run acceptance pass rather than a lane.

## The scenarios

Five scenarios, run in order, in one process. Each one's output is the next one's input.

That order is the ARRAY in `src/scenarios/index.ts`, walked by the kit's [`scenarioRunner.ts`](../../packages/acceptance-kit/src/scenarioRunner.ts). It is worth
saying only because it used to need a custom vitest sequencer: the default one reorders the files it
is handed from a cache of the previous run (failed first, then longest-duration first), so paired
with `bail: 1` the slowest spec of the last pass ran FIRST, failed in milliseconds on a ledger key
nothing had written yet, and stopped the pass before the spec that writes it had started. What that
looked like from outside was the LAST spec failing in a pass where nothing else ran, under a message
telling you to run the suite from the start.

| Scenario                   | What it does                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `00-preflight`             | Reports every prerequisite as its own named step. Creates nothing. The GATE runs before each of the others, so a resumed pass cannot skip it.                      |
| `01-adopt-and-scaffold`    | Connects the k3s engine, backs a service with each of your two repositories, declares each one's manifest source, then scaffolds both through `pl_build`.          |
| `02-feature-with-defect`   | Ships a paginated catalog across both services on `pl_build`. Asserts the environment came up on the cluster, CI gated it, the merge resolved, the namespace went. |
| `03-investigate-and-fix`   | Files the resulting bug as a report, runs `pl_bugfix`, answers its `clarity-review` human gate over `/api/v1`, and asserts a red-then-green reproduction proof.    |
| `04-issue-intake-to-close` | Files an issue on the backend repository as an outside reporter, files a task FROM it, delivers it on `pl_build`, and asserts the platform CLOSED the issue.       |

**What the pass prints**, since no reporter does it now: the run id and the resume command, then each
scenario with its steps as they start and how long each took, then the failure in full where there is
one, then a summary naming which scenario broke, at which step, and that the ones after it did not
run, and last the closing words, which say what to do next. It exits 1 for a failed scenario and 2 for
a pass that refused to START (an unconfigured checkout, a `latest` that names no pass, a ledger
belonging to another pass, a declined password), which is the difference between a pass that ran and
one that never reached a scenario. **Whether a failed pass left anything behind is a separate
question**, answered off the ledger in those closing words rather than by the exit code: the commonest
failure in this suite is a prerequisite refusing a FRESH attempt, which exits 1 having created nothing
to inspect and nothing to resume.

### You create the two repositories; the suite adopts them

Repository creation is the one setup step the suite cannot perform. A PAT connection reports
`canCreateRepos: false` for every workspace, and the App path creates only under
`/orgs/{org}/repos`, so a personal account was never a supported target either: on the deployment
shape this README offers first, scenario 01 could not run at all.

So you create two empty repositories, name them in the `.env`, and scenario 01 backs a board service
with each (`POST /api/v1/services` takes a `repoId`, which is where one comes from) and then
scaffolds both through `pl_build` from the same briefs the bootstrapper agent used to be handed.
Each one is an ordinary pipeline run, which is why an interrupted scaffold resumes exactly as an
interrupted feature run does. Decision record:
[ADR 0056](../../docs/adr/0056-acceptance-suite-operator-setup.md).

**Create them with a README and nothing else.** A scaffold run opens a pull request, which needs a
default branch to target, and a repository with no commits has none. Content beyond that is not
refused (no `/api/v1` read can see it) and is scaffolded on top of.

**You do NOT have to link them: the suite adopts each one itself** through
`POST /api/v1/repos/link`, so a `.env` written by hand gets the same pass as one `configure` wrote.
Linking is a per-workspace act that nothing on the platform performs on its own (the provider webhook
for an added repository does not project one, and a resync refreshes what is already linked), which is
why `GET /api/v1/repos` can be empty for a repository that plainly exists; adopting one is a public
operation, so the suite makes the call rather than sending you to the app.

**What you do owe is REACHABILITY**, which no API can arrange for you: the repository has to exist
under `ACCEPTANCE_REPO_OWNER`, and this workspace's connection has to be granted it (a GitHub App
installation must include it; a classic PAT needs `repo` to see a private one). A repository the
connection cannot reach is absent exactly as a non-existent one is, so both `run configure` and the
`target-repos` gate report the pair rather than guessing which it was.

### The defect is planted in the SPECIFICATION, not in the code

Scenario 03 can only investigate a bug scenario 02 actually shipped, so something has to put one there.
Telling the coder to write a bug does not survive the pipeline: `pl_build` runs a `reviewer` step,
and a deliberate defect inside one service is exactly what a reviewer is for. It would be caught,
the run would bounce, and scenario 03 would find nothing wrong.

So the defect is a **contract mismatch between the two briefs**: the backend's says `offset` counts
from 1, the frontend's says it counts from 0. Each service is implemented faithfully, reviewed
against its own brief, and found correct, because it is. The defect exists only in the space
between them, which no single-repository review can see, and it shows up only when both run
together, which is what the ephemeral environment is for. It is also the most ordinary integration
bug there is.

The symptom it produces, which is what the bug report describes: page 1 lists items 1–10, page 2
starts at item 10 again, and the last page is short.

The consequence, stated because it is easy to misread as a gap: **scenario 02 asserts the delivery
machinery worked, never that the product is defect-free.** By construction it is not. The claim
that the product is right is scenario 03's, and it is settled by fixing the bug rather than by
asserting it away.

### The reporter in scenario 04 is a stranger, and holds its own credential

Scenario 04's premise is that somebody who has never heard of cat-factory opens an issue on a repository,
and the platform picks it up, delivers it and closes it. That is the loop a headless deployment runs
on, and every part of it is invisible to a task filed with a `description`: the ticket import, the
linked issue every agent step re-reads as context, and the writeback.

So the issue is filed through the PROVIDER's own API with a credential of its own
(`ACCEPTANCE_VCS_TOKEN`), and read back the same way. Using the workspace's connection instead would
make the test circular: an issue the platform's credential created, closed by the platform's
credential, proves that the credential works and nothing else. There is no `/api/v1` operation for
either half, and there should not be, since filing an issue is not something this product does for
you.

**What it asserts is a PAIR**, and the second half is what makes the first mean anything:

1. The issue is CLOSED, by nobody.
2. The platform wrote two distinct comments on it naming the run's pull request, one when it opened
   and one when it merged.

A provider closes an issue by itself when a merged pull request's text carries a closing keyword
(`Closes #12`), and that path posts no comment at all, so a closed issue on its own cannot tell the
writeback from the host noticing a word an agent wrote. The two comments are a fingerprint no keyword
can leave. Both edges are on by default and the `tracker-writeback` prerequisite refuses a pass whose
workspace turned either off, so the count is deterministic rather than hopeful.

**What the issue asks for is deliberately small and orthogonal**: tighter validation of one query
parameter on the catalog API, which changes nothing about a valid request. The claim of the scenario is
the LOOP, not the feature, and a change that moved the paging contract scenario 03 has just settled would
make a scenario 04 failure unreadable. `src/instructions.ts` carries the issue text and that reasoning.

## Prerequisites

A local cat-factory that can really do the work, and a cluster to deploy onto.

**Most of this list is CHECKED, and checked before anything is created.** `src/prerequisites.ts`
probes each condition below, the runner runs the whole gate before every scenario that spends
anything, and a pass that would fail is refused with every unsatisfied prerequisite and its remedy in
one message. That
matters because each of these otherwise surfaces between fifteen and ninety minutes in, wearing a
failure that names something else: an unwired model looks like a broken dispatcher, a connection
without workflow permission looks like a repository whose CI never fires, and a preset that holds
every merge for a person looks like a run that stalled on its last step.

Three states, not two: a probe that cannot READ an answer reports that, and never as evidence
that the prerequisite is unmet.

**And such a probe names its CAUSE**, because there are three ways to fail and they need opposite
fixes. The kit's [`probeFailure.ts`](../../packages/acceptance-kit/src/probeFailure.ts) owns the distinction, as a discriminated verdict rather than one shape
with optional fields.

_It never got an answer._ A transport failure on Node is a bare `TypeError: fetch failed` with the
informative link (`connect ECONNREFUSED 127.0.0.1:8787`, a DNS miss, an untrusted certificate) one
`.cause` down, so read as `error.message` all of those rendered as those same two words under a remedy
listing the causes it had not told apart: a deployment that was simply not started offered three
candidate fixes, two of them about a credential no refused connection had sent. The chain is
classified through kernel's `describeConnectionFailure`, the same producer behind every "Test
connection" button in the product, and its per-cause remedy is relayed rather than paraphrased. One
class the chain cannot see is corrected here: the SDK's own deadline aborts with a marker NAMED
`AbortError`, which reads as a cancelled request, so a hung or firewalled deployment was told to run
the test again instead of being pointed at dropped packets.

_It got an answer, and the answer was a refusal._ The SDK throws a typed `CatFactoryApiError` carrying
the status, the machine-readable `code` and the `X-Request-Id`, so the remedy is about the request
rather than the address, and the request id travels with it. One case earns its own branch: a 404
carrying no error envelope is an UNMATCHED ROUTE, which is what a deployment older than this suite
looks like (`pnpm build`, then restart) and equally what a base URL naming the SPA answers. That reads
nothing like a `not_found` naming a resource, and telling them apart is the difference between
rebuilding and hunting a workspace id. The two unauthenticated root reads answer here too, through
`DeploymentAnswerError`, and their remedy is a different accusation from the same status on
`/api/v1`: neither route takes a credential, so nothing about the API key is implicated, and what a
status narrows is which LAYER answered (a 401 is something in front demanding what the route never
requires, a 5xx is a boot failure or a gateway).

_Something answered, and it was not this deployment._ A 2xx whose body is not the JSON the route
documents is neither a refusal nor a transport fault: every refusal a backend states comes back in
its own error envelope, so this is a fact about the ORIGIN. It is the SPA (which serves a `/health`
of its own), a login portal, or a gateway intercepting the path, and it is the answered failure that
puts the address back in question rather than settling it.

**A refusal is INSTRUCTIONS, not a diagnosis.** Every unmet prerequisite comes back with numbered
steps and the commands that carry them out, rendered with what the probe just read rather than
with a placeholder to go and resolve: the workspace id the key is actually bound to, the account
the workspace is actually connected to, the `kubectl auth can-i` line for the ServiceAccount, the
resume command for the pass whose frames are in the way. Two rules keep that honest. Where the fix
is a console action (minting a token, raising a budget, wiring a provider) the remedy names the
SCREEN and offers only the read-only command that CONFIRMS the change landed, because an invented
command sends someone to a shell that will refuse them. And where the deployment publishes its own
diagnosis, `deployment-health` relays it verbatim, doc link included: the backend's per-variable
remedy already names the exact `openssl`/`npx` line, and a paraphrase here would be a second copy
of it, one release behind.

| Prerequisite         | Checked | What it means                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deployment-health`  | yes     | The backend booted. A misconfigured one serves a fallback app, and its own problem list is reported.                                                                                                                                                                                                                                                                                                                                   |
| `api-key`            | yes     | `CAT_FACTORY_API_KEY` names `ACCEPTANCE_WORKSPACE_ID` and is scoped `admin`.                                                                                                                                                                                                                                                                                                                                                           |
| `spend-budget`       | yes     | The workspace is not over budget, which pauses every run.                                                                                                                                                                                                                                                                                                                                                                              |
| `agent-model`        | yes     | At least one catalog model is selectable. Distinguishes "unconfigured" from "blocked by account policy".                                                                                                                                                                                                                                                                                                                               |
| `model-preset`       | yes     | `ACCEPTANCE_MODEL_PRESET` exists here AND its base model can be dispatched to (see below).                                                                                                                                                                                                                                                                                                                                             |
| `vcs-connection`     | yes     | Connected to `ACCEPTANCE_REPO_OWNER` and may write workflow files.                                                                                                                                                                                                                                                                                                                                                                     |
| `target-repos`       | yes     | Both named repositories are REACHABLE (linked already, or point-read through `/repos/available`) AND adoptable: no monorepo, nothing homed on another board, and any existing service link is one this pass's own ledger names.                                                                                                                                                                                                        |
| `issue-credential`   | yes     | `ACCEPTANCE_VCS_TOKEN` can reach the backend repository and open an issue on it (which needs its Issues feature switched on).                                                                                                                                                                                                                                                                                                          |
| `tracker-writeback`  | yes     | The workspace comments on a linked tracker issue when a pull request opens AND closes it when the pull request merges: scenario 04's whole claim.                                                                                                                                                                                                                                                                                      |
| `auto-merge-policy`  | yes     | The workspace's default risk policy permits auto-merge (see below).                                                                                                                                                                                                                                                                                                                                                                    |
| `board-titles`       | yes     | A fresh pass is not about to create a second frame under a title this board already has.                                                                                                                                                                                                                                                                                                                                               |
| `cluster-connection` | yes     | The apiserver answers the ServiceAccount token, probed without persisting anything.                                                                                                                                                                                                                                                                                                                                                    |
| `cluster-ingress`    | yes     | That cluster can SERVE the URL those templates render, which the apiserver credential says nothing about: it runs an ingress CONTROLLER, and a host PORT is published into it. Reuses `cat-factory k3s`' own probe rather than restating it. Reports `unknown` rather than a verdict when the configured apiserver is not this machine, since the IngressClass read goes through the current kubectl context and nothing ties the two. |
| `ingress-template`   | yes     | The configured namespace and host templates COMPOSE into a URL that reaches this cluster: each renders with no hole left, and the name they build together carries one address rather than the wildcard-DNS shift that sends a run somewhere else. Graded once per repository, since a namespace template may name `{{repoName}}`.                                                                                                     |
| `image-template`     | yes     | The manifests' `{{image}}` renders to a reference a cluster could pull. It says outright what it did NOT check: whether anything publishes that reference, whether the cluster may pull it, and whether the owner is spelled as the provider spells it.                                                                                                                                                                                |
| `pipeline-catalog`   | note    | Advisory: an unadopted pipeline materialises on first start, so this is a heads-up rather than a refusal.                                                                                                                                                                                                                                                                                                                              |

Three things it deliberately does NOT check, because none is knowable from where it stands:

- **Whether the two repositories are EMPTY.** No `/api/v1` read publishes whether a repository holds
  content: the bootstrapper used to answer it inside its container pre-flight, and putting it on the
  repository LIST would cost one provider round-trip per row on every call. `target-repos` says so
  in its own verdict rather than implying it checked.
- **Whether an unreachable repository was never created, or exists and is not granted.** A provider
  answers those identically, so the refusal names both rather than picking one.
- **Whether the wired model can actually build a small service.** A model that cannot scaffold a
  Fastify app fails scenario 01 for reasons that are not the platform's. This suite is not a model
  benchmark and does not grade one.
- **Whether a container runtime is available to the agent jobs.** Nothing short of dispatching a
  job answers it.

**Why `serviceId: null` is not enough to call a repository free.** `GET /api/v1/repos` reports the
service a repository backs ON THIS BOARD. A whole-repo service homed on another board of the same
account has no id this workspace-scoped surface can hand back, so it answers `serviceId: null` **with
`linkedElsewhere: true`**, and `POST /api/v1/services` then refuses it
(`reason: repo_service_homed_elsewhere`). `target-repos` reads the flag, so that arrives as a refusal
with a remedy rather than as a 409 out of scenario 01's first adopt. An existing link on this board is
compared against the ledger's own service ids, not against "is this a resume at all": a ledger holding
only the backend service cannot vouch for the frontend repository.

**Why the preset is checked separately from the model catalog.** `agent-model` answers "can this
deployment dispatch to ANYTHING", which is what the first live setup attempt needed: all 21 catalog
entries reported unavailable because the models that deployment ran on were per-user, which an API
key can see neither of. `model-preset` answers the narrower question a pinning pass actually
depends on, and keeps three outcomes apart, because they have three different fixes: no such
preset, a preset naming a model the catalog has since dropped, and a preset whose model is listed
but has no provider wired (or is refused by the account's model-family policy, or runs on a
subscription this token is not bound to spend).

**Why the pass PINS a preset rather than taking the workspace default.** The default is whatever
someone last chose on that board, so a pass that adopted it silently would report a result nobody
can reproduce, and two passes a week apart could differ for a reason neither records. Every task
the suite files carries `modelPresetId`, through the one helper that creates them
(`filePinnedTask`). The risk policy is deliberately NOT pinned: `auto-merge-policy` grades the
workspace default, and pinning one here would make that gate a check on a policy no run uses.

**Why auto-merge is a prerequisite rather than a preference.** `pl_build` ends in a `merger`, and
the suite asserts each run reached `done`, which the platform reaches only when the pull request
really merged. A preset that holds everything for a person is correctly configured and will stop
this suite. What the gate cannot settle is a preset's `dryRunRoles`: the public API does not
report which workspace role a key's runs are admitted under, so a non-empty list is STATED as a
caveat rather than graded, which is the honest disposition for an answer the probe cannot reach.

**The machine you run the suite from**

- **Node 24 or newer**, which is the repository's floor (root `package.json`, `engines.node`) and
  this package's too. The four commands below are `node src/<entry>.ts`, run by Node's own type
  stripping with no flag. Nothing checks the version, and the loader is not a check either: type
  stripping is on by default from 22.18 and 23.6, so the commands load and run on those and a
  successful start says nothing about the version you are on. Only 20 and 22 before 22.18 fail
  outright, with `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"` and nothing else to go on.
  Anything below 24 is unsupported rather than degraded.

**The deployment**

- Running in **local mode** (`@cat-factory/local-server`), or any deployment you hold an `admin`
  key for. Nothing here needs the deployment to run open: every call the suite makes is either
  key-authenticated against `/api/v1` or one of the two unauthenticated deployment root reads.
- `ENCRYPTION_KEY` set, or `/api/v1` answers `503` on every call.
- A **container runtime** for the agent jobs.

**The model, when it is your own subscription**

A pinned preset whose model is an individual-usage vendor (Claude / Codex / GLM) runs on ONE
person's subscription, and only their personal password opens it. Two consequences for a pass:

- **Mint the key as a PERSONAL token** (Integrations → API access tokens, "Runs as" → yourself).
  A system token may not spend a credential that belongs to a person, so `GET /api/v1/models`
  reports such a model `available: false`, and the row says which of three unrelated things that
  means. `subscriptionConfigured: true` is the one worth knowing: the deployment RESOLVED your
  subscription (existence is a row lookup, so no password is involved) and only the token's identity
  is in the way, which `configure` and the `model-preset` gate render as "your subscription is
  connected; this token is not bound to spend it". `false` means the owner is known and holds none;
  `null` means there was nobody to ask about, which is a token minted through `POST /api/v1/keys`
  rather than in the app. Those three are gated on `personalSubscription`, so a model with no
  individual-usage subscription route at all keeps reading as unwired and a workspace-POOLED
  subscription (Kimi, DeepSeek) is never mistaken for one: its token belongs to the workspace, which
  every key can already see.

  What the row cannot tell you apart, and the suite therefore does not claim to: a model that
  declares a personal subscription NOBODY has connected reads the same as one whose owner this token
  could not resolve, until `subscriptionConfigured` answers. That is the whole reason the three
  states are kept separate rather than collapsed into "user-scoped".

- **The pass asks for your personal password at the terminal**, once for the WHOLE pass, before the
  first scenario runs, and never for a workspace running on a provider API key. It is held in memory and
  written NOWHERE: not the `.env`, not the ledger, not the journal, not an environment variable. That
  is deliberate rather than an omission, since a copy beside `CAT_FACTORY_API_KEY` would put both
  halves of a two-factor credential in one file. A resumed pass asks again. No variable or file can
  supply it instead. See
  [`individual-subscription-usage.md` §7](../../docs/individual-subscription-usage.md).
- **Asked up front because a person is at the terminal at the START of a pass and by design not
  twenty minutes in.** One process could now hold the answer from whenever it was first needed, so the
  ask is up front for that reason alone rather than for the one it was written for: under vitest a
  password collected in spec 01 could not be reached from spec 02, so asking lazily was asking four
  times, each prompt drawn over a reporter redrawing the same lines. It only asks when the pinned
  preset's base model reports `personalSubscription`, so a provider-key workspace sees no prompt; when
  the catalog cannot be read, it says so and leaves the ask at the first dispatch that needs it. What
  it never does is hand the password back as a value: the prompt fills the holder that rides every
  request (the kit's `@cat-factory/acceptance-kit/console-credential`), which is what makes "written
  nowhere" a property of the code.
- **What is asked for early is also HELD from early**, and the condition on that is the confirmation
  above: the ask only happens once the catalog has said this pass will spend the subscription, so the
  credential is not being attached speculatively. A pass runs headless for an afternoon and its
  operator has gone, so from the ask onward having the password is a property of the client seam
  rather than something each later call site reaches for. The alternative (collect now, attach at the
  first `428`) narrows the exposure to a handful of reads against the one deployment the pass is
  pinned to, which reads the header only on the gated run calls, and pays for it with a failure mode
  nobody is present to answer.
- **That ask can only ever DELAY the prompt, never end the pass**, and the one exception is a person.
  It runs before the first prerequisite is evaluated and before a journal line exists, so anything it
  threw would be the operator's whole output: no "your key names another workspace", no "the pinned
  preset's model is unwired", no ledger. A terminal it cannot ask on is therefore printed and
  continued from, and the preflight keeps ownership of diagnosing what is actually wrong. Pressing
  Ctrl-C at the prompt is the opposite fact, and stops the pass: it is a decision, not a limit.
- **So run the pass from an INTERACTIVE terminal**, with the ordinary invocation above: nothing
  about the command changes, and there is no separate mode for this. Under the hood the prompt opens
  the CONTROLLING TERMINAL for reading (`/dev/tty`, `CONIN$` on Windows) and writes the prompt back
  down it (`CONOUT$` on Windows, the device it read from on POSIX) rather than through this process's
  own stdio. That was written for vitest, whose workers are forked with PIPED stdio, and it is KEPT
  because the layer that decides this process's stdio is still there: `pnpm --filter … run` sits
  between your shell and the script, and a `| tee pass.log` sits outside both. A console is inherited
  by child processes independently of stdio, so those layers cost it nothing. Where that terminal
  cannot be opened at all, `process.stdin` is the fallback IF it happens to be one and the prompt goes
  to stderr; a process with neither refuses.
- **A pass with no console REFUSES at that first dispatch**, naming the two ways out (run it
  interactively, or pin a preset whose model resolves to a provider API key). That covers CI, a
  daemon, `nohup`, and an agent's detached background shell, all of which cannot open the console
  device at all. The up-front ask meets the same refusal earlier and prints it rather than throwing
  it, so what stops such a pass is the dispatch, with everything the preflight found already on
  screen.
- **On Windows the console input buffer is opened READ-WRITE**, and that is not a detail: turning
  echo off is `SetConsoleMode`, which WRITES to that buffer, so a read-only handle reads perfectly
  well and then answers `EPERM`. Opened read-only, the prompt therefore failed on every Windows
  machine, console or no console, and it arrived as a bare `Error: setRawMode EPERM` (errno -4048)
  naming neither the password nor a remedy.
- **A terminal that will not stop echoing gets its own refusal**, separate from the no-console one,
  because nothing about the invocation is wrong and both of that one's remedies are dead ends. Its
  remedies follow the PLATFORM, since the state is reachable on both. On Windows, expect it from an
  MSYS/mintty window (Git Bash launched by its own shortcut), where `winpty` in front of the command
  is the fix; Windows Terminal, PowerShell and the JetBrains terminal all implement console modes.
  `cmd.exe` does too and is deliberately not offered, because the commands this suite prints for
  Windows are PowerShell's. On POSIX the same refusal means a process with a `/dev/tty` it cannot put
  into raw mode, which is a `docker exec` without `-t`, an `ssh` without one, or a detached
  `screen`/`tmux`.
- **The verdict on turning echo off is the stream's own `isRaw`**, never "the call did not throw".
  Node reports a refused mode switch by EMITTING `error`, and that reaches a caller as a throw only
  because an unhandled `error` is what Node turns into one; on the `process.stdin` fallback path,
  where something else in the process is usually already listening, the same failure arrives as a
  quiet return. Read as success, the prompt would take the password with echo ON, into the
  scrollback, which is the one thing it exists to prevent.

**The repositories**

Two, created by you under the connected account, each empty except for a README, and each reachable by
its connection. Adopting them is the suite's job. `run configure` opens each creation page prefilled
and then ADOPTS each repository, reporting what that answered, so an unreachable one arrives as an
answer carrying the remaining steps rather than as a prompt that repeats itself.

**The cluster**

Any k3s/k3d you can reach. The `ServiceAccount`, RBAC and long-lived token are the ones in
[`backend/docs/local-k3s-environments.md`](../../docs/local-k3s-environments.md), **including the
cluster-wide binding** the ephemeral-environments backend needs to create per-PR namespaces.
`cat-factory k3s` (the CLI's guided setup) provisions all of it.

No deploy runner is needed. The suite uses a `raw` manifest source, which the backend applies
directly over the apiserver; a `kustomize` overlay would need `LOCAL_DEPLOY_RUNTIME=container` and
a deploy image on top. That is real product surface and is covered by the doc above, not here.

**Two things to know about images**, and the second one is a setup step nobody can do for you.

The bootstrapped repositories ship a workflow that builds and pushes their image, and their
manifests reference the platform's `{{image}}` placeholder, which the connection resolves from
`ACCEPTANCE_K3S_IMAGE_TEMPLATE` (default `ghcr.io/{{repoOwner}}/{{repoName}}:pr-{{pullNumber}}`).
Tagging by pull-request number is what forces the workflow's `pull_request` trigger: a provision
carries no commit sha, so the tag is built from the number, and the number does not exist until the
pull request does. `pl_build` puts a whole `reviewer` pass between the pull request opening and the
`deployer` step, so the image is normally already pushed by then; where it is not, the pods sit in
`ImagePullBackOff` and the kubelet retries until it lands, which the environment status poll
absorbs as an environment that took longer to become ready.

**A private package needs no setup, and one thing about the token does.** A GHCR package published
by Actions is private until somebody makes it public, and a kubelet with no credential answers 403
for the whole life of the environment. The platform closes that itself: when the apiserver names
the machine the platform runs on (loopback, k3d's `0.0.0.0`, or a Docker Desktop host alias, which
covers the default kubeconfig of every local k3s, k3d, kind and Rancher Desktop cluster), each
per-PR namespace gets the workspace's own VCS credential written into it as a `dockerconfigjson`
pull secret, attached to the service accounts the manifests run as, before the workloads are
applied. Nothing is configured for this and nothing is asked of you.

The credential is short-lived, about an hour, and nothing renews it. That covers the rollout a
pass waits on. A pass that later restarts a workload long after provisioning gets a fresh
`ImagePullBackOff` instead, and the fix is a re-provision rather than anything about the cluster.

What it cannot supply is SCOPE. The credential is whatever token the workspace's VCS connection
holds, so it must be allowed to read packages: a classic PAT needs `read:packages`, a fine-grained
one needs "Packages: Read", and a GitHub App installation needs `packages: read`. Without it the
pull still 403s, and the environment still presents as one that provisions and never becomes ready.
The `image-template` prerequisite names this in its PASS text because it cannot check it: the
deployment's connection is sealed and no `/api/v1` operation publishes a token's scopes. Making
each package public once (its **Package settings → Change visibility**) remains a valid way to
sidestep the whole question, as does pointing `ACCEPTANCE_K3S_IMAGE_TEMPLATE` at a registry the
cluster reads anonymously.

A pass writes what it did into the environment's provisioning log under `registry-auth`, naming
the registry and the account count on success and the reason on a skip, so an `ImagePullBackOff`
can be told apart from a credential that was never wired.

## Configuration

```sh
pnpm --filter @cat-factory/acceptance run configure
```

**Start here.** `configure` writes the `.env` below by asking as little as it can. Both tokens it
cannot resolve arrive with the page that mints them: the API token's screen, and the provider's
classic-token form carrying the description and the `repo` scope already filled in (it names the
fine-grained alternative too, which is the better credential and the one GitHub's form cannot
prefill). Most of these
are not questions: the deployment knows its own workspace and connected account, the kubeconfig
knows the cluster, and the preset library knows what a pass can run on, so all of those are
RESOLVED and reported rather than prompted for. What it does ask is the API token (nothing can mint
one) and the two repository names, and having asked it opens each repository's creation page
prefilled and re-reads the repository list until it can see them.

**Each attempt states its outcome.** An adopt that succeeds says so; one that cannot reach the
repository names what only a person can fix (create it empty-with-a-README, grant the credential
access, check the owner) and offers the creation page again. Those steps are one source, shared with
the `target-repos` prerequisite and the adopt itself, so the three cannot come to disagree about the
fix.

It never overwrites a value without saying so: an existing value becomes the prompt's default, the
summary names every key it replaced, and anything in the file it does not manage (a pasted
`ACCEPTANCE_K3S_CA_PEM`, say) is carried over byte for byte. Neither token is ever printed back.

| Variable                               | Required | What it is                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAT_FACTORY_BASE_URL`                 | yes      | Backend origin, e.g. `http://127.0.0.1:8787`. Serves `/api/v1` and the deployment root reads.                                                                                                                                                                                                                                                              |
| `CAT_FACTORY_API_KEY`                  | yes      | A public-API key scoped **`admin`** (scenario 03 also needs the `decide` rung it includes).                                                                                                                                                                                                                                                                |
| `ACCEPTANCE_WORKSPACE_ID`              | yes      | The workspace the key is bound to. `GET /api/v1/me` reports it.                                                                                                                                                                                                                                                                                            |
| `ACCEPTANCE_REPO_OWNER`                | yes      | The owner both repositories live under. `GET /api/v1/vcs/connection` reports it.                                                                                                                                                                                                                                                                           |
| `ACCEPTANCE_BACKEND_REPO`              | yes      | Name of the empty repository the backend service adopts. **You create it; the suite adopts it.**                                                                                                                                                                                                                                                           |
| `ACCEPTANCE_FRONTEND_REPO`             | yes      | Name of the empty repository the frontend adopts. Must differ from the backend's.                                                                                                                                                                                                                                                                          |
| `ACCEPTANCE_VCS_TOKEN`                 | yes      | Provider token scenario 04 files its issue with, as an outside reporter, and `reset --purge-repos` empties the repositories with. Classic GitHub: `repo` (plus `workflow` for the purge). Fine-grained: "Issues: Read and write" on the backend repository (plus "Contents" and "Workflows" read+write on both, for the purge). Never the API key.         |
| `ACCEPTANCE_VCS_API_BASE`              | no       | The provider's REST base, default `https://api.github.com`. GitHub Enterprise Server is `https://<host>/api/v3`, which no `/api/v1` read publishes.                                                                                                                                                                                                        |
| `ACCEPTANCE_K3S_API_SERVER`            | yes      | Apiserver URL, e.g. `https://127.0.0.1:6443`.                                                                                                                                                                                                                                                                                                              |
| `ACCEPTANCE_K3S_TOKEN`                 | yes      | The ServiceAccount bearer token.                                                                                                                                                                                                                                                                                                                           |
| `ACCEPTANCE_K3S_CA_PEM`                | one of   | The cluster CA in PEM. Wins over the insecure flag when both are set.                                                                                                                                                                                                                                                                                      |
| `ACCEPTANCE_K3S_INSECURE`              | one of   | `true` to skip apiserver TLS verification. Throwaway clusters only.                                                                                                                                                                                                                                                                                        |
| `ACCEPTANCE_MODEL_PRESET`              | no       | Preset id pinned on every task, default `mdp_claude` (the built-in Claude preset). `configure` offers the library as a menu, so the id never has to be typed.                                                                                                                                                                                              |
| `ACCEPTANCE_K3S_INGRESS_HOST_TEMPLATE` | no       | Default `{{namespace}}.127.0.0.1.nip.io`, which needs no DNS of your own. Also the host the scaffold briefs ask each service's Ingress to serve, so overriding it moves both halves together. Only correct **together** with the namespace template below, and the `ingress-template` preflight grades the pair rather than either half.                   |
| `ACCEPTANCE_K3S_IMAGE_TEMPLATE`        | no       | Default `ghcr.io/{{repoOwner}}/{{repoName}}:pr-{{pullNumber}}`. What the manifests' `{{image}}` resolves to, and what the workflow the briefs ask for is told to publish, so overriding it moves both halves together. A provision knows no commit sha, and `{{branch}}` is `cat-factory/<taskId>`, which no tag may contain.                              |
| `ACCEPTANCE_K3S_NAMESPACE_TEMPLATE`    | no       | Default `cf-acc-pr{{pullNumber}}`. **The `pr` is load-bearing**: with a `nip.io` host, a namespace ending in a separator plus digits makes the pull number the first octet of a different address (`cf-acc-5.127.0.0.1.nip.io` answers `5.127.0.0`), so end the name with a letter. See [local-k3s-environments.md](../../docs/local-k3s-environments.md). |
| `ACCEPTANCE_NAME_PREFIX`               | no       | Default `cf-acc`. Prefixes the board frames and tasks, not the repositories. Set it per-person when a board is shared.                                                                                                                                                                                                                                     |
| `ACCEPTANCE_RUN_BUDGET_MS`             | no       | Per-run ceiling, default 90 min. Not a whole-scenario timeout; see below.                                                                                                                                                                                                                                                                                  |
| `ACCEPTANCE_STATE_DIR`                 | no       | Default `.acceptance`, relative to this package.                                                                                                                                                                                                                                                                                                           |
| `ACCEPTANCE_RUN_ID`                    | no       | A run id to **resume**, or `latest` for the most recent pass that recorded a fact. Unset starts a new one. The one variable normally set per invocation, so see the shell forms below.                                                                                                                                                                     |

They live in a **`.env` at this package's root** (gitignored, and read by `src/envFile.ts`: nothing
applies one for a Node entry point on its own). A variable set in the shell wins over the file, so
the file states the setup and the invocation states the exception.

**Every variable can be set either way, and the file is the one form that needs no shell dialect.**
That matters most for `ACCEPTANCE_RUN_ID`, the only one routinely set per invocation:

```sh
ACCEPTANCE_RUN_ID=latest pnpm --filter @cat-factory/acceptance run acceptance   # POSIX
```

```powershell
$env:ACCEPTANCE_RUN_ID = 'latest'; try { pnpm --filter @cat-factory/acceptance run acceptance } finally { Remove-Item Env:ACCEPTANCE_RUN_ID }
```

**PowerShell has no inline environment prefix**, so the POSIX form is not merely unidiomatic there,
it reads the assignment as the command NAME and fails with `CommandNotFoundException`. Every command
this suite PRINTS with a variable in it is rendered for the shell that will RECEIVE it (the banner
the pass opens with, the resume in two prerequisite remedies, the closing words of a failed pass, the
line the status report ends with, the per-person prefix, and the three remedies whose whole fix is one
value), so a pasted remedy
runs where it was read. The shell, not the platform: on Windows that is PowerShell unless `SHELL` or
`MSYSTEM` is set, which is how a Git Bash or MSYS operator gets the POSIX form. `cmd.exe` reads as
PowerShell and is a known limit rather than a decision: nothing in the environment separates the two
(`PSModulePath` and `ComSpec` are in both, and cmd's `PROMPT` is inherited by a PowerShell started
from it), and guessing the other way would hand `&&` to Windows PowerShell 5.1, which cannot parse it
at all. The `curl` remedies are the remaining exception and are still POSIX-only: they interpolate
`$CAT_FACTORY_API_KEY`, which PowerShell expands as one of its own variables and sends as an empty
bearer token.

**The `try`/`finally` is what makes the printed PowerShell resume a one-off**, which the POSIX prefix
is for free. `$env:` is the process environment, and no block, function or child scope narrows it, so
an assignment left behind silently resumes that finished pass on every later invocation in the same
window. Typed by hand without the clear, `Remove-Item Env:ACCEPTANCE_RUN_ID` is the undo.

Putting the id in the `.env` works everywhere and survives closing the terminal, with the same trap
inverted: it resumes that pass until the line is removed.

Missing configuration is reported **all at once**, with what each variable is for. The suite
refuses rather than guessing, because it merges real pull requests into real repositories.

## Watching a pass

A pass runs for an afternoon in a terminal nobody is watching, and the questions asked afterwards
are asked from somewhere else. So every observation is appended to a journal beside the ledger,
and a second command reduces the two into an answer:

```sh
pnpm --filter @cat-factory/acceptance run status          # the pass that ran last
pnpm --filter @cat-factory/acceptance run status 20260809175530
pnpm --filter @cat-factory/acceptance run status latest   # the pass worth resuming
```

With no run id it reports whichever pass wrote to the state directory last, which is usually the
attempt just watched. That is deliberately NOT the pointer `ACCEPTANCE_RUN_ID=latest` follows: the
pointer names the most recent pass to record a FACT, and an attempt a prerequisite refused records
none while still writing the journal saying why. Asked through the pointer, the report someone wants
most is the one it cannot reach.

`ACCEPTANCE_RUN_ID` reaches this command too, out of the shell or out of the `.env` (see
[Resuming](#resuming)), and it names the pass this report is about when nothing was passed on the
command line: the pass in play is normally the one you are asking after. What it does not do is change
which QUESTION the bare form answers. A `latest` typed as the argument refuses when no pass has
recorded a fact, because that is what was asked; a `latest` line in the `.env` resolves through the
pointer when it can and otherwise reports the pass that ran last, rather than refusing about a question
nobody asked.

Both are shown either way. A pass that created nothing is reported as such, and the report closes by
naming the pass that DID, so the resume line is never an invitation to start over.

A phase re-entered by a later attempt at the same run id is re-opened and re-timed from that
entry, so what the report shows is the CURRENT pass rather than a phase that reads `done` under
yesterday's message with an elapsed time spanning the night between them.

It reports each phase with how long it has been in it, the last thing that phase observed,
anything the pass created (services, runs, pull requests) and how long ago the last line was
written. That last number is the one that matters: a pass whose
poll interval is ten seconds and whose journal has been silent for twenty minutes is not slow, it
is dead or detached, and nothing else distinguishes those from "still working".

The command opens no connection to the deployment, creates nothing, and needs no API key, so it is
safe to run against a pass that is currently going. It does read the same `.env` the pass does, for
`ACCEPTANCE_STATE_DIR` and `ACCEPTANCE_RUN_ID` only: read off the shell alone it would look for the
passes somewhere the pass never wrote them, and the command it would be disagreeing with is the
`watch:` line the pass itself printed for the operator to paste.

## Resuming

A full pass costs an afternoon and real spend, so it is written to be resumed. Every scenario records
what it created in a ledger under `ACCEPTANCE_STATE_DIR`, re-reads it on start, and re-checks it
against the deployment rather than trusting it.

```sh
ACCEPTANCE_RUN_ID=20260809175530 pnpm --filter @cat-factory/acceptance run acceptance
ACCEPTANCE_RUN_ID=latest pnpm --filter @cat-factory/acceptance run acceptance
```

```powershell
$env:ACCEPTANCE_RUN_ID = '20260809175530'; try { pnpm --filter @cat-factory/acceptance run acceptance } finally { Remove-Item Env:ACCEPTANCE_RUN_ID }
$env:ACCEPTANCE_RUN_ID = 'latest'; try { pnpm --filter @cat-factory/acceptance run acceptance } finally { Remove-Item Env:ACCEPTANCE_RUN_ID }
```

Or the `ACCEPTANCE_RUN_ID` line in the `.env`, which needs no dialect at all; see
[Configuration](#configuration) for what each form costs.

The run id is settled ONCE per pass, by `src/runAcceptance.ts` before any scenario exists, and
handed to the harness every scenario shares. It may not be resolved per scenario, because the id is
the ledger's KEY: minted per file (which is what vitest's module-graph-per-spec-file forced) it made
a fresh pass structurally unable to finish, with five ledgers opened a second apart, scenario 02
unable to read the two services scenario 01 had just adopted, and `status` left with five journals to
choose between.

`latest` resolves through a pointer written when a pass records its first FACT, not when it opens
and not when it finishes. Not on finishing, because the pass worth resuming is by definition one
that did not finish; not on opening, because the pass that opens a ledger and creates nothing is
the common one (a fresh attempt refused by a prerequisite), and pointing `latest` at it is how the
half-built pass whose leftovers caused the refusal became reachable only by an id nobody had
written down. A refusal over leftover state therefore names the run id of the pass whose ledger
holds it, rather than offering `latest`. Asking for `latest` when no pass exists is refused rather
than quietly starting a new one, because those are opposite intents and the wrong one spends an
afternoon.

What a resumed pass does with each thing it finds:

| Found                             | Action                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------- |
| A service in the ledger           | Re-read the BOARD; reuse it if the frame is still there, adopt again if not.    |
| A repository backing a service    | Reuse that service rather than raising a second frame over the same repository. |
| A task filed, never started       | Start it.                                                                       |
| A run still working               | Re-attach and keep driving it. Nothing is re-filed.                             |
| A run that already reached `done` | Adopt it.                                                                       |
| A task the board no longer has    | File it again, saying so.                                                       |
| An issue the ledger names         | Re-read it from the provider: adopt it if it is there, file a fresh one if not. |

Every one of those states is recorded the moment it is entered rather than when it completes, so
the window a crash can land in is as small as the ledger write. The one thing recorded that is not
an id is the set of decision kinds the suite ANSWERED, because a settled decision is
indistinguishable afterwards from one nobody had to make, and scenario 03's claim that it drove a human
gate over `/api/v1` has to survive the process that made it. It travels with the TASK it was
recorded against and no further: a task the board no longer has is re-filed as new work, and
inheriting the deleted run's answers would let scenario 03 claim it drove a gate the replacement run
never reached.

**Nothing is cleaned up on failure.** The run, its pull request and any provisioned namespace are
left in place to be inspected, and the failure message says so. Successful passes reclaim their
namespaces through the pipeline's own `disposer`, which scenario 02 asserts.

## Starting over: `reset`

The other way out of a refusal over leftover state, for when the work is not worth resuming:

```sh
pnpm --filter @cat-factory/acceptance run reset                       # what it WOULD delete
pnpm --filter @cat-factory/acceptance run reset --yes                 # do it
pnpm --filter @cat-factory/acceptance run reset 20260809175530 --yes  # …plus that pass's own state
pnpm --filter @cat-factory/acceptance run reset --all                 # every frame the board lists
pnpm --filter @cat-factory/acceptance run reset --purge-repos         # …and the PROVIDER side too
```

It deletes the service frames this configuration would adopt, every task under them and the run
history recorded against those tasks, over `DELETE /api/v1/services/{serviceId}` and
`DELETE /api/v1/tasks/{taskId}` with the same key the suite already holds, and then removes the local
files of the passes that named those frames. Until this existed the third branch of the `target-repos`
remedy ("delete the service frame that holds this one") was the one instruction a HEADLESS operator
could not carry out headlessly, because deleting a service was an app act.

Only the UNFINISHED tasks get a delete call of their own, which is what the frame delete's refusal
counts; the finished ones go with the frame, which cascades its whole subtree. The preview names them
all, because they all disappear.

**`--all` is a whole-board clear**, for when the point is an empty board rather than one refusal. It
targets every frame `GET /api/v1/services` lists, whatever backs it and whatever it is called, and
every pass in the state directory. The two questions below are deliberately narrow (they answer the two
refusals a pass earns) and a board accumulates frames neither can see: a pass run under a different
`ACCEPTANCE_NAME_PREFIX`, one whose repositories the `.env` has since replaced, a frame raised by hand
while debugging. None of those blocks the next pass, which is why no refusal prints the flag. It is
still a preview by default, the plan still names every frame and task, and the plan states the scope
outright, because a board holding one pass renders an identical list either way.

Six things about it are decisions rather than details:

- **It previews by default.** The bare form changes nothing and names every frame, task and file, since
  the board may be one two people share. `--yes` is the whole of the opt-in; `pnpm` forwards both the
  positional and the flag, so no `--` separator is needed.
- **It targets what the CONFIGURATION points at**, not what a ledger remembers: the two repositories'
  frames and the frames holding this prefix's titles, which are the two things the gate refuses over.
  That is what lets it clear state whose owning ledger is gone (another machine, another operator, a
  cleared `ACCEPTANCE_STATE_DIR`), which is the case with no other way out. Naming a pass ADDS whatever
  its ledger holds, so a frame this `.env` no longer points at is reachable too, and `--all` replaces
  the question entirely with "everything the board lists".
- **Under `--all`, every pass on disk goes with the board**, and so does the `latest` pointer, even
  when it names a pass no ledger backs any more. That follows from what was deleted rather than from
  the flag being the widest: with no frames left, a kept file is a run id `status` still lists and
  `latest` may still resolve to, and resuming it opens a ledger whose frames no longer exist. It is
  also the only branch that reaches a refused attempt's files, since a ledger that is absent or
  malformed names no frame for the others to match on.
- **It keeps a pass's files whenever a frame that ledger names survives**, whether the delete was
  refused or the plan never targeted it. The ledger is the only thing mapping a leftover frame back to
  a run id, so removing it would strand that frame with no pass for the next refusal to name and no id
  to resume. A repository it could not FREE keeps every ledger in the plan for the same reason one
  step further out: the frame still holding that repository is one no read here can name at all, so
  no ledger can be matched to it and one of them holds the id that reaches it.
- **The preview lists a pass under "to remove" or under "KEPT", never both**, decided by that same
  rule. Everything it keys on but a REFUSED frame is known before anything runs, and a plan that
  named files the apply then keeps would misstate an outcome it had already computed.
- **It states what it cannot reclaim.** The two repositories keep whatever a previous pass scaffolded,
  branches and open pull requests included, and no `/api/v1` call can empty them, so a fresh pass
  scaffolds ON TOP of that (`target-repos` says outright that it cannot see whether a repository is
  empty). Any OTHER repository a deleted frame backed is named too, since under `--all` the configured
  pair is a fraction of what was emptied. An issue scenario 04 filed stays open, because it was the
  reporter's and never the platform's.
  Per-PR cluster namespaces are untouched. A cleared board is not a fresh one, and the report says so
  rather than reading as "everything is clean".

It needs the deployment, the key, the two repository names and the state directory: no cluster and no
reporter token, because those belong to RUNNING a pass. An operator resetting is often doing so
precisely because one of them has moved on.

### `--purge-repos`: the provider side, recoverably

The two leftovers above are the two things an `admin` key structurally cannot reclaim: the tree a
scaffold run pushed, and an issue filed by the REPORTER, which was never the platform's to close.
`--purge-repos` reclaims both, using `ACCEPTANCE_VCS_TOKEN` (the same credential scenario 04 files with).
It is a separate flag from `--all`, on a different axis: `--all` says how much of the BOARD to clear,
this says whether to touch the provider at all. Without the variable it refuses, naming it, and
changes nothing.

The purge asks more of that token than filing an issue does: **Contents and Workflows read+write on
both repositories**, on top of Issues. A scaffolded repository holds a GitHub Actions workflow, and
the provider refuses a commit that removes one from a token carrying no workflow permission, so the
credential that ran the pass may still be refused by the cleanup. Which provider it calls comes from
`GET /api/v1/vcs/connection` rather than being assumed: a workspace connected to one this suite
cannot address refuses here for the same reason the `issue-credential` prerequisite does, rather than
having its calls sent to GitHub.

**Nothing it does is destructive, and that is the design rather than a caution.** The two
repositories are named in a `.env`, a `.env` can name the wrong thing, and the failure worth
engineering against is an operator emptying a repository that mattered. So:

- **The emptying is an ordinary commit ON TOP of the current tip**, whose tree holds only the README.
  The previous tip is its parent, so every prior commit stays reachable from the branch itself and one
  `git revert` restores the tree. Moving the branch is therefore a fast-forward, and the call is made
  with `force: false`: the API request cannot be the thing that loses a commit. The rejected
  alternative was a parentless orphan commit, which reads as a genuinely fresh repository and makes
  the old tree reachable from nothing. Messy history is the price, and it is the right one.
- **Every ref is TAGGED before it is touched**, at the sha it held
  (`cf-acc-reset/<stamp>/<branch>-<digest>`). Redundant for the default branch and load-bearing for
  the leftover scaffold branches, which are deleted: a deleted branch's commits are reachable from
  nothing unless something names them. Each backup is the precondition of the write it protects and
  no more, so a branch whose own tag did NOT land is left in place while the rest goes ahead. The
  digest is over the branch name, because flattening the slashes alone maps `cat-factory/x` and
  `cat-factory-x` onto one tag, and a tag that already exists at somebody else's sha is not a backup:
  the provider answers 422 either way, so what is there is READ rather than assumed.
- **The report prints the recovery command with the sha in it**, per repository, and states what it
  did beside the tree. A purge that can be undone but does not say how is only half the property, and
  the moment it is needed is the moment the ledger naming the pass may already be gone.
- **A repository with no README at the root is REFUSED in the plan**, since the emptying is expressed
  as a tree listing what stays and there is no such tree with nothing to keep.

**Which issues it closes is a PAIR, and both halves matter.** An issue qualifies when the reporter
credential authored it AND its title is one this suite files. Author alone would close a human's
issue that happens to sit on a fixture repository; title alone would close somebody else's issue
quoting this suite's. Everything failing either test is reported as skipped, with which half failed,
because "we saw it and left it" and "we never looked" are different facts. Issues a removed pass's
ledger names are closed on the ledger's word, since that is evidence of authorship on its own.

**An issue belonging to a pass whose files are KEPT is left alone, and the plan says what that is
worth.** Discovery cannot tell one apart on its own (a kept pass's issue wears the same title and the
same author), so the exclusion is named rather than inferred. But files and issues are per-pass while
the repositories are not: there is one pair per board, and emptying them is what stops a kept pass
being resumable, whatever its ledger says. So the preview names those passes and states the
consequence, where it can still be acted on, rather than letting the retention read as a promise the
purge does not keep.

It does NOT guess whether a repository "looks scaffolded" before emptying it. No honest test exists
(a scaffolded repository and a hand-built service look identical), and a wrong guess either refuses a
legitimate reset or empties something on a hunch. Recoverability is the protection.

Two refusals it declines to paper over. A repository whose service this workspace cannot name has no
id to delete, and `GET /api/v1/repos` answers that way for TWO states with opposite fixes: the
service is homed on ANOTHER board of the account, or it is a frame on THIS board that has been
ARCHIVED (an archived frame is not listed, so nothing holds an id for it). Both readings are printed,
because no `/api/v1` read tells them apart, and the archived one is fixed in the app: restore or
delete the frame, which is what releases the repository projection. The other refusal is the
platform's own: a frame still holding an unfinished task answers `422 service_has_unfinished_tasks`
rather than being deleted with the work in it, and that refusal happens before anything is torn
down, so it changes nothing.

Both are reported with the steps, and the command exits non-zero, because the board still holds what
the next pass will be refused over. That includes the case where nothing was refused and nothing was
deleted: a clear whose only blocker is an unfreeable repository would otherwise exit 0 under "Done. A
fresh pass can start" onto a board that earns the identical refusal on the next attempt.

## The rules these scenarios are written to

Five, and each is load-bearing.

**0. Refuse before spending, say everything that is wrong, and say how to fix each one.** The gate
above runs before every scenario rather than only in scenario 00, because a resumed pass starts
wherever it stopped and a check only the first one runs is a check the resume path skips. It is also
re-evaluated each time rather than cached: a pass takes an afternoon, and a workspace that went over
budget during the feature runs is worth refusing before the next scenario spends. Everything it knows
is reported together: this suite's unit of feedback is an afternoon, so learning about the second
problem tomorrow costs a day per problem. The same arithmetic is why a refusal carries the steps
and commands rather than a description of them, and why they are rendered from what the probe read.

**1. Assert on evidence the platform COMPUTED, never on prose an agent wrote.** A test that greps a
coder's reply for "fixed the off-by-one" is testing the model's turn of phrase; change the model
and it goes red having found nothing wrong. The verification report exists because the platform
derives its verdicts in code from captured facts, so `reproduction.verdict`, `environments.proof`,
`ci.verdict` and `merge.outcome` are stable claims. The kit's [`evidence.ts`](../../packages/acceptance-kit/src/evidence.ts) reduces them, and is itself
unit-tested: a bug in a grader reports green and nothing else notices.

**2. Never auto-answer a decision the suite was not designed for, or one that is in flight.**
The kit's [`decisions.ts`](../../packages/acceptance-kit/src/decisions.ts) answers exactly two kinds and hard-fails on every other, naming it. The tempting
shape is a loop that settles whatever it finds so the run keeps moving; that produces a green suite
that proves nothing, because a `pr-review` gate auto-resolved and a `fork` auto-picked are
decisions a person was supposed to make.

Being LISTED is not being answerable, and that is a second way to auto-settle by accident. The
decision list deliberately keeps showing a review the driver is mid-cycle on (`incorporating`,
`reviewing`) so a poller can see its answers are in flight. `isActionable` decides per kind from
the status the platform reports, and both the answering path and the poll wait read it: without
it, the suite waives the clarity gate one poll after answering it, racing the incorporation of the
very answers it gave, while the run still reaches `done` and the ledger still records the gate as
answered. A review parked at its ITERATION CAP (`exceeded`) is refused rather than pushed past,
for the same reason a `fork` is: the choice belongs to a person.

**3. A wait that expires must say what it last saw.** The kit's [`deadline.ts`](../../packages/acceptance-kit/src/deadline.ts) owns every wait and the
runner deliberately introduces no timeout of its own (the vitest one was disabled for the same
reason): "timed out after 5400000ms" is true and useless, where "step 3 `coder` was still working,
4/9 subtasks" separates a parked run from a wedged one from a slow one.
A wait whose last observation is itself GRADED may hand it back instead of throwing, and
`waitForIssueSettled` is the one that does: the checks render each claim with its own detail, which
is more than the single line an expiry message carries. What is banned is ending a wait with
neither, and a wait must poll for everything its grade asserts or it hands the grader a half-written
observation and fails what was working.

**A THROWN poll is covered by that rule too**, and it used to escape it. The deployment this suite
polls is by design a local one, run under `cat-factory supervise` (whose job is to restart the
backend when it stops serving) in front of a `node --watch` that cycles the process on a file
change, so a restart is an ordinary event over an afternoon. One of them killed a pass 41 minutes
in: a `pl_build` scaffold with its coder and reviewer done and a pull request open, whose next
`GET /tasks/:id/run` threw `connect ECONNREFUSED` and took the scenario with it, while the run
itself carried on to its deployer step unobserved. So the kit's [`deploymentOutage.ts`](../../packages/acceptance-kit/src/deploymentOutage.ts) makes an
unanswered poll an OBSERVATION for two minutes (journalled, and the recovery is journalled too,
because an unexplained gap in the observations is how a restart becomes invisible), and an outage
that outlasts that says the deployment stopped answering rather than blaming the run. An ANSWER is
never waited through: a refusal is evidence, and the typed SDK error is rethrown untouched so its
status and request id survive. What is waited through is an allow-list of four transport causes
that have the shape of a restart (refused, reset, timeout, unreachable); a DNS entry that stopped
resolving, an expired certificate and a credential pasted with a newline in it are each their own
diagnosis, and sitting on one for two minutes only delays it and then blames a restart that never
happened.

**And an outage never becomes the LAST OBSERVATION.** "The deployment did not answer" says nothing
about the run, so it is journalled but never overwrites the last thing the deployment actually
said; a wait that expires mid-outage prints the last real observation plus the silence as a
separate clause. Otherwise both expiry messages report the silence, while the outage message is
still telling its reader the run may well be fine, having discarded the only evidence about it.

Between the waits, a restart is absorbed by the SDK client's raised retry budget
(`createPassClient`), which covers every READ a scenario makes one-shot. A write is deliberately
not retried: replaying an answered decision is not a call this suite may make on the deployment's
behalf.

**Preflight runs on the SDK's default budget instead (`createClient`), and the asymmetry is the
point.** The dozen prerequisite checks each reach the deployment, run in sequence and never bail
early, so a budget raised there multiplies across all of them: against a deployment that is simply
not running, the commonest setup mistake of all, that buries the clearest refusal this suite can
produce under minutes of silence. Nothing has been created yet at that stage and a re-run costs
nothing, so preflight refuses fast. Once a scenario is an hour deep, the same tens of seconds buy
back the whole pass.

**4. Every failing claim is reported, not just the first.** A run that both skipped its environment
and failed CI is one story, and learning the second half on tomorrow's re-run wastes a day per bug.

## The two calls that are not `/api/v1`

The suite drives the public API through the **published TypeScript SDK**, the same artifact an
integrator installs, so a surface change that would break an integration breaks this suite at
compile time. That is now true of the WHOLE narrative, setup included: listing the repositories,
backing a service with one, connecting the cluster, declaring a service's manifest source, pinning
a model preset and reading what the deployment has wired are all public operations.

What is left outside are two UNAUTHENTICATED reads on the deployment root, `GET /health` and
`GET /auth/config`, in the kit's [`deploymentApi.ts`](../../packages/acceptance-kit/src/deploymentApi.ts). They are not a smaller
escape hatch; they answer a question `/api/v1` structurally cannot. Both have to work for a
deployment whose configuration failed to validate, and such a backend serves a fallback app that
answers 503 on every other route, `/api/v1` included. A key-authenticated health check cannot
describe a deployment too broken to authenticate a key, which is exactly the state worth describing.

That reasoning is also the rule for adding to that file: it does not extend to anything scoped to a
workspace. A caller acting on one holds a key, so that is a public endpoint.

## Where things live

| Path                         | What                                                                                                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/runAcceptance.ts`       | `pnpm run acceptance`. Settles the run id and the password, builds the harness, hands the scenarios to the kit's `runPass`, and owns the two exits nothing has been created through.                                          |
| `src/identity.ts`            | Who this suite is, as the kit's refusals render it (the run command, the resume variable, the configuration file), plus the three commands only this suite prints. Unit-tested.                                               |
| `src/packageRoot.ts`         | The ONE spelling of the package root, which the `.env` and a relative state directory both anchor on.                                                                                                                         |
| `src/world.ts`               | WHAT this suite's ledger holds (its two services, its runs, the issue it filed), over the kit's `LedgerStore`. Unit-tested.                                                                                                   |
| `src/publicApi.ts`           | The two clients wired to this configuration (the unlock rides their header seam), the one task-creation door, and what is wrong with a key pointed at another board.                                                          |
| `src/scenarios/index.ts`     | The ORDER, as an array. What the vitest sequencer used to be. Unit-tested against each id's own numeric prefix, so a scenario added out of place fails a test rather than a live pass.                                        |
| `src/scenarios/*.ts`         | The five scenarios themselves, one per file, each a factory over the harness.                                                                                                                                                 |
| `src/harness.ts`             | What every scenario is handed, built once per pass, plus the prerequisite gate the driver runs before each of them.                                                                                                           |
| `src/personalPasswordAsk.ts` | What the up-front ask decides, and what it does when it cannot: degrade and continue, except for a person declining. Unit-tested.                                                                                             |
| `src/config.ts`              | Environment → config in two halves (a BOARD, and what it takes to RUN a pass on one), reporting every problem at once. Pure; unit-tested.                                                                                     |
| `src/envFile.ts`             | The `.env` at the package root, read the same way by all four commands. Pure.                                                                                                                                                 |
| `src/manifestTemplates.ts`   | The two checks that render the templates the briefs embed (ingress host, image reference). Config-only, so they carry the narrower context. Unit-tested.                                                                      |
| `src/prerequisites.ts`       | The checks, each with the steps and commands that fix it. Unit-tested.                                                                                                                                                        |
| `src/adopt.ts`               | Repository → board service (adopting it first when the workspace has not), every way that join refuses, and the one copy of the reachability steps the gate and `configure` share. Unit-tested.                               |
| `src/presets.ts`             | The one preset-to-catalog join `configure`, `model-preset` and the up-front unlock share. Pure; unit-tested.                                                                                                                  |
| `src/status.ts`              | Ledger + journal → "where is this pass", plus WHICH pass a bare invocation is about (the argument asks, the environment pins). Unit-tested; its closing resume line takes the ambient shell from `operatorText.ts`.           |
| `src/statusCli.ts`           | `pnpm run status`. Reads the two files and nothing else, finding them through the same `.env` the pass does.                                                                                                                  |
| `src/reset.ts`               | Starting over: which frames a clear targets (this configuration's two questions, a named pass, or `--all`), the order the deletes go in, what it refuses to remove, and what it cannot reclaim. Driven by seams; unit-tested. |
| `src/resetCli.ts`            | `pnpm run reset`. Supplies the real clients and file removals, parses the positional and the three flags, owns the exit code.                                                                                                 |
| `src/providerPurge.ts`       | `--purge-repos`: composing the issue and repository halves into one plan, one apply and one report. Unit-tested through its two halves.                                                                                       |
| `src/repoPurge.ts`           | Emptying a repository back to its README RECOVERABLY: what to keep, what to tag, the order the writes go in, and the recovery command. Pure; unit-tested.                                                                     |
| `src/issuePurge.ts`          | Which issues are this suite's to close (ledger-named, plus author-and-title discovery) and which are somebody's real ones. Pure; unit-tested.                                                                                 |
| `src/repoContentApi.ts`      | The provider calls `repoPurge.ts` plans against, provider-keyed. The one decision in it: the emptied tree is built with no `base_tree`.                                                                                       |
| `src/configure.ts`           | `configure`'s flow: what it resolves, what it asks. Driven by seams; unit-tested.                                                                                                                                             |
| `src/configureEnv.ts`        | What only THIS suite knows about its own `.env`: which variables are secret, and the two creation URLs. The MERGE is `@cat-factory/cli`'s `envMerge.ts`, which is where its five silent-failure rules are documented.         |
| `src/configureCli.ts`        | `pnpm run configure`. Supplies the real terminal, shell, files and client.                                                                                                                                                    |
| `src/instructions.ts`        | The briefs, the two frame titles, the reporter's issue, and the reasoning behind the planted defect.                                                                                                                          |
| `src/vcsIssues.ts`           | The reporter's own client: filing an issue on the provider and reading it back, provider-keyed. The one thing here that is not the platform.                                                                                  |
| `src/issueIntake.ts`         | Filing that issue exactly once across attempts, waiting for the platform to settle it, and the pair of claims that grades what it did.                                                                                        |
| `src/k3s.ts`                 | The engine connection and the per-service manifest source.                                                                                                                                                                    |

### What the KIT owns

Everything above sits on [`@cat-factory/acceptance-kit`](../../packages/acceptance-kit), which is
this suite with the suite taken out: the scenario driver, the ledger and journal mechanics, the
prerequisite vocabulary and its refusals, the waits, the run driver and the evidence reductions. It
is published, so a deployment can cover its OWN providers, agent kinds or gates the same way without
copying this package.

What stays here is what the kit cannot know: the prerequisites (what a deployment must have wired to
run THIS pass), the five scenarios, the briefs, the configuration, the personal-subscription prompt,
and the identity the kit's refusals render against (`src/identity.ts`). The seams are
`Prerequisite`, `Scenario`, `SuiteIdentity` and `CredentialRetry`; the kit's own README documents
each.

One consequence worth knowing before a pass: **the kit is a workspace package, so `pnpm build` has
to have run** (the suite itself is type-stripped and builds nothing). Any tree that can serve a
local deployment has already done it.

**See also:** [`@cat-factory/acceptance-kit`](../../packages/acceptance-kit) (the building blocks),
[`backend/internal/e2e`](../e2e) (the faked-externals product suite),
[`backend/internal/sdk-smoketest`](../sdk-smoketest) (the same SDK against a booted backend),
[`backend/docs/public-api.md`](../../docs/public-api.md),
[`backend/docs/local-k3s-environments.md`](../../docs/local-k3s-environments.md).
