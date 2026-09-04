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
