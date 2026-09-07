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

## The verdict is computed, never read off the reply

The model judges each operation it attempted; the platform derives everything else
(`summarizeEnvironmentProbe`). The deciding rule:

> `operable` requires every attempted operation to have worked **AND at least one of them to have
> gone through authentication.**

A healthcheck answering `200` proves an ingress exists and says nothing about whether an agent can
work in this environment, so it can never earn a clean verdict on its own. Both prompts are told
so explicitly, and `operations[].authenticated` is the field the rule turns on.

`not_attempted` counts towards neither `attempted` nor `succeeded`: an operation the agent
declared it could not even try is a **finding** carrying the reason why, not a failed call.
Counting it as attempted would make "the agent could not work out what to call" read as
"everything was tried and the service refused it".

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

- **The claim is written BEFORE the dispatch, never after.** `probeSurface` is the claim, taken
  through the same running-guard every other write uses. The durable driver replays, so a marker
  written _after_ the container was dispatched would let a crash between the two put a second agent
  on the same environment.
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
  probe always advances to teardown, whatever it found.
- **`agent-probe` is refused up front on a deployment that cannot drive one** (409
  `env_test_probe_unavailable`). Admitted, such a run would create a branch, stand an environment
  up and then park at a stage nothing can advance until the sweeper tore it all down with a
  timeout, for a wiring gap that was knowable before the first side effect.
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

The model follows the **tester's** routing rather than the coder's: a dry run reads a service and
exercises it without changing anything, so a deployment that routed its testers to a cheap model
gets a cheap dry run with no second setting, and it must be proxyable, since the prober runs on
the Pi harness over the LLM proxy. A non-proxyable routing model leaves the capability unwired
with a `warn` at boot rather than failing every dispatch.
