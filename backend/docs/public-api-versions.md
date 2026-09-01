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

1.39.0, not 1.38.0: one new value, `consensus_panel`, on the `reason` of a step's unavailable tool
servers (carried by the run reads that project `toolServers`). It says the step ran as a consensus
panel, so its participants were inline model calls with no checkout, no shell and no agent CLI, and
there was nothing for the server to be wired into. The same step with consensus off gets the server,
which is why the value points at the panel rather than at the kind or the credential. Additive, and
the SDKs tolerate unknown members by design, so a consumer built against 1.38.0 keeps parsing every
response it already understood.

It is a new member rather than a reuse of `harness_unsupported` because that is the one reuse a
consumer would act on wrongly: `harness_unsupported` says the resolved CLI cannot serve this server,
so the operator sent there widens a `harnesses` list that was never the constraint. Here the kind's
standard surface serves it perfectly and the panel is what withheld it.

Written against a main already on 1.38.0: the `environments` section above took that number while
this branch was in flight. The collision arrived exactly as the note at the top describes it, with
the VERSION line auto-merging byte-identically and only the prose beside it conflicting. Nothing
about the reason member changed with the move.

1.40.0, not 1.39.0: one new optional field, `frameIds`, on the run report's `scope`
(`GET /api/v1/runs/{runId}/report`, and the same block rendered into a pull request body). It
names EVERY involved service frame whose changes ride the pull request the report sits on,
where `frameId` names one. Additive: `frameId` keeps its meaning and its value (the first of
the set), so a consumer built against 1.39.0 reads exactly what it read before.

The field exists because the singular one was answering a question with no single answer. A
cross-service run checks out one repo per REPO, not per frame, so several involved services
living in one monorepo share a checkout, a work branch and therefore one pull request. The
report on it speaks for all of them, and naming only the first made every other frame look
like a service the run opened no pull request for. `frameId` stays because it is published;
read `frameIds` and treat `frameId` as its head.

Written against 1.39.0: the `consensus_panel` reason above took that number while this branch was
in flight, and the VERSION line auto-merged byte-identically as the note at the top of this file
says it does, conflicting only in this prose. Nothing about the field changed with the move.

1.41.0: eight new operations, no change to anything already published, so a consumer built against
1.40.0 reads and writes exactly what it did before. They close the one gap that made a fully
headless deployment impossible: everything needed to bring a workspace from "connected" to "able to
run a pipeline" existed only on the session-authenticated app API, so a caller that could provision
its own keys, enrol its own webhook and file its own work still had to open a browser first.

- `POST /api/v1/repos/bootstrap` + `GET /api/v1/repos/bootstrap/{jobId}`: create a repository and
  adapt it with the bootstrapper agent. `POST /api/v1/services` could only back a service with a
  repository that already existed.
- `POST /api/v1/environments/connections` + `.../test`: bind (or probe) the cluster per-run
  environments are provisioned onto.
- `PATCH /api/v1/services/{serviceId}`: patch a service, including the `provisioning` that says
  where its manifests live. A connected cluster alone provisions nothing without it.
- `GET /api/v1/models`, `GET /api/v1/vcs/connection`, `GET /api/v1/merge-presets`: what this
  deployment has WIRED. (The last of those is renamed to `GET /api/v1/risk-policies` in 1.43.0
  below, in place and with no dual-serving; the exception is argued there.)

All eight are `admin`. The three reads are `admin` rather than `read` even though `/repos` and
`/pipelines` are `read`, and the distinction is what each names: those name board CONTENT, where
these name deployment configuration, including the permissions the VCS credential holds. `admin`
can be relaxed later and a scope can never be tightened, so the reversible reading wins (ADR 0034).

Two shape decisions are worth recording because they are the ones a future change will press on.
The public `kubernetes` engine maps onto the internal `remote-kubernetes`, and the internal split
between that and `local-k3s` is deliberately not a public fact: one backend serves both and they
lower to the same provision config, so exposing the choice would freeze a decision that changes
nothing. And `failureKind` on a bootstrap job carries the FULL agent-failure vocabulary rather than
the narrower list a bootstrap is documented to reach, because the stored value is the shared
`agentFailure`: projecting through the narrow list would leave the mapper holding a value outside
its own type on the very path whose job is to say what went wrong.

Every request body here states its omitted-value rule in prose and carries no schema default. A
default means "always present" on the way out and "may be omitted" on the way in, and the SDK
emitter refuses that ambiguity outright; the defaults are applied in
`PublicProvisioningController`.

1.42.0: one new optional field, nothing else, so a consumer built against 1.41.0 reads and writes
exactly what it did before. The `ingressTemplate` environment-URL source gains `port`.

An ingress-template URL is derived as `scheme://<rendered hostTemplate>`, so a cluster whose ingress
controller answers on anything but the scheme's default port had nowhere to say so. The obvious
workaround, writing `{{branch}}.example.com:8080` into `hostTemplate`, yields the right URL and an
unusable manifest: that same rendered value is the Ingress `spec.rules[].host` a service declares,
and Kubernetes rejects a `host` carrying a port. `port` is therefore its own field, matching
`serviceStatus.port` beside it. Absent means the scheme default, which is what every existing
connection means today.

1.43.0: the two preset knobs become callable, and the one that shipped in 1.41.0 is renamed. Task
create and task PATCH gain optional `modelPresetId` and `riskPolicyId`, `GET /api/v1/model-presets`
lists the model library, and `PublicTask` reads both pins back (null ⇒ the task follows the
workspace default rather than holding a copy of its id). Additive, except for the rename below: a
consumer built against 1.41.0 keeps resolving the workspace default when it omits both fields.

**`GET /api/v1/merge-presets` becomes `GET /api/v1/risk-policies`, in place**, with the response
key `presets` → `policies`, each row's `presetId` → `policyId`, the SDK group `mergePresets` →
`riskPolicies`, the OpenAPI tag "Merge presets" → "Risk policies", and the refusal reasons
`merge_preset_not_found` / `merge_presets_unwired` → `risk_policy_not_found` /
`risk_policies_unwired`. The old path is REMOVED rather than served beside the new one.

That is a break, and ADR 0034 says a break takes an incremental migration path plus a version step.
This is a deliberate, owner-approved exception, and the argument for it is narrow enough to be
worth writing down so it is not read as precedent:

- The endpoint is one release old. It shipped in 1.41.0 the same day, and it has no known adopter,
  so the migration window a dual-served path exists to provide would protect nobody.
- The name it shipped under was already wrong. "Merge threshold preset" was renamed to **risk
  policy** across the domain, the SPA and the internal routes a month earlier, precisely because
  one policy row also caps CI-fixer attempts, requirement and tester iteration rounds, judge scores
  and the release-health watch window. The public surface was the last place still saying the old
  word.
- The alternative made it permanent. Keeping `merge-presets` while task create takes `riskPolicyId`
  puts two names for one concept on one wire: a caller reads an id from one and posts it under the
  other. Dual-serving the correction would leave both names on the surface for a release window
  and add a second SDK group and MCP tool for the same rows.

So the version step is a MINOR rather than a major: the exception is being taken because the
surface has no adopters, and a major would announce a migration nobody has to make.

What a consumer NOTICES about the pins is the refusal, not the fields. An id no library carries is
a `422` (`details.reason: 'model_preset_not_found'` / `'risk_policy_not_found'`) rather than a
silent fall back to the default, because the two are indistinguishable afterwards and a run that
quietly used another model succeeds while being about something else. A deployment with the library
unwired answers `503` (`'model_presets_unwired'` / `'risk_policies_unwired'`) for a caller that
pinned one, which is a different fact from an unknown id and needs a different fix; both list
endpoints answer with the same two reasons, so one condition is not reported two ways.

**The refusal does not name the library's contents.** Pinning takes `write` and listing takes
`admin`, so a `422` carrying the available ids would let the lower rung enumerate by typo exactly
what the higher one gates. It names the id that missed and which library it missed.

`riskPolicyId` is the one that changes what a caller may DO rather than what it may say: a policy
carries `autoMergeEnabled` and the score ceilings, so pinning one selects how much oversight
landing takes. It is exposed because withholding it was never the control it resembled (a caller
could always move the workspace default, which aims the same power at every other task too), and
the actual control is an admission rule over which policies a caller may pin:
`docs/initiatives/role-scoped-risk-policy-admission.md`. Until that lands, an `admin` key may pin
any policy its workspace holds, which is the authority it already had by editing one.

1.44.0: two new operations, no change to anything already published, so a consumer built against
1.43.0 reads and writes exactly what it did before. `GET /api/v1/repos/available` lists the
repositories the workspace's connection can REACH, and `POST /api/v1/repos/link` adopts one by
`owner`/`name`.

They close a hole that made headless setup impossible to finish rather than merely awkward, and the
hole was invisible from the surface. `GET /api/v1/repos` serves the repositories a workspace has
LINKED, which is a set someone assembles in the app: linking is explicit per workspace, the provider
webhook for an added repository does not project one, and a resync refreshes what is already linked
rather than rediscovering the installation. So a repository that exists and is perfectly reachable is
absent from every public read until a human opens the picker, and `POST /api/v1/services` answers 404
for its `repoId`, which is byte-for-byte what a caller gets for a repository that does not exist. A
deployment could create a repository through this API (1.41.0's bootstrap) and could not adopt one it
already had.

What a consumer NOTICES, beyond the two new methods:

- **The two reads are a population pair, not a duplicate.** `/repos` lists what is linked (every row
  carries a `repoId` a service can be created against); `/repos/available` lists what could be, with
  `linked` as the join. An absent repository is now diagnosable: reachable-but-unlinked appears in the
  second with `linked: false`, and one that does not exist appears in neither.
- **The adopt is IDEMPOTENT and answers 200 either way**, because the caller that needs it most is a
  setup script re-running itself. It answers with the same row shape `/repos` serves, projected from
  the same read, so `serviceId` and `linkedElsewhere` cannot come to mean something else here. The
  idempotency is resolved from what the workspace LINKS before the provider is consulted, so it holds
  for a repository the credential can no longer see (a personal repository, or a narrowed App grant):
  the alternative was a 404 for a repository `/repos` still lists, which reads to a setup script as
  "go and create it".
- **Both rows report whether the repository is spoken for**, from one account-scoped judgement.
  `/repos/available` publishes `serviceId` and `linkedElsewhere` as `/repos` does, because a
  repository nobody here has linked can still back a service on another board of the account, and the
  create refuses it either way. A discovery read that could not say so would hand a caller a
  repository whose very next call fails.
- **`truncated` on the available read marks a capped list.** The provider legs behind it stop at a
  page cap and a search cap, so on a wide connection the rows are a prefix and a reachable repository
  can be missing from them. That is the one absence this read exists to make actionable, so it is
  stated rather than left to look like non-existence. A point-read (`?q=owner/name`) resolves the
  exact slug directly and stays authoritative about that repository regardless.
- **`404` with `details.reason: 'repo_not_reachable'` covers two causes deliberately**: a repository
  that does not exist and one the workspace's credential is not granted are the same answer from a
  provider, and inventing a split would be a guess in the one place a caller acts on it.
- **Both take `admin`**, like every other operation in the provisioning group: the read names what the
  deployment's credential can reach, which is operator-facing, and the write changes what the
  workspace can run against.
- **`personal` is published on the available-repo row and is always false**, because an API key
  authenticates as the WORKSPACE: a repository only somebody's personal token reaches is not reachable
  by a key at all. It is stated rather than omitted so a caller comparing this list against what a
  colleague sees in the app knows why the two can differ.
- **Two new `details.reason` values ride along**, on these operations only: `vcs_credential_rejected`
  (503, the provider refused the workspace's credential) and `vcs_rate_limited` (429, worth retrying).
  These are the first two operations on the surface that reach the provider while a caller waits, so
  they are the first that could fail for a reason that is neither the caller's nor the platform's;
  without them both arrived as a `500 internal`, which tells a headless caller to report a platform
  fault about a credential only they can replace. Both operations answer them, and on whichever
  provider the workspace connected.
- **The link's `owner` accepts a namespace PATH.** A GitLab project can live under nested groups, so
  its owner reads `group/subgroup`, which is what the available read publishes; the adopt takes back
  exactly what it was given.

1.45.0: one new request field and one new response field, both optional, and no change to anything
already published. A consumer built against 1.44.0 mints exactly the key it minted before and reads
exactly what it read before, because the new identity's default IS the old behaviour.

`POST /workspaces/:ws/public-api-keys` (the session-authed mint, not `/api/v1` itself) takes
`actsAsSelf`, and every key resource now carries `actsAsUserId`. A key was always a workspace
credential belonging to nobody, which made one class of run impossible to start over this API at
all: a task pinned to an individual-usage model (Claude / Codex / GLM) runs on ONE person's
subscription, and there was no way for a headless caller to be that person. It was refused with
`409 individual_model_unsupported`, and the refusal was correct for the credential it was refusing.

The new identity is not a permission and is deliberately not spelled as one. A key minted with
`actsAsSelf` records its MINTER, and the only value the server will write is the id it reads off the
session, so the wire shape cannot express minting a key onto someone else's subscription. The
password is the other half and is never stored: such a key must send `X-Personal-Password` on each
call that advances such a run (start, retry, and each answered decision, because answering wakes the
next dispatch), and one that does not gets `428 credential_required` carrying `{ vendor, reason }` —
the same refusal, on the same header, that the app has always used. So the binding alone spends
nothing, and a leaked personal token cannot open a subscription.

`409 individual_model_unsupported` is unchanged for a system token and now means what it says: no
password would help. A personal token reaches the answerable `428` instead. The one operation that
still refuses both is `POST /api/v1/notifications/:id/act`, whose retry arm mints no activation.

`GET /api/v1/models` gained the case it most needed to cover, as a NEW per-model field rather than a
new meaning for the existing one. A personal SUBSCRIPTION — the commonest user-scoped credential —
was reported `available: false` with nothing saying why, so it read as "no provider is wired" for a
model the workspace ran every day. Each row now carries `userScoped`, true where the model runs on a
subscription vendor, so a token that resolved no user can say precisely which rows it could not judge.

`excludesUserScopedModels` keeps the meaning it was published with: models this answer could not
ENUMERATE, which is per-user locally-run endpoints. Widening it to "a personal subscription exists
here" was the alternative and was rejected: the server cannot know whether one exists without a user,
so the honest implementation would be `personalSubscriptions !== undefined`, true on every deployment
with `ENCRYPTION_KEY` set. A flag that is true everywhere says "this build supports withholding"
where a consumer reads "something was withheld from you", and it would have re-pointed a published
field at a different predicate under the same name. Personal tokens see it `false` where their own
endpoints resolved, which the field's own wording ("that this read cannot enumerate") already covered.

`X-Personal-Password` is now DECLARED on every operation that reads it (the two starts, the retry,
and each decision mutation), so it appears in `docs/openapi.json` and the generated clients document
it. Each official client also gained a way to supply it after construction
(`setPersonalPassword` / `set_personal_password` / `SetPersonalPassword`), because a caller learns it
is needed from a `428` and rebuilding a configured client to send one header is not a workflow.

1.46.0: two new operations, no change to anything already published, so a consumer built against
1.45.0 reads and writes exactly what it did before. `GET /api/v1/tracker/writeback` reports what a
task's LINKED tracker issue hears as its pull request opens, merges, or parks a requirements review,
and `PATCH /api/v1/tracker/writeback` changes it.

They close the last gap in the ticket-driven loop this surface otherwise supports end to end. A
caller has been able to file a task FROM a ticket since 1.30.0 (`ticket` on the create), and the
platform comments on that issue and closes it when the work merges, but WHETHER it does was
workspace configuration reachable only from the app. So the deployment shape that most needs the loop
closed, one with nobody in the SPA at all, was the one that could neither read the disposition nor
change it, and a caller had no way to tell "this deployment leaves tickets open" from "the writeback
is broken".

What a consumer NOTICES, beyond the two new methods:

- **The published shape is the WRITEBACK half of the workspace's tracker settings, not the whole
  row.** The rest of that row is the FILING selection (which tracker the tech-debt recurring pipeline
  raises its ticket on, plus that vendor's target), which is a separate decision with its own
  cross-field rules and is not what writeback keys off: the writeback follows each linked issue's own
  source, so a workspace with no filing tracker selected still writes back to the GitHub issue a task
  was filed from. Publishing both together would invite the reading that one gates the other. The
  path is `/tracker/writeback` rather than `/tracker/settings` so the filing half can be added beside
  it later, additively.
- **The write MERGES: an action a caller omits keeps its stored value.** That is now the rule on
  every door into this row, the app's own included, and the merge happens in the STORE rather than
  as a load-and-replace above it, so two callers naming different actions both land. The reading it
  replaces (an omitted action reverting to the deployment default) had no caller who wanted it, the
  actions being booleans anyone can restate, and one victim: the app's recurring-pipeline dialog
  persists a FILING tracker and names no action at all, so under the old rule scheduling a tech-debt
  pipeline re-enabled writeback on a workspace that had turned it off. What this operation keeps
  from the internal PUT is the SCOPE, not the merge semantics: it never names a filing tracker.
- **`updatedAt` is nullable, and null means nobody has chosen.** The values alongside it are then the
  deployment's defaults rather than anyone's decision, which is what a caller needs before
  overwriting a board it shares. It is null rather than the `0` the internal read spells an absent
  row as, because an epoch timestamp is a value a client formats and compares, and every one of those
  readings is "configured in 1970".
- **An empty patch is a no-op that does NOT stamp `updatedAt`.** Probing the endpoint cannot make the
  defaults look chosen.
- **The defaults themselves changed in this release, and that is a behaviour change rather than a
  surface one.** All three writeback actions are now ON for a workspace that has never configured
  them, where all three were off. It is not a `/api/v1` break (nothing published said what they
  were), and it IS a change a deployment can notice: a board that never opened the issue-tracker
  panel now closes a linked ticket when its task's pull request merges, and comments on it twice on
  the way. The actions only ever touch an issue a task is LINKED to, and nothing links one by
  accident, which is the reasoning behind the flip; a deployment that wants the old behaviour turns
  it off with one call to the new operation.

1.47.0, not 1.46.0: TWO new response fields on `GET /api/v1/models`, both additive, and nothing
already published changes meaning. Written against 1.46.0 and moved once main took that number for
the tracker-writeback pair above. The collision this file warns about, arriving exactly as described:
both sides wrote `'1.46.0'`, so the VERSION LINE auto-merged with no conflict and only this paragraph
came back as one.

`personalSubscription` is the first, and it exists because the field it supersedes could not be
corrected in place. `userScoped` (1.45.0) is derived from the route IN FORCE
(`flavor === 'subscription'`), and a model with more than one route resolves, when nothing is
configured, to the most-preferred route it merely DECLARES. `subscription` is last in that order, so
`claude-opus`, the built-in Claude preset's own model, which also declares OpenRouter, answered
`userScoped: false` and read as "no provider is wired". The version that shipped the flag to remove
that misreport left it in place for the commonest personal credential in the product;
`claude-sonnet` (subscription-only) was the case it did cover.

Fixing that reading in place would have moved a published field's meaning in BOTH directions at once,
which is the thing this surface does not do. It would have started answering true for `claude-opus`
(right) and stopped answering true for a POOLED vendor's model whose subscription route is in force
(also right, and also a change under a consumer already branching on it). So `userScoped` keeps
answering exactly what it always answered, `personalSubscription` answers the question both
corrections were reaching for, and the removal of the old half is a later change once consumers have
had a release window: true where the model DECLARES a subscription route whose vendor is
individual-usage only. The pooled exclusion is not a detail. A Kimi or DeepSeek token belongs to the
WORKSPACE, so every key can already see it, and reporting such a model as belonging to a person sent
an operator to re-mint a token when the fix was a pooled token or a provider key.

`subscriptionConfigured` is the second: whether a personal subscription for that row's vendor is
stored for the person the key belongs to (`actsAsUserId` when bound, else its MINTER), `null` when
there was nobody to ask about. `personalSubscription` alone tells a caller its answer is unreliable
and stops there; the operator's next move was to re-mint the token and see what happened, which is
what the first person to hit this actually did. Existence is a row lookup, so the deployment can
answer it without the personal password that OPENS the credential, which is precisely what 1.45.0's
rejected alternative got wrong. That entry concluded "the server cannot know whether one exists
without a user"; the correction is that an unbound key does have a user for DESCRIPTION purposes, its
minter, and reading it changes nothing about admission. `available` is still resolved under
`actsAsUserId` alone, so a system token reads `available: false` beside `subscriptionConfigured:
true` and the two statements are both true: the model is wired, and this credential may not spend it.

What that trades is stated rather than left implicit: on an unbound key the person asked about is the
MINTER, who need not be whoever holds the key, and provenance is never re-validated against current
membership. So an `admin`-scoped key learns one bit about a named colleague, including one who has
left. Contained by the bit being EXISTENCE only (never the person, the vendor account or the
credential) and by the route's `admin` floor; the alternative of reporting for the workspace's
members at large is strictly more leakage for the same remedy.

`null` is a third state and not a shy `false`, for the same reason `excludesUserScopedModels` exists:
"asked, and there is none" is a subscription to connect, where "there was nobody to ask" is a token to
mint in the app instead of through `POST /api/v1/keys`. A client that collapses them is back to
sending an operator to a screen that was already correct.

1.48.0, not 1.47.0: one additive enum member, `state_unreadable`, on the failure kind the
run-debugging reads report. A consumer built against 1.47.0 keeps parsing (the SDKs tolerate an
unknown member by design), and no existing value changes meaning. Written against 1.47.0 and moved
once main published the `GET /api/v1/models` pair above under that number, the same collision the
entry above describes: both sides wrote `'1.47.0'`, the version LINE auto-merged, and only the prose
came back as a conflict.

What a consumer NOTICES is a kind that could not previously be produced at all, because the runs it
describes could not previously be settled: a run whose stored row violates its own contract. Every
richer settle path begins by READING the run, so such a row used to stay `running` forever while
each recovery attempt threw on the load. It is now closed through the one write that decodes
nothing, and the kind says which runs those were rather than filing them under `stalled`, whose
whole advice is "retry" and whose retry would re-read the same row.

Where the kind actually surfaces is the operator's failure-kind breakdown, which aggregates the
`failure` column in SQL and so can report a row nothing can decode. It is deliberately NOT reachable
from the ordinary run reads, and that includes the debug ones: `GET /debug/runs` drops such a row
from its page and `GET /debug/runs/:runId` answers 500, because both decode the run before they
project it and the whole premise of this kind is that the decode fails. A consumer holding the id of
a `state_unreadable` run therefore sees it in the aggregate and cannot fetch it, which is the honest
outcome: the row is beyond what an API can say about it, and the fix is a person at the data.

1.49.0, not 1.48.1: two additive fields on `GET /api/v1/risk-policies`, `isUnattendedDefault` and
`autonomy`. No existing field changes meaning and no value changes shape, so a consumer built
against 1.48.0 keeps parsing unchanged.

What a consumer NOTICES is that `isDefault` was only ever half the answer to the question this
surface is asked. A workspace now carries TWO default policies, one for a run somebody started in
the app and one for a run nothing is watching, and every run a key starts resolves the SECOND. A
client that read `isDefault` to predict which policy would govern its own task was reading the
in-app row; `isUnattendedDefault` is the field it wanted. `isDefault` keeps its exact former
meaning rather than being re-pointed, which is why this is an addition and not a break: an existing
client is not wrong about anything it was told, it was told about a different scope.

`autonomy` answers the question a headless caller could not previously ask at all: whether a run
under this policy can reach a terminal state without a person. Under `attended`, a run can park on
a judgement call the API can LIST but only a human can settle (a companion at its rework cap, an
iterative review at its pass cap, untriaged follow-ups), and a caller with nobody to escalate to
waits indefinitely. Under `unattended` the platform takes the documented "proceed" answer to each
of those and records that it did. It never covers a gate the PIPELINE asked for: a human-test step,
a review gate or an approval gate stops the run under either value, which is what keeps the field a
statement about waiting rather than about oversight.

## 1.50.0

1.50.0, not 1.49.1: additive fields on each side of the pipeline question. `POST
/api/v1/services/:serviceId/tasks` accepts `pipelineId`, and `GET /api/v1/pipelines` reports both
`unattendedDefaultPipelineId` (on the list) and a per-row `unattendedDefault`. No existing field
changes meaning, so a consumer built against 1.49.0 keeps parsing and keeps behaving unchanged.

**Read the LIST-level field, not the per-row flag, to learn what an empty start body runs.** The two
carry the same answer where the answer is a row this list holds, and they part company where it is
not: a workspace that has never adopted the catalog's declared rung still resolves it (and adopts it
on that first start), so every row reports `unattendedDefault: false` while empty start bodies work.
The per-row flag exists for the ordinary case of marking which listed rung it is; only
`unattendedDefaultPipelineId` distinguishes "the workspace released its default" (`null`, and the
start call refuses) from "the default is a rung not in this list". Both are answered for the KEY that
asked, from the same resolution the start route runs, so a report and a start can never disagree.

One BEHAVIOUR change rides with them, and it turns a refusal into a run rather than the reverse:
`POST /api/v1/tasks/:taskId/start` with no `pipelineId`, against a task that pinned none, used to
answer `400 pipeline_required`. For a key that satisfies `decide` it now resolves the workspace's
default pipeline for a run nothing is watching and starts it. The refusal survives whenever no such
default resolves, so the error code is not retired and a client branching on it still needs to.

**A `write` key sees no change at all**, and that is a decision rather than an oversight. The seeded
default rung reaches a human test and a human PR review on a risky task, which
`pipeline_requires_decide_scope` rightly withholds from a caller that cannot answer a park — so
offering it there would trade an actionable "pass a pipelineId" for a 403 about a pipeline the caller
never picked. The scope that gains the fallback is the one that can answer what it starts.

That is worth stating as a change rather than filing under "it works now", because a `decide` caller
depending on the 400 as a validation signal (checking that a task is startable by trying it) will
now start work. The check that does not start anything is `GET /api/v1/tasks/:taskId`, which reports
the task's own pinned pipeline, plus `GET /api/v1/pipelines` for what an empty body would resolve.

`pipelineId` at creation is what makes the pairing usable: a caller that files a task now and lets
somebody start it later, from the board or from an empty start body, previously had to repeat its
pipeline choice on the start call, and a task filed by an integration and started from the app ran
whatever that board defaults to. Unlike `modelPresetId` / `riskPolicyId`, an id nothing defines is
NOT refused at creation: a dangling preset pin falls back to a default and runs, which is why that
one has to be caught at the write, while a dangling pipeline pin can start nothing and so refuses
loudly on its own at the start call.

## 1.51.0

1.51.0, not 1.50.1: one additive endpoint, `DELETE /api/v1/services/{serviceId}` (`admin`), which
deletes a service frame, its subtree and the run history recorded under it. Nothing existing changes
shape or meaning, so a consumer built against 1.50.0 parses and behaves identically.

**It closes the last board write with no headless door.** A key authenticates on `/api/v1` alone, so
until now a caller that could provision its own keys, adopt a repository, raise a service and file
work against it still had to ask a person to take one down. Whoever provisions a board is also
whoever has to reclaim it.

Two answers a caller has to branch on rather than retry:

- **`422` with `details.reason: 'service_has_unfinished_tasks'`** is the app's own guard, reached
  through the same service method. A frame holding a task that has not finished is refused rather
  than deleted, because deleting one discards work in flight along with its history. The caller that
  means it deletes those tasks first (`DELETE /api/v1/tasks/{taskId}`, which stops a live run) and
  calls this again; the alternative on the app side is archiving, which this surface does not offer.
- **`404` for an ARCHIVED service**, which is the same population rule every per-service endpoint
  here follows: an archived frame is absent from `GET /api/v1/services`, so it is absent here too. A
  caller that archived instead of deleting has to restore it in the app first.

A run under the frame is stopped and its container killed before anything is removed, so a delete
during a live run never leaves a container idling until its watchdog.

## 1.52.0

1.52.0, not 1.51.1: one additive field, `branchContentionRecoveries`, on every step of
`GET /api/v1/debug/runs/{runId}`. Nothing existing changes shape or meaning, and a consumer built
against 1.51.0 ignores it.

**It is the counter for a recovery that is otherwise invisible.** The harness checkpoint-pushes an
agent's commits while it works, so a push to the work branch can be REFUSED because the branch moved
under the run; the engine re-dispatches the step once, and the run then reports as an ordinary
success. The only trace that a whole agent run was spent twice, in tokens and in wall clock, is this
number. It sits beside `evictionRecoveries`, which exists for the same reason and answers the same
kind of question: reading the step alone, a re-dispatched run is indistinguishable from a clean one.

## 1.53.0

1.53.0, not 1.52.1: one additive field, `blockingFindings`, on the `approval-gate` entry of
`GET /api/v1/runs/{runId}/decisions`. Nothing existing changes shape or meaning, and a consumer built
against 1.52.0 ignores it.

**It closes a gap between what a caller may decide and what it can see.** A companion gate reporting
`exceeded: true` is answered with `resolve-exceeded`, and one of the three choices is `proceed`. Until
now the only prose on that decision was `proposal`, the companion's verdict SUMMARY, which the shipped
reviewer prompt forbids from restating the individual findings: the graded points lived only in
internal step state. So an integration answering `proceed` was accepting work whose stated must-fixes
it had never been shown. The engine's own unattended risk policies refuse that park for exactly this
reason, which made an external caller the one route past it and the one most in need of the detail.

Each entry carries the reviewer's note and the `anchorId` it targets; severity is not carried because
every entry is a `blocker` by construction. An empty array with `exceeded: true` is the OTHER cap: the
rework rounds ran out with the rating under the bar, which is a loop giving up rather than a review
objecting.

## 1.54.0

1.54.0, not 1.53.0: one additive enum member, `harness_shutdown`, in the run failure-kind
vocabulary (`GET /api/v1/debug/runs/{runId}`, the bootstrap-job projection, and any surface
carrying a failure kind). Nothing existing changes shape or meaning, and the SDKs tolerate unknown
enum values by design, so a consumer built against 1.53.0 keeps parsing.

This one was authored as 1.53.0 and collided with `blockingFindings` above, which reached main
first: both branches bumped the minor to the same number, so `API_VERSION` and the generated
`docs/openapi.json` auto-merged byte-identically with no conflict, and the only thing that objected
was this file's own section heading.

**What a consumer NOTICES is a population change**: a class of failure that used to arrive as
`evicted` now arrives under its own name. A container whose harness exited CLEANLY while a job was
still running was indistinguishable, to the engine, from one that vanished, so it was reported as
an eviction and re-dispatched on the crash budget. Those two need opposite handling: an eviction is
worth one fresh container, and a shutdown is caused by something that is still there on the next
attempt (a host restart, an operator, or, in the run that named this, the agent's own cleanup
command killing the harness process). A dashboard that counts `evicted` will see that count fall.

## 1.55.0

One additive enum member, `deploy_blocked`, in the notification-type vocabulary
(`GET /api/v1/notifications`, `POST /api/v1/notifications/{id}/act`, and the outbound
notification-webhook delivery contract). Nothing existing changes shape or meaning, and the SDKs
tolerate unknown enum values by design, so a consumer built against 1.54.0 keeps parsing.

**What a consumer NOTICES is a new card in an existing population, with an existing action.** It is
the `ci_failed` shape one step earlier in the pipeline: the machine gave up, the run failed, and
`act` retries it. A caller that branches exhaustively on notification type will meet a value it does
not know; one that treats unknown types as informational will simply leave the card open, which is
the safe reading. It is also in `DEFAULT_NOTIFICATION_WEBHOOK_TYPES`, so an endpoint registered
without an explicit type filter starts receiving it.

Its `act` retries the run, which puts it in the class the individual-usage credential guard refuses
headlessly: a workspace whose runs resolve to an individual-usage model gets a 409
(`individual_model_unsupported`) here, exactly as it already does for `ci_failed` and `test_failed`.

## 1.56.0, not 1.55.0

One additive enum member, `asset`, in the run-artifact kind vocabulary
(`GET /api/v1/runs/{runId}/artifacts`, and the artifact rows the blob endpoint is addressed from).
Nothing existing changes shape or meaning, and the SDKs tolerate unknown enum values by design, so
a consumer built against 1.55.0 keeps parsing.

The number moved because main reached 1.55.0 with `deploy_blocked` while this branch was in
flight: the collision this file's header warns about, arriving exactly as described. Both sides
wrote `const API_VERSION = '1.55.0'`, so the version line itself auto-merged clean and only the
paragraph beside it conflicted.

**What a consumer NOTICES is a new population in a list it already reads.** The two members that
existed are an EVIDENCE pair: a `screenshot` is what a run captured, a `reference` is the design a
human uploaded for it to be judged against, and pairing them by `view` is what the vocabulary was
for. An `asset` is neither half of that pair: it is a DELIVERABLE a media-generating step produced
and stored through the platform's own asset storage, so a caller that pairs screenshots against
references must filter it out rather than treat it as an unmatched capture. It also does not
expire: assets are exempt from the retention sweep that reclaims a run's screenshots, so a run's
artifact list can stay non-empty long after its evidence is gone.

## 1.57.0

Three additive changes, all from one place: gaps a third-party acceptance suite hit while driving a
deployment whose environments are provisioned by a backend the deployment itself registers
([ADR 0058](./adr/0058-acceptance-kit-consumer-gaps.md)).

**A new variant on `provisioning`.** `PublicServiceProvisioning` gains
`{ type: 'custom', manifestId, manifestPath? }` beside the `kubernetes` member, and the service
projection now serves it. The READ half is the one that mattered: the projection omitted every shape
it could not describe, so a service pinned to a custom backend and a service pinned to nothing
answered identically (`provisioning` absent), and a caller could not report the state, let alone
check it. A consumer that switches exhaustively on `provisioning.type` meets a value it does not
know; one that reads `manifestSource` off it must narrow on `type` first, which is what the variant
is for.

What it deliberately does NOT gain is the engine side. Registering a handler for a custom backend
means supplying an `environmentManifest`, whose `providerConfig` is an open
`Record<string, unknown>` by design, and freezing that onto a surface that may never be reshaped
would be a break waiting to happen. Pinning by an id the deployment already registered is closed and
stable; registering the handler behind it stays a composition-root act.

**A new read: `GET /api/v1/environments/connections`.** Handlers could be written here and never
read, so a deployment that seeds them programmatically had no way for a headless caller to confirm
the seed landed. It answers its OWN shape rather than the connect call's, whose `engine` is the
literal `kubernetes`: a list has to report every engine, including one a deployment registered
itself, and widening a shipped literal to a string would retype a field a released client already
narrows on.

**A new read: `GET /api/v1/repos/{owner}/{name}/contents`.** One file out of a LINKED repository, at
a ref, so a caller can grade what a run committed instead of grepping the agent's prose or holding a
second source-control credential. `path` is a query parameter because a repo-relative path contains
slashes and an OpenAPI path segment cannot. One file, no directory listing: a listing has its own
frozen-forever questions (pagination, recursion, large trees) and this surface should not answer one
by accident.

## 1.58.0

**A new resource: Kaizen entries** (`GET /api/v1/kaizen/entries`, `GET …/{entryId}`,
`POST …/{entryId}/acknowledge`). The platform's post-run gradings of its own agent steps, as a
backlog a consumer drains rather than a screen a person browses.

The gradings already existed and were already rendered, which is why this is a shape change rather
than a new feature. What did not exist was any way to READ them without naming a run or a task
first, and that is precisely what a consumer asking "what has the platform learned about my agents"
cannot supply: finding out is the question it is asking. The app's own reads are per board and
bounded (the Kaizen screen) or per run (the run window), so the newest entries pushed the rest out
of reach, and a poll loop re-reported the same rows every pass with no way to say it had dealt with
one.

Hence the second half, and the one part that is not merely a projection: an entry now carries
`acknowledged` / `acknowledgedAt` / `acknowledgedBy` / `acknowledgementNote`, written ONLY through
this surface and never by the grading sweep. `?acknowledged=false&settled=true` is the queue, and
acknowledging is what shrinks it. A re-graded row keeps its acknowledgement, so the queue never
re-fills behind a consumer's back.

`settled` is a filter of its own beside `status` because the drainable backlog is a SET rather than
one state: it selects exactly the gradings the acknowledge write accepts, from the same definition
that write is gated on. Spelling it as `status=complete` would silently drop the `failed` entries,
which are the ones naming a deployment-level problem, and a client-side union of two `status` calls
would miss any settled state added later.

Two refusal reasons are new, both on `error.details.reason`: `kaizen_entry_not_found` (a 404 shared
by the point read and the acknowledge write, so one value covers both doors) and
`kaizen_entry_not_settled` (a 409 for acknowledging an entry whose grading is still `scheduled` or
`running`, with `details.status` naming which). The second is deliberately not a 404: the entry
exists, and acknowledging it then would take it off the backlog before there were recommendations on
it.

Additive throughout: no existing field changed type or meaning, and `KaizenGrading` on the
session-authed surface gained the same acknowledgement fields, which is an internal shape rather
than part of this contract.

`task.serviceId` is resolved by walking board ancestry to the enclosing service frame, the same way
`GET /api/v1/services/{serviceId}/tasks` and `GET /api/v1/tasks/{taskId}` resolve it, so one task
cannot report a different service depending on which endpoint is asked. It and `task.serviceTitle`
are non-null together, both read off the one resolved frame, so a caller is never handed a
`serviceId` that `GET /api/v1/services/{serviceId}` cannot answer for. The entry's task `status` is
the same closed vocabulary `/api/v1/tasks` publishes, not the internal board one it mirrors.

## 1.59.0

The INLINE USE-CASE surface: `GET /api/v1/use-cases`, `GET /api/v1/use-cases/{useCaseId}` and
`POST /api/v1/use-cases/{useCaseId}/invocations`. A deployment registers named, non-container model
operations in code (kernel's `InlineUseCaseRegistry`), and a wrapper over this API discovers what it
may generate and runs one, synchronously, with no board task, repository, container or run behind it.

What a consumer notices is a new resource group and nothing else: no existing shape changed. The
group is deliberately not folded into `models`, which answers what this deployment could dispatch to
at all; a use case is a named piece of work that NARROWS that set to the models its author chose for
it, declares the parameter form it accepts, and states the temperature and output bounds an
invocation may steer within.

The refusals are the part worth reading before building against it, because two of them are choices
rather than mechanics. A model outside the use case's declared list is `422`
`use_case_model_not_allowed` and a model this deployment cannot serve inline is `503`
`use_case_model_unavailable`: neither falls back to another model, because a narrowed list that
silently substitutes is not a narrowing, and the caller would have no way to see it happened. And a
model that answers with no usable text is `503` `use_case_empty_reply` rather than a `200` carrying
an empty string, which a content editor would otherwise store as the model's answer.

The rest are ordinary: `404 use_case_not_found`, `422 use_case_parameters_invalid` (every problem at
once, from the same descriptor validator a reusable operation's create door runs),
`422 use_case_generation_out_of_range`, `429 budget_exhausted` (the tiered budget safeguard, which an
invocation answers to for the same reason the bug hunt's ranking does: it is a billable model call
that no run start gates, and the account and user ceilings apply as well as the workspace's) and
`503 use_case_models_unconfigured` for a deployment with no model provider at all. Discovery still
answers on such a deployment, with each model carrying `available: false` and its cause, so a wrapper
can tell an unregistered catalog from an unconfigured one.

Two name what happened at the VENDOR, and an exhaustive consumer switch needs both: `503
use_case_generation_failed` (the call was made and the provider answered with an error) and `503
use_case_generation_timeout` (it did not answer inside the deployment's per-invocation deadline).
They are separate because the caller's move differs, and the deadline itself is part of the contract:
a synchronous endpoint that held the request open for as long as the transport allowed would leave a
caller with nothing to reason about.

## 1.60.0

Two additions to the FOLLOW-UP TRIAGE surface, both about what answering a Coder's question
actually does.

`POST /api/v1/runs/{runId}/decisions/follow-ups/items/{itemId}/answer` gains an optional
`resolution`, either `answered` (the default, and byte-for-byte the prior behaviour) or
`closed`. The two are different
acts, and the endpoint previously had no way to tell them apart. `answered` says the reply carries
information the next Coder pass applies, so the item is folded into a send-back that spends a pass.
`closed` says the reply RULES ON the question without supplying anything to act on: the Coder asked
for a fact nobody has, or asked to widen scope and the answer is no. A closed item clears the gate
exactly as an answer does, spends no pass, and is carried into every later rework prompt as settled.

The distinction is not cosmetic and is the reason this shipped. An unattended caller that answers
every question with one fixed steer was, in effect, telling the Coder there was something new to
apply each time. There never was, so the Coder reworded its uncertainty in the code and re-raised
the same question under a new title, once per pass, until the send-back budget ran out. Callers
that answer with a standing policy rather than with facts should send `resolution: 'closed'`.

Alongside it, each item in a `follow-ups` decision gains `sendBackDropped`. It is true when the
item was decided for a send-back the Coder never received, because the step's loop budget was
already spent. Such an item reads `answered` or `queued` forever, which is indistinguishable from
one the Coder acted on; this is the only field that says the run advanced without applying a
decision somebody made. The same fact appears in the run's verification report
(`GET /api/v1/runs/{runId}/report`), whose payload gains a `followUps` section and moves to
`version: 10`.

## 1.61.0

The two halves a `custom` provisioning pin was missing: a catalog to check an id against, and a
way to take a pin back.

`GET /api/v1/environments/manifest-types` publishes every custom-manifest-type id this workspace
can pin, each with its `label`, its `defaultManifestPath` (null when the type declares none) and
its `source`: `registered` for one the deployment holds in code, `workspace` for an editable row.
Both tiers arrive as one list, the same one the app's own service inspector reads.

It exists because nothing checks a pin on the way in, which is the part worth reading. A `custom`
pin's `manifestId` is validated as a STRING and against no registry, so an id no handler serves is
accepted, reported back as configured, and fails at the `deployer` step of a run that has already
paid for a design pass and an implementation. Refusing the write instead would narrow what a live
integration may send, which this surface does not do; the catalog is the additive answer, and a
caller that lists before it pins can refuse before it spends.

Alongside it, the service provisioning variant gains an `infraless` member, which
`PATCH /api/v1/services/{serviceId}` accepts to take a stored pin back and leave the service with
no environment to provision. Omitting the key keeps its existing meaning exactly (the stored pin is
left alone, so a caller correcting a title does not un-deploy a service), and a member that was
previously rejected is now accepted, so nothing a consumer sends today changes meaning. Taking a
pin back removes the whole stored provisioning rather than the published half of it; a caller
narrowing a pin sends the member it wants instead. Until this shipped, a suite that pinned a shared
board's frame changed it permanently, because the variant had two members and neither meant "none".

The undo is a MEMBER rather than a `provisioning: null`, and that choice is a constraint on this
surface generally: a null-valued OPTIONAL field is not expressible from the Go, Java or Python
clients, each of which drops one when serializing (`omitempty`, `@JsonInclude(NON_NULL)`,
`if ... is not None`). A field where absent and null must mean different things is therefore a
shape only the TypeScript client can drive, and `/api/v1` does not have one.

## 1.62.0

`PublicRunStep` gains an optional `skipped`, true on a step the pipeline skipped rather than ran.

Additive, and it closes a hole a consumer could not work around: a skipped step's `state` is
`done` with no output, which is byte-for-byte what a step that RAN and produced nothing looks
like. Following a run's chain, the two are opposite facts (the engine decided the step was
unnecessary, versus the step happened and had nothing to say), and until now nothing on this
surface distinguished them. The acceptance kit's run-transition reducer already knew how to
announce the difference and could never observe it against real API data.

Present only when true, so a step that ran carries no flag rather than a `false` that a consumer
would have to read as "false, or this run predates the field". A boolean rather than the engine's
internal skip REASON: which axis skipped a step is a vocabulary the engine grows as it grows new
gating, and publishing it here would be a promise to keep that vocabulary still.

## 1.63.0

The provisioning-log `operation` vocabulary gains `remediate`: a row the platform appends when it
asks a provider to repair an environment in place, for the environment investigation's `restart`
remedy.

Additive, and the same shape `teardown-verify` took for the same reason: a distinct ACTOR gets its
own verb rather than being folded into an existing one. A restart is the one investigation action
that mutates a live cluster, and folding it under `status` (a read) or `provision` (a stand-up)
would report an operation that did not happen. The clients tolerate unknown enum values by design,
so a consumer built against 1.62.0 keeps parsing; one that maps `operation` through an exhaustive
table gains a member to name, which is what the vocabulary being closed is for.

What a consumer NOTICES beyond the new value: the environment rows for a run that hit the
investigation loop are no longer a complete account of what touched the environment unless
`remediate` is read. Before this, they silently were not.
