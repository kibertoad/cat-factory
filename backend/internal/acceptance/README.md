# `@cat-factory/acceptance`

**Acceptance tests against a LIVE local deployment.** Real agents, real model spend, real
repositories, real pull requests, and a real k3s cluster. They bootstrap two empty repositories
into working services, ship a feature across both onto an ephemeral Kubernetes environment, then
file the defect that feature leaves behind and let the platform investigate and fix it.

**Never run in CI**, and structurally cannot be: `test:run` (the task CI runs) points at
`vitest.config.ts`, which collects only this package's own unit tests. The acceptance specs live
under `acceptance/` behind a second config that nothing but the `acceptance` script names.

```sh
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
| `01-bootstrap`           | Connects the k3s engine, bootstraps a backend repo and a frontend repo from empty, declares each service's manifest source, and checks both are fileable services. |
| `02-feature-with-defect` | Ships a paginated catalog across both services on `pl_build`. Asserts the environment came up on the cluster, CI gated it, the merge resolved, the namespace went. |
| `03-investigate-and-fix` | Files the resulting bug as a report, runs `pl_bugfix`, answers its `clarity-review` human gate over `/api/v1`, and asserts a red-then-green reproduction proof.    |

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

| Prerequisite         | Checked | What it means                                                                                             |
| -------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `deployment-health`  | yes     | The backend booted. A misconfigured one serves a fallback app, and its own problem list is reported.      |
| `api-key`            | yes     | `CAT_FACTORY_API_KEY` names `ACCEPTANCE_WORKSPACE_ID` and is scoped `admin`.                              |
| `spend-budget`       | yes     | The workspace is not over budget, which pauses every run.                                                 |
| `agent-model`        | yes     | At least one catalog model is selectable. Distinguishes "unconfigured" from "blocked by account policy".  |
| `vcs-connection`     | yes     | Connected to `ACCEPTANCE_REPO_OWNER`, may CREATE repositories, and may write workflow files.              |
| `auto-merge-policy`  | yes     | The workspace's default merge preset permits auto-merge (see below).                                      |
| `board-titles`       | yes     | A fresh pass is not about to create a second frame under a title this board already has.                  |
| `cluster-connection` | yes     | The apiserver answers the ServiceAccount token, probed without persisting anything.                       |
| `ingress-template`   | yes     | An environment URL renders from the configured host template.                                             |
| `pipeline-catalog`   | note    | Advisory: an unadopted pipeline materialises on first start, so this is a heads-up rather than a refusal. |

Two things it deliberately does NOT check, because neither is knowable without spending:

- **Whether the wired model can actually build a small service.** A model that cannot scaffold a
  Fastify app fails spec 01 for reasons that are not the platform's. This suite is not a model
  benchmark and does not grade one.
- **Whether a container runtime is available to the agent jobs.** Nothing short of dispatching a
  job answers it.

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

| Variable                               | Required | What it is                                                                                                                                                                         |
| -------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAT_FACTORY_BASE_URL`                 | yes      | Backend origin, e.g. `http://127.0.0.1:8787`. Serves `/api/v1` and the deployment root reads.                                                                                      |
| `CAT_FACTORY_API_KEY`                  | yes      | A public-API key scoped **`admin`** (spec 03 also needs the `decide` rung it includes).                                                                                            |
| `ACCEPTANCE_WORKSPACE_ID`              | yes      | The workspace the key is bound to. `GET /api/v1/me` reports it.                                                                                                                    |
| `ACCEPTANCE_REPO_OWNER`                | yes      | GitHub owner the bootstrapped repositories are created under.                                                                                                                      |
| `ACCEPTANCE_K3S_API_SERVER`            | yes      | Apiserver URL, e.g. `https://127.0.0.1:6443`.                                                                                                                                      |
| `ACCEPTANCE_K3S_TOKEN`                 | yes      | The ServiceAccount bearer token.                                                                                                                                                   |
| `ACCEPTANCE_K3S_CA_PEM`                | one of   | The cluster CA in PEM. Wins over the insecure flag when both are set.                                                                                                              |
| `ACCEPTANCE_K3S_INSECURE`              | one of   | `true` to skip apiserver TLS verification. Throwaway clusters only.                                                                                                                |
| `ACCEPTANCE_K3S_INGRESS_HOST_TEMPLATE` | no       | Default `{{namespace}}.127.0.0.1.nip.io`, which needs no DNS. Also the host the bootstrap briefs ask each service's Ingress to serve, so overriding it moves both halves together. |
| `ACCEPTANCE_K3S_NAMESPACE_TEMPLATE`    | no       | Default `cf-acc-{{pullNumber}}`.                                                                                                                                                   |
| `ACCEPTANCE_NAME_PREFIX`               | no       | Default `cf-acc`. Set it per-person when an org is shared: repository names collide account-wide.                                                                                  |
| `ACCEPTANCE_RUN_BUDGET_MS`             | no       | Per-run ceiling, default 90 min. Not a vitest timeout; see below.                                                                                                                  |
| `ACCEPTANCE_STATE_DIR`                 | no       | Default `.acceptance`, relative to this package.                                                                                                                                   |
| `ACCEPTANCE_RUN_ID`                    | no       | A run id to **resume**, or `latest` for the most recent pass. Unset starts a new one.                                                                                              |

Set them in a **`.env` beside `vitest.acceptance.config.ts`** (gitignored, and read by that
config: vitest does not pick one up on its own). A variable exported in the shell wins over the
file, so the file states the setup and the invocation states the exception:
`ACCEPTANCE_RUN_ID=latest pnpm … acceptance` resumes without editing anything.

Missing configuration is reported **all at once**, with what each variable is for. The suite
refuses rather than guessing, because it creates real repositories.

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
anything the pass created (services, runs, pull requests), any bootstrap started but not settled,
and how long ago the last line was written. That last number is the one that matters: a pass whose
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
wrong one bootstraps two repositories.

What a resumed pass does with each thing it finds:

| Found                               | Action                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| A service in the ledger             | Re-read the BOARD; reuse it if the frame is still there, bootstrap again if not. |
| A bootstrap job started, no service | Re-attach to the job. The repository already exists, so a second one collides.   |
| A task filed, never started         | Start it.                                                                        |
| A run still working                 | Re-attach and keep driving it. Nothing is re-filed.                              |
| A run that already reached `done`   | Adopt it.                                                                        |
| A task the board no longer has      | File it again, saying so.                                                        |

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
compile time. That is now true of the WHOLE narrative, setup included: bootstrapping a repository,
connecting the cluster, declaring a service's manifest source and reading what the deployment has
wired are all public operations (surface 1.41.0).

What is left outside are two UNAUTHENTICATED reads on the deployment root, `GET /health` and
`GET /auth/config`, in [`src/deploymentApi.ts`](./src/deploymentApi.ts). They are not a smaller
escape hatch; they answer a question `/api/v1` structurally cannot. Both have to work for a
deployment whose configuration failed to validate, and such a backend serves a fallback app that
answers 503 on every other route, `/api/v1` included. A key-authenticated health check cannot
describe a deployment too broken to authenticate a key, which is exactly the state worth describing.

That reasoning is also the rule for adding to that file: it does not extend to anything scoped to a
workspace. A caller acting on one holds a key, so that is a public endpoint.

## Where things live

| Path                         | What                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `acceptance/*.acceptance.ts` | The four specs, in order. `fixtures.ts` builds the harness and mounts the gate.  |
| `src/config.ts`              | Environment → config, reporting every problem at once. Pure; unit-tested.        |
| `src/preflight.ts`           | The prerequisite vocabulary, runner and refusal. Pure; unit-tested.              |
| `src/prerequisites.ts`       | The checks, each with the steps and commands that fix it. Unit-tested.           |
| `src/world.ts`               | The resumable ledger, and the `latest` pointer.                                  |
| `src/journal.ts`             | The append-only progress record a pass can be watched through.                   |
| `src/status.ts`              | Ledger + journal → "where is this pass". Pure; unit-tested.                      |
| `src/statusCli.ts`           | `pnpm run status`. Reads the two files and nothing else.                         |
| `src/publicApi.ts`           | SDK client, run observation, the polling wait.                                   |
| `src/resume.ts`              | File a task, or adopt / re-attach to what a previous pass left.                  |
| `src/runDriver.ts`           | Drive a started run to terminal, answering parks under one shared budget.        |
| `src/decisions.ts`           | The two kinds this suite answers, what is answerable NOW, and the refusals.      |
| `src/evidence.ts`            | The report reductions the specs assert on. Pure; unit-tested.                    |
| `src/instructions.ts`        | The briefs, and the reasoning behind the planted defect.                         |
| `src/k3s.ts`                 | The engine connection and the per-service manifest source.                       |
| `src/bootstrap.ts`           | Starting (or re-attaching to) a bootstrap, and reporting its structured failure. |
| `src/deploymentApi.ts`       | The two unauthenticated deployment root reads (`/health`, `/auth/config`).       |
| `src/deadline.ts`            | Waiting, with the observation the expiry needs.                                  |

**See also:** [`backend/internal/e2e`](../e2e) (the faked-externals product suite),
[`backend/internal/sdk-smoketest`](../sdk-smoketest) (the same SDK against a booted backend),
[`backend/docs/public-api.md`](../../docs/public-api.md),
[`backend/docs/local-k3s-environments.md`](../../docs/local-k3s-environments.md).
