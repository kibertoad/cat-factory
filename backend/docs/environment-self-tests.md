# Environment self-tests: provisioning, and the agent dry run

Two developer-triggered diagnostics on a service frame, run from the inspector's provisioning
section. Both exercise the service's real ephemeral-environment config against a **throwaway
branch** and both always clean up; they differ in how far they go.

|                                                     | Question                                                                                                                                                 | Stages                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Test environment creation** (`mode: 'provision'`) | Does this service's provisioning stand an environment up and take it down again?                                                                         | `creating_branch` → `provisioning` → `tearing_down` → `deleting_branch` → `done` |
| **Test agent dry run** (`mode: 'agent-probe'`)      | Handed that environment, could an **agent** work out how to operate the service: what to call, which credential opens it, what it can actually get done? | the same, plus `probing` between `provisioning` and `tearing_down`               |

The dry run exists because the expensive failure is not a red deploy. It is a **green** one: the
environment stands up, the tester reaches it, and the agent then spends its whole step
reverse-engineering an auth flow, guessing at a base path, or reporting a service as broken
because nobody told it which credential to send. That is a full pipeline run to discover a
missing sentence of configuration. The dry run buys the same finding for one container.

- Wire shapes and the report vocabulary: [`contracts/src/environment-test.ts`](../packages/contracts/src/environment-test.ts) and [`environment-probe.ts`](../packages/contracts/src/environment-probe.ts).
- The state machine: [`EnvironmentTestService`](../packages/orchestration/src/modules/environments/EnvironmentTestService.ts); the probe stage: [`environmentProbeStage.ts`](../packages/orchestration/src/modules/environments/environmentProbeStage.ts).
- The dispatch: [`ContainerEnvironmentProbeAgent`](../packages/server/src/agents/ContainerEnvironmentProbeAgent.ts); the prompts: [`prompts/environment-probe.ts`](../packages/agents/src/agents/prompts/environment-probe.ts).
- What a service's provisioning config even is: [`per-service-provisioning.md`](./per-service-provisioning.md).

## One state machine, two modes

Both modes are the same run row (`environment_test_runs`), driven by the same durable driver (the
Worker's `EnvironmentTestWorkflow` / Node's pg-boss `env-test.advance` queue) and swept by the
same stale-run cron. That is deliberate rather than incidental: the hard parts of this flow are
the **always-cleans-up** contract, the **stop ⇄ driver race guard** and the sweeper, and a second
implementation of them is a second set of ways to strand a live environment on somebody's cloud
bill. The extra mode costs one stage, one claim column and one report column.

`fail()` remains the single funnel every failure path runs through, and it now reclaims four
things rather than three: the in-flight deploy job, the environment, its synthetic registry row,
the throwaway branch, and the prober's container.

## The run's `status` is the LIFECYCLE; the report's `verdict` is the FINDING

A dry run that reports `inoperable` **succeeded**. The diagnostic ran, produced the finding
somebody has to act on, and left nothing behind.

Folding the verdict into `status` was the obvious first design and is wrong twice over:

- the one _interesting_ outcome (a completed dry run with bad news) becomes indistinguishable
  from a _broken_ one (an evicted container, a reply with no JSON), and those need opposite
  reactions: fix your service versus retry the diagnostic;
- a real teardown failure has nothing left to say, because `failed` is already spoken for.

So the SPA renders three states: a lifecycle failure in rose, a completed run whose verdict is
`operable` in emerald, and a completed run with findings in amber.

## What the agent is handed, and what each absence means

Everything the prober needs is resolved **at the moment of the probe**, not pinned when the run
started: the environment's URL, its access credentials and its proved route are all written by
the provisioning stage that just finished, so a value pinned earlier would be the value from
before there was an environment.

|                                | Source                                                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The service under test         | the frame's own title + description                                                                                                                                                                |
| The environment                | `getHandleWithAccess`: URL, status, the provider's access handle, the route the platform proved                                                                                                    |
| The service's test credentials | the sealed per-frame store, resolved **once** in the facade: the values become the container's environment variables, the key + description pairs of that same list are what the prompt advertises |
| The repository                 | a read-only checkout of the **throwaway branch**: the tree this environment was actually built from, not `main`                                                                                    |

**Every absence is STATED rather than omitted**, and that is load-bearing here in a way it is not
in an ordinary prompt. The report's most valuable field is `missingContext`, the list of things
the platform failed to supply. A prober that cannot tell "no credentials are configured for this
service" from "credentials exist and I was not shown them" fills that list with its own ignorance
instead of the platform's gap, which is the whole product of the run, reported backwards.

The credentials section is a three-state brief for that reason, not a list that can be empty:

- **resolved** (possibly with nothing in it): the store was read, and this service genuinely has no
  test credentials on the board. A board fact, with a board fix.
- **unreadable**: credentials may well be configured and the platform could not open its own sealed
  store (a bad `ENCRYPTION_KEY`, a store that would not answer). The run still goes ahead, because a
  report naming what was missing beats a refused stage, but the prompt says the PLATFORM failed.
  Collapsed into "none configured", this sends an operator to re-enter secrets that are already
  there.
- **unwired**: this deployment has no sealed credential store at all, so no service on the board can
  be given test credentials. A deployment fact, again not something to fix on the frame.

### The prober is told what the TESTER will be told

A dry run makes exactly one claim: an agent handed this environment could operate the service, so
the tester step that gets here later will not be the one to discover otherwise. That claim rests
entirely on the two being handed the same facts, so they are handed them by the same code:

- **The credential brief** above is `TestCredentialBrief` in contracts, rendered into both prompts
  by `testCredentialLines` (`prompts/environment-under-test.ts`). It reached the tester as an
  absent section before this, i.e. as "none configured", so a store outage sent someone to re-enter
  secrets that were already there.
- **The environment's access scheme** goes through `environmentAccessLines`, which STATES a
  provider that declared the environment open and a provider that named a scheme and supplied
  nothing usable for it. Both used to render as silence on the tester's side, and silence there
  reads as a broken service.
- **Where to look for how to operate the service** is one `SERVICE_DISCOVERY_GUIDANCE` list (the
  OpenAPI/GraphQL schema, route definitions, auth middleware, seed fixtures naming test users, the
  repo's own `curl` examples). A prober that discovers a service through its schema while the tester
  is only told to read the README are not exercising the same surface, so the dry run's verdict
  would not transfer.
- **The values** are resolved by one `resolveTestCredentials` (server), which both the step
  dispatcher and the prober call. Its best-effort read is why a sealed store that will not open now
  costs the credentials rather than the step.
- **What a success has to look like** is `FALSE_SUCCESS_SHAPES` (`prompts/shared.ts`), in all four
  prompts. Each role had a half of this: the prober named the HTTP shapes of a pass nobody
  observed, the tester had the principle and none of the shapes, in the role where a false pass is
  what lets a change merge. The fragment carries the suite shapes too (a command that printed
  failures and exited 0, a suite that ran zero tests), which is what a tester needs and a prober
  rarely meets.

Two rules deliberately did NOT move, and they are the line between sharing a rule and merging two
roles. **Grading**: a prober reports per-operation outcomes and leaves the conclusion to
`summarizeEnvironmentProbe`, while a tester's whole product is a greenlight. **Writing**: the
prober's "never change the service, the repository or the environment" is a security property, held
up by a dispatch that carries no `pr`, `pushBranch` or `newBranch`, where a tester legitimately
authors tests on the branch in library mode. A single fragment over both would have to weaken the
first or contradict the second.

What is deliberately NOT shared is the ROLE. A tester judges a CHANGE and rules on whether it is
safe to release; a prober judges the SETUP and reports what the platform failed to supply. Each
passes its own `CredentialGapGuidance` so the shared sections name a gap in the report shape that
role actually emits (`missingContext` for a prober, a failed outcome for a tester).

## The verdict is computed, never read off the reply

The model judges each operation it attempted; the platform derives everything else
(`summarizeEnvironmentProbe`). The deciding rule:

> `operable` requires every operation the agent LISTED to have been attempted, every one of them
> to have worked, **and at least one of them to have gone through authentication.**

A healthcheck answering `200` proves an ingress exists and says nothing about whether an agent can
work in this environment, so it can never earn a clean verdict on its own. Both prompts are told
so explicitly, and `operations[].authenticated` is the field the rule turns on.

`not_attempted` counts towards neither `attempted` nor `succeeded`: an operation the agent
declared it could not even try is a **finding** carrying the reason why, not a failed call.
Counting it as attempted would make "the agent could not work out what to call" read as
"everything was tried and the service refused it".

It does keep the run off `operable`, though, which is why the counts and the verdict are computed
together. One authenticated success beside four operations the agent could not work out how to try
is the exact shape this diagnostic exists to surface, and grading it on the attempted ones alone
renders "an agent can operate this service" in green directly above the list of what it could not
do.

The two ways a reported operation fails to reach the report are counted **apart**, for the same
reason: `operationsOmitted` is what the cap dropped (the agent reported more than is shown) and
`operationsUnreadable` is what carried no usable name (the reply was malformed). One number for
both tells a reader the list was truncated when nothing was.

## The failure taxonomy is shaped by WHOSE PROBLEM it is

`EnvironmentProbeFailure` is a closed, persisted vocabulary, and its members are grouped by who
has to act:

- **the platform did not say enough**: `auth_missing`, `access_unclear`, `endpoint_unknown`.
  These are the findings the feature exists for: nothing is broken, the run would simply have been
  spent guessing.
- **the service refused a well-formed attempt**: `auth_rejected`, `bad_request`. A credential
  that is present and rejected is a different fix from one that was never supplied, which is why
  they are not one member.
- **the environment is at fault**: `unreachable`, `timeout`, `server_error`. The dry run has then
  found something the provisioning test's `ready` verdict did not.
- **the attempt says nothing**: `tooling_missing`. Its own member because, collapsed into
  `other`, a container with no browser reads as a service that failed.

The SPA maps each member to translated copy through a `te`-guarded exhaustive `Record`, so a
report stored before a member was renamed renders the raw value rather than an empty line.

## Traps

- **The claim is written BEFORE the dispatch and the MARK after it.** `probeSurface` is the
  claim, taken through the same running-guard every other write uses; the durable driver replays,
  so a marker written _after_ the container was dispatched would let a crash between the two put a
  second agent on the same environment. `probeDispatchedAt` is the other half, and it is what makes
  the window between them describable: a replay landing there finds a claim with no job behind it,
  and a poll of a job nobody started comes back from the backend as an **eviction**, reporting a
  lost isolate to the developer as a container failure. Seeing the mark null, the poll re-dispatches
  instead (a dispatch is idempotent per job id). The mark's own guard does double duty: rejected, it
  means a stop landed while the dispatch was in flight, so the stop's reclaim ran against a
  container that did not exist yet and `fail()` has to collect the one now starting.
- **The claim carries the SURFACE because the surface addresses a container.** A browser prober
  runs on the heavier `ui` image, so every later poll and reclaim has to name the container that
  actually started. Re-deriving it from the frame would address the wrong one for a frame that was
  retyped, or none at all for a frame that was deleted, exactly when a leaked browser container
  costs the most.
- **A dispatch DECLARES its environment through `RunnerDispatchOptions.environments`.** That is
  what feeds the container's hosts entry, and a transport is documented never to reach into the
  job body for it. Omitted, the local backend bridges nothing and every operation the prober tries
  reports `unreachable`: a report that blames the service for the platform's own gap.
- **A probe that BROKE throws; a probe that REPORTED advances.** An evicted container or a reply
  carrying no JSON is a diagnostic that never happened, and returning it as a verdict would tell
  an operator their service is inoperable when it is the platform's step that failed. A completed
  probe always advances to teardown, whatever it found. The throw NAMES the failure class ahead of
  the container's own message, because the run record has one error field and "the dry run failed"
  cannot tell a vanished container (worth retrying) from a model that errored (not).
- **A reply that is not a plain object is a BROKEN probe, not an empty report.** A top-level array
  or a bare string coerces to zero operations, which the platform grades `inoperable` and the SPA
  renders as a finding about the service. The dispatcher asks the same predicate the coercion
  applies (`isEnvironmentProbeReportPayload`) before the shape is flattened.
- **The report is SCRUBBED at compose time.** It is model-authored text on its way to a persisted
  row and a rendered panel, and the prompt hands the agent the environment's own credential
  verbatim plus every sealed test secret in its shell. Asking the model not to echo them is
  guidance; `redactSecrets`, applied before any cap can split a token, is the boundary.
- **`probing` is the only stage measured in minutes**, so it is the only one that has to push
  progress. The prober's todo counts land on `probeProgress` whenever they MOVE; with nothing
  written, the run row never changes, no `envTestChanged` event fires for the whole container run,
  and the card sits on "probing with an agent" in a way indistinguishable from a wedge. The counts
  are cleared with the write that lands the report, since a stale "3 of 5" beside a finished probe
  reads as one still working.
- **One self-test at a time per frame** (409 `env_test_already_running`). Each run provisions its
  own environment under a synthetic per-run key nothing supersedes, so two in flight is two live
  environments for one service: billed twice, and racing each other to create on any provider whose
  namespace is derived per service rather than per branch. The SPA disables both buttons while
  either run is live; the refusal is what holds across two tabs and two people.
- **`agent-probe` is refused up front on a deployment that cannot drive one** (409
  `env_test_probe_unavailable`). Admitted, such a run would create a branch, stand an environment
  up and then park at a stage nothing can advance until the sweeper tore it all down with a
  timeout, for a wiring gap that was knowable before the first side effect. A wired prober is not
  the same question as a runnable one: each surface runs on its OWN executor image, so admission
  also asks the resolved runner backend whether it can serve THIS frame's image
  (`RunnerTransport.supportsImage`, absent ⇒ unknown ⇒ admitted, which is the honest answer for a
  self-hosted pool that resolves images on its own side).
- **A dry run answers to the workspace spend budget** (409 `env_test_over_budget`). It is a
  billable model call that no run start gates, exactly like the bug hunt's ranking, and the probe
  fails CLOSED: a ledger nobody can read is not a licence to spend against it. The provisioning
  self-test costs nothing and is never blocked by it.
- **The prober must never be able to write.** The job is `mode: 'explore'` with no `pr`, no
  `pushBranch`, no `newBranch` and no bootstrap block; the prompts say so too. A diagnostic with
  push access to the repository it is reading is a different feature.

## Wiring

`environmentProbeAgent` is an optional `CoreDependencies` entry, so a deployment without it keeps
the provisioning self-test byte-for-byte and refuses the other mode. Each facade builds it beside
its env-config repairer (`selectEnvironmentProbeAgent` on the Worker,
`selectNodeEnvironmentProbeAgent` for the Node family, which local inherits), gated on the same
prerequisites: a container transport, a connected source-control App, the proxy's public URL and
its signing secret.

### Which model the prober runs

The same precedence a pipeline step gets, resolved **per dispatch**: the frame's own `modelId` pin,
else the workspace's **model preset** entry for the prober's kind, else the deployment's env
routing. `buildSingleKindModelResolver` is that resolution, over the shared `ModelRouter`, so a dry
run and a coder step on the same frame cannot disagree about which model the workspace chose.

**One kind per surface** (`environment-prober-api`, `environment-prober-ui`), which is what makes
the two routable apart: the browser prober reads screenshots and drives a page where the HTTP one
reads a schema and calls it, so a workspace that pointed one at a vision-capable model and the
other at a cheap text one gets that split. A preset naming neither kind answers with its base
model, which is the blanket statement it is.

Per dispatch rather than at wiring, because the answer is a per-workspace fact and wiring has none
in hand. Read at wiring it is a per-deployment guess: a workspace running everything on its Claude
preset had its dry run dispatched at the Node family's Qwen default, which the LLM proxy then
refused for having no key configured (`502 unavailable`), after the run had already created a
branch and stood a real environment up. The proxyable check moved with it, and is now asked of the
**resolved** model at dispatch instead of disabling the capability for the whole deployment on the
strength of a routing entry no workspace had chosen.

### Which credential opens it

Whatever the resolved model's harness needs, through the same `ContainerJobAuthResolver` the step
executor uses: a short-lived, model-locked proxy session token for a Pi model, a pooled
subscription credential for Claude Code / Codex, the run-initiator's OWN personal credential for an
individual-usage vendor (Claude), or `ambientAuth` in native local mode, where the harness drives
the developer's installed CLI and nothing is leased.

A personal credential is only leasable with its owner's unlock password, so the **start route gates
on it** exactly as a run start does (`personalGateForAgentKind`, 428 `credential_required`), for the
kind `EnvironmentTestService.probeAgentKind` says the dispatch will resolve its model under. The
activation is minted against the **run id**, which is the id the prober's dispatch leases against;
its 12h TTL comfortably outlives a provision. Two things go wrong if this is skipped: the person is
never asked for the unlock they were willing to give, and the dispatch reaches the lease with
nothing activated, having spent a branch, a provision and (on the way back out) a teardown. The SPA rides
its cached password through `withCredential`, so the modal opens on the 428 and the start is retried
transparently; a cancelled prompt resolves to no run rather than a spinner waiting for one.

`provision` mode spends no model call and so is never gated, which is also what keeps the
historical body-less start working.
