# `@cat-factory/acceptance`

**Acceptance tests against a LIVE local deployment.** Real agents, real model spend, real
repositories, real pull requests, and a real k3s cluster. They adopt two empty repositories you
created, scaffold a working service into each, ship a feature across both onto an ephemeral
Kubernetes environment, then file the defect that feature leaves behind and let the platform
investigate and fix it.

**Never run in CI**, and structurally cannot be: `test:run` (the task CI runs) points at
`vitest.config.ts`, which collects only this package's own unit tests. The acceptance specs live
under `acceptance/` behind a second config that nothing but the `acceptance` script names.

```sh
pnpm --filter @cat-factory/acceptance run configure   # assemble the .env, once
pnpm --filter @cat-factory/acceptance run acceptance
```

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

Four spec files, run in order. Each spec's output is the next one's input.

| Spec                     | What it does                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `00-preflight`           | Reports every prerequisite as its own named test. Creates nothing. The GATE runs in each spec, so a resumed pass cannot skip it.                                   |
| `01-adopt-and-scaffold`  | Connects the k3s engine, backs a service with each of your two repositories, declares each one's manifest source, then scaffolds both through `pl_build`.          |
| `02-feature-with-defect` | Ships a paginated catalog across both services on `pl_build`. Asserts the environment came up on the cluster, CI gated it, the merge resolved, the namespace went. |
| `03-investigate-and-fix` | Files the resulting bug as a report, runs `pl_bugfix`, answers its `clarity-review` human gate over `/api/v1`, and asserts a red-then-green reproduction proof.    |

### You create the two repositories; the suite adopts them

Repository creation is the one setup step the suite cannot perform. A PAT connection reports
`canCreateRepos: false` for every workspace, and the App path creates only under
`/orgs/{org}/repos`, so a personal account was never a supported target either: on the deployment
shape this README offers first, spec 01 could not run at all.

So you create two empty repositories, name them in the `.env`, and spec 01 backs a board service
with each (`POST /api/v1/services` takes a `repoId`, which is where one comes from) and then
scaffolds both through `pl_build` from the same briefs the bootstrapper agent used to be handed.
Each one is an ordinary pipeline run, which is why an interrupted scaffold resumes exactly as an
interrupted feature run does. Decision record:
[`docs/initiatives/acceptance-suite-operator-setup.md`](../../../docs/initiatives/acceptance-suite-operator-setup.md).

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

Spec 03 can only investigate a bug spec 02 actually shipped, so something has to put one there.
Telling the coder to write a bug does not survive the pipeline: `pl_build` runs a `reviewer` step,
and a deliberate defect inside one service is exactly what a reviewer is for. It would be caught,
the run would bounce, and spec 03 would find nothing wrong.

So the defect is a **contract mismatch between the two briefs**: the backend's says `offset` counts
from 1, the frontend's says it counts from 0. Each service is implemented faithfully, reviewed
against its own brief, and found correct, because it is. The defect exists only in the space
between them, which no single-repository review can see, and it shows up only when both run
together, which is what the ephemeral environment is for. It is also the most ordinary integration
bug there is.

The symptom it produces, which is what the bug report describes: page 1 lists items 1–10, page 2
starts at item 10 again, and the last page is short.

The consequence, stated because it is easy to misread as a gap: **spec 02 asserts the delivery
machinery worked, never that the product is defect-free.** By construction it is not. The claim
that the product is right is spec 03's, and it is settled by fixing the bug rather than by
asserting it away.

## Prerequisites

A local cat-factory that can really do the work, and a cluster to deploy onto.

**Most of this list is CHECKED, and checked before anything is created.** `src/prerequisites.ts`
probes each condition below, every spec runs the whole gate in its `beforeAll`, and a pass that
would fail is refused with every unsatisfied prerequisite and its remedy in one message. That
matters because each of these otherwise surfaces between fifteen and ninety minutes in, wearing a
failure that names something else: an unwired model looks like a broken dispatcher, a connection
without workflow permission looks like a repository whose CI never fires, and a preset that holds
every merge for a person looks like a run that stalled on its last step.

Three states, not two: a probe that cannot READ an answer reports that, and never as evidence
that the prerequisite is unmet.

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

| Prerequisite         | Checked | What it means                                                                                                                                                                       |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deployment-health`  | yes     | The backend booted. A misconfigured one serves a fallback app, and its own problem list is reported.                                                                                |
| `api-key`            | yes     | `CAT_FACTORY_API_KEY` names `ACCEPTANCE_WORKSPACE_ID` and is scoped `admin`.                                                                                                        |
| `spend-budget`       | yes     | The workspace is not over budget, which pauses every run.                                                                                                                           |
| `agent-model`        | yes     | At least one catalog model is selectable. Distinguishes "unconfigured" from "blocked by account policy".                                                                            |
| `model-preset`       | yes     | `ACCEPTANCE_MODEL_PRESET` exists here AND its base model can be dispatched to (see below).                                                                                          |
| `vcs-connection`     | yes     | Connected to `ACCEPTANCE_REPO_OWNER` and may write workflow files.                                                                                                                  |
| `target-repos`       | yes     | Both named repositories are REACHABLE (linked already, or point-read through `/repos/available`) AND adoptable: no monorepo, nothing homed on another board, and any existing service link is one this pass's own ledger names. |
| `auto-merge-policy`  | yes     | The workspace's default risk policy permits auto-merge (see below).                                                                                                                 |
| `board-titles`       | yes     | A fresh pass is not about to create a second frame under a title this board already has.                                                                                            |
| `cluster-connection` | yes     | The apiserver answers the ServiceAccount token, probed without persisting anything.                                                                                                 |
| `ingress-template`   | yes     | An environment URL renders from the configured host template.                                                                                                                       |
| `pipeline-catalog`   | note    | Advisory: an unadopted pipeline materialises on first start, so this is a heads-up rather than a refusal.                                                                           |

Three things it deliberately does NOT check, because none is knowable from where it stands:

- **Whether the two repositories are EMPTY.** No `/api/v1` read publishes whether a repository holds
  content: the bootstrapper used to answer it inside its container pre-flight, and putting it on the
  repository LIST would cost one provider round-trip per row on every call. `target-repos` says so
  in its own verdict rather than implying it checked.
- **Whether an unreachable repository was never created, or exists and is not granted.** A provider
  answers those identically, so the refusal names both rather than picking one.
- **Whether the wired model can actually build a small service.** A model that cannot scaffold a
  Fastify app fails spec 01 for reasons that are not the platform's. This suite is not a model
  benchmark and does not grade one.
- **Whether a container runtime is available to the agent jobs.** Nothing short of dispatching a
  job answers it.

**Why `serviceId: null` is not enough to call a repository free.** `GET /api/v1/repos` reports the
service a repository backs ON THIS BOARD. A whole-repo service homed on another board of the same
account has no id this workspace-scoped surface can hand back, so it answers `serviceId: null` **with
`linkedElsewhere: true`**, and `POST /api/v1/services` then refuses it
(`reason: repo_service_homed_elsewhere`). `target-repos` reads the flag, so that arrives as a refusal
with a remedy rather than as a 409 out of spec 01's first adopt. An existing link on this board is
compared against the ledger's own service ids, not against "is this a resume at all": a ledger holding
only the backend service cannot vouch for the frontend repository.

**Why the preset is checked separately from the model catalog.** `agent-model` answers "can this
deployment dispatch to ANYTHING", which is what the first live setup attempt needed: all 21 catalog
entries reported unavailable because the models that deployment ran on were per-user, which an API
key can see neither of. `model-preset` answers the narrower question a pinning pass actually
depends on, and keeps three outcomes apart, because they have three different fixes: no such
preset, a preset naming a model the catalog has since dropped, and a preset whose model is listed
but has no provider wired (or is refused by the account's model-family policy).

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

**The deployment**

- Running in **local mode** (`@cat-factory/local-server`), or any deployment you hold an `admin`
  key for. Nothing here needs the deployment to run open: every call the suite makes is either
  key-authenticated against `/api/v1` or one of the two unauthenticated deployment root reads.
- `ENCRYPTION_KEY` set, or `/api/v1` answers `503` on every call.
- A **container runtime** for the agent jobs.

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

**One thing to know about images.** The bootstrapped repositories ship a workflow that builds and
pushes their image on every push, and their manifests reference the platform's `{{image}}`
placeholder. The `deployer` step runs after `coder` and `reviewer`, so the image is normally
already pushed by then; where it is not, the pods sit in `ImagePullBackOff` and Kubernetes retries
until it lands, which the environment status poll absorbs. The registry must be readable by the
cluster (a public package, or an `imagePullSecret` you have already installed).

## Configuration

```sh
pnpm --filter @cat-factory/acceptance run configure
```

**Start here.** `configure` writes the `.env` below by asking as little as it can. Most of these
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

| Variable                               | Required | What it is                                                                                                                                                                        |
| -------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAT_FACTORY_BASE_URL`                 | yes      | Backend origin, e.g. `http://127.0.0.1:8787`. Serves `/api/v1` and the deployment root reads.                                                                                     |
| `CAT_FACTORY_API_KEY`                  | yes      | A public-API key scoped **`admin`** (spec 03 also needs the `decide` rung it includes).                                                                                           |
| `ACCEPTANCE_WORKSPACE_ID`              | yes      | The workspace the key is bound to. `GET /api/v1/me` reports it.                                                                                                                   |
| `ACCEPTANCE_REPO_OWNER`                | yes      | The owner both repositories live under. `GET /api/v1/vcs/connection` reports it.                                                                                                  |
| `ACCEPTANCE_BACKEND_REPO`              | yes      | Name of the empty repository the backend service adopts. **You create it; the suite adopts it.**                                                                                  |
| `ACCEPTANCE_FRONTEND_REPO`             | yes      | Name of the empty repository the frontend adopts. Must differ from the backend's.                                                                                                 |
| `ACCEPTANCE_K3S_API_SERVER`            | yes      | Apiserver URL, e.g. `https://127.0.0.1:6443`.                                                                                                                                     |
| `ACCEPTANCE_K3S_TOKEN`                 | yes      | The ServiceAccount bearer token.                                                                                                                                                  |
| `ACCEPTANCE_K3S_CA_PEM`                | one of   | The cluster CA in PEM. Wins over the insecure flag when both are set.                                                                                                             |
| `ACCEPTANCE_K3S_INSECURE`              | one of   | `true` to skip apiserver TLS verification. Throwaway clusters only.                                                                                                               |
| `ACCEPTANCE_MODEL_PRESET`              | no       | Preset id pinned on every task, default `mdp_claude` (the built-in Claude preset). `configure` offers the library as a menu, so the id never has to be typed.                     |
| `ACCEPTANCE_K3S_INGRESS_HOST_TEMPLATE` | no       | Default `{{namespace}}.127.0.0.1.nip.io`, which needs no DNS. Also the host the scaffold briefs ask each service's Ingress to serve, so overriding it moves both halves together. |
| `ACCEPTANCE_K3S_NAMESPACE_TEMPLATE`    | no       | Default `cf-acc-{{pullNumber}}`.                                                                                                                                                  |
| `ACCEPTANCE_NAME_PREFIX`               | no       | Default `cf-acc`. Prefixes the board frames and tasks, not the repositories. Set it per-person when a board is shared.                                                            |
| `ACCEPTANCE_RUN_BUDGET_MS`             | no       | Per-run ceiling, default 90 min. Not a vitest timeout; see below.                                                                                                                 |
| `ACCEPTANCE_STATE_DIR`                 | no       | Default `.acceptance`, relative to this package.                                                                                                                                  |
| `ACCEPTANCE_RUN_ID`                    | no       | A run id to **resume**, or `latest` for the most recent pass. Unset starts a new one.                                                                                             |

They live in a **`.env` beside `vitest.acceptance.config.ts`** (gitignored, and read by that
config: vitest does not pick one up on its own). A variable exported in the shell wins over the
file, so the file states the setup and the invocation states the exception:
`ACCEPTANCE_RUN_ID=latest pnpm … acceptance` resumes without editing anything.

Missing configuration is reported **all at once**, with what each variable is for. The suite
refuses rather than guessing, because it merges real pull requests into real repositories.

## Watching a pass

A pass runs for an afternoon in a terminal nobody is watching, and the questions asked afterwards
are asked from somewhere else. So every observation is appended to a journal beside the ledger,
and a second command reduces the two into an answer:

```sh
pnpm --filter @cat-factory/acceptance run status          # the most recent pass
pnpm --filter @cat-factory/acceptance run status 20260809175530
```

A phase re-entered by a later attempt at the same run id is re-opened and re-timed from that
entry, so what the report shows is the CURRENT pass rather than a phase that reads `done` under
yesterday's message with an elapsed time spanning the night between them.

It reports each phase with how long it has been in it, the last thing that phase observed,
anything the pass created (services, runs, pull requests) and how long ago the last line was
written. That last number is the one that matters: a pass whose
poll interval is ten seconds and whose journal has been silent for twenty minutes is not slow, it
is dead or detached, and nothing else distinguishes those from "still working".

The command opens no connection to the deployment, creates nothing, and needs no API key, so it is
safe to run against a pass that is currently going.

## Resuming

A full pass costs an afternoon and real spend, so it is written to be resumed. Every spec records
what it created in a ledger under `ACCEPTANCE_STATE_DIR`, re-reads it on start, and re-checks it
against the deployment rather than trusting it.

```sh
ACCEPTANCE_RUN_ID=20260809175530 pnpm --filter @cat-factory/acceptance run acceptance
ACCEPTANCE_RUN_ID=latest pnpm --filter @cat-factory/acceptance run acceptance
```

`latest` resolves through a pointer written when a pass OPENS, not when it finishes: the pass
worth resuming is by definition one that did not finish. Asking for `latest` when no pass exists
is refused rather than quietly starting a new one, because those are opposite intents and the
wrong one spends an afternoon.

What a resumed pass does with each thing it finds:

| Found                             | Action                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------- |
| A service in the ledger           | Re-read the BOARD; reuse it if the frame is still there, adopt again if not.    |
| A repository backing a service    | Reuse that service rather than raising a second frame over the same repository. |
| A task filed, never started       | Start it.                                                                       |
| A run still working               | Re-attach and keep driving it. Nothing is re-filed.                             |
| A run that already reached `done` | Adopt it.                                                                       |
| A task the board no longer has    | File it again, saying so.                                                       |

Every one of those states is recorded the moment it is entered rather than when it completes, so
the window a crash can land in is as small as the ledger write. The one thing recorded that is not
an id is the set of decision kinds the suite ANSWERED, because a settled decision is
indistinguishable afterwards from one nobody had to make, and spec 03's claim that it drove a human
gate over `/api/v1` has to survive the process that made it. It travels with the TASK it was
recorded against and no further: a task the board no longer has is re-filed as new work, and
inheriting the deleted run's answers would let spec 03 claim it drove a gate the replacement run
never reached.

**Nothing is cleaned up on failure.** The run, its pull request and any provisioned namespace are
left in place to be inspected, and the failure message says so. Successful passes reclaim their
namespaces through the pipeline's own `disposer`, which spec 02 asserts.

## The rules these specs are written to

Five, and each is load-bearing.

**0. Refuse before spending, say everything that is wrong, and say how to fix each one.** The gate
above runs in every spec rather than only in spec 00, because a resumed pass starts wherever it
stopped and a check only the first file runs is a check the resume path skips. Everything it knows
is reported together: this suite's unit of feedback is an afternoon, so learning about the second
problem tomorrow costs a day per problem. The same arithmetic is why a refusal carries the steps
and commands rather than a description of them, and why they are rendered from what the probe read.

**1. Assert on evidence the platform COMPUTED, never on prose an agent wrote.** A test that greps a
coder's reply for "fixed the off-by-one" is testing the model's turn of phrase; change the model
and it goes red having found nothing wrong. The verification report exists because the platform
derives its verdicts in code from captured facts, so `reproduction.verdict`, `environments.proof`,
`ci.verdict` and `merge.outcome` are stable claims. `src/evidence.ts` reduces them, and is itself
unit-tested: a bug in a grader reports green and nothing else notices.

**2. Never auto-answer a decision the suite was not designed for, or one that is in flight.**
`src/decisions.ts` answers exactly two kinds and hard-fails on every other, naming it. The tempting
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

**3. A wait that expires must say what it last saw.** The vitest timeout is disabled on purpose so
that `src/deadline.ts` fires first: "timed out after 5400000ms" is true and useless, where "step 3
`coder` was still working, 4/9 subtasks" separates a parked run from a wedged one from a slow one.

**4. Every failing claim is reported, not just the first.** A run that both skipped its environment
and failed CI is one story, and learning the second half on tomorrow's re-run wastes a day per bug.

## The two calls that are not `/api/v1`

The suite drives the public API through the **published TypeScript SDK**, the same artifact an
integrator installs, so a surface change that would break an integration breaks this suite at
compile time. That is now true of the WHOLE narrative, setup included: listing the repositories,
backing a service with one, connecting the cluster, declaring a service's manifest source, pinning
a model preset and reading what the deployment has wired are all public operations.

What is left outside are two UNAUTHENTICATED reads on the deployment root, `GET /health` and
`GET /auth/config`, in [`src/deploymentApi.ts`](./src/deploymentApi.ts). They are not a smaller
escape hatch; they answer a question `/api/v1` structurally cannot. Both have to work for a
deployment whose configuration failed to validate, and such a backend serves a fallback app that
answers 503 on every other route, `/api/v1` included. A key-authenticated health check cannot
describe a deployment too broken to authenticate a key, which is exactly the state worth describing.

That reasoning is also the rule for adding to that file: it does not extend to anything scoped to a
workspace. A caller acting on one holds a key, so that is a public endpoint.

## Where things live

| Path                         | What                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acceptance/*.acceptance.ts` | The four specs, in order. `fixtures.ts` builds the harness and mounts the gate.                                                                            |
| `src/config.ts`              | Environment → config, reporting every problem at once. Pure; unit-tested.                                                                                  |
| `src/preflight.ts`           | The prerequisite vocabulary, runner and refusal. Pure; unit-tested.                                                                                        |
| `src/prerequisites.ts`       | The checks, each with the steps and commands that fix it. Unit-tested.                                                                                     |
| `src/adopt.ts`               | Repository → board service (adopting it first when the workspace has not), every way that join refuses, and the one copy of the reachability steps the gate and `configure` share. Unit-tested. |
| `src/presets.ts`             | The one preset-to-catalog join `configure` and `model-preset` share. Pure.                                                                                 |
| `src/world.ts`               | The resumable ledger, and the `latest` pointer.                                                                                                            |
| `src/journal.ts`             | The append-only progress record a pass can be watched through.                                                                                             |
| `src/status.ts`              | Ledger + journal → "where is this pass". Pure; unit-tested.                                                                                                |
| `src/statusCli.ts`           | `pnpm run status`. Reads the two files and nothing else.                                                                                                   |
| `src/configure.ts`           | `configure`'s flow: what it resolves, what it asks. Driven by seams; unit-tested.                                                                          |
| `src/configureEnv.ts`        | The `.env` merge and the creation URL. Pure; unit-tested.                                                                                                  |
| `src/configureCli.ts`        | `pnpm run configure`. Supplies the real terminal, shell, files and client.                                                                                 |
| `src/publicApi.ts`           | SDK client, the one task-creation door, run observation, the polling wait.                                                                                 |
| `src/resume.ts`              | File a task, or adopt / re-attach to what a previous pass left.                                                                                            |
| `src/runDriver.ts`           | Drive a started run to terminal, answering parks under one shared budget.                                                                                  |
| `src/decisions.ts`           | The two kinds this suite answers, what is answerable NOW, and the refusals.                                                                                |
| `src/evidence.ts`            | The report reductions the specs assert on. Pure; unit-tested.                                                                                              |
| `src/instructions.ts`        | The briefs, and the reasoning behind the planted defect.                                                                                                   |
| `src/k3s.ts`                 | The engine connection and the per-service manifest source.                                                                                                 |
| `src/deploymentApi.ts`       | The two unauthenticated deployment root reads (`/health`, `/auth/config`).                                                                                 |
| `src/deadline.ts`            | Waiting, with the observation the expiry needs.                                                                                                            |

**See also:** [`backend/internal/e2e`](../e2e) (the faked-externals product suite),
[`backend/internal/sdk-smoketest`](../sdk-smoketest) (the same SDK against a booted backend),
[`backend/docs/public-api.md`](../../docs/public-api.md),
[`backend/docs/local-k3s-environments.md`](../../docs/local-k3s-environments.md).
