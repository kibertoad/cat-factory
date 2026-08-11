# `@cat-factory/acceptance`

**Acceptance tests against a LIVE local deployment.** Real agents, real model spend, real
repositories, real pull requests, real issues, and a real k3s cluster. They adopt two empty
repositories you created, scaffold a working service into each, ship a feature across both onto an
ephemeral Kubernetes environment, file the defect that feature leaves behind and let the platform
investigate and fix it, and then file an issue as an OUTSIDE reporter and watch the platform deliver
it and close it.

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

Five spec files, run in order. Each spec's output is the next one's input.

| Spec                       | What it does                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `00-preflight`             | Reports every prerequisite as its own named test. Creates nothing. The GATE runs in each spec, so a resumed pass cannot skip it.                                   |
| `01-adopt-and-scaffold`    | Connects the k3s engine, backs a service with each of your two repositories, declares each one's manifest source, then scaffolds both through `pl_build`.          |
| `02-feature-with-defect`   | Ships a paginated catalog across both services on `pl_build`. Asserts the environment came up on the cluster, CI gated it, the merge resolved, the namespace went. |
| `03-investigate-and-fix`   | Files the resulting bug as a report, runs `pl_bugfix`, answers its `clarity-review` human gate over `/api/v1`, and asserts a red-then-green reproduction proof.    |
| `04-issue-intake-to-close` | Files an issue on the backend repository as an outside reporter, files a task FROM it, delivers it on `pl_build`, and asserts the platform CLOSED the issue.       |

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

### The reporter in spec 04 is a stranger, and holds its own credential

Spec 04's premise is that somebody who has never heard of cat-factory opens an issue on a repository,
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
parameter on the catalog API, which changes nothing about a valid request. The claim of the spec is
the LOOP, not the feature, and a change that moved the paging contract spec 03 has just settled would
make a spec 04 failure unreadable. `src/instructions.ts` carries the issue text and that reasoning.

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

**And such a probe names its CAUSE**, because there are three ways to fail and they need opposite
fixes. `src/probeFailure.ts` owns the distinction, as a discriminated verdict rather than one shape
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

| Prerequisite         | Checked | What it means                                                                                                                                                                                                                   |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deployment-health`  | yes     | The backend booted. A misconfigured one serves a fallback app, and its own problem list is reported.                                                                                                                            |
| `api-key`            | yes     | `CAT_FACTORY_API_KEY` names `ACCEPTANCE_WORKSPACE_ID` and is scoped `admin`.                                                                                                                                                    |
| `spend-budget`       | yes     | The workspace is not over budget, which pauses every run.                                                                                                                                                                       |
| `agent-model`        | yes     | At least one catalog model is selectable. Distinguishes "unconfigured" from "blocked by account policy".                                                                                                                        |
| `model-preset`       | yes     | `ACCEPTANCE_MODEL_PRESET` exists here AND its base model can be dispatched to (see below).                                                                                                                                      |
| `vcs-connection`     | yes     | Connected to `ACCEPTANCE_REPO_OWNER` and may write workflow files.                                                                                                                                                              |
| `target-repos`       | yes     | Both named repositories are REACHABLE (linked already, or point-read through `/repos/available`) AND adoptable: no monorepo, nothing homed on another board, and any existing service link is one this pass's own ledger names. |
| `issue-credential`   | yes     | `ACCEPTANCE_VCS_TOKEN` can reach the backend repository and open an issue on it (which needs its Issues feature switched on).                                                                                                   |
| `tracker-writeback`  | yes     | The workspace comments on a linked tracker issue when a pull request opens AND closes it when the pull request merges: spec 04's whole claim.                                                                                   |
| `auto-merge-policy`  | yes     | The workspace's default risk policy permits auto-merge (see below).                                                                                                                                                             |
| `board-titles`       | yes     | A fresh pass is not about to create a second frame under a title this board already has.                                                                                                                                        |
| `cluster-connection` | yes     | The apiserver answers the ServiceAccount token, probed without persisting anything.                                                                                                                                             |
| `ingress-template`   | yes     | An environment URL renders from the configured host template.                                                                                                                                                                   |
| `pipeline-catalog`   | note    | Advisory: an unadopted pipeline materialises on first start, so this is a heads-up rather than a refusal.                                                                                                                       |

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

- **The pass asks for your personal password at the terminal**, once, at the first call that needs
  it, not at `configure` time, and never for a workspace running on a provider API key. It is held
  in the process's memory and written NOWHERE: not the `.env`, not the ledger, not the journal. That
  is deliberate rather than an omission, since a copy beside `CAT_FACTORY_API_KEY` would put both
  halves of a two-factor credential in one file. A resumed pass asks again. No variable or file can
  supply it instead. See
  [`individual-subscription-usage.md` §7](../../docs/individual-subscription-usage.md).
- **So run the pass from an INTERACTIVE terminal**, with the ordinary invocation above: nothing
  about the command changes, and there is no separate mode for this. Under the hood the prompt opens
  the CONTROLLING TERMINAL for reading (`/dev/tty`, `CONIN$` on Windows) and writes the prompt back
  down it (`CONOUT$` on Windows, the device it read from on POSIX) rather than through this process's
  own stdio, and both halves of that are what make it work under vitest at all: a worker is forked
  with PIPED stdio, so `stdin.isTTY` is undefined there and a stdin prompt could never ask, while the
  reporter owning that worker's stdout would swallow a printed one. A console is inherited by child
  processes independently of stdio, so the pnpm and vitest layers between your shell and the spec
  cost nothing. Where that terminal cannot be opened at all, `process.stdin` is the fallback IF it
  happens to be one (which is what a plain `run status` from a shell gets) and the prompt goes to
  stderr; a process with neither refuses.
- **A pass with no console REFUSES at that first dispatch**, naming the two ways out (run it
  interactively, or pin a preset whose model resolves to a provider API key). That covers CI, a
  daemon, `nohup`, and an agent's detached background shell. Windows opens `CONIN$` even with no
  console attached, so the refusal comes from the raw-mode switch rather than from the open; before
  it was translated, that arrived as a bare `Error: setRawMode EPERM` (errno -4048), which named
  neither the password nor either remedy.

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

| Variable                               | Required | What it is                                                                                                                                                                        |
| -------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAT_FACTORY_BASE_URL`                 | yes      | Backend origin, e.g. `http://127.0.0.1:8787`. Serves `/api/v1` and the deployment root reads.                                                                                     |
| `CAT_FACTORY_API_KEY`                  | yes      | A public-API key scoped **`admin`** (spec 03 also needs the `decide` rung it includes).                                                                                           |
| `ACCEPTANCE_WORKSPACE_ID`              | yes      | The workspace the key is bound to. `GET /api/v1/me` reports it.                                                                                                                   |
| `ACCEPTANCE_REPO_OWNER`                | yes      | The owner both repositories live under. `GET /api/v1/vcs/connection` reports it.                                                                                                  |
| `ACCEPTANCE_BACKEND_REPO`              | yes      | Name of the empty repository the backend service adopts. **You create it; the suite adopts it.**                                                                                  |
| `ACCEPTANCE_FRONTEND_REPO`             | yes      | Name of the empty repository the frontend adopts. Must differ from the backend's.                                                                                                 |
| `ACCEPTANCE_VCS_TOKEN`                 | yes      | Provider token spec 04 files its issue with, as an outside reporter. Classic GitHub: `repo`. Fine-grained: "Issues: Read and write" on the backend repository. Never the API key. |
| `ACCEPTANCE_VCS_API_BASE`              | no       | The provider's REST base, default `https://api.github.com`. GitHub Enterprise Server is `https://<host>/api/v3`, which no `/api/v1` read publishes.                               |
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
| `ACCEPTANCE_RUN_ID`                    | no       | A run id to **resume**, or `latest` for the most recent pass. Unset starts a new one. The one variable normally set per invocation, so see the shell forms below.                 |

They live in a **`.env` beside `vitest.acceptance.config.ts`** (gitignored, and read by that
config: vitest does not pick one up on its own). A variable set in the shell wins over the file, so
the file states the setup and the invocation states the exception.

**Every variable can be set either way, and the file is the one form that needs no shell dialect.**
That matters most for `ACCEPTANCE_RUN_ID`, the only one routinely set per invocation:

```sh
ACCEPTANCE_RUN_ID=latest pnpm --filter @cat-factory/acceptance run acceptance   # POSIX
```

```powershell
$env:ACCEPTANCE_RUN_ID = 'latest'; pnpm --filter @cat-factory/acceptance run acceptance
```

**PowerShell has no inline environment prefix**, so the POSIX form is not merely unidiomatic there,
it reads the assignment as the command NAME and fails with `CommandNotFoundException`. Every command
this suite PRINTS with a variable in it is rendered for the shell that will RECEIVE it (the resume in
two prerequisite remedies, the line the status report ends with, the per-person prefix, and the three
remedies whose whole fix is one value), so a pasted remedy runs where it was read. The shell, not the
platform: on Windows that is PowerShell unless `SHELL` or `MSYSTEM` is set, which is how a Git Bash or
MSYS operator gets the POSIX form. The `curl` remedies are the remaining exception and are still
POSIX-only: they interpolate `$CAT_FACTORY_API_KEY`, which PowerShell expands as one of its own
variables and sends as an empty bearer token. `$env:` also persists for the whole session rather than
the one command, which is what makes it a resume that outlives the pass you meant it for:
`Remove-Item Env:ACCEPTANCE_RUN_ID` clears it.

Putting the id in the `.env` works everywhere and survives closing the terminal, with the same trap
inverted: it resumes that pass until the line is removed.

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

```powershell
$env:ACCEPTANCE_RUN_ID = '20260809175530'; pnpm --filter @cat-factory/acceptance run acceptance
$env:ACCEPTANCE_RUN_ID = 'latest'; pnpm --filter @cat-factory/acceptance run acceptance
```

Or the `ACCEPTANCE_RUN_ID` line in the `.env`, which needs no dialect at all; see
[Configuration](#configuration) for what each form costs.

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
| An issue the ledger names         | Re-read it from the provider: adopt it if it is there, file a fresh one if not. |

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
A wait whose last observation is itself GRADED may hand it back instead of throwing, and
`waitForIssueSettled` is the one that does: the checks render each claim with its own detail, which
is more than the single line an expiry message carries. What is banned is ending a wait with
neither, and a wait must poll for everything its grade asserts or it hands the grader a half-written
observation and fails what was working.

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

| Path                         | What                                                                                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acceptance/*.acceptance.ts` | The five specs, in order. `fixtures.ts` builds the harness and mounts the gate.                                                                                                                 |
| `src/config.ts`              | Environment → config, reporting every problem at once. Pure; unit-tested.                                                                                                                       |
| `src/preflight.ts`           | The prerequisite vocabulary, runner and refusal. Pure; unit-tested.                                                                                                                             |
| `src/prerequisites.ts`       | The checks, each with the steps and commands that fix it. Unit-tested.                                                                                                                          |
| `src/probeFailure.ts`        | What a THROWN probe was (never answered / refused / answered by something else) and the remedy for each. Pure; unit-tested.                                                                     |
| `src/operatorText.ts`        | How a value is rendered for an operator: a thrown chain, a scrubbed address, and every pasteable command, whose shell dialect is decided here and nowhere else. Pure; unit-tested.              |
| `src/adopt.ts`               | Repository → board service (adopting it first when the workspace has not), every way that join refuses, and the one copy of the reachability steps the gate and `configure` share. Unit-tested. |
| `src/presets.ts`             | The one preset-to-catalog join `configure` and `model-preset` share. Pure.                                                                                                                      |
| `src/world.ts`               | The resumable ledger, and the `latest` pointer.                                                                                                                                                 |
| `src/journal.ts`             | The append-only progress record a pass can be watched through.                                                                                                                                  |
| `src/status.ts`              | Ledger + journal → "where is this pass". Pure; unit-tested.                                                                                                                                     |
| `src/statusCli.ts`           | `pnpm run status`. Reads the two files and nothing else.                                                                                                                                        |
| `src/configure.ts`           | `configure`'s flow: what it resolves, what it asks. Driven by seams; unit-tested.                                                                                                               |
| `src/configureEnv.ts`        | The `.env` merge and the creation URL. Pure; unit-tested.                                                                                                                                       |
| `src/configureCli.ts`        | `pnpm run configure`. Supplies the real terminal, shell, files and client.                                                                                                                      |
| `src/publicApi.ts`           | SDK client, the one task-creation door, run observation, the polling wait.                                                                                                                      |
| `src/resume.ts`              | File a task, or adopt / re-attach to what a previous pass left.                                                                                                                                 |
| `src/runDriver.ts`           | Drive a started run to terminal, answering parks under one shared budget.                                                                                                                       |
| `src/decisions.ts`           | The two kinds this suite answers, what is answerable NOW, and the refusals.                                                                                                                     |
| `src/evidence.ts`            | The report reductions the specs assert on. Pure; unit-tested.                                                                                                                                   |
| `src/instructions.ts`        | The briefs, the reporter's issue, and the reasoning behind the planted defect.                                                                                                                  |
| `src/vcsIssues.ts`           | The reporter's own client: filing an issue on the provider and reading it back, provider-keyed. The one thing here that is not the platform.                                                    |
| `src/issueIntake.ts`         | Filing that issue exactly once across attempts, waiting for the platform to settle it, and the pair of claims that grades what it did.                                                          |
| `src/k3s.ts`                 | The engine connection and the per-service manifest source.                                                                                                                                      |
| `src/deploymentApi.ts`       | The two unauthenticated deployment root reads (`/health`, `/auth/config`), and the typed answer a non-2xx or non-JSON reply becomes. Unit-tested.                                               |
| `src/deadline.ts`            | Waiting, with the observation the expiry needs.                                                                                                                                                 |

**See also:** [`backend/internal/e2e`](../e2e) (the faked-externals product suite),
[`backend/internal/sdk-smoketest`](../sdk-smoketest) (the same SDK against a booted backend),
[`backend/docs/public-api.md`](../../docs/public-api.md),
[`backend/docs/local-k3s-environments.md`](../../docs/local-k3s-environments.md).
