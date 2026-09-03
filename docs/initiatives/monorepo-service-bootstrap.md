# Initiative: Bootstrapping a service INTO a monorepo

Tracker for **monorepo service bootstrap**: creating a new service inside an existing
monorepo from a reference template, with an explicit human review of what the service adopts
from the monorepo versus what it keeps from the template.

## Goal & rationale

Repo bootstrap creates a service in a repository of its own: clone a reference architecture,
adapt it, force-push a single commit to a fresh, empty repo. That is the whole design, and it
is exactly wrong for a monorepo. A monorepo already holds other people's services, so there is
no empty target, a force-push would destroy them, and the interesting question is not "what
should this service contain" but **"what should it share with everything around it"**.

That question has no good default. The template ships its own build tooling, lint config, test
runner, CI wiring and layout; the monorepo has answers for the same areas, usually different
ones. Getting it wrong is expensive in both directions:

- adopt the template wholesale and the monorepo now has two toolchains, two lint configs and a
  CI matrix that has to special-case one directory;
- adopt the monorepo wholesale and the template stops being worth having.

Nobody can settle that from either repository alone, and a model settling it silently produces
a pull request whose reviewer cannot tell which choices were considered. So the flow **parks**:
the platform surveys both sides, a model proposes per-area recommendations with the files it
read behind each, and a human decides before a line is written.

End state: a bootstrap either creates a repository (unchanged) or lands a service in a
directory of one that exists, delivered as a pull request, under decisions a person made.

## Decisions

### D1: A second target axis, not a third launch "mode"

**Decision: `BootstrapRepoInput.monorepo` is an optional TARGET, orthogonal to the existing
`referenceArchitectureId` / freeform-instructions axis.**

The existing axis says where the CONTENT comes from (a template, or a prompt). The new one says
where the service LANDS. They compose: a monorepo run can still be template-based or freeform.
Folding them into one three-valued mode would have made "from scratch, into a monorepo"
unrepresentable for no reason.

### D2: The survey is INLINE, not a container

**Decision: the platform reads through the checkout-free `RepoFiles` port and one inline model
call judges what it finds. No container, no clone, no runner image change.**

Considered and rejected: an explore-mode container agent that greps the monorepo. The cost is
what rules it out: a clone of a large monorepo is minutes, plus a runner-image bump, for a read
that is mostly `list` and `read`. What a container would genuinely buy is `grep` over the whole
tree, which matters for "which services depend on `@acme/service-base`"; that is a real gap and
it is not worth a clone yet.

The first cut also argued that a container agent's claims would be "unfalsifiable at review
time". That argument was wrong and is withdrawn: nothing stops the platform verifying a
container agent's cited paths afterwards, exactly as `parseAdoptionDecisions` does now. The
falsifiability comes from checking citations against a record of reads, not from the platform
choosing the reads. See D10, which is what that correction led to.

The survey's model call is the platform's second billable call that no run start gates, so it
takes the same `isOverBudget` safeguard `BugHuntService` does, and reports an exhausted budget as
its OWN unavailable reason: "no model configured" and "over budget" send an operator to different
places. A longer loop makes that guard more valuable, not less.

### D10: The read is a BOUNDED TOOL LOOP, not a declared file list

**Decision: the platform seeds an opening context and the MODEL chooses what else to read,
through `list`/`read` tools bound per side over the same `RepoFiles`. The platform keeps the
budget and the transcript.** ([#2171](https://github.com/kibertoad/cat-factory/issues/2171))

The first cut read a DECLARED list: the root convention files, up to two CI workflows, and one
probed sibling service. That list was the bug, not its contents. What the survey could not see
was decided before it looked, and the two findings the first slice's review produced were both
symptoms of that rather than of the shape: an alphabetically chosen sibling landing on `.github`,
and `source-layout` being one of twelve areas the model was asked to judge with no evidence it
could legitimately cite. Four things a declared list structurally cannot reach:

- **what a shared internal package OBLIGES.** The sibling's manifest gives the dependency NAME;
  `packages/service-base/` is on no declared path, so what adopting it entails, which is the whole
  decision for `observability` and `runtime-config`, was invisible.
- **heterogeneity.** One sibling is a sample of size one. A six-year-old Java service beside three
  new TypeScript ones has no house convention, and `siblingService` being a single nullable path
  meant the plan had no shape in which to say "the siblings disagree, you pick", precisely the
  case where the human review is worth the most.
- **depth.** Nothing below a sibling's top level, so `src/domain|app|infra` versus
  `src/services|utils` was undecidable.
- **enforcement.** CI capped at two workflow files, so what a new directory is actually REQUIRED
  to satisfy (a path filter, a `CODEOWNERS` entry, a required check) was likely in one of the
  twenty-eight nobody read.

**What the platform still owns is the BOOKKEEPING, and that is what keeps the review worth
doing.** Every read, seeded or model-chosen, is budgeted, secret-scrubbed and appended to ONE
transcript by `MonorepoSurveySession`, which is also the `MonorepoAdoptionExplorer` the advisor
explores through. The transcript is read back off the SESSION after the advisor returns, never
returned with the plan, so an advisor cannot claim a read it did not make.
`parseAdoptionDecisions` is unchanged and gets strictly stronger: it drops a citation naming
anything the transcript does not hold as READ, and the transcript is now a record of what
happened rather than a prediction.

The bounds are a call ceiling (24 model reads), a content ceiling (54 000 characters for the
loop, on top of the seed's own 36 000) and a structural step cap. The seed's number is a TOTAL
split into an equal reservation per side, so a run with no template reserves all of it for the
monorepo and a run with one gives each side half; whatever a side leaves unspent carries to the
next, which makes the reservation a floor rather than a cap. Every body is capped at 6 000
characters on its own, a directory listing as much as a file: uncapped, one listing of a
generated directory is wider than the whole loop budget, and the only answer a charge has to that
is to refuse it and latch `exhausted`.

Exhausting a budget is ANSWERED to the model rather than thrown, so the loop still ends in a plan
that names the areas it ran short on, and it is reported on `AdoptionSurvey.exploration.exhausted`
so the reviewer can tell a thin read from a thin reading. The transcript ARRAY has a cap of its
own (96 rows, since one model turn can emit any number of tool calls), and what that cap cut rides
on `exploration.recordsDropped`: the gap between `calls` and the array's length cannot state it,
because the seed adds rows without adding calls and a call answered from what was already read
adds a call without a row.

The seed is deliberately STRUCTURE-FIRST: each side's root listing and the convention files it
really holds, whichever CI declaration the repository's provider uses (`.github/workflows` and
`.circleci` LISTED rather than sampled, `.gitlab-ci.yml` read, each gated on the root listing
actually holding it), and the listing of every sibling that holds a convention file of its own.
Naming every provider matters as much here as the cross-ecosystem convention list does: a
GitLab-hosted monorepo has no `.github` at all, so a GitHub-only seed leaves the `ci` area with
nothing citable on a deployment shape the platform supports as first-class. Listings are cheap,
they are the only evidence either side offers about layout, and a listing is a menu the model
picks from rather than a guess the platform makes on its behalf. The cheap case stays cheap:
nothing spends a model call rediscovering `package.json`, and a body the reservation could not
fit is HELD rather than dropped, so the model taking the prompt's invitation to ask for it is
answered from memory instead of a second contents-API round trip.

The transcript is reviewer detail, so it rides the SINGLE-JOB read and not the list: `listJobs`
feeds every workspace snapshot with every bootstrap run the workspace has ever made, and the only
surface that renders the transcript is the review a parked run waits on. A settled run therefore
sends `reads: null`, which says "not carried here" where `[]` would say "this survey read
nothing".

Latency was the open question and the answer is that it is free here. The survey ends in a human
wait of hours or days, so a handful of extra round trips costs nothing a reviewer will notice.
Cost is not free, and that is what the ceilings are for.

No fallback to the declared read. A second code path is debt, and the failure it would guard
against (a loop that errors mid-way) already has an honest answer: the run parks with
`analysis_unusable` and the transcript of whatever was read before it died, which is exactly the
`unavailable` plan D6 exists for.

### D3: The apply phase is an ORDINARY coding job

**Decision: the apply dispatch carries no `bootstrap` spec. It is the standard multi-repo coding
shape: the monorepo as the writable primary at a work branch, the reference template as a
read-only `referenceRepos` sibling, one pull request on the primary.**

The harness already does all of this, including the guarantee that matters most: a
`ReferenceRepoSpec` carries no branch or PR fields at all, so the run is structurally incapable
of pushing to the template. A bespoke monorepo mode in the harness would have been a second
implementation of the same mechanics with one more way to get the push wrong, against a
repository holding other people's code, and an image bump on top.

`repo.serviceDirectory` scopes the agent to the new subdirectory: the same field every monorepo
service run rides, so the working-directory rule is stated in one place.

### D4: `awaiting_review` is a status, and a drive KEY comes with it

**Decision: a new non-terminal `BootstrapStatus`, plus a `driveId` on the run distinct from its
id.**

A parked run is neither running nor finished. `running` would make the stale-run sweeper
finalize it as an orphan; a terminal status would lose it. So it is its own value, excluded from
`listStale` (which reads `running`) and included in `liveRunIds` (which asks "not terminal").

The drive key is what the park forced. A monorepo run is driven TWICE (once for the survey,
once for the apply a review releases, possibly days later), and neither facade's driver can be
re-keyed on the run id: a Cloudflare Workflows instance id cannot be recreated once its instance
is terminal, and a pg-boss `exclusive` singleton key would dedupe the resumed drive against the
finished one. `driveId === jobId` for every single-drive run, so plain bootstraps are unchanged;
the apply phase takes `<jobId>-apply`. A HYPHEN, not a colon: the string becomes a Workflows
instance id, whose accepted character set is narrower than a run id's, and `startRun` swallows a
rejected `create` by design (a duplicate start is the normal case), so the failure would have
been an approved bootstrap that silently never dispatches. That swallow now logs, on the same
rule as `WorkflowsEnvironmentTestRunner`: a genuine create failure is otherwise a run the
sweeper re-drives under the same rejected key forever with nothing naming the cause.

The stale-run sweeper on both facades resolves the key through `BootstrapService.driveIdOf`
rather than assuming the run id, or an apply-phase run would be probed under a key with no
instance and finalized as an orphan while perfectly healthy.

### D5: An incomplete review is REFUSED, never defaulted

**Decision: `resolveAdoptionReview` requires an answer for every decision in the plan, and
refuses an answer naming a decision the plan does not carry.**

Defaulting the gaps to the model's recommendation would erase the difference between a human
agreeing with a suggestion and never having read it, which is the single fact this step exists
to record. The UI mirrors it: recommendations are pre-selected as a starting point, but the
submit button waits until every line has been touched (and "accept all" is one explicit act).

An answer for a decision the plan does not have means the reviewer was looking at a different
proposal (a stale tab, a re-run survey), so applying the rest of it would build under a review
that was never given for this plan.

### D6: No suggestion is its own state

**Decision: `AdoptionPlan.status` is `ready` or `unavailable`, with a reason.**

An empty decision list and "the analysis never ran" are opposite facts. A deployment with no
model configured still gets the decision: the run parks, the reviewer is told the platform had
nothing to offer and why, and their notes still reach the agent. Presenting that as an empty
plan would have a reviewer approve a survey nobody made.

**And "gets the decision" has to mean the review is ACCEPTED.** The first cut refused a review
against an `unavailable` plan, which made the park a dead end: the review is the only exit (a
retry re-enters the same phase carrying the same plan), so a deployment with no adoption model
could not bootstrap into a monorepo at all. There is nothing to answer, so the answer set is
empty and the reviewer's notes are the whole instruction; what still refuses is an answer naming
a decision the plan does not carry, which is D5's check doing the work the status guard was
wrongly doing. A retry additionally CLEARS a non-ready plan, because every cause of one is
fixed outside the run (wire a model, grant the permission, raise the budget) and carrying it
forward would re-park on a failure that no longer exists.

### D7: The run's state rides `agent_runs.detail`, so there is NO migration

**Decision: `monorepo`, `phase`, `driveId`, `adoptionPlan`, `adoptionReview` and `prUrl` are
fields of the existing bootstrap `detail` JSON on both runtimes.**

Nothing queries on any of them (a run is read by id, or listed by workspace/service), so columns
would buy indexes nobody uses at the cost of a mirrored migration. `awaiting_review` needs none
either: neither store constrains `agent_runs.status`.

The one thing that is NOT free is the write shape, and it differs per runtime: D1's `json_set`
needs `json(?)` for an object (a bare `?` stores the object's TEXT), while Postgres's
`jsonb_set` takes `JSON.stringify(...)::jsonb` for scalars and objects alike. The conformance
suite drives a real plan through a real store on both, which is what makes that asymmetry a test
failure rather than a runtime where the reviewer is shown nothing.

### D8: The survey is guarded by an ATOMIC CLAIM, not by the plan it writes

**Decision: `BootstrapJobRepository.claimSurvey` is one conditional UPDATE, taken before the
model call, with a TTL that makes a dead claimer's claim re-takeable.**

A stored plan short-circuits a LATER drive, which is what makes the phase idempotent, but it
cannot guard the FIRST one: both facades' drivers replay (a Workflows step re-run, a pg-boss
retry, the stale-run sweeper re-driving a run whose drive died), and two drives that each read
"no plan yet" both survey. That bills twice, and the loser's `park` replaces the plan under a
reviewer already looking at the winner's, whose answers then 422 as `adoption_choice_unknown`.
The rule this follows is the general one: an external side effect in a replaying driver is
guarded by a claim taken BEFORE the effect, never a marker written after.

The claim rides `detail.surveyClaimedAt` through `json_set` / `jsonb_set` conditioned in the
`WHERE`, so the winner is decided by the database rather than by a read the caller did first.
It expires, because a claimer can die between the claim and the plan and a claim with no expiry
would park that run on nothing with no way back in.

### D9: The settled decisions are an engine-owned REGION of the pull request body

**Decision: the engine splices them into a marker-delimited region of the PR body after the
apply completes, using the same `spliceManagedSection` the verification report rides (with its
own marker pair).**

The dispatch-time `pr.body` alone does not survive. The harness folds an agent-authored
`.cat-pr-description.md` over it FIELD-WISE, and it asks the agent to write one whenever the
target repository ships a pull request template, which a mature monorepo generally does. So the
reviewed decisions (the one thing on that pull request the agent did not choose and cannot
restate) were routinely replaced by the agent's own narrative. A region is owned by whoever
writes those markers, so the agent keeps the narrative and the engine keeps the decisions;
read-splice-write against the CURRENT body preserves both, and the markers make a retry replace
the region rather than append a second copy. Distinct markers from the report's, because a task
run on the same repository later publishes one and must not land on top of these.

Publishing is BEST-EFFORT and logs: the pull request is open either way and the decisions are on
the run record the board renders, so failing the run over a description write would discard a
delivered service.

The body is also the HOST rendering of the brief, not the agent's. `renderAdoptionBrief` sends
its holes verbatim because its reader is a model; `renderAdoptionPrSection` routes every hole
through `hostMarkdown` and the caller scrubs secrets at compose time, because a reviewer's note
reading "fixes #412" would otherwise close an unrelated issue on the monorepo when the bootstrap
PR merged.

### D11: The run's STEPS are derived, and a retry resumes at the one it reached

**Decision: `bootstrapRunSteps` / `bootstrapResumeStep` in `@cat-factory/contracts`, derived from
the run row, with `BootstrapService.retry` branching on the same function the board reads.**

A monorepo run is three moves around a human decision, and the board rendered it as one
"bootstrapping…" bar. That bar cannot say which move a stopped run got to, and the control under
it said "Retry bootstrap", which reads as "start over" and is not what the service does: a retry
carries the settled review forward and re-enters at the phase reached (D4's own consequence). A
reviewer offered "retry" after their decisions were recorded had no reason to expect those
decisions to survive it.

Derived, not stored: `phase`, the recorded plan and `awaiting_review` already say where the run
is, and a stored cursor would be a fourth thing to keep in step with those three. It lives in
contracts rather than kernel because the SPA and the backend both have to AGREE about the answer:
the board names the step the button resumes from and the service branches on it, and stated twice
they drift.

Two questions, deliberately not one. `bootstrapReachedStep` is where the run GOT to;
`bootstrapResumeStep` is where a retry RE-ENTERS, and they differ on exactly one case: a run
parked on an `unavailable` plan reached the review, but a retry drops a non-ready plan (D6) so a
fixed deployment can produce a real suggestion, so it resumes at the survey. Collapsing them
would promise a reviewer that a pending decision is what the run picks up from, while the
suggestion behind it is about to be recomputed.

A new-repo bootstrap derives a single `scaffold` step. The SPA renders no list for it and keeps
saying "retry": one move has no progress to resume, and a one-row checklist restates the banner
above it.

### D12: A bootstrap files its telemetry under the RUN, so it is inspectable like any other run

**Decision: the session token, the job body's `executionId`, the provided-context snapshot and
the drained tool-call trajectory all carry `request.jobId`; the drive id addresses the container
and nothing else.**

A bootstrap is already a first-class agent run (one `agent_runs` table, one retry surface, one
stop surface). It was not an inspectable one: it filed no context snapshot and drained no
trajectory, and the apply phase's model calls were keyed on its DRIVE id, which is the one id no
run-scoped read asks for. So the run that most needs explaining when it goes wrong (nothing has
been written, and the only artefact is a failure message) was the one with the least recorded
about it, and its more expensive half was recorded where nobody looks.

The survey is the other half, and it is an INLINE caller on a run path: it now tags its whole
loop with the run, so its spend rolls up beside the apply's rather than sitting in the store
outside every read that could find it. Both file under kinds that name what ran
(`repo-bootstrapper`, `monorepo-adoption-advisor`) rather than under `architect`, whose routing
the container still follows for its MODEL.

The reads themselves needed no new endpoint: the four sinks are keyed by the run, so the panel
the board opens over a bootstrap is the same panel over the same routes. What that costs is a
standing constraint, now pinned by the bootstrap conformance group: those routes may never gate
on an execution row existing.

## Slices

- [x] **Slice 1, the flow end to end.** Contracts (`monorepo` target, adoption plan/review,
      `awaiting_review`, `bootstrapPhase`), kernel adoption logic + the `MonorepoAdoptionAdvisor`
      port, the survey reader, `MonorepoBootstrapController`, `BootstrapService`'s three moves
      (survey → park → apply), the container dispatch, both runtimes' drive keys and stores, the
      conformance group, and the SPA (target picker + review modal).
- [x] **Slice 2, the survey stops guessing what to read.** The `MonorepoAdoptionExplorer` port,
      `MonorepoSurveySession` (seed + budget + transcript + secret scrub), the
      `monorepoExplorationTools` tool set, the advisor's loop, `AdoptionSurvey` as a transcript
      with `siblingServices` and `exploration`, the SPA's "what the survey read" disclosure, and
      three conformance assertions (the call budget is enforced, exhaustion is reported, a plan
      cites nothing outside the transcript). See D10.
- [x] **Slice 3, the run is legible.** The derived step model plus the resume rule both sides
      read (D11), the board's step list on the in-progress, parked and failed cards, the retry
      control that names the step it resumes from, and the telemetry a bootstrap run had not been
      filing: the provided-context snapshot per dispatch, the tool-call trajectory per poll, and
      every sink keyed on the RUN rather than the drive (D12).

## Gotchas the first slice surfaced

- **The repo projection does not reach `CoreDependencies` unless a VCS connection is
  configured.** Resolving a monorepo target therefore lives on the `RepoBootstrapper` port
  (`resolveMonorepoTarget`), not beside the projection: an unconfigured deployment must refuse
  the whole flow rather than half-resolve it, and the conformance harness can fake the port.
- **Marking the repo a monorepo is one DECISION with the resolution, but not one moment.**
  `resolveRepoTarget` hands an agent a service's subdirectory only while the repo's `isMonorepo`
  flag is set, so the mark cannot be skipped: a service pinned inside an unmarked repo has its
  agents dispatched at the repository ROOT. But it also cannot be written first, which the
  single `prepareMonorepoTarget` call did: the caller still has refusals to raise between the
  two, and a flag written before them survived the refusal, silently re-pointing every service
  already pinned to that repository. Hence two port methods and one ordering rule (resolve →
  pre-flight → mark), all inside `resolveTarget`.
- **The target-directory pre-flight may not be OPTIONAL on the reader that performs it.** It was
  wrapped in `if (files)`, so it disappeared whenever `resolveRepoFilesForCoords` was unwired or
  could not bind the repo, and it is the only thing standing between a bootstrap and somebody
  else's service. An unbindable repo is now refused, which also closes the provider hole: the
  binding is provider-matched, so a repo projected under a provider this bootstrapper cannot
  push to is refused here rather than at a dispatch that would build its clone URL off the
  wrong host.
- **A completed apply with no pull request is a FAILURE.** The deliverable is the PR (nothing is
  merged for the reviewer), so a run reporting done without one has left the work where nobody
  can find it. The container reports `prUrl` alone on that path rather than a fabricated
  "created repository" outcome naming a repo it did not create.
- **The directory is pre-flighted twice, deliberately.** Once before the survey (so a refused
  target leaves neither a job nor a board card) and again at dispatch, because a review can be
  settled days later and something may have landed there in between.
- **A retry carries the settled review FORWARD.** The failure being retried is a container fault,
  not a change of mind; re-surveying would throw away a decision a human already made and ask for
  it again. It does NOT carry a non-ready plan forward (see D6).
- **`repoUrl` is not where a pull request goes.** The public API documents it as the web URL of
  the CREATED repository, and a monorepo run creates none: writing the PR link there re-scoped a
  released field in place, and an integration that clones what it reads would clone a PR URL. It
  stays null and `prUrl` is projected publicly beside it (1.65.0).
- **A parse that drops every entry needs its own cap.** The decision cap counts KEPT decisions,
  so a reply whose entries are all invalid never trips it while contributing one drop line each,
  every one persisted on the plan and rendered to the reviewer. The drop list is capped and the
  overflow COUNTED, because "the reply was mostly invention" and "the reply proposed little"
  need opposite reactions.

## Gotchas the second slice surfaced

- **The plan must be checked against the transcript the loop LEFT, not the snapshot it was
  handed.** `AdoptionSurvey` is a value, so the controller holds the opening context by
  reference; parsing against that copy dropped every model-fetched citation as invention while
  the run still looked healthy. The session is re-read after `advise` returns, and the conformance
  group pins it by having its fake advisor cite a file the seed deliberately does not carry.
- **A tool result must never throw.** A `RepoFiles` failure inside `execute` aborts the whole
  generation, so one unreadable file turns into a survey that produced no plan at all. Every read
  answers with an OUTCOME (`read` / `absent` / `unreadable` / `refused`) plus the sentence that
  says which, because those need three different next moves from the model and an empty string
  reads as the first whichever one happened.
- **A loop stopped by the step cap ends ON a tool call**, so `result.text` is empty and thirty
  round trips report `analysis_unusable`. The final step withdraws the tools (`prepareStep` →
  `toolChoice: 'none'`) so it is spent on the reply. Budget exhaustion is likewise ANSWERED, not
  thrown: the model has to be able to say which areas it ran short on.
- **A refused call still costs a call.** Counting only successful reads let a model emitting
  nonsense paths loop until the step cap fired, having read nothing.
- **Scrubbing moved to READ time.** The old shape scrubbed in the controller, at compose time,
  which the exploration half has no equivalent of: a credential would have reached the model
  through the new path while the old one stayed clean.
- **valibot cannot describe a tool.** It implements Standard Schema but not its JSON Schema
  conversion, which is what the AI SDK needs to send a tool definition to a provider, so a valibot
  `inputSchema` fails at CALL time rather than at build time. The tools use `jsonSchema()` with an
  explicit `validate`.

## Not in this slice

- **Starting a monorepo bootstrap from `/api/v1`.** The public surface's
  `POST /api/v1/bootstraps` still creates a repository of its own. `awaiting_review` is already
  named in the spec (1.65.0) because a run started in the app is READ through that surface; the
  start body and the review endpoint are a later, additive step.
- **Reading the monorepo through an installation the workspace has not linked.** The survey
  resolves both sides through `resolveRepoFilesForCoords`, which is scoped to the workspace's
  PROJECTED repos. An unlinked reference template is reported as unsurveyed rather than silently
  surveyed as empty; the apply phase still clones it with the installation token.
- **A second reviewer, or a review that can be revised after approval.** Approval is one act by
  one person; changing your mind means retrying the run.
- **Grep over the whole tree.** The loop reaches any path it can NAME, which is what closes the
  four gaps in D10, but "which of the forty services depend on `@acme/service-base`" is a search,
  not a read, and neither `RepoFiles` nor the tools expose one. That is the one thing a container
  agent still buys, and it is not worth a clone and an image bump yet. A provider-side code-search
  API would close it without either.
- **Benchmarking how well the budget is actually spent.** A model that burns 24 calls listing
  directories produces a worse plan than the declared read did. The ceilings bound the cost, the
  transcript makes the spend visible, and `/benchmark` against a couple of real monorepo shapes is
  what would turn that from visible into tuned.
