`OutcomeEnvironment` gains `detailKind`, saying which of two claims its `detail` carries: a
recorded `fault`, or the provider's own `note` about a state the environment has not left yet.

Additive, and the field arrived with the reason for it. `detail` used to be the producer's cause
and nothing else; it now also carries a provider's note, which is the only account a row about a
still-building environment has (the commonest row on a live run's card). Both land in one slot and
read identically as prose, so without the label "the deploy job is queued behind 3 others" sits
where "quota exceeded" sits and a reader cannot tell "wait for it" from "fix it".

Stated rather than derivable: a recorded fault survives onto a reclaimed environment, so `state`
does not imply the kind. Null exactly when `detail` is null, and required-nullable like `detail`
itself rather than optional, so the pair can never disagree about whether the row said anything.

## 1.64.0, not 1.63.0

The provisioning-log `operation` vocabulary gains `remediate`: a row the platform appends when it
asks a provider to repair an environment in place, for the environment investigation's `restart`
remedy.

Additive, and the same shape `teardown-verify` took for the same reason: a distinct ACTOR gets its
own verb rather than being folded into an existing one. A restart is the one investigation action
that mutates a live cluster, and folding it under `status` (a read) or `provision` (a stand-up)
would report an operation that did not happen. The clients tolerate unknown enum values by design,
so a consumer built against 1.63.0 keeps parsing; one that maps `operation` through an exhaustive
table gains a member to name, which is what the vocabulary being closed is for.

What a consumer NOTICES beyond the new value: the environment rows for a run that hit the
investigation loop are no longer a complete account of what touched the environment unless
`remediate` is read. Before this, they silently were not.

The number moved after the fact: this branch was written against 1.62.0 and main reached 1.63.0
with `OutcomeEnvironment.detailKind` while it was in flight. The version line auto-merged clean,
because both sides produced the same bytes; the collision arrived here, in the paragraph, exactly
as the note at the top of this file says it does.

## 1.65.0

`BootstrapJob.status` gains `awaiting_review`: a repo-bootstrap run parked on a human decision.
`BootstrapJob` gains `prUrl` beside it.

It is reachable only for the new monorepo bootstrap (a run that adds a service to an existing
repository rather than creating one), which this surface does not yet offer a way to START:
`POST /api/v1/bootstraps` still creates a repository of its own. The value reaches a public
caller anyway, because a run started in the app is READ through this surface, and a status the
spec did not name would be the one thing a poller cannot handle honestly.

`prUrl` is the same run shape's deliverable. A monorepo bootstrap creates no repository, so it
has no `repoUrl` to report: it delivers a pull request against a repository that already exists,
and nothing is merged for the reviewer. The pull request therefore gets its own field rather than
riding `repoUrl`, which this surface documents as the web URL of the CREATED repository. Putting a
PR link there would have re-scoped a released field in place, and a caller that clones what it
reads would clone a pull-request URL. Exactly one of the two is set on any run, which is also how
a caller tells the two shapes apart without reading `status`.

Additive on both counts: the clients tolerate unknown enum values by design and ignore unknown
response fields, so a consumer built against 1.64.0 keeps parsing. What a poller has to CHANGE is
its terminal test, and that is the point of naming the value: `awaiting_review` is neither running
nor finished, so a loop that treats "not `succeeded` and not `failed`" as "still working" now
waits forever on a run that is waiting for a person. Branch on it and surface the run to a human
instead.

## 1.66.0

`PrReportEnvironments.entries[]` gains `remediation`: what the platform TRIED about a frame whose
provision failed, as `{ deployFix?, investigation? }`.

Both remediation loops (the `deploy-fixer`'s repair-and-re-provision rounds, and the environment
investigation's diagnose-and-act rounds) recorded their whole history on the deployer STEP and
nothing reduced either into this report, so a run whose environment failed, was diagnosed as a
provider fault, was restarted in place and then came up served byte-for-byte what a run with no
remediation loop wired at all serves. Nothing outside the backend could establish that the loop
had run, which made the feature unfalsifiable for a headless consumer reading only this surface.

What travels is the decisions, not the prose: the classified cause the fixer was dispatched
against and how many of its rounds finished rather than died, and the layer the investigation
blamed, the action it asked for, every action the engine actually ran, why a requested action was
withheld, and how many readiness-ceiling extensions a `wait` verdict won. The investigator's own
summary paragraph and cited evidence list stay on the run's record.

Both halves also carry `cycles` and `droppedRounds`, and a consumer needs both to read `attempts`
honestly. Something can send a run back to its deployer, and each pass is a fresh provisioning
CYCLE that re-arms the budget: `attempts` counts the whole run, `maxAttempts` bounds ONE cycle,
and the two are a ratio only where `cycles` is 1. `droppedRounds` counts rounds whose per-round
detail the step's log cap dropped; they are counted in `attempts` and in neither `completed` nor
`failed`, since nobody can now say which they were.

`PrReportEnvironments.entries[].status` gains a fourth value, `unsettled`: the frame the run holds
no terminal outcome for. Both remediation loops clear the recorded outcome to make the
re-provision happen, so a report composed in that window (the run was abandoned, timed out, or
failed at another step) would otherwise omit the frame and read as a deployer that recorded
nothing. A consumer switching on `status` must not treat it as a failure or as a success: nothing
settled. The SDKs tolerate an unknown enum value by design, so a client built against 1.65.0 keeps
parsing.

Three absences are deliberately distinct and a consumer must not collapse them. `remediation`
absent means neither loop ran, which is every clean provision. `investigation.faultLayer` null
means no round produced a verdict, which is NOT the `unknown` fault layer (a verdict reached on
evidence that did not settle the question). `investigation.ranActions` empty means nothing was
run, which a `withheld` reason then explains.

There is no field saying whether the remedy WORKED, and there will not be one: that is the
deployer's next verdict, which `entries[].status` already states.

Additive: a new optional field on an existing response object, and the clients ignore unknown
fields, so a consumer built against 1.65.0 keeps parsing.

## 1.67.0

The BUG-FISHING EXPEDITION lands, and three closed vocabularies the public surface exposes gain a
member each.

`taskType` gains `bug-fishing`: a read-only, multi-angle hunt through a service's codebase for
defects nobody has reported. It changes nothing and opens no pull request; its deliverable is the
findings, and a human marks the ones worth fixing, each of which spawns its own bug-fix task.

`NotificationType` gains `bug_fishing_triage`, raised when such an expedition has fished every
angle and is waiting for its catch to be triaged. A webhook receiver that enumerates the types it
subscribes to keeps working: it simply never asks for this one. `NotificationPayload` gains
`phaseCount` (how many angles the expedition fished) and `untriagedFindingCount` (how many findings
still have no decision — deliberately not the total, since a human who triaged half the catch while
the later angles were still fishing is being told what is left).

Additive throughout: a new enum member on two existing unions and two new optional payload fields.
The SDKs tolerate an unknown enum value and ignore unknown fields by design, so a consumer built
against 1.66.0 keeps parsing.

## 1.68.0

`BootstrapJob` gains `delivery` (`pull_request` | `direct_push`): how a bootstrap run publishes
what it wrote.

It is projected because the pair of URL fields no longer answers the question a poller asks.
1.65.0 added `prUrl` beside `repoUrl` and said "exactly one of the two is set on any run, which is
also how a caller tells the two shapes apart". That was true while the target decided the delivery:
a monorepo run opened a pull request, a new-repo run force-pushed. A bootstrap now says how its
work should land, so a run that created a repository OF ITS OWN can also deliver into it as a pull
request, and both fields are then set.

**Read `delivery` for whether a pull request is coming, and `repoUrl` for which target the run
took.** `repoUrl` is unchanged and still names the created repository (null on a monorepo run
always), so the target discrimination survives; what does not is inferring the delivery from
`prUrl`, which on a `direct_push` run is null terminally and correctly, and on a `pull_request` run
is null only until the pull request exists. `delivery` answers both from the first poll.

`POST /api/v1/repos/bootstrap` does NOT accept `delivery`, exactly as it does not accept a
`monorepo` target: a run started through this surface still takes the default for the target it
creates, `direct_push`. The field reaches a caller anyway, because a run started in the app is read
back here, which is the same reason `awaiting_review` was named in 1.65.0.

Additive: a new field on an existing response object, whose value is one of two members the
clients receive as a string. A consumer built against 1.67.0 keeps parsing, and one that branched
on `prUrl === null` to mean "this run created a repository" should move to `repoUrl !== null`.

## 1.69.0, not 1.68.0

`POST /api/v1/repos/bootstrap` gains two refusals, both about the reference architecture a creation
names: `422` with `details.reason: reference_repo_not_found` when the workspace's source-control
connection cannot see that repository, and `503` with `reference_repo_unreadable` when the probe
itself failed. Each carries `details.referenceArchitectureId` and `details.repo`.

Additive in shape (two new `details.reason` values on statuses this surface already answers), and
a change of BEHAVIOUR a caller has to notice, which is why it is written down rather than left to
the spec: the template is now checked before anything is recorded, so a refusal about it arrives as
an HTTP error instead of a `failed` creation in the `201`. A caller that only branches on the
creation body sees an exception where it used to see a job it could read `failureKind` off. Nothing
that used to succeed now fails: the same runs previously failed several minutes later inside the
container, with a job row and a board card left behind.

A template the connection can READ but the App was never granted still passes the check and fails
at dispatch, as a `failed` creation whose message names the repository to grant. A public
repository is the case that reaches it: `repository_ids` may only name repositories an installation
holds, and reading one proves nothing about that.

The number moved after the fact, the way 1.64.0's did and for the same reason: this branch was
written against 1.67.0 and main reached 1.68.0 with `BootstrapJob.delivery` while it was in
flight. Both sides produced the same version line, so git auto-merged it clean and the collision
arrived here, in the paragraph, exactly as the note at the top of this file says it does.

## 1.70.0

A task-type field DESCRIPTOR (`GET /api/v1/task-types`, and the descriptors a registered task type
carries) gains `integer`: whether a `number` field's value must be a whole number.

Additive, and it exists because the descriptor's whole job is to state what the create door will
accept, before a caller sends anything. `min` and `max` could not say this, so a field the internal
schema pipes through `integer()` advertised itself as accepting `4.5`, admitted it through every
public validation, and was then refused at creation with a raw parse error naming a schema path
rather than the field. Both built-in `number` fields declare it (`review.prNumber`, and
`bug-fishing.fishingMaxPasses`, new in this release), and a consumer that renders a form from the
descriptors gains a stepper that agrees with the server.

Nothing that used to succeed now fails: a fractional value for either field was already refused,
one layer further in and less legibly.

## 1.71.0

`tests.gap` on `GET /api/v1/runs/{runId}/outcome` gains `verified_by_committed_tests`: the run
carries no tester step and none was wanted, because its pipeline verifies through tests COMMITTED
beside the change (an `integration-test` step) which the CI gate runs.

Additive (one new value in a closed vocabulary the SDKs already tolerate unknown members of), and
it exists because the value it splits off from was answering a question with the opposite fact.
`no_tester_step` translates as "nothing was exercised", which is what a reader of the outcome card
saw for a run whose pull-request report said, in the same breath, that the change had been verified
from the repository. A consumer branching on `no_tester_step` keeps working and simply stops seeing
it for those runs; one that wants the old grouping treats both members as "no tester".

Requirement coverage deliberately keeps answering `no_tester_step` on the same runs. Committed
integration tests produce no per-requirement verdicts, so "no requirement was checked" is exactly
what happened there, and splitting it would state a distinction that has no consequence.

## 1.72.0

Three additions around the PR deep review, so the whole "review this pull request, curate the
findings, post the ones we keep" loop is drivable from outside the app.

`POST /api/v1/runs/{runId}/decisions/pr-review/resume` re-dispatches a review wedged mid-review for
only the slices that never reported, re-aggregating from the reports already captured. `409` unless
the review is still in progress. Without it a headless caller's only exit from a stalled review was
stopping the task, which throws away every slice that had finished.

The `pr-review` decision gains `postReport` and `postedFindingIds`. A `post` resolution that partly
or wholly fails re-parks the review at `awaiting_selection` with its resolution cleared, which was
byte-for-byte a review nobody had resolved yet: a caller that posted seven comments and landed none
saw the state it had a moment before. `postReport` states what the pull request actually received
(`attempted`, `posted`, `folded`, `failures[]`, `bodyPosted`/`bodyError`) and `postedFindingIds`
names what a retry will skip.

`postReport` also carries `attempt` (which `post` pass it describes) beside the decision's
`postAttempts` (how many have been requested), because a retry that fails identically to the pass
before it produces an otherwise byte-identical report: a caller polling on an interval that missed
the brief `posting` window could not tell its retry's failure from the one it had already read. The
decision gains `postedBody` too, the summary comment's sticky counterpart of `postedFindingIds`,
which is what makes `bodyPosted: null` readable ("suppressed, it already landed" versus "there was
never a summary to send").

The `pr-review` decision also states what a caller needs before it spends a resume:
`resumeAttempts` / `maxResumeAttempts`, `reportedSlices` (against `slices`, so a reviewer on its
final aggregation turn is recognisable) and `lastActivityAt`. **The resume route is bounded on this
API** at `maxResumeAttempts`, answering `409` past it. Each resume stops the running reviewer and
dispatches a fresh container, and a headless caller has no eyes on the review, so a poller resuming
on a timer shorter than the review takes would kill it repeatedly just as it was about to finish.
The app's own resume stays uncapped: a person clicking Resume is watching what they nudged.

`unanswerable[]` gains the `curation_gate` reason, for a run parked on a step that CURATES where
marking what it found has no route here. That is the honest report the refusal below promises: a
parked expedition is `parked: true` with the wait NAMED, rather than an empty list, and the entry
says why resolving the step's approval gate is an exit rather than an answer (it ends the run with
everything the expedition caught unacted on). A parked `pr-reviewer` is deliberately NOT reported
there, because its curation IS answerable (`kind: "pr-review"`), and both halves read the same
table the start refusal is built from.

Every addition above is additive. The behaviour change beside them is not, and it is stated here
rather than left to be discovered: **starting the `pl_review` or `pl_bug_fishing` presets now
requires a `decide` key**, where a `write` key was admitted before. Both are single-step pipelines whose step parks the
run for a person to curate what it found, and admission could not see that park because the two
kinds park through machinery of their own rather than through anything a registry declared. So a
`write` key could start either and then hold a run whose every verb needs `decide`, with the SPA or
`POST /tasks/:taskId/stop` as the only way out. The refusal is the existing
`403 pipeline_requires_decide_scope`, and it now names the surface: `pr-review` as answerable
here, `bug-fisher` as not (marking a catch for fixing has no public route yet). The park surfaces
are listed as the pipeline spells them and the answer promise names `decisions[]` KINDS, which are
not always the same word: a `pr-reviewer` step is answered by a `pr-review` decision, and both
brainstorm kinds by one `brainstorm`. Naming the surface in a sentence that points at `decisions[]`
sent an integration looking for an entry that is never in it.

**`POST /tasks/:taskId/retry` takes the same rule**, asked of the run's stored steps because that is
what a retry re-drives. It is the same narrowing, for the same reason: a start path is not the only
way to set a park in motion, and without it a `write` key holding a task whose parking run had
failed could re-drive it and be holding a parked run again a moment later.

No run that could be finished through this API stops being startable; what is refused is a run that
could not.

## 1.73.0

`GET /api/v1/prompt-fragments` lists the workspace's best-practice standards, and
`fragmentIds` on task creation names which of them a task's agents are held to. `PublicTask`
gains `fragmentIds`, the set the creation froze.

Additive on all three counts. What it closes is a gap with no workaround rather than an awkward
one: a task's standards were selectable from the app and from the internal API and nowhere else,
so a caller filing a review headlessly could name the pull request, the focus, the pipeline and
the model, and could not say which of the team's own standards the reviewer was to judge it
against. The only lever it had was the enclosing SERVICE's standing set, which is the right
default and aims any change at every other task under that service.

Three decisions a consumer can see. The catalog read carries each standard's identity and NOT its
`body`: naming a standard needs the id, the title, the category, the one-line summary and the
tags, which is also exactly what the platform's own relevance selector decides from, where the
body is the authored text of an organisation's guidelines. It still sits at `write` rather than
`read`, because a standard imported from a repo of Markdown guidelines has no authored summary of
its own and the importer derives one from the opening of the file: for those entries the summary
is a capped slice of the guidance, which does not belong behind the most widely handed-out kind of
key. `write` is exactly the scope that names a standard on a task, so the discovery pairing stays
whole, and it stays below the `admin` the preset libraries take.

The list is keyset-paginated from this first release (`?limit=`, `?cursor=`, `nextCursor`),
ordered by `fragmentId`. A tier can link a whole repo directory of guidelines and get one standard
per Markdown file, so the catalog has no natural ceiling: shipping it unbounded would have left
only a `/v2` or a silent truncation as the way to add the bound later.

And an id the board does not resolve is REFUSED (`422`, `details.reason:
'prompt_fragment_not_found'`, `details.fragmentIds` naming every one that missed) where the run
path drops it. The run path is right to drop: a standard deleted after a task was filed must not
break the run. At the door it is the wrong disposition, because a typo would answer `201` for a
review that folded nothing, which is byte-for-byte a review nobody asked to be judged against
anything. `503 prompt_fragments_unwired` is the separate case of a deployment with no standards
library, and it fires only for a caller that named standards.

What a caller NOTICES beyond the new field: `PublicTask.fragmentIds` is the UNION the creation
froze, not an echo of what was sent. A create that names nothing still reads back its service's
standards, and an empty array clears that inheritance without holding the task to nothing (the
chosen task type's own defaults still apply, which is visible on a `document` task). It is
create-only for the reason `pipelineId` is, plus one of its own: the frozen set is what the run
folds however the library moves afterwards, which is what keeps a finished review's standards
readable rather than re-derived.

## 1.74.0

Three additions, all serving one gap: what a run is DOING while it works.

`GET /api/v1/runs/{runId}/decision-events` streams the run's decision list over SSE.
`publicDecisionKindSchema` gains `bug-fishing`, with three routes under
`/api/v1/runs/{runId}/decisions/bug-fishing/`. The outbound webhook's `runEvents` family gains
`run.step_completed`.

Additive on every count: a new endpoint, a new decision kind (the SDKs tolerate unknown enum values
by design), three new routes, and an opt-in event on a filter whose empty value already means NONE.

What it closes is a gap the run streams had by construction rather than by omission. A frame is
emitted when the RUN projection changes, and the state a chunked operation moves through does not
live on it: a PR deep review's slice count, its challenge verdicts and its post report ride
`step.prReview`, an expedition's angles ride `step.bugFishing`, and neither is `step.custom`. So a
seventeen-minute review produced no frame at all for its whole duration and then one `decision` at
the park, while this repo's own documentation told a caller to poll `/runs/{runId}/decisions` for
exactly the progress the stream could not give it.

**The decision stream is its own endpoint rather than a flag on the two run streams, and that is
the decision worth reading.** A `?decisions=true` was built first and rejected on the SDKs: a query
parameter added to an existing operation is emitted as a positional argument ahead of the trailing
options bag, so `client.tasks.stream(taskId, options)` becomes
`client.tasks.stream(taskId, query, options)` and Go's `Stream(ctx, taskID)` grows an argument. That
is an in-place retype of four released clients, which this surface does not do, and a TypeScript
caller passing `{ headers }` would have gone on compiling against the wrong parameter for a release.
A new operation is the additive shape, and it is the better one: it is keyed by RUN like the list it
streams, so one endpoint serves a board task and a headless job where the flag needed adding to two,
and the run streams stay progress channels. The cost a consumer sees is one more connection to watch
both, which the run streams' own `decision` frame still makes unnecessary for a caller that only
needs to know a park happened.

The frame carries the WHOLE list, `unanswerable[]` included, never a delta or a subset: an empty
`decisions` that means "I asked and nothing is being asked" and one that means "this payload was
narrowed" are opposite facts, and telling them apart is what the field beside it exists for.

`bug-fishing` is the second CURATING park to gain verbs, and the first thing a caller notices is
what STOPS happening: a parked expedition used to arrive in `unanswerable[]` as a `curation_gate`,
saying the marking had to be done in the app. It is now a `decisions[]` entry, and the start
surface's refusal promises the answer path instead of withholding it, so a `decide` key that could
previously only END an expedition can now act on what it caught. `curation_gate` survives with a
narrower population: a curating kind a DEPLOYMENT registered, whose marking lives wherever that
deployment surfaced it. Both shipped curating kinds are answerable here.

`run.step_completed` is the narrowing of the per-step feed [ADR 0030](./adr/0030-public-api-surface.md)
rejected, not a reversal of it. That rejection was about a PROGRESS feed, which the engine emits on
every container poll; this fires once per step BOUNDARY, so a ten-step pipeline delivers ten events
over however many hours it runs. Two things a receiver must read: `deliveryId` is
`<runId>:run.step_completed:<index>` rather than the two-part key the run edges use, because this is
the one event a single run emits repeatedly and the run-scoped key would collapse a whole pipeline
onto its first step; and `step.outcome` distinguishes `skipped` from `completed`, because the engine
skips a gated step by marking it done with no output, which is otherwise byte-for-byte a step that
ran and reported nothing.
