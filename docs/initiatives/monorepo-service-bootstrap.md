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

**Decision: the platform computes the inventory through the checkout-free `RepoFiles` port and
one inline model call judges it. No container, no clone, no runner image change.**

Considered and rejected: an explore-mode container agent that greps the monorepo. It would have
cost a dispatch, a clone and an image bump for a read whose useful subset is small and
enumerable: the root manifests, the CI workflows, and one existing sibling service.

The split is also what makes the review worth doing. The platform COMPUTES what was read; the
model only JUDGES it, and every recommendation must cite a path the survey actually produced
(`parseAdoptionDecisions` drops the ones that do not, and the plan reports the drops). A
container agent's claims about "the monorepo's convention" would be unfalsifiable at review
time, which is precisely the failure this feature exists to avoid.

What the survey reads, per side, is therefore load-bearing and worth stating: the root
convention files (by intersection with a real listing, so naming a file no repository has costs
nothing), up to two CI workflows, and one existing sibling service. Two rules keep the sibling
honest, and both are corrections to the first cut. It is chosen by PROBING candidates rather
than taking the alphabetically first directory (`.github` sorts below every letter, so a
root-level target reported a workflows folder as "what a service here looks like"), and a
candidate qualifies only by holding a convention file of its own; when none does, the plan says
`siblingService: null` rather than naming a guess. Each side also contributes its own directory
LISTING as a citable entry, off a listing the survey already fetched: no root manifest states
where a service puts its code, its tests or its entry point, so without it `source-layout` was
an area the model was asked to judge with no evidence it could cite, and the honest answer would
have been `template` on every monorepo.

The aggregate prompt budget is RESERVED PER SIDE for the same reason. Spent in key order it was
not a bound at all but a handover to whichever side sorts first, and `monorepo:` sorts before
`template:` for every key: a large monorepo spent the whole allowance and the template landed
entirely in `omitted`, on exactly the repositories this feature targets.

Cost: the survey sees a bounded set. A convention expressed only in a file the inventory does
not name is invisible to it. That is stated to the reviewer rather than hidden: `AdoptionSurvey`
lists what was read and, separately, what could not be.

The survey's model call is also the platform's second billable call that no run start gates, so
it takes the same `isOverBudget` safeguard `BugHuntService` does, and reports an exhausted
budget as its OWN unavailable reason: "no model configured" and "over budget" send an operator
to different places.

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

## Slices

- [x] **Slice 1, the flow end to end.** Contracts (`monorepo` target, adoption plan/review,
      `awaiting_review`, `bootstrapPhase`), kernel adoption logic + the `MonorepoAdoptionAdvisor`
      port, the survey reader, `MonorepoBootstrapController`, `BootstrapService`'s three moves
      (survey → park → apply), the container dispatch, both runtimes' drive keys and stores, the
      conformance group, and the SPA (target picker + review modal).

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
- **Letting the model choose what to read** ([#2171](https://github.com/kibertoad/cat-factory/issues/2171)).
  D2's read is DECLARED, so what the survey cannot see is decided before it looks, and the two
  findings this slice fixed there (an alphabetical sibling landing on `.github`, `source-layout`
  having no citable evidence at all) were symptoms of that rather than of the shape. A bounded tool
  loop over the same `RepoFiles` port would keep every property D2 argues for while deriving the
  read set from the repository: the issue holds the four gaps a declared list structurally cannot
  close, and what it would cost.
