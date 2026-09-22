# Delegated executors: embedding lower-level orchestration under cat-factory

**Status:** the seam is landed and driven end to end; one slice open · **Owner:** core · **Started:** 2026-09-13

> This is the durable source of truth for a multi-PR initiative. Read it FIRST before picking up
> the next slice; update the checklist at the end of each PR.

> **Provenance of PR 6.** The first consumer to build against the seam (a `DelegatedExecutor`
> running a [Ratchet](https://github.com/lokalise/ratchet) pipeline on GitHub Actions, measured
> against `kernel@0.348.1` / `agents@0.166.3` / `local-server@0.151.5` / `node-server@0.231.5` and
> cat-factory `main` at `bc073ab6`) reported three gaps in the seam and six in Ratchet. The three
> here were re-verified against HEAD and against the published surface: all three confirmed, none
> stale, and the seam's whole timing is that **nothing had been published yet**, so each landed as
> the shape it should have had rather than beside a compatibility shim. Two of the three asks were
> granted with a DIFFERENT remedy than the one requested; see §PR 6 below for what and why. The
> report's other six findings are against `lokalise/ratchet` and are not ours.

## Goal & rationale

cat-factory today owns the whole vertical: intake (tracker webhooks, bug hunt, the assistant),
context (service estate, foundational services, best-practice fragments, skills), the pipeline
engine, and the execution of every agent step in its own container harness. Companies already run
their own lower-level coding executors: a GitHub-Actions-driven implement/review/test loop, an
internal job runner, a vendor's autonomous PR bot. Those systems are good at running one bounded
change and bad at everything above it: they know nothing about the service catalog, the standards
a team has agreed on, which Jira ticket the work came from, or who has to be told when it lands.

The goal is to let a deployment plug such a system in as **the executor of a pipeline step**, so
that cat-factory stays the highest-level orchestrator (what to work on, in which repo, with which
context, gated by which policy, followed by which merge and notification path) while the
lower-level system does the implementing. The pilot is an internal GitHub-Actions-managed executor
(referred to below as "the pilot executor"); nothing in this design names it, and the shipped
seam has to be sufficient for any executor that can be started, observed as
running/failed/completed, and linked to.

Visibility expectations are deliberately modest: the platform shows that the step is running,
failed or completed, and links to where the executor's own logs live. Token usage, LLM call
telemetry and tool trajectories are out of reach for a system that does not report them, and the
design does not pretend otherwise: every telemetry hook is exposed so the executor can start
filing data the day it has some, and until then each surface STATES that the data is not
reported rather than rendering a zero.

## Why not the two seams that already exist

Two existing seams look close and were considered as the primary vehicle. Both were rejected as
the primary vehicle, and each lends one pattern to the design.

- **A `manifest` runner backend** (`RunnerTransport`, `runnerPoolManifestSchema` with its
  dot-path response mapping). A runner backend answers "run the cat-factory harness somewhere
  else": it dispatches a harness JOB BODY, expects a `RunnerJobView` back, and owns an image
  variant. An external executor runs its own workflow with its own prompts; forcing it through
  this seam means fabricating a harness-shaped result and lying about an image. The one thing
  worth borrowing is the credential pattern (a sealed per-pool secret bundle resolved at
  dispatch), and the design copies it rather than the transport.
- **A polling gate** (`GateDefinition.probe()`). A gate polls an external system on a bounded
  attempt budget, records a structured verdict with external URLs, and can settle without a fix
  (`resolveHelperCompletion`). But a gate has no PRODUCT: it cannot record a step output, a pull
  request or usage, and its escalation is a container helper. An executor's whole point is the
  product. What the design borrows is the shape of the running-state record: a bounded attempt
  log with an external URL per attempt.

The correct seam is a THIRD EXECUTOR CLASS beside inline and container, chosen per agent kind and
registered by reference like every other deployment extension.

## Vocabulary

- **Delegated executor**: a code-registered implementation of the new kernel port
  `DelegatedExecutor`, owned by the deployment, that knows how to start, observe and cancel one
  unit of work in an external system.
- **Delegated kind**: an agent kind whose `agent.surface` is `'delegated'` and which names the
  executor it runs on. Registered on `AgentKindRegistry` exactly like a container kind.
- **Brief**: the neutral `{ systemPrompt, userPrompt, contextFiles, repo, branches, task,
correlationKey }` bundle the engine hands the executor at dispatch. It is what the container
  path already composes, extracted so it exists as a value outside a harness job body.
- **Delegation record**: `step.delegated`, the persisted per-step state (executor id, external
  id, external URL, status, attempt log). The delegated sibling of `step.container`.

## Target pattern

```
pipeline step (agentKind: 'acme:feature-executor')
  |
  v
RunDispatcher -> AgentContextBuilder -> composeBrief()             (engine, pure)
  |
  v
CompositeAgentExecutor.pick()  ->  DelegatedAgentExecutor          (server, one class)
                                     |  resolves credentials by NAME (ToolSecretResolver)
                                     |  runs registered preOps over RepoFiles (optional)
                                     v
                             DelegatedExecutorRegistry.get('acme:executor')
                                     |
                                     v
                             DelegatedExecutor.start(brief, credentials) -> { externalId, url }
                                     |
   awaiting_job poll loop  <---------+  poll(handle) -> running | done(result) | failed
   (unchanged driver, per-executor cadence)
  |
  v
recordStepResult()  -> block.pullRequest, ci gate, merger, notifications   (unchanged)
```

Everything downstream of the settle is the existing engine: `recordOpenedPullRequests` lands the
PR on the block, the auto-inserted `ci` gate polls real checks, `merger` applies the risk policy,
`RunLifecycleSink` and `NotificationChannel` announce, the tracker writeback comments on the
issue. That is the whole value of choosing a step-level seam: the company gets Jira intake, Slack
notifications, the merge policy and the track record for free, with the executor supplying only
the middle.

## Decisions

### D1. A fourth `AgentSurface`, `'delegated'`, and a third arm in `CompositeAgentExecutor`

`AgentSurface` (`kernel/src/ports/agent-definition.ts`) gains `'delegated'`. `AgentStepSpec`
gains `executor: string` (required when the surface is `'delegated'`, refused otherwise at
registration). `CompositeAgentExecutor.pick()` gains a third arm keyed off the registry, and
`pollJob` routes by `handle.agentKind` through the same registry instead of hard-routing to the
container. Every function that switches on the surface today (`runsInContainer`,
`dispatchDeliversCheckout`, `deliverableIsReply`, `applySurfaceDirectives`) gets its fourth case,
and each is exhaustive so the build fails until it does:

- `runsInContainer`: false. The executor owns its own checkout.
- `dispatchDeliversCheckout`: false. A delegated kind is never panel-eligible (a consensus
  participant has no checkout, and here neither does the platform), and the consensus tier
  chooser must refuse it explicitly rather than skip it silently.
- `deliverableIsReply`: false. The deliverable is a pushed branch or PR, so
  `FINAL_ANSWER_IN_REPLY` is not appended; the executor's summary is recorded as `step.output`.
- `applySurfaceDirectives`: no read-only guardrail, no container-specific directives. The brief
  carries the role prompt and the trait guidance unchanged, so the standards a workspace agreed
  on reach the executor whether or not it chooses to use them.

Rejected: an `agentExecutor` option on `start()` that a deployment replaces wholesale (the
Cloudflare `overrides` route). That is a test seam. It would make the deployment re-implement the
inline and container routing to add one arm, and the drift guard in `registry-seams.spec.ts` would
never see it.

### D2. `DelegatedExecutorRegistry`: an app-owned registry, by reference, on both entry points

A new kernel-owned registry, `DelegatedExecutorRegistry`, holding `DelegatedExecutorDefinition`s:

```ts
interface DelegatedExecutorDefinition {
  id: string // namespaced, 'acme:executor'
  presentation: { label: string; icon: string; description: string }
  credentials?: CapabilityCredential[] // key NAMES, resolved per dispatch, values never in context
  poll: { intervalMs: number; maxDurationMs: number } // per executor, not the harness default
  telemetry: 'not-reported' | 'self-reported' // see D8
  create(deps: DelegatedExecutorDeps): DelegatedExecutor
}

interface DelegatedExecutor {
  start(brief: DelegationBrief, credentials: Record<string, string>): Promise<DelegationStart>
  poll(handle: DelegationHandle, credentials: Record<string, string>): Promise<DelegationUpdate>
  cancel?(handle: DelegationHandle, credentials: Record<string, string>): Promise<void>
}

type DelegationStart = { externalId: string; url?: string; note?: string }
type DelegationUpdate =
  | { state: 'running'; url?: string; phase?: string; lastActivityAt?: number }
  | { state: 'done'; result: DelegationResult }
  | { state: 'failed'; error: string; url?: string; detail?: string; retryable?: boolean }
type DelegationResult = {
  summary: string // becomes step.output
  pullRequest?: PullRequestRef
  branch?: string
  custom?: unknown // the generic channel, exactly as for a registered kind
  usage?: AgentTokenUsage // D8: only when the executor knows
}
```

It is routed exactly like `AgentKindRegistry`: an option on `NodeContainerOptions`, on
`StartOptions` and `startLocal()`, on `CreateAppOptions`, asserted at those entry points, exported
with a constructor, and classified in both `registry-seams.spec.ts` files as `'option'` plus
`'entry-point'`. `defaultDelegatedExecutorRegistry()` is EMPTY: the platform ships no executor,
and a kind naming an unregistered executor fails boot validation the same way a kind naming an
unknown skill does.

`DelegatedExecutorDeps` is small and bound: `logger`, `clock`, `fetchImpl`, `urlSafetyPolicy`
(the notification-webhook SSRF policy, reused, because an executor is an outbound HTTP surface
the deployment configured), and `repoFiles(ctx)` for the executors that want to commit context to
the branch themselves.

### D3. The brief is the production prompt, composed once by the engine

`buildKindBody` (`server/src/agents/jobBody.ts`) composes the system prompt, the user prompt and
the context files and then wraps them in a harness job body. The composition moves into a pure,
exported `composeBrief(context, registry): DelegationBrief` that the container body builder then
CONSUMES, so the two paths cannot drift (the sandbox's rule: every kind resolves its input through
the SAME pure builder its production caller uses).

```ts
interface DelegationBrief {
  correlationKey: string // the cat-factory job id; the executor MUST make it recoverable (D5)
  workspaceId: string
  runId: string
  stepIndex: number
  agentKind: string
  task: { id: string; title: string; description: string; trackerRef?: { provider; key; url } }
  repo: { owner: string; name: string; cloneUrl: string; provider: VcsProvider; directory?: string }
  branches: { base: string; work: string }
  systemPrompt: string // role + standards + trait guidance, overrides applied
  userPrompt: string
  contextFiles: InjectedContextFile[] // .cat-context/*, the foundational catalog, linked docs
  ownService: OwnServiceDescription // the discriminated result, never omitted
}
```

Two delivery channels for context, both existing:

1. **Inline in the brief.** The executor maps `userPrompt` and `contextFiles` into whatever its
   own input is (the pilot takes literal spec text up to 1 MiB and an `AGENTS.md`-shaped repo
   layer). A brief that does not fit is REFUSED at dispatch with the same
   `assertContextReferencesFit` disposition the container path uses, never truncated.
2. **Committed to the work branch by preOps.** A delegated kind may declare `preOps` exactly as
   a container kind does; they run over `RepoFiles` before `start()`, so a deployment can land
   `.cat-context/` or an executor-specific layer file on the branch the executor will check out.
   `standardsDelivery: 'context-files'` works unchanged.

The brief carries NO credentials. Executor credentials arrive through the second argument of
`start()`/`poll()`, resolved per dispatch (D4). The brief is what the agent-context snapshot
records (`buildAgentContextRecord`), so what the executor was told is auditable through
`/api/v1/debug/runs/:runId/agent-context` under the existing double gate.

### D4. Credentials: declared by NAME, resolved through `ToolSecretResolver` with a new subject

`ToolSecretSubject` gains `{ kind: 'delegated-executor'; id }`. The definition's `credentials`
are key names; the values are resolved once per dispatch and once per poll (a poll may run hours
after dispatch, and a GitHub App token lives one hour), handed to the executor call and never
persisted on the step, the handle or the snapshot. The env fallback and the per-workspace
capability-credential store apply unchanged, so a multi-tenant deployment turns the fallback off
and each workspace holds its own executor token.

The lookup key is a boundary and `isReservedPlatformEnvKey` refuses a platform variable as a
credential name, as for every other capability credential (ADR 0041).

### D5. Correlation is the executor's problem, and the brief makes it solvable

Many external systems return no id at start (`workflow_dispatch` returns 204 and no run id). The
platform does not paper over this: `start()` must return an `externalId`, and it is the
executor's job to recover one, but the brief gives it the one stable handle it needs,
`correlationKey`, the cat-factory job id. The documented pattern for a GitHub Actions executor:
pass the key as a workflow input, have the caller workflow set `run-name` to include it, and list
runs filtered by event and creation time until the one whose name carries the key appears. A
shipped helper (D10) implements this once.

`start()` MUST be idempotent per correlation key: the durable drivers replay, and an executor that
starts a second workflow on a replayed dispatch produces two PRs. The existing rule (an external
side effect behind an atomic claim taken before the effect) applies: `DelegatedAgentExecutor`
writes `step.delegated = { status: 'starting', correlationKey }` and commits it before calling
`start()`, and a replay that finds it asks the executor to `poll` by correlation instead.

### D6. The delegation record is its own step field, never `step.container`

`recordDispatchedJob` stamps `step.container = { status: 'up' }` unconditionally today, so a
delegated step would render as a container. Instead `pipelineStepSchema` gains

```ts
delegated?: {
  executor: string
  status: 'starting' | 'running' | 'done' | 'failed' | 'cancelled'
  externalId?: string
  url?: string
  phase?: string
  attempts: { startedAt: number; externalId?: string; url?: string; outcome?: string }[]
  note?: string
}
```

and `recordDispatchAttribution` persists `executor`/`externalId`/`url` from the handle, because
the poll site rebuilds the handle from the STEP alone (`pollHandleFor`) and anything not on the
step is silently absent in production. `AgentJobHandle` gains `delegated?: { executor;
externalId; url? }` for the same reason.

The SPA gets `StepDelegatedStatus.vue` beside `StepContainerStatus.vue`: status pill, executor
label from the snapshot, the external link as the primary affordance (`target="_blank"`,
`rel="noopener noreferrer"`, copy button), and the attempt log. `customAgentKindSchema` gains an
additive `executor: 'inline' | 'container' | 'delegated'` beside the existing `container` boolean,
so the palette can label the kind; the boolean is left in place (the snapshot is internal wire, but
removing it buys nothing this slice). The pipeline builder shows the executor's presentation on the
kind card, so a person composing a pipeline sees which steps leave the platform.

### D11. Who creates the work branch is DECLARED, not assumed

`branches.work` is the deterministic per-task branch every step of a run's pipeline shares. For a
container step the harness's own clone brings it into existence; for a delegated step nothing did,
and the seam said nothing about it. Both readings were live at once: `dispatchDeliversCheckout`
answers TRUE for a delegated kind ("the executor is handed a repository and a work branch and
checks them out itself") while `composeBrief` explicitly declined to create the ref, so the brief
told the agent it was working on a branch that was not there.

Neither default is safe. A CI runner fails at `actions/checkout`, or worse, substitutes a branch
of its own and SUCCEEDS on a ref the platform never recorded, at which point the run reports having
produced nothing over a pull request nobody links to. And an unconditional create leaves an empty
ref behind for every run whose external work never landed.

So `DelegatedExecutorDefinition.workBranch` is a REQUIRED `'platform-creates' | 'executor-creates'`,
which is the `telemetry` pattern: the deployment knows something the platform cannot, and the
question is put in front of whoever writes the registration rather than discovered at checkout
hours into a run. `platform-creates` writes through the same checkout-free binding a pre/post-op
uses, so the engine owns the one VCS write rather than every deployment re-implementing it over a
second credential.

The refusal lives at the DISPATCH, not where the arm is built. The Worker builds its container per
request, so a throw at the build turns a delegated-only misconfiguration into a 500 on the board,
the API and the settings the operator would go and fix it on: a blast radius far wider than the
fault. The dispatch is also the altitude at which the two distinguishable causes separate (this
deployment has no VCS provider configured, versus this workspace has connected no repository), and
both carry the translated `delegated_work_branch_unprepared`.

Which branch is NOT the engine's own answer either: the task's apriori WORKING branch wins when it
declared one, through the same `resolveAprioriWorkingBranch` the container dispatch and the
repo-ops controller use. Delegating a step changes nothing about where the run builds, and the
first cut of this slice hard-coded `cat-factory/<blockId>` on the brief: on a task that named a
branch, the platform would have created a competing empty ref while the pull request, the `ci` gate
and the merger all rode the branch the user picked. An apriori branch is probed, never created
([ADR 0021](../../backend/docs/adr/0021-apriori-branches.md)), so a dispatch onto a missing
one is refused rather than forked off base.

The alternative considered and rejected was an `ensureWorkBranch()` callback on
`DelegatedExecutorDeps`. Same write in the same place, but an executor author still has to know to
call it, and the one who does not is exactly the one the declaration exists to catch.

### D12. The GitHub Actions helper resolves its workflow per dispatch

`GitHubActionsExecutorDescription` fixed `owner` / `repo` / `workflowFile` / `ref` at registration,
which cannot express the ordinary multi-repo shape: a caller shim committed to each onboarded
repository puts the workflow wherever the work is, so the dispatch target varies per brief while
the registration stays one. Everything else in the helper was already per-call, and the result
reader already took the work repo off `handle.repo`; the dispatch was the single part that could
not follow.

The requested remedy was to make the four fields `(brief) => string`. Rejected: `poll` and `cancel`
are handed a HANDLE, not a brief, so that signature type-checks at dispatch and then addresses a
different repository on every call after it, reporting a live run as one that never appeared. What
landed instead is one `workflow` field that is a location OR a function of a
`GitHubActionsWorkflowScope`, deliberately narrowed to the INTERSECTION of what a brief and a
handle carry, so the failure is unrepresentable rather than merely documented. A handle that names
no work repository is refused rather than defaulted, exactly as the result reader refuses a handle
with no branches.

### D7. Completion is poll-driven first; push-wake is an additive second slice

The `awaiting_job` park is a poll loop on both drivers and that is enough for the stated
visibility bar. `poll.intervalMs` / `poll.maxDurationMs` on the definition replace the harness
defaults for a delegated step, because an Actions run of an hour is normal where a harness job of
an hour is a stall; the driver derives `jobMaxPolls` from them rather than a constant.

The second slice adds push: `POST /v1/delegations/:correlationKey/complete`, authenticated by a
per-dispatch **delegation token** minted like the container session token
(`dispatchTokenMint.ts`, pinned to workspace + execution + job id, handed to the executor inside
`start()`'s credentials bag under a reserved name). It records the update and calls
`WorkRunner.signalResume` so the next poll fires now instead of at the interval. It is an
accelerator, never the source of truth: the poll still runs, so an executor that never calls it
still settles. The `/complete` body is the same `DelegationUpdate` shape, and the executor's
`poll()` is still asked to confirm before the step settles, so a forged or stale callback cannot
finish a step on its own.

### D8. Telemetry: every hook exposed, nothing guessed

A delegated step bypasses the LLM proxy, the harness call recorder and the tool-trajectory drain,
so by default it has no spend, no calls, no trajectory. The rule is "absent" and "zero" never
render the same:

- The definition declares `telemetry: 'not-reported' | 'self-reported'`. For `'not-reported'`
  the step's run-meta card shows "usage not reported by <executor>" and the run-level rollups
  carry a `reporting: { delegatedStepsWithoutUsage: n }` field, so a run total is never read as
  the whole cost. The outcome summary and the PR verification report render the executor's
  sections as `status: 'absent'` with a note naming the executor.
- For `'self-reported'`, three hooks, each an existing recorder reached through the delegation
  token rather than a new recording path:
  1. `DelegationResult.usage` on completion lands on the step through `recordJobFacts`, like a
     harness result's usage.
  2. `POST /v1/delegations/:correlationKey/telemetry` accepts the same
     `{ metrics, toolCalls, searchQueries, snapshots }` batch the mothership ingest accepts
     (`TelemetryIngestController`, the row caps and the envelope stamp reused), routed through
     `LlmObservabilityService` and the repositories' `recordMany` under the step's
     `(workspaceId, executionId, agentKind)` scope. Ids are minted `${correlationKey}-dc-${seq}`,
     first write wins, so a resend is a no-op.
  3. `DelegationUpdate.running.lastActivityAt` feeds the throttled `step.lastActivityAt` so a
     quiet executor is not swept as orphaned.
- `reportsOwnLlmCalls` stays a marker on a model object; the delegated path never constructs a
  model, so nothing stands down and nothing double-counts.

The pilot reports none of this today; the hooks are what let it start without a platform change.

### D9. Failure, cancel, reclaim, retry

- `failed` carries a DISPOSITION, `terminal` or `retryable`, and the engine branches both ways.
  `terminal` fails the run at once with the executor's own `error` and `detail`, URL preserved on
  the record. `retryable` buys one fresh dispatch, bounded by `MAX_DELEGATED_RETRIES` (the ENGINE's
  number, not the executor's asking: it decides how much of somebody else's runner a blip is
  worth), settling the failed attempt onto the record first so its log keeps it. Both classify as
  `delegated_failed`: retryability and classification are separate axes. A closed pair rather than
  an optional flag, because an unstated default is what made the retry half unimplemented and
  invisible.
- `cancelRun` calls `cancel?()` when defined and marks the record `cancelled` either way; an
  executor without `cancel` leaves the external run alive, and the record's `note` says so.
- `reclaimRun` (the stale-run sweeper) asks `poll()` by correlation before deciding a step is
  orphaned, because an Actions run outliving a platform restart is the normal case.
- A restart of the step (`resetStepForRerun`) appends a new `attempts[]` entry; prior entries and
  their URLs are kept, since the previous run's logs are the evidence for why it is being re-run.

### D10. What ships in the platform: one reference executor helper and one example

Nothing about the pilot. Two generic things do ship, because every GitHub-hosted company hits the
same three problems (correlation without a run id, App-token renewal, reading a result artifact):

- `@cat-factory/delegation-github-actions`: a helper that implements `DelegatedExecutor` given a
  `{ owner, repo, workflowFile, ref, inputs(brief), resultFrom }` description: dispatches,
  correlates by `run-name`, polls `status`/`conclusion`, exposes the run URL, and on completion
  runs `resultFrom` (default: find the PR whose head is `branches.work`; optional: download a
  named artifact and parse it). A company's executor becomes a twenty-line definition in its
  deployment repo.
- `backend/internal/example-delegated-executor`: a sibling of `example-custom-agent` with a fake
  executor, a delegated kind, a pipeline `[delegated step] -> ci -> merger`, and the boot
  validation wired, so the docs have a runnable reference and the conformance suite has a
  fixture.

## The pilot, mapped onto the seam (deployment-side, not in this repo)

For the reader checking the seam against the concrete case. The pilot executor is started by a
reusable GitHub Actions workflow taking `spec` (literal text), `pipeline`, `harness` and `ref`;
it reads an org context layer from a file in the target repo and a repo layer from `AGENTS.md`;
it publishes a PR whose body links back to the Actions run; it declares no outputs, returns no
run id, and reports no token usage.

| Seam                | Pilot mapping (owned by the company's deployment repo)                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Executor definition | `id: 'acme:executor'`, one dispatch-token credential, `poll: { 60s, 3h }`, `telemetry: 'not-reported'`                                                                                                                 |
| `start(brief)`      | the shipped GitHub Actions helper: a thin caller workflow in the target repo sets `run-name` from a `correlation` input and forwards `spec`, `pipeline`, `ref` to the reusable workflow                                |
| Context             | `inputs.spec = brief.userPrompt` plus the context files rendered as sections; a preOp commits `brief.systemPrompt` as the org layer file on the work branch so the standards ride the executor's own context mechanism |
| Correlation         | `run-name` carries `brief.correlationKey`; the helper lists runs by event and finds it                                                                                                                                 |
| `poll`              | Actions `status`/`conclusion`; the run URL is the record's `url`                                                                                                                                                       |
| Result              | PR found by head branch recorded as `pullRequest`; the job summary is `summary`; the result artifact's summary file is parsed for `status`/`stopped_stage` into `custom`                                               |
| Downstream          | cat-factory's `ci` gate and `merger` run as usual; Slack and Jira are the existing channels                                                                                                                            |

Gaps this exposes on the pilot's side, stated so nobody designs around them here: no correlation
input (the caller workflow supplies one), no machine-readable PR URL (recovered by head branch),
no usage (the hooks in D8 wait for it).

## What stays unchanged

Tracker intake, the service estate, foundational services, prompt fragments, skills, the risk
policy, the merge lifecycle, notifications, the lifecycle webhook and the public API all stay as
they are. A delegated step is an ordinary step to all of them. No `/api/v1` change is required for
the first two slices; the two `/v1/delegations/*` endpoints are container-facing machine routes
like `/v1/artifacts/ingest`, not public API.

## Per-slice status

- [x] **PR 0**: this tracker.
- [x] **PR 1: the surface and the registry.** `'delegated'` surface, `DelegatedExecutorRegistry`
      routed on both facades and `startLocal`, the surface switches made total through one
      `Record<AgentSurface, SurfaceTraits>` (`SURFACE_TRAITS`), boot validation of `agent.executor`,
      `registry-seams.spec.ts` both files.
- [x] **PR 2: dispatch, poll, settle.** The shared composition extracted as `composeRoleSystemPrompt`
      and CONSUMED by the container body builder; `composeDelegationBrief`; `DelegatedAgentExecutor`;
      the third arm in `CompositeAgentExecutor` (and its `pollJob` now ROUTES off the handle rather
      than hard-routing to the container); `step.delegated` plus the handle fields;
      `ToolSecretSubject`'s `delegated-executor` member; per-executor poll cadence on both drivers
      via the `awaiting_job` park; cancel / reclaim / retry (D9). Conformance: a fake executor driven
      through dispatch, poll, settle and PR-on-the-block on all three facades
      (`suites/execution-delegated.ts`).
- [x] **PR 3: SPA.** `StepDelegatedStatus.vue`, the executor on the kind's palette projection
      (`CustomAgentKind.executor` / `.delegatedExecutor`), "usage not reported by <executor>" on the
      step card and `llm.reporting` on both run rollups, i18n in all ten locales.
- [x] **PR 4: the GitHub Actions helper and the example package** (D10):
      `@cat-factory/delegation-github-actions` and `backend/internal/example-delegated-executor`.
- [x] **PR 6: the first consumer's gaps** (D11, D12). `DelegationBrief.blockId`, so the
      `repoFiles` resolver in the deps bundle is reachable from `start`, which is the only moment
      its stated purpose ("before starting") exists; `workBranch` on the definition plus the
      engine's idempotent create and the entry-point assertion; the helper's `workflow` resolver.
      Landed BEFORE the first publish, so all three are the shape the seam ships with rather than a
      second one beside the first.
- [ ] **Converge the container path's work-branch ensure onto `RepoFiles`.** The delegated path
      creates the branch through the provider-neutral binding a pre/post-op writes with; the
      container path still uses `server/src/github/ensureWorkBranch.ts`, which is GitHub REST over
      a minted installation token (so GitLab needs a second implementation) and answers a
      best-effort boolean where a dispatch has to be refused. Two implementations of one operation
      is one too many, and a change to the create semantics has to be made in both or the paths
      quietly disagree about what the work branch means. Not folded into PR 6: it changes a wired
      port on both facades and belongs with its own conformance assertion.
- [ ] **PR 5: push-wake and per-call telemetry ingest** (D7 second half, D8's second and third hooks).
      See "What is still open" below: the first is blocked on the drivers' park machinery, and the
      second has no consumer until an executor reports.
- [x] **Website page under `/extend/`**:
      [cat-factory-website#92](https://github.com/kibertoad/cat-factory-website/pull/92), a
      separate repo and so a separate PR, ownership following the reader per ADR 0051. It owns what
      a reader acts on with no checkout (the three registrations, the `workflow_dispatch`
      `run-name` contract, the credential and cadence declarations, the two failure dispositions,
      and what the platform does and does not measure); the internal design stays in
      [`backend/docs/delegated-executors.md`](../../backend/docs/delegated-executors.md).
- [ ] **Close-out**: convert to an ADR under `backend/docs/adr/`, `git rm` this tracker. Held until
      PR 5 settles, since the telemetry stance is part of what the ADR records.

## What is still open, and why

**Push-wake is blocked on the drivers, not on a route.** D7's second half assumed
`WorkRunner.signalResume` could shorten the wait. It cannot: both durable drivers SLEEP between polls
(`step.sleep` on Workflows, a timer on Node) and neither sleep is interruptible by an event:
`signalResume` wakes a run parked on `waitForEvent`, which an `awaiting_job` step is not. An
accelerator therefore needs the `awaiting_job` loop to become an event-wait WITH a timeout on both
drivers, which is a change to the park machinery that every container job also rides. Shipping the
route without it would be a surface an executor calls and nothing happens sooner.

**Per-call telemetry ingest has no consumer yet.** `DelegationResult.usage` is landed and is what
makes `telemetry: 'self-reported'` real today: it meters through `recordJobFacts` as
`usageBilling: 'subscription'` (recorded, excluded from the budget gate, because the tokens were
spent on the executor's account), and the run views stop saying the data is missing. Individual
prompts and tool trajectories would need an authenticated ingest route, and no shipped executor
reports them, and an authenticated write surface nothing calls is a surface to secure for nothing.

**The run-level gap is computed from what LANDED, not from the declaration.** `llmReportingGaps`
counts delegated steps whose step metrics hold no calls, so an executor that declares
`self-reported` and silently stops filing is reported as a gap rather than assumed covered.

## Conventions & gotchas (carry between iterations)

- **The brief is the production prompt.** If `composeBrief` and the container body ever
  compose differently, the standards a workspace agreed on reach one executor and not the other.
  Pin it with a test that builds both from one context and compares the triple.
- **Anything the poll needs is on the step.** `pollHandleFor` rebuilds the handle from the step;
  a field on the handle that `recordDispatchAttribution` does not persist is absent in production
  with no error.
- **Idempotent start, always.** Both drivers replay. Claim before effect; on replay, re-attach or
  re-dispatch under the same correlation key. The engine's half goes through ONE function every
  async dispatch site calls (`startStepDispatch`), which claims, calls the executor and folds the
  outcome either way, because each of those written out per site held at a different subset of the
  eight: the step's own dispatch claimed, and a gate helper, a Tester fixer round, a Ralph
  iteration, the two human-gate fixers and the deploy-fixer did not. It answers the same question
  the container cold boot answers, which is why the two live together rather than beside each
  other. A claim the dispatch never ANSWERED is not a live job (`liveJobId`): the re-attach guards
  re-dispatch it rather than polling a run nobody started.
- **A dispatch that threw is not a dispatch that did nothing.** The claim stays open when the
  executor's own `start()` threw (liveness unknown, so the teardown asks it to cancel) and settles
  when the platform refused before contacting anything (nothing is running, so a cancel request
  would be a false alarm). The engine reads which happened off the refusal's own
  `delegated_executor_failed` reason rather than inferring it. Both drop the job id, so a replay
  re-dispatches under the same correlation key instead of polling a job that may not exist.
- **A cadence the record does not hold falls back to the deployment's job cadence.** Synthesising a
  zero window instead derives `ceil(0 / 0)` = `NaN`, and a `p < NaN` poll loop runs no iterations:
  the step fails as un-settled before its first poll.
- **The handle carries the BLOCK, not only the workspace.** Credentials re-resolve on every poll
  and every cancel, and `ToolSecretResolver.resolve` takes the block so a per-service store can
  scope its lookup. Dropped, such a deployment starts the run fine and then reads an empty bag for
  the rest of its life, dying on "status was unreadable" while the external work carries on.
- **The URL policy is enforced in the FETCH.** Every executor is built over a wrapped `fetchImpl`
  that runs the deployment's `UrlSafetyPolicy` on the first URL and on every redirect hop, the same
  guard the notification-webhook sender uses. Handed over beside the fetch instead, it was declared
  on the port, documented on both sides and read by nobody.
- **Credentials re-resolve per poll**, never cached on the handle: a one-hour token dies inside a
  three-hour run.
- **Absent is not zero, on every surface**: the run-meta card, the outcome summary, the
  verification report, the spend rollups. A delegated step with no usage must never be a `0`.
- **Mothership mode**: the executor runs where the engine runs, credentials resolve through the
  same delegated resolver the tool servers use, and the registry is code on the node; a definition
  the mothership knows and the node does not is refused at dispatch, never merged. Its conformance
  harness has to COMPOSE the delegated arm like the other three (`withDelegatedArm` plus both
  registries on the container): without it the suite's delegated kind falls through to the
  deterministic fake, and eight assertions about an executor that was never called go green on
  every runtime except the one being tested.
- **Runtime symmetry**: both drivers' poll cadence and the step-schema change land together with a
  conformance group that runs on every facade. A delegated step's whole state is what the claim
  persisted (no container to re-address, no runner to ask), so it is exactly the shape a facade can
  get wrong alone: a nested attempt array round-tripped differently through D1 and Postgres fails
  nothing else.
- **The brief's branches AND its target repo ride the HANDLE.** Not in the original design: an
  executor reading back what its own system produced (the pull request whose head is the work
  branch) is doing so at POLL time, where only the handle exists. The work branch is named from the
  BLOCK, so it cannot be derived from a run id. The REPO is the same trap one level up, and the
  sharper one: `description.owner/repo` is where the WORKFLOW lives, and a central automation repo
  dispatching against many product repos is the ordinary shape, so a reader that took its own
  configured repository found nothing on every run and reported every one as having opened no pull
  request. A guess on either puts the wrong pull request on the block, which becomes the `ci`
  gate's checks and the merger's diff.
- **Every dispatch-time fact an executor needs has to be ON THE BRIEF, and every later one on the
  HANDLE.** The deps bundle is built ONCE per app, so a resolver in it is keyed by arguments the
  call site must supply: `repoFiles` takes `{ workspaceId, blockId }`, and with no `blockId` on the
  brief the one dependency that exists for the DISPATCH path was reachable only from `poll` and
  `cancel`, where staging a context layer is too late to matter. The first consumer reached the
  repository over a second credential of its own instead. `task.id` is not a substitute: it falls
  back to the run for a context carrying no block.
- **A branch-naming rule with three call sites gains a fourth silently.** `branches.work` on the
  delegated brief was written as a literal `cat-factory/<blockId>` beside three sites that resolve
  the task's apriori working branch first, and nothing failed: the derived name is right for every
  task that declares no branch, which is most of them. Anything naming a ref, a checkout or a base
  goes through the shared rule in `@cat-factory/contracts`, never a template literal.
- **A JOIN neither side owns is a gap even when both sides are correct.** The work branch was the
  worked example: the engine had a defensible reason not to create it (no empty refs for runs that
  never landed) and the executor had no way to know that was the contract, so the prose on one side
  and the code on the other disagreed with nothing failing. When a new fact is like this, DECLARE
  it on the definition rather than defaulting it, and let the entry point assert what the
  declaration then requires.
- **`step.delegated` is not the question; `inFlightDelegation(step)` is.** The record OUTLIVES the
  work it describes, deliberately: its attempt log is the evidence for why a step is being re-run,
  and `resetStepForRerun` clears `jobId` and keeps the record. So a step that delegated its own work
  and later ran a CONTAINER job (a helper round, a re-run under an overriding kind, a PR-review
  `fix`) still carries it, and every `if (step.delegated)` read routes that container job's poll at
  an external system, folds its phase onto work that finished hours ago, and overwrites its outcome
  on settle. The predicate keys on `step.jobId === record.correlationKey`, which is exactly why the
  key is persisted.
- **The executor's TERMINAL failure has its own name.** It is the same disposition the container
  path's `harnessShutdown` carries ("do not spend a recovery budget"), and it borrowed that flag at
  first: every external CI failure then reported `failureKind: 'harness_shutdown'`, rendering as
  "Harness shut down" for a step that never had a harness and filing external verdicts under
  container eviction in every rollup. It rides `update.delegated.disposition` and maps to
  `delegated_failed`, as its `retryable` sibling does.
- **A successful poll is the sign of life.** The shipped executor's running answer is identical on
  every tick of a quiet run, so nothing changes, nothing persists, and the step's `lastActivityAt`
  freezes at the first poll while the stale-run sweeper re-collects a run that is perfectly alive.
  `toJobUpdate` floors `lastActivityAt` at the poll's own clock; the engine's existing throttle
  decides how often that lands.
- **A reclaim ANSWERS, and both arms are asked.** `AsyncAgentExecutor.reclaimRun` may now return a
  `RunReclaimReport`, because "we asked" and "it stopped" are different facts for work running
  somewhere else, and only the executor can turn the first into the second. The composite's two
  arms are independent resources: an unguarded container reclaim that throws skipped the external
  cancel entirely and recorded every live delegation as "could not stop the external work".

## Checked and genuinely fine

Verified while working the first consumer's report, recorded so the next round does not
re-investigate them.

- **The three problems `@cat-factory/delegation-github-actions` solves are the right three**, and
  the consumer said so independently: correlating a 204, mapping Actions conclusions onto a
  retryable/terminal pair, and recovering a result from the repository are each a day of getting
  subtly wrong and none is about anybody's workflow. D12 is a complaint about one signature.
- **The telemetry stance survives contact with a real executor that reports nothing.** The consumer
  declared `telemetry: 'not-reported'`, read "usage not reported by ‹executor›" on the step card and
  `delegatedStepsWithoutUsage` in the rollup, and reported the outcome as "honest but real" rather
  than as a defect. Nothing to change: the gap is in what Ratchet publishes, and the platform
  already says it does not know.
- **`correlationKey` plus a caller-rendered `run-name` is the only handle Actions offers**, checked
  again against the alternatives the consumer also ruled out (inputs are not queryable, `created`
  has one-second granularity, a called workflow cannot set its caller's run name).
- **`poll` reporting the workflow STEP as its phase is the finest progress the API exposes** for a
  run whose stages live in one step's stdout. That is the executor's ceiling, not the seam's: the
  port takes whatever phase vocabulary the executor has.

## Deliberately NOT pursued

- **Modelling the executor as a runner backend.** Explained above: wrong product shape, a fake
  image.
- **Letting the executor decide the pipeline.** A delegated step is one step; whether a
  spec-writer runs before it or a `ci` gate after it is the pipeline author's decision in
  cat-factory, which is the whole point of keeping cat-factory the top-level orchestrator.
- **A per-step webhook firehose to the executor.** The executor is called by `poll()`; it does not
  subscribe to the run. The lifecycle webhook already carries the four run-level edges.
- **Naming any specific executor in the platform, in docs or in code.** The example package
  uses a fake; the helper is GitHub-Actions-generic; the pilot lives in its company's repo.
