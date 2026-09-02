# Environment investigation

Goal: when an ephemeral environment never becomes usable and no checkout edit can fix it, diagnose
it against the provider's own evidence, act on the diagnosis where the platform has an action worth
taking, and, when it does not, stop with a NAMED cause instead of a tester guessing from a DNS
failure.

## Why now

A `pl_build` run provisioned a preview environment, dispatched `tester-api` against it, and failed
at step 5 of 11. The tester's report was correct and its conclusion was the one the platform's own
contract forces:

> This needs a human to re-provision or fix DNS for the PREnv and re-run; it is not something a
> fixer agent can address, and I found no code defect to hand one.

It was right that there was no code defect. The Dockerfile, the compose file and the health block
were all correct, and the deploy job's log shows the image building and the container starting.
What was actually wrong lived entirely in the provider: the deploy job finished `Success`, the VM
then went `offline`, both load balancers fronting it stayed unhealthy, and the environment's DNS
record was never published.

**All three of those facts were in the provider's API response the whole time.** The tester could
not see any of them, because what a consuming step is handed is
`{ id, url, status, expiresAt, lastError, provisionType, engine }`, so its only move was to
resolve the name, watch it fail, and escalate. A human diagnosed it in about fifteen minutes using
the provider's own API, a DNS lookup, a TCP connect and a job log. Every step of that was
mechanical.

`REPO_FIXABLE_ENVIRONMENT_FAILURES` has exactly one `true`, and the reasoning above it is right: an
agent handed a `cluster_unreachable` and a checkout has no honest move, and letting it edit code
would produce a plausible guess rather than a repair. That reasoning is also the whole gap. The
conclusion drawn from "a code fixer cannot help here" was "no agent can help here", when what
actually follows is that a DIFFERENT investigator is needed, one whose evidence points at the
platform rather than at the repository.

Filed as [#2154](https://github.com/kibertoad/cat-factory/issues/2154).

## Decisions

### The investigator is INLINE, not a container agent

Three reasons, any one of which is sufficient.

- **The evidence is entirely platform-side**: a registry row, the captured provision-field bag, the
  run's provisioning log, and a provider API. A checkout buys nothing.
- **The credentials must not leave the backend.** Reading the provider means holding its
  credentials, and a container agent would need them in its job body. That is the same rule the
  release-health connections follow (`observability_connections` are sealed and never reach a
  container), and it is not one worth spending on a diagnostic.
- **The actions are `EnvironmentProvider` calls the engine already makes.** Handing those to an
  agent would mean exporting a control plane rather than asking a question.

So the shape is the `merger`'s, one layer in: the model returns ONLY a structured assessment, and
the ENGINE decides what happens next. `EnvironmentInvestigationService` is the inline call
(`JudgeService`'s twin) behind the kernel `EnvironmentInvestigator` port, so a conformance harness
can swap in a deterministic verdict through the same seam a facade wires the real one through.

### The action vocabulary is CLOSED and narrowed BEFORE the model is asked

`stop` / `wait` / `restart` / `reprovision` / `recreate`, and the engine computes which of those it
will honour this round (from the step's configuration, the remaining budget, and the provider's
declared support), and tells the model the list.

Narrowing first rather than filtering the verdict afterwards is what stops a report naming a remedy
nobody tried: an operator reading "the platform should have restarted the workload" against a
provider that cannot restart anything has been told about a decision that never existed. An action
outside the offered list is read as `stop` with the divergence recorded, never substituted onto a
neighbour.

`REMEDIATION_NEEDS_PROVIDER_SUPPORT` records, per action, whether the provider has to have
implemented anything. Only `restart` does: standing an environment up again and tearing one down
are `EnvironmentProvider` methods every provider already has.

### Diagnostics are an OPTIONAL provider capability, and its absence is STATED

`EnvironmentProvider.diagnostics` is separate from `status()` for the reason `confirmTeardown` is:
`status()` answers "how is my environment doing" in one word because that is what a readiness
judgement needs, so every provider reduces a rich control-plane answer to a member of
`EnvironmentStatus` and drops the rest. A provider that cannot answer the new question must be able
to SAY so rather than have an answer inferred from a call meant for something else.

A provider that implements none of it degrades to exactly the platform's own evidence, which is
what it would have had anyway, and the bundle says which of the two happened, because a missing
diagnosis section reads exactly like one that came back clean.

### The proof is the re-probe, never the verdict

Every action hands the frame back to the deployer: `wait` and `restart` re-enter the readiness
park on the same environment, `reprovision` and `recreate` clear the frame's terminal outcome so
the fan-out stands it up again. What settles the frame is the provider's next verdict. Same rule as
the teardown probe (only a `confirmed` probe is a reclaim), the bugfix reproduction proof (only
red-then-green is proof) and the deploy-fixer (the re-provision, not the agent's account of
itself).

### Most of the evidence already existed and was thrown away

The adapter that motivated this records balancer health, DNS resolution and a reachability sentence
into `provisionFields` on every poll, and nothing had ever read them: the bag is persisted
encrypted as TEARDOWN state, and `resolveForBlock` projects four fields. The bundle carries the
whole bag, redacted. That is why a deployment whose provider implements no diagnostics still gets
most of the value.

### The GATHERER owns the boundary onto the prompt, not the provider

A provider is asked to cap and redact what it knows to be a credential, because it is the only party
that knows which of its own fields carry one. That is an obligation and it cannot be the only line
of defence: most of a diagnosis is control-plane text the provider never authored (a container's own
log, a scheduler's event message), and that is exactly where a bad DSN or an echoed `Authorization`
header shows up. So `createEnvironmentDiagnostics` scrubs and re-caps everything on the way out.

The cap is the same argument in the other direction. The prompt is ONE string, so an unbounded
section does not merely degrade the diagnosis: `generateText` rejects on context length, the round
records `failed`, and the budget is spent with nothing to show. Every section therefore has a
budget, and what a budget cut is STATED, in the value where it is one value and in the bundle's
`evidenceCaps` where it is a whole entry. `evidenceCaps` is its own member rather than extra
`diagnosis.gaps`, because a gap is the PROVIDER's list of reads it could not make: attributing a
platform cap to the provider has the investigator reasoning about a control plane that answered fine.

### The loop must never be able to fail a run on its own

It runs INSIDE the caller's terminal-failure path, and that path's next move is to record the
failure. So a throw escaping the investigation does not cost the diagnosis, it reaches the durable
driver as an unreadable poll and fast-fails the run as a `timeout`: the loop replacing the failure
it exists to explain with a misattributed one of its own. GATHERING is inside the guard, not just
the asking, and every read in the gatherer degrades to a NAMED absence rather than propagating,
including the registry read the whole walk starts from.

The same rule shapes what the loop refuses to accept as success. A `recreate` re-provisions over
whatever the teardown left behind, so only a `confirmed` teardown probe counts as a reclaim: a
namespace wedged in `Terminating` behind a stuck finalizer makes `teardown()` return without
complaint, and re-provisioning into it reproduces the fault and burns the remaining round.

### A REPORT names what happened, never what was refused

The narrowing above is the safety argument, and it survives only if the one operator-facing message
says so too. A verdict asking for an action the engine did not offer produces the WITHHELD reason,
not `Recommended: <that action>`, which would tell an operator about a decision that never existed
with the refusal left in an attempt log nothing surfaces. Same for an action that ran and failed:
the message says what was tried and could not be done. `EnvironmentFindingClosing` makes the four
endings a closed union, so a new one has to be decided about rather than inheriting a default.

### A mutation gets its own provisioning-log row

`restart` is the one investigation action that changes a live cluster, and the investigation's own
second round rebuilds its timeline from the provisioning log. Unlogged, round 2 reasons about an
environment it believes nothing has touched, and the operator's provisioning drawer never shows the
mutation either. So `remediate` is a member of the operation vocabulary, for the reason
`teardown-verify` is one: a distinct ACTOR gets its own verb rather than being folded into another.

## Slice 1: the loop, the port and the first provider (landed)

- [x] Contracts: the fault-layer and remediation vocabularies, the verdict + its lenient coercion,
      the step config (`stepOptions.environmentInvestigation`) and the step state
      (`step.environmentInvestigation`). Every schema that lands inside `PipelineStep` is declared
      as an explicit interface and annotated `v.GenericSchema<unknown, T>`, because inferring it tips
      `tsc` into "type instantiation is excessively deep" in a consumer several packages away.
- [x] Kernel: the optional `EnvironmentDiagnostics` capability (`describe` / `supportedActions` /
      `remediate`), the `EnvironmentInvestigator` port, the evidence-bundle vocabulary, and
      `redactSecretFields` (the deep walk reaches a string LEAF and scrubs it with no field name,
      which is the one thing a `key -> value` bag needs).
- [x] Integrations: `createEnvironmentDiagnostics` gathers the bundle from four independent sources
      and never merges them (the motivating failure was two sources disagreeing), plus the thin
      delegates on `EnvironmentProvisioningService`.
- [x] Agents: the `environment-investigator` inline engine kind, split `{ role, directives }` and
      entered in `PROMPT_VERSIONS`, plus the prompt renderer that renders the bundle's ABSENCES.
- [x] Orchestration: `EnvironmentInvestigationService` (the inline call, honouring a workspace
      prompt override) and `EnvironmentInvestigationController` (the loop), hooked into
      `settleDeployerFailure` immediately after the deploy fixer declines.
- [x] Kubernetes: `describe` reads the namespace phase, the Deployments' unsatisfied conditions,
      every pod through `analyzePodStatus` (plus its `phase`, which that walk cannot give and which
      is the whole diagnosis for a pod that was never scheduled), the namespace's warning events and
      a log tail from each unhealthy pod; `remediate` rolls every Deployment the
      `kubectl rollout restart` way. This is also where `analyzePodStatus` finally reaches a reader
      on the environment path: an `ImagePullBackOff` arrived at the run as a generic timeout. Both
      diagnostic entry points parse the CONNECTION half of the stored config, like every other path
      that reaches an existing cluster rather than building in one, so a manifest whose provisioning
      half stopped validating is still the one failure class the diagnosis can name outright.

## Slice 2: a proved route, and telling the two failures apart

- [x] **[#2148](https://github.com/kibertoad/cat-factory/issues/2148) is the prerequisite for the
      second trigger.** Today the loop fires when the environment itself never became usable. The
      other half (a `ready` environment a STEP could not reach) needs a proved route first, or an
      investigator cannot tell "the environment is dead" from "this container cannot reach a live
      environment" and would confidently repair the wrong layer. Landed as
      [ADR 0062](../../backend/docs/adr/0062-environment-address-bridge-and-route-proof.md).
- [x] **[#2153](https://github.com/kibertoad/cat-factory/issues/2153)**: a provider that reports
      `provisioning` has no way to say why, so `lastError` is structurally always null on the
      readiness-ceiling path. Sharper input for the same diagnosis. Landed as
      `ProvisionedEnvironment.statusNote`.

## Slice 2b: the first shipped verdict was confidently wrong, and the inputs were why

The first real investigation blamed a platform readiness gate that had worked correctly, told a
human to go change three behaviours that already behave as asked, and subordinated the actual cause
to one bullet. Three separate defects, filed together, all landed:

- [x] **[#2162](https://github.com/kibertoad/cat-factory/issues/2162)**: `refreshStatus` handed the
      whole captured field bag back to the provider and then persisted a patch that omitted it, so
      a provider's fields were frozen at CREATE time for the life of an environment. For an async
      provider the create response is the least informative answer it will ever give, so the most
      load-bearing input in the bundle was stale by construction. Fields are now re-sealed from
      every poll that states them, `null` states nothing and keeps what is stored, and the port
      docstring says which.
- [x] **[#2163](https://github.com/kibertoad/cat-factory/issues/2163)**: the ordering half. The
      bundle now carries the route evidence and folds the proof into ONE derived timeline dated
      from `proof.checkedAt`, so an ordering claim contradicted by a timestamp the platform held is
      structurally hard to state; an ANSWERED status poll leaves a marker on the row, so "nothing
      polled" and "polling is not logged" stop being the same data; the provisioning log's own
      state (kept / read / empty / unreadable) is a timeline entry rather than something inferred
      from the list being short; and the platform COMPUTES the determinate cause
      (`determinateRouteCause`) and tells the model it outranks anything inferred from apparent
      ordering. Prompt bumped to `environment-investigation@v2`.
- [x] **[#2165](https://github.com/kibertoad/cat-factory/issues/2165)**: a stored route proof was
      dropped by any later poll whose candidate list merely REORDERED, and nothing re-took one.
      Survival is now decided on what the proof established, and `refreshStatus` re-proves a
      `ready` environment whose proof it had to drop, at most once a minute and paced off a stored
      `probedAt` that outlives the dropped verdict.

## Slice 3: more providers, more evidence

- [ ] The Docker Compose backend: `describe` over `docker compose ps` / container logs, and
      `restart` over `docker compose restart`. The local facade is where a developer meets this
      failure most often.
- [ ] The generic HTTP (`remote-custom`) provider: a manifest-declared `diagnose:` template, so a
      deployment's own management API can answer without a code change. This is the one that would
      have covered the motivating incident directly.
- [ ] A FRESH probe as bundle evidence (a DNS resolution and a TCP connect taken at investigation
      time), for the environments whose provider says nothing useful. The STORED route proof is
      already in the bundle (slice 2b), which is the cheap half; this is the half that costs I/O on
      the failure path. Note the facade split: a Worker has neither.

## Slice 4: surfacing

- [ ] The investigation on the run-details surface. The evidence exists
      (`step.environmentInvestigation.attemptLog`) and only the recorded failure message reduces it
      today, so a reader gets the cause and not the rounds behind it.
- [ ] The investigation in the PR verification report, alongside the deploy-fixer attempts that
      the same slice of `deployment-failure-remediation.md` still owes.
- [ ] A per-step UI for `stepOptions.environmentInvestigation`, if and when `deployFix` gets one:
      the two are siblings and neither has one, so shipping one alone would be the odd surface.

## When the committed scope completes

Convert this tracker into a numbered ADR under `backend/docs/adr/` and `git rm` it in the same PR.
Keep Context / Decision / Rationale / Consequences, drop the checklists. Check the next free number
against ALL existing files first: parallel branches have collided on one three times.
