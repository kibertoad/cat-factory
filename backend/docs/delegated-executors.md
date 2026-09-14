# Delegated executors: running a pipeline step on a system you already have

A deployment plugs its own lower-level coding executor (a GitHub-Actions implement/review/test
loop, an internal job runner, a vendor's autonomous PR bot) in as **the executor of one pipeline
step**. cat-factory stays the top-level orchestrator (what to work on, in which repo, with which
standards, gated by which policy, followed by which merge and which notification) and the
registered executor supplies only the middle.

Everything after the step settles is the engine that was already there: `recordOpenedPullRequests`
lands the pull request on the block, the auto-inserted `ci` gate polls real checks, `merger` applies
the workspace's risk policy and merges for real, `RunLifecycleSink` and `NotificationChannel`
announce, and the tracker writeback comments on the issue. That is the whole value of choosing a
step-level seam.

Design record: [`docs/initiatives/delegated-executors.md`](../../docs/initiatives/delegated-executors.md).

## Registering one

Three declarations, all through public seams:

```ts
const executors = defaultDelegatedExecutorRegistry()
executors.register({
  id: 'acme:executor', // NAMESPACED; see "ids" below
  presentation: { label: 'Acme CI', icon: 'i-lucide-bot', description: 'Our implement loop' },
  credentials: [{ key: 'ACME_TOKEN' }], // key NAMES; the values never touch a prompt
  poll: { intervalMs: 60_000, maxDurationMs: 3 * 60 * 60_000 },
  telemetry: 'not-reported',
  create: (deps) => myExecutor(deps),
})

agentKinds.register({
  kind: 'acme:implementer',
  systemPrompt: 'You implement the requested change end to end.',
  traits: ['code-aware'],
  agent: { surface: 'delegated', executor: 'acme:executor' },
  presentation: {
    label: 'Acme implementer',
    icon: 'i-lucide-bot',
    color: '#6366f1',
    description: '…',
    category: 'build',
  },
})

pipelines.register(
  definePipeline({
    id: 'pl_acme_build',
    name: 'Acme build',
    purpose: 'build',
    steps: [{ kind: 'acme:implementer' }, { kind: 'merger' }],
  }),
)
```

Both registries ride their own option on `start()` / `startLocal()` / `createWorker`, by reference,
like every other app-owned registry. A runnable version of the whole thing, with a fake executor and
no external system, is
[`backend/internal/example-delegated-executor`](../internal/example-delegated-executor); a
GitHub-Actions implementation of the `create` hook ships as
[`@cat-factory/delegation-github-actions`](../packages/delegation-github-actions/AGENTS.md).

**Ids are namespaced and refused otherwise.** An unnamespaced `executor` is how two deployments'
shared composition modules collide, and the loser's kinds then dispatch to the winner's external
system: a wrong run in the wrong company's CI, with nothing anywhere reporting a conflict.

## What the executor is handed

The **brief**: `{ correlationKey, workspaceId, runId, stepIndex, agentKind, task, repo, branches,
systemPrompt, userPrompt, contextFiles, ownService }`.

It is the production prompt. `composeRoleSystemPrompt` composes the system half and the harness job
body consumes the SAME function, so the workspace's prompt override, its agreed best-practice
standards and the service the work belongs to reach an external executor and a container harness
identically. `delegationBrief.spec.ts` builds both from one context and compares them; a drift there
would deliver a team's standards to one executor and not the other, silently.

The brief carries **no credentials**. Those arrive as the second argument to `start` / `poll`,
resolved through the `ToolSecretResolver` port under a `delegated-executor` subject: **once per
dispatch and once per poll**, never cached on the handle. A delegated poll runs hours after the
dispatch and a GitHub App token lives one, so a credential frozen at dispatch is dead exactly on the
long runs this executor class exists for.

## The traps

**A replayed `start()` starts a second external run.** This is the deadliest one, and both halves
have to hold. The ENGINE commits a delegation CLAIM (`status: 'starting'`, the correlation key as
the step's job id) _before_ calling `start`, so a replayed dispatch re-attaches instead of
dispatching. The EXECUTOR owes the other half: `start` must be idempotent per
`brief.correlationKey`. Two workflows working one branch means two pull requests for one task.

**Anything the poll needs is on the step.** A delegated poll rebuilds its handle from the persisted
step alone, in another process, after a durable replay. The executor id, the external id, the branch
pair, the TARGET REPO and the poll cadence are all persisted for exactly that reason: a fact the
poll cannot derive and nobody recorded is absent in production with no error. The repo is the least
obvious of them and the one with the sharpest failure: an executor's own configured repository is
routinely not the one the work targets (a central automation repo dispatching against many product
repos is ordinary), so a reader that assumed they were the same found nothing on every run and
reported every one as having produced no pull request.

**`step.delegated` existing is not the same as the delegated job being in flight.** The record
OUTLIVES the work it describes, deliberately: its attempt log is the evidence for why a step is
being re-run, and `resetStepForRerun` clears the job id and keeps the record. A step that delegated
its own work can still run a CONTAINER job afterwards (a helper round, a re-run under an overriding
kind), so every read asks `inFlightDelegation(step)`, which keys on
`step.jobId === record.correlationKey`. A bare truthiness test hands the container job's id to the
external executor, folds its phase onto work that finished hours ago, and overwrites its outcome on
settle.

**The cadence is the executor's, not the platform's.** An Actions run of an hour is ordinary where a
harness job of an hour is a stall, so `poll.intervalMs` / `poll.maxDurationMs` ride the definition,
are copied onto the claim, and travel to both durable drivers on the `awaiting_job` park.

**"Absent" and "zero" never render the same.** A delegated step bypasses the LLM proxy, the harness
call recorder and the tool-trajectory drain, so its tokens are in no total. `telemetry:
'not-reported'` puts "usage not reported by <executor>" on the step, and the run rollups carry
`reporting.delegatedStepsWithoutUsage` so a run total is never read as the whole cost. An executor
that fills `DelegationResult.usage` is metered as `subscription`: recorded, excluded from the
budget gate, because the tokens were spent on its account rather than this deployment's.

**A cancel that could not happen is SAID.** An executor declaring no `cancel` leaves its run alive:
it will finish, open its pull request and bill its tokens long after the platform recorded this run
as stopped. The reclaim reports what it ACHIEVED, and the record says so rather than rendering a
clean teardown. The composite asks BOTH its arms: they are independent resources, so a container
reclaim that throws must not cost the external cancel, which would record every live delegation as
work the platform could not stop while the executor that could stop it was never asked.

**A delegated failure is not a harness one.** A verdict the external system called final is
terminal (a second dispatch reaches the same answer and spends the budget getting there), which is
the disposition the container path's `harnessShutdown` carries. It travels on its own channel,
`update.delegated.terminal`, and maps to `failureKind: 'delegated_failed'`. Borrowing the container
flag rendered "Harness shut down" for a step that never had a harness and filed external CI
verdicts under container eviction in every rollup.

**A successful poll is the sign of life.** Many executors report no activity timestamp, and a quiet
external run answers identically on every tick, so nothing changes and nothing persists. The
delegated arm floors `lastActivityAt` at the poll's own clock; without it the step's
`lastActivityAt` and the run's `updated_at` freeze at the first poll and the stale-run sweeper
re-collects a run that is perfectly alive.

**A delegated kind needs a CHECKOUT, just not one of ours.** `SURFACE_TRAITS.delegated.container` is
false because the platform runs no container for it; `dispatchDeliversCheckout` is TRUE, because the
executor is handed a repository and a work branch and checks them out itself, which is what
`composeDelegationBrief` tells the agent. Reading the second off the first had a kind's preOps
prepare checkout-less context for an agent whose own prompt named the branch it was working on. Its
deliverable is a pushed branch rather than a reply (`deliverableIsReply` is false) and it takes no
container directives; those answers live in one total `Record<AgentSurface, …>` (`SURFACE_TRAITS`),
so a new surface fails the build there with every question in front of whoever adds it.

## What a mothership node does

A mothership-mode node resolves its agent kinds from the mothership and boot-validates none of
them, so "this build registers no such executor" is not the same fact as "this run has no delegated
step". The dispatch therefore **refuses by name** (`delegated_executor_unwired`, naming what IS
registered) rather than falling through to the container executor, which would run a step the
deployment declared as external inside the platform's own harness, against the repository, looking
successful.

## Open

- **Push-wake.** `POST /v1/delegations/:key/complete` would let an executor shorten the wait. It is
  not implemented, and the reason is worth recording: both durable drivers _sleep_ between polls
  (`step.sleep` on Workflows, a timer on Node), and neither sleep is interruptible by an event. An
  accelerator needs the `awaiting_job` loop to become an event-wait with a timeout on both drivers,
  which is a change to the park machinery rather than a route.
- **Per-call telemetry ingest.** `DelegationResult.usage` covers spend today. Individual prompts and
  tool trajectories would need an authenticated ingest route, and there is no executor to call one.
