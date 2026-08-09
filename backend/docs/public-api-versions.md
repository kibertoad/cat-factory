# Public API surface version history

Why `/api/v1`'s OpenAPI `info.version` sits where it does, one entry per step, newest last.

The number itself lives in `scripts/generate-openapi.mjs` (`API_VERSION`), and the rules that
govern moving it are in [CLAUDE.md](../../CLAUDE.md) ("The public API does not break") and
[ADR 0034](./adr/0034-public-api-stability.md); what a consumer is promised, field by field, is
[public-api.md](./public-api.md). This file is the record of the STEPS: what each number added,
and what a consumer built against the one before it would notice.

It is a document rather than a comment block because it grows with every release and never
shrinks, which is a shape a generator script should not carry (the file-size ratchet said so
first). Two things earn it its keep beyond history:

- **Several entries say `X, not Y`.** That is not pedantry: the version line COLLIDES SILENTLY.
  A branch that bumps the minor and a main that bumps it to the same number produce
  byte-identical text, so git auto-merges them with no conflict and the branch ships a DIFFERENT
  surface under a number main already used. Every one of those collisions was caught here, in the
  paragraph that had to be merged by hand, and never on the version line itself. **After every
  merge, re-read the last entry against `origin/main` rather than trusting a clean auto-merge.**
- **Each entry states what a consumer NOTICES**, including the population changes that are
  additive on the wire and still change what a client concludes (a list that gained rows of a new
  scope, a field that used to be null for a whole class of runs).

1.12.0: `PrReportValidation.configUnreadable`, an additive optional field on the run report,
so a consumer built against 1.11.0 keeps parsing.

1.13.0, not 1.12.0: additive only, on the run-debugging surface (a new `ok` filter on the
tool-call list and a `toolCalls` rollup on the run overview), but main reached 1.12.0 with
`configUnreadable` while this branch was in flight. The collision note above, arriving exactly
as it describes: both sides wrote the same number, so the VERSION line auto-merged clean and
only the comment beside it conflicted. Re-checked against `origin/main` rather than trusting
that clean merge.

1.14.0: additive only, an optional `modelPin` on the report's judge verdicts (which model the
rubric was authored for, and whether the run got it). Third number that change held: it was
written against 1.12.0, moved to 1.13.0 when the validation field took that, and again once the
debug surface took 1.13.0. Every one of those was found by re-reading this line after a merge,
which is the only thing that catches it.

1.15.0, not 1.12.0: `GET /api/v1/me` and `unanswerable[]` on the decision list, both additive,
written against a main that was still on 1.11.0. Four numbers have gone past this branch while
it was in flight (`configUnreadable`, the run-debugging surface, the judge model pin, and the
release that published them), so it takes the next free one. Nothing about that is unusual any
more, which is the point of the note at the top of this block: on a repo landing this many
additive changes, a clean auto-merge of the VERSION line is the normal way to ship a number
someone else already published. Re-read it against `origin/main` every time.

1.16.0, not 1.15.0: the run report gains an optional `scope`, naming WHICH of a multi-repo run's
pull requests a given copy is written onto. Additive: a consumer written against 1.15 reads every
field it knows, and an absent `scope` means what it always meant (the own-service PR). FIFTH
number this one addition has held (1.12 → 1.13 → 1.14 → 1.15 → 1.16), and 1.15 was taken by the
`/me` endpoint landing on main while this branch was in flight, caught by re-reading this line
after the merge rather than by trusting a clean auto-merge of the VERSION itself.

1.17.0, not 1.15.0: the tool-call list's `?ok=true|false` filter is REPLACED by
`?outcome=ok|error`, the same param name and vocabulary the llm-call list already uses. This is
a MINOR for a change that is technically breaking, taken deliberately: `?ok=` existed for one
release, has no known consumer, and the two drill-downs answering the same question under two
spellings is the wart the change exists to remove. A picklist also lets the set gain a member (a
timeout, a refusal) where `true|false` could only be retyped. If an adopter turns up before this
lands, the honest shape is `?ok=` served beside `?outcome=` for a release, not a rename.

This branch reserved 1.17.0 while 1.16.0 was still unlanded, on the reasoning that the multi-repo
verification-report branch held it and two branches sitting on the same number auto-merge the
VERSION line byte-identically, conflicting only in this comment: the silent failure the note at
the top of this block describes. That branch has since merged, so 1.16.0 is main's published
number and 1.17.0 is simply the next free one. Re-read against `origin/main` anyway.

1.18.0, not 1.17.0: `GET /api/v1/task-types` plus `fields` on task creation, both additive (a new
endpoint and a new optional key). THIRD number this one addition has held: written against

1.16.0, moved to 1.17.0 when the multi-repo report `scope` took 1.16.0 on main, and moved again
when the `?outcome=` rename above published 1.17.0 on main while this branch was in flight. Both
moves were found the same way, and it is the only way that works: by re-reading this line after
the merge, never by trusting that the VERSION itself auto-merged clean (it did, twice, to a
number main had already used).

1.19.0, not 1.18.0: attaching a document by REFERENCE gains two `error.details.reason` values on
its 422, `document_ref_unrecognized` and `document_ref_claimed_by_other_source` (the public create
resolves every ref through the same service the app's attach pre-flight calls). Additive: a
consumer that branches on nothing still sees the same status and message, and one that does gains
two codes to branch on. The reason VOCABULARY is part of the stable surface, which is why a new
member is a version step at all, and why `public-api.md` names both codes rather than describing
the refusal only in prose. 1.18.0 is main's published number as of this branch's last merge.

1.20.0, not 1.19.0: a descriptor field on `GET /api/v1/task-types` may carry an optional `section`,
the grouping caption a long operation form is rendered under. Additive, and inert for a headless
caller: it groups nothing the create call validates, so a client that ignores it fills exactly the
same bag as before, and one that renders a form gains the author's own grouping. 1.19.0 is main's
published number as of this branch's last merge; re-read this line after any merge rather than
trusting that the VERSION auto-merged clean.

1.21.0, not 1.20.0: each step of `GET /api/v1/debug/runs/:runId` may carry `toolServers`, what
the step's dispatch wired and what it dropped with the reason. Additive, and it is the
REPLACEMENT half of a deprecation: the same facts sat in the agent-context snapshot's untyped
`extras` bag, which keeps serving them until the window in `public-api.md` closes, so no
consumer has to move on this version. 1.20.0 is main's published number as of this branch's last
merge; re-read this line after any merge rather than trusting that the VERSION auto-merged clean.

1.24.0: `PATCH /api/v1/tasks/:taskId` accepts `fields`, the task's per-type bag, merged over
what the task already carries. Additive (a new optional request field; a caller that never sends
one is unaffected), and it is what makes the pre-dispatch input gate's findings FIXABLE
headlessly: four of its seven codes name a field of that bag, and until now the surface named a
remedy it did not offer.

1.22.0 belongs to `GET /api/v1/runs/:runId/outcome` and the verification report's new optional
`requirements.unmatchedVerdicts`. Two diffs claiming one number is a lie a consumer pinning
the version would act on, so re-read this line after any merge rather than trusting that the
VERSION auto-merged clean.

1.24.0, not 1.23.0: `PATCH /api/v1/tasks/:taskId` accepts `fields`, the task's per-type bag,
merged over what the task already carries. Additive (a new optional request field; a caller that
never sends one is unaffected), and it is what makes the pre-dispatch input gate's findings
FIXABLE headlessly: four of its seven codes name a field of that bag, and until now the surface
named a remedy it did not offer. This branch first claimed 1.23.0, which main then published for
`x-min-scope` while the branch was in flight: the collision surfaced as a conflict on this
comment block only because each version step writes its own paragraph here, never as one on the
VERSION line, which auto-merges clean to a number main has already used.

1.25.0, not 1.24.0: `gitlab` joins the `TaskSourceKind` enum, GitLab Issues being a fourth
built-in task source. Additive on a CLOSED vocabulary, which is the shape the SDKs are built to
tolerate: they map an unknown enum member through rather than refusing it, so a client compiled
against 1.24.0 keeps parsing every response it already understood and simply never asks for the
new source. No existing member changes meaning and no persisted `source` value moves.

1.26.0, not 1.22.0: a step's `toolServers` on `GET /api/v1/debug/runs/:runId` gains an optional
`observed`, the agent CLI's own account of the servers it managed to load beside the `wired` /
`unavailable` account of what the platform decided. Additive: a consumer written against 1.21.0
reads both existing lists unchanged, and an ABSENT `observed` is not an empty one: it means no
observation was made (a harness whose CLI publishes no such report, an older runner image, an
unmapped runner pool), which is a distinction a consumer has to keep or it will report working
servers as dead.

FIFTH number this one addition has held: written against 1.21.0 (the number the `toolServers`
record itself took), then displaced in turn by the run outcome endpoint, `x-min-scope`, the
task-`fields` patch and the GitLab source above, each published by main while this branch was in
flight. Not one of the five announced itself on the VERSION line, which auto-merged clean every
time to the number main had just used; every one surfaced as a conflict in THIS comment block,
only because each version step writes its own paragraph here. That is the whole reason the
paragraphs exist, and it is why the note at the top of the block says to re-read this line after
every merge rather than trust a clean one.

1.27.0: the verification report gains a `context` section and the run outcome summary a
`sources` one, both saying which linked pages a run's agents read and at which revision.
Additive on both surfaces (a new section object beside the existing ones, on two endpoints and
inside the PR body's fenced block), and inert for a consumer that ignores it: every section it
already reads is byte-for-byte unchanged. `PR_VERIFICATION_REPORT_VERSION` steps to 9 and
`RUN_OUTCOME_VERSION` to 2 with it.

1.28.0, not 1.26.0: the outbound webhook becomes a COLLECTION,
`GET /api/v1/notification-webhooks` plus `GET|PUT|DELETE /api/v1/notification-webhooks/:webhookId`,
beside the singular routes, which keep working and now address the `default` entry. Additive on
every axis: four new operations, and two new fields (`id`, `name`) on a response projection a
consumer already tolerates unknown members of. FOURTH number this one has held: it claimed

1.25.0, then 1.26.0, then 1.27.0, each published by main while the branch was in flight, and not
one of them announced itself on the VERSION line, which auto-merged clean to a number main had
already used every time. Re-read this line here, not there, after every merge.

1.29.0, not 1.28.0: a run's `diagnostics.lastDispatch` gains a `failure` object, and is now
stamped for INLINE steps as well as container ones. Additive on the wire: the new object is
present only on a dispatch that never reached a running job, `executionBackend` gains one
further value (`inline`) in a field already documented as free-form, and every existing field
is byte-for-byte unchanged. What DOES change for a consumer is the population: a pure-inline run
used to answer `diagnostics: null` on the debug overview and now answers a block, so a client
treating "no diagnostics" as "no agent work happened" reads differently. That is the point of
the change, and it is stated here rather than left for a reader to discover.

SEVENTH number for this one, displaced by the same five as the `observed` paragraph above plus
its own `toolServers` CLI record and the webhook collection. Two long-lived branches losing this
race independently is the case for reading the note at the top of the block rather than treating
it as history.

1.30.0, not 1.29.0: `POST /api/v1/keys` accepts an opaque `externalIdentity`, the identity a
provisioner is minting a key FOR, echoed on the key resource, on `GET /api/v1/me`, and on the
run projections as the identity the run was started for. Additive on every axis: one optional
request field, one nullable response field, and `null` is what every run and key that predates
it correctly reports. This branch first claimed 1.29.0, which main then published for the
dispatch-`failure` diagnostics above while the branch was in flight: the SECOND number this one
has held, and it surfaced here rather than on the VERSION line, which auto-merged clean to the
number main had just used. Re-read this line after any merge rather than trusting that.

1.31.0, not 1.30.0: board PROVISIONING and the relationships that outlive a create. Seven new
operations (`GET /api/v1/repos`, `POST /api/v1/services`, the two dependency writes, and the
three task-document routes), two new optional request fields (`autoStartDependents` on the task
patch), and three new response fields (`dependsOn` and `autoStartDependents` on the task
projection, `scope` on a run artifact, `output` and `data` on a run step). Additive on every
axis: nothing is renamed, retyped or re-scoped, and a consumer built against 1.30.0 keeps
parsing every response it already understood.

One population change is worth stating rather than leaving for a reader to discover, because it
is the point of one of the slices: `GET /api/v1/runs/:runId/artifacts` now returns the reference
designs attached to the run's TASK alongside the artifacts the run captured, each row saying
which it is. A consumer counting rows off that list to mean "screenshots this run captured" must
filter on `scope: 'run'`; one comparing a screenshot against the design it was judged against
finally has both, which is why the list was half the truth before.

1.32.0: the two cost/telemetry reads that were reachable only from a browser session. Two new
operations (`GET /api/v1/usage/spend`, `GET /api/v1/debug/runs/{runId}/llm-export`), no change
to anything already served. Additive on every axis, so a consumer built against 1.31.0 keeps
parsing every response it already understood.

Worth stating for a reader comparing the new spend read against `GET /api/v1/usage`: the two
answer different questions off the same ledger and will not tie out. `/usage` is the current
calendar month against the budget; `/usage/spend` is a rolling window snapped to a bucket edge,
and on `30d`/`90d` it is served from the durable rollup, whose attribution was frozen while the
money was spent. `source` and `since` on the response are what say which is talking.

1.33.0: the MERGE-EVIDENCE loop (ADR 0046) reaches `/api/v1`. Four new operations
(`GET /api/v1/runs/:runId/merge-record`, `GET /api/v1/merge-records/rollups`,
`GET /api/v1/merge-records/:recordId`, `POST /api/v1/merge-records/:recordId/effort`) plus an
all-optional body on `POST /api/v1/notifications/:id/act`. Purely additive: no existing path,
shape, scope floor or error vocabulary moves.

The scope split is the part worth stating. Recording how much review a merged pull request
needed is `write`, not the `admin` that `act` carries: `act` MERGES a pull request, where
tagging one that already landed merges nothing. An integration whose job is collecting evidence
therefore no longer needs a key that can also delete tasks and merge.

`act`'s new body is what gives the app's one-tap confirm-and-tag a headless equivalent, and it
reaches four published clients without breaking a caller because the emitters now render an
all-optional body as a parameter that may be OMITTED. Sending no body at all still works
(the route mounts `optionalJsonBody`), so an integration calling it since 1.0 is untouched.

1.34.0, not 1.32.0: `GET /api/v1/services/:serviceId/spec`, the service's in-repo requirement
tree. One new operation and its schemas; nothing existing is renamed, retyped or re-scoped, so a
consumer built against 1.33.0 is unaffected. This branch first claimed 1.32.0, which main then
published for the spend/export reads above while the branch was in flight, and then 1.33.0 went
to the merge-evidence loop: the THIRD number to move under a branch in flight, which is what the
note higher up is warning about.

One consequence is worth stating rather than leaving for a reader to discover, because it is a
commitment rather than an addition: the response serves `SpecDoc` and everything under it
(`SpecModule`, `RequirementGroup`, `RequirementItem`, `AcceptanceCriterion`, `DomainRule`) as the
SAME shapes the app's requirements window consumes, deliberately, so the two surfaces cannot
drift about one artifact. Those schemas were internal and freely breakable until this version;
from here they are part of the stable `/api/v1` surface and change on its terms.

1.35.0: one new `teardown` value, `retained`, on the environments section of the verification
report (`GET /api/v1/runs/{runId}/verification-report`). It says the run's Deployer DECLARED
that its environments outlive the run, so no reclaim is coming and none is missing. Additive:
no path, shape, scope floor or error vocabulary moves, and a consumer built against 1.34.0
keeps parsing every response it already understood.

It is worth naming what a consumer that does NOT recognise it will do, because this is an enum
on a field that already had five values and the SDKs tolerate unknown members by design: such a
consumer sees a value it cannot classify rather than a wrong one. That is the whole reason the
state is new instead of folded into `pending` — `pending` is a teardown still expected, and
reporting one that is never coming is the misreport the section exists to avoid.

1.36.0: one new endpoint, `GET /api/v1/runs/{runId}/spec`, at `read` scope. It serves the same
specification `GET /api/v1/services/{serviceId}/spec` does, read at the branch ONE RUN pushed its
work to rather than at the repository default. Purely additive: no existing path, shape, scope
floor or error vocabulary moves.

It is a second endpoint rather than a `ref` parameter on the first because the two answer
different questions, and the run one is what makes the criterion-to-evidence join complete: while
a run's pull request is open, every requirement that run ADDED is missing from the default
branch, so a caller joining `requirements` rows from `…/report` or `…/outcome` against the
service read finds no criterion for exactly the rows the run is about.

Its `anchor` carries a fourth value the service read cannot answer, `not_read`, and it is a `200`
rather than a refusal on purpose: the run's spec read is gated on a tester having reported, so
that the tree served is the one the verdicts were made against, and before that the platform has
consulted no tree. That is the same fact `requirements.spec: "not_read"` on the run's outcome
already states. `provenance` is null there, and only there.

1.37.0: one new value, `unusable_secret`, on the `reason` of a step's unavailable tool servers
(carried by the run reads that project `toolServers`). It says a credential the server declares
named a channel its transport does not have (a header on a `stdio` child process, no header on a
remote url), so the value resolved and reached nothing. Additive, and the SDKs tolerate unknown
members by design, so a consumer built against 1.36.0 keeps parsing every response it already
understood and sees a value it cannot classify rather than a wrong one.

It is a new member rather than a fold onto `missing_secret` or `reserved_secret` because those
two are what a consumer would act on wrongly: nothing is missing (the value resolved) and nothing
was refused (the platform withheld no key). Only a member of its own points at the declaration,
which is the one thing that has to change.

1.38.0, not 1.37.0: one new section, `environments`, on the run outcome summary
(`GET /api/v1/runs/{runId}/outcome`), plus the `version` field of that payload moving to 3. It
carries the throwaway environments the run stood up: where each one is, where it stands, when
its TTL lapses, and whether the run declared that it outlives the run. Additive: no path, shape,
scope floor or error vocabulary moves, and a consumer built against 1.37.0 keeps parsing every
response it already understood.

The rule the section commits to is worth stating, because it is what a consumer may rely on: a
`live` state is the ONLY one that means the URL is worth opening. Every other state still
carries the URL it had (an operator greps for it, and it says which environment the row is
about), so a client that renders the URL without reading the state beside it offers a link to
something that is no longer there. A client with a clock owes the other half of it: `expiresAt`
is served as an instant rather than folded into `state`, because the reduction is clock-free so
that the app composing it live and the endpoint composing it server-side cannot disagree about
one run, so a `live` row whose TTL has passed is not a URL to hand anyone either.

The number has now moved twice, both times for the same reason: main published 1.36.0 for the run
spec read while this branch was in flight, and then 1.37.0 for `unusable_secret` above. The second
move arrived exactly as the note higher up describes it, with the VERSION line itself auto-merging
byte-identically and only the prose beside it conflicting. Nothing about the section changed with
either move.

1.39.0: one new optional field, `frameIds`, on the run report's `scope`
(`GET /api/v1/runs/{runId}/report`, and the same block rendered into a pull request body). It
names EVERY involved service frame whose changes ride the pull request the report sits on,
where `frameId` names one. Additive: `frameId` keeps its meaning and its value (the first of
the set), so a consumer built against 1.38.0 reads exactly what it read before.

The field exists because the singular one was answering a question with no single answer. A
cross-service run checks out one repo per REPO, not per frame, so several involved services
living in one monorepo share a checkout, a work branch and therefore one pull request. The
report on it speaks for all of them, and naming only the first made every other frame look
like a service the run opened no pull request for. `frameId` stays because it is published;
read `frameIds` and treat `frameId` as its head.
