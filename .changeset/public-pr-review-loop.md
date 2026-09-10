---
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/conformance': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Drive the whole PR deep review through `/api/v1`

Triggering a review of an existing GitHub or GitLab pull request, reading back its prioritized
findings and posting the ones a person kept as inline comments was already reachable over the
public API, one call at a time. Driving it end to end was not, for three reasons that only show up
once something goes wrong.

**A `post` that failed reported nothing.** A partial or total failure re-parks the review at
`awaiting_selection` with its resolution cleared, which is byte-for-byte a review nobody has
curated yet: a caller that posted seven comments and landed none read back the state it held a
moment before, and either looped or reported success. The `pr-review` decision now carries
`postReport` (what was attempted, what posted, what was folded into the summary comment because its
line falls outside the diff or the branch moved, and the provider's own error per finding) and
`postedFindingIds` (what a retry skips, so re-posting the same selection never double-comments).
The report names the PASS it describes (`attempt`, against the decision's `postAttempts`), because
a retry that fails identically leaves an otherwise byte-identical report and the defect would
reappear one level in; `postedBody` states whether the summary comment has landed, so
`bodyPosted: null` is readable as "suppressed, it already went" rather than "there was none". A
finding dismissed after a failed pass loses its `failures[]` row with it, so no id on this surface
names a finding the caller can no longer see.

**A wedged review had no exit but throwing the work away.** The reviewer fans its slices out across
parallel subagents and emits findings only in a final aggregation turn, which can hang with every
slice finished; the watchdogs cannot see it and the 60-minute kill discards the lot. The app could
already re-dispatch only the slices that never reported, and now so can a key:
`POST /api/v1/runs/{runId}/decisions/pr-review/resume`. BOUNDED, unlike the app's own resume, and
projecting the evidence a bound needs (`resumeAttempts` / `maxResumeAttempts`, `reportedSlices`,
`lastActivityAt`): each call stops the running reviewer and starts a fresh container, so a poller
resuming on a timer shorter than the review takes would otherwise kill it forever, each time it
was about to finish. A person clicking Resume in the window is watching what they nudged, which is
the judgement a headless caller cannot supply.

**A `write` key could start a review it could not finish.** Both `pl_review` and `pl_bug_fishing`
are single-step pipelines whose step parks the run for a person to curate what it found, and public
admission could not see that park: the two kinds park through machinery of their own rather than
through anything a registry declared, so a `write` key was admitted and then held a run whose every
verb needs `decide`. Both kinds now carry a `curation-gate` trait, which is the sixth park mechanism
admission enumerates and the fourth it derives from a registration, so a deployment's own curating
kind is seen with no edit there. **Starting either preset now needs a `decide` key**
(`403 pipeline_requires_decide_scope`), and so does RETRYING a run whose stored steps carry one: a
start path is not the only way to set a park in motion. The refusal names `pr-review` as answerable
through the decision surface and `bug-fisher` as not, and it names the DECISION KINDS rather than
the park surfaces, three of which are spelled differently in the two places (a `pr-reviewer` step
is answered by a `pr-review` decision, both brainstorm kinds by one `brainstorm`), so an
integration mapping the refusal onto `decisions[]` no longer hunts for an entry that is never
there. A run parked on the curation this API cannot answer now NAMES that wait
(`unanswerable[].reason = "curation_gate"`), which is what makes "honestly reported as parked with
nothing to answer" true rather than an empty list plus an approval that would end the run.

OpenAPI `info.version` 1.71.0 → 1.72.0. The Python and Java clients (Kotlin with them) carry the
new operation and models too, so their manifests move 0.6.0 → 0.7.0: for those two the version
change IS the release, so regenerating without it would have shipped the loop in two clients of
four.
