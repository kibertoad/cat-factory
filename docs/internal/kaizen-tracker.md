# Kaizen tracker

**What the platform's own graders have said about the agents this repo ships, filed once.**

After every run, the Kaizen agent grades each completed agent step on how smooth or chaotic the
interaction was and says what would have made it better, keyed by the `(agentKind, model,
promptVersion)` combo the step ran on. Those gradings live on a deployment as a backlog
(`GET /api/v1/kaizen/entries`, [public-api.md](../../backend/docs/public-api.md#kaizen-entries-apiv1kaizenentries)).
This file is where the ones worth acting on land, so a recommendation the grader made in July is
still findable in October and is not re-litigated every time it recurs.

Produced by the [`kaizen-sweep`](../../.claude/skills/kaizen-sweep/SKILL.md) skill, which pulls the
backlog, matches each recommendation against what is already here, and opens the PR that adds what
is new. **The sweep files; it never fixes.** Acting on an item is its own PR, and the item is where
that PR links from.

## How to read this

An item is a THEME, not an entry. The grader files near-identical recommendations across many runs,
so one item collects every entry that says the same thing and counts them: recurrence is the signal
that separates a one-run irritation from something the agents keep hitting.

Each item carries:

- **Status**: `open` (nobody has acted), `in progress` (a PR is up, linked), `done` (landed, with
  the PR), `dismissed` (with the reason, which is the part worth writing). Every item in every
  section carries one, the dismissals included, so filtering on Status reaches the whole file
  rather than the part of it that happens to be repo work.
- **Combos**: the `agentKind | model | prompt@vN` pairings the entries came from. A theme that only
  ever appears under one model is a model-selection finding; the same theme across four is a prompt
  or platform finding. Carried by the items whose subject is a prompt this repo ships; a
  deployment-level failure or a dismissal names none, because the pairing is not what it is about.
- **Combo status**: whether the pairing is still being graded. `combo.verified === true` means the
  streak threshold was crossed and the engine STOPPED scheduling gradings for it (`kaizen.logic.ts`,
  `nextComboState`), so a verified combo goes quiet whether or not anything was fixed. Any verdict
  leaning on "no later grading complained" needs this field, because without it that silence and a
  real fix are the same observation. A sweep that did not read it records that in its sweep-log row,
  so an item without the field is never silently missing it.
- **Occurrences**: how many entries say it, and the window they span. A single-entry item states its
  date instead, and says so where the sweep did not record one.
- **What the grader says**: the recommendations, quoted, with the auto-linking characters
  neutralised (see the writing rules in the skill). Never paraphrased into something stronger than
  what was said.
- **Verdict against HEAD**: what is true in the tree TODAY. A grading describes a run that already
  happened, on a prompt version this repo may since have moved past, so every item states whether
  it still reproduces. This is the field that decides whether an item is work or history.
- **Evidence**: the entry ids, and one `runId` to start from.

**Open items** is work this repo has not done. **Landed** holds the items whose fix is already in
the tree: they stay because the theme recurs, and the next sweep has to match a recurrence against
them rather than re-open it. Three further sections hold items that are not repo work at all, and
they exist so those entries are answered rather than silently skipped:

- **Handed to the workspace** is for recommendations about a deployment's own configuration or a
  task's authored inputs. Nothing in this repo changes for them.
- **Deployment-level failures** is for `failed` gradings, which name a deployment problem (prompt
  recording off, no grader model wired) rather than a run problem. One item per distinct cause, not
  one per entry.
- **Dismissed** is for recommendations this repo declines, each with the rule or design record it
  contradicts. A dismissal is what stops the next sweep from re-proposing it.

## Sweep log

One row per sweep, so a gap in the record is visible as a gap rather than as silence. `Read` counts
every entry the pull returned, `filed` the ones that became or joined an item, and `no finding`
the settled entries the grader had nothing to say about, which are real and are why the ledger
exists.

| Sweep      | Deployment / workspace                             | Read | Filed | No finding | Truncated | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | -------------------------------------------------- | ---- | ----- | ---------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-19 | local dev instance / `ws_6583a14a0fed4579a86ec62f` | 76   | 76    | 0          | no        | First sweep, so the whole backlog: 2026-06-29 to 2026-08-14, one page, 0 in flight. Of the 76 filed, 15 carried recommendations and became or joined KZ-0001 to KZ-0015 and KZ-0019 to KZ-0023; the other 61 are `failed` gradings and are covered by the three causes in KZ-0016 to KZ-0018. No finding is 0 because every entry the grader could complete, it had something to say about. Combo verification status was not read on this sweep, so nothing here rests on the absence of a later grading. |

## Open items

### KZ-0001: Gate a conditional prompt section on what was actually injected

- **Status**: open
- **Combos**: `pr-reviewer | anthropic:claude-opus-5 | 1`, `coder | anthropic:claude-opus-5 | build@v5` and `@v6`, `reviewer | anthropic:claude-opus-5 | 1`, `architect | anthropic:claude-opus-5 | 1`
- **Occurrences**: 8 entries, 2026-07-28 to 2026-08-13
- **What the grader says**: three sections keep being named. On the standards: "the BEST-PRACTICE ADHERENCE section instructs the agent to review against `<best-practice-standard>` blocks 'folded into this prompt above', but none were injected", and "the system prompt ends the role section with 'Treat every best-practice standard appended below as a hard requirement' but nothing was appended". On the spec: "the `spec/` navigation block is included unconditionally even though the architect step already established there is no `spec/` directory in this repo". On the catalog: "collapse the ~200-word reuse-mandate section to a single line plus the required fenced block" when it resolves to nothing. One entry adds a consequence rather than a cost: `fragmentAdherence` "is a required output field" and came back empty, "so a review isn't silently shipped with its judged-against dimension missing".
- **Verdict against HEAD**: still reproduces, all three, and the standards half is two separate strings across seven files rather than the one site a first read suggests. `STANDARDS_FOOTER` ("appended below") is the closing line of `prompts/standard.ts` (all four phases), `prompts/testing.ts`, `prompts/acceptance.ts`, `prompts/business-logic.ts` (twice), `prompts/mock.ts`, `kinds/code-commenter.ts` and `kinds/skill.ts`. Every one of those serves a `prompt`-delivery kind, where `foldStandards` returns the base prompt UNCHANGED on an empty fragment list (`runtime/fragments.ts`), so the pointer dangles by construction in all seven, and a fix that touches only `standard.ts` leaves six files emitting it. The BEST-PRACTICE ADHERENCE text the graders quoted is a SECOND constant, `FRAGMENT_ADHERENCE_GUIDANCE`, appended unconditionally to the `reviewer` companion (`prompts/companion.ts`) and dangling the same way; the `pr-reviewer` already carries the correct `FRAGMENT_ADHERENCE_GUIDANCE_CONTEXT_FILES` variant, which points at `.cat-context/standard-*.md` rather than at the prompt, so that kind is not part of this. An empty fragment list is also only one of three ways `composeBlockSystemPrompt` returns the base unchanged (`delivery: 'none'` unconditionally, `context-files` once `standardsDelivered`), so the condition to gate on is what was ACTUALLY delivered, which that function already models, not a length check. `SPEC_AWARE_GUIDANCE` and `FOUNDATIONAL_CATALOG_GUIDANCE` are static trait strings attached by TRAIT, not by presence (`kinds/traits.ts`). The engine knows all three answers at dispatch, which is what makes this a gating question rather than a prompt-wording one. The cost is already a stated concern in the tree: the spec block carries a comment that it is "kept to one imperative line ON PURPOSE" because it rides every turn of the implementer kinds. Fixing the footer means bumping `build` and `review`, the two standard phases under version control; `design`, `test` and the six other files carry no number.
- **Evidence**: entries `kzn_f4ca74d3b3b147b1bc5d3ea8`, `kzn_2a576d2d3f9642c8aa876025`, `kzn_e61eaeb40cae4b6ebae6e1ba`, `kzn_e97c831900ea43a29ace1414`, `kzn_721d8df72c3e44edabe6311d`, `kzn_5655ca16834c42bbb6f71e41`, `kzn_10df55de96b045c399919d66`, `kzn_6ce4818f5d6b43aabefd12d3`; run `exec_194b231198454c7785f29589`

### KZ-0002: The read-only guardrail and the effort-report guidance contradict each other

- **Status**: open
- **Combos**: `architect | anthropic:claude-opus-5 | 1`, `pr-reviewer | anthropic:claude-opus-5 | 1`
- **Occurrences**: 5 entries, 2026-07-28 to 2026-08-13
- **What the grader says**: "the READ-ONLY clause says the agent 'MUST NOT modify, create or delete files', and the very next paragraph orders it to write `.cat-effort.json` in the working directory". Another states the second half: the effort file is mandated "'after any commit/push' on a step that is forbidden to commit". Every entry proposes the same remedy, an explicit carve-out: "state explicitly that `.cat-effort.json` is the single permitted write and that no commit/push will occur".
- **Verdict against HEAD**: still reproduces, and it is structural rather than a wording slip. `applySurfaceDirectives` appends `READ_ONLY_GUARDRAIL` ("your written report is the only deliverable") to every read-only kind and every `container-explore` surface, then `buildKindBody` appends `EFFORT_REPORT_GUIDANCE` to EVERY container kind unconditionally, at the dispatch chokepoint, so the two always arrive together. That reaches every `container-explore` kind that does not declare `localWrites`: `architect`, `analysis`, `spec-writer`, `blueprints`, `pr-reviewer`, `bug-investigator`, `spike`, `merger`, `on-call`, the container-backed companions (`reviewer`, `doc-reviewer`) and every registered explore kind. It does NOT reach the inline companions `architect-companion` and `spec-companion`, which declare no `surface` in `companions.ts` and so never pass through `buildKindBody` at all; `merger` and `on-call` are the opposite case, both `container-explore` with no `localWrites`, so both get the contradicting pair. Scope the fix off the surface, not off a hand-listed set of kinds. HEAD already concedes the guardrail's wording is over-broad in one place: `localWrites` exists to exempt the tester because "the guardrail's wording ('must not create files')" otherwise "reads to that agent as a refusal to run the suite". This is the same wording problem, one exemption short.
- **Evidence**: entries `kzn_f4ca74d3b3b147b1bc5d3ea8`, `kzn_df3419ff44a2460a9f1d6431`, `kzn_e97c831900ea43a29ace1414`, `kzn_721d8df72c3e44edabe6311d`, `kzn_5655ca16834c42bbb6f71e41`; run `exec_f261f28a352145a794141516`

### KZ-0003: A rework round re-sends every prior artefact as prose instead of one open-points list

- **Status**: open
- **Combos**: `architect | anthropic:claude-opus-5 | 1`, `coder | anthropic:claude-opus-5 | build@v5` and `@v6`, `architect-companion | anthropic:claude-opus-5 | 1`, `reviewer | anthropic:claude-opus-5 | 1`
- **Occurrences**: 6 entries, 2026-08-12 to 2026-08-13
- **What the grader says**: "the same six points appear three times (reviewer feedback, per-part comments, and the round-1/round-2 history), which inflates prompt size and gives the agent no single authoritative checklist. Collapse to one numbered list of OPEN points with stable ids, plus a short list of CLOSED points not to regress." On the companion side: "the round-1 result appears once as the rendered Markdown summary and again immediately after as a near-identical bullet list". On the reviewer side: "deliver the previous round's findings as structured items (severity, file, line, and the producer's claimed disposition) rather than as free prose". And one asks for the missing direction: "carry adjudicated decisions forward into the REVIEWER's context, not just the coder's", after a point settled as out of scope was re-raised the next round.
- **Verdict against HEAD**: partly addressed, and the remainder is real. Severity now travels: `renderPriorReviewRounds` and `renderRevisionComments` order points worst-first and label each with its severity, and `ACCOUNTING_REVIEW_DIRECTIVE` tells the companion how to treat a producer's per-point answer. Carrying settled decisions into the REVIEWER's own context exists too, so that half is not the greenfield it reads as: `withPriorReview` branches on `context.role`, and for a grader it renders "Your own previous verdicts" followed by `PRIOR_ROUNDS_DIRECTIVE` ("Do not re-open a point you already accepted"), with `ACCOUNTING_REVIEW_DIRECTIVE` beside it ("A point argued against is settled on the argument, so accept a sound one and stop raising it rather than repeating it"). Whether that is ENOUGH for the case the grader hit is a question about the directive's effect, not about a missing channel, and the fix belongs in the text already there rather than in a second one beside it. What does not exist is the deduplication: `renderPriorReviewRounds` still renders every settled round in full (4000 chars for the latest, 1200 for each earlier one) alongside `renderRevisionComments`, so the same point still reaches the producer through two renderings. That is the open half of this item.
- **Evidence**: entries `kzn_df3419ff44a2460a9f1d6431`, `kzn_2a576d2d3f9642c8aa876025`, `kzn_26f4a6c4ae804b4c846d0f2e`, `kzn_7523cd8c5ff74f20b5608ce0`, `kzn_10df55de96b045c399919d66`, `kzn_6ce4818f5d6b43aabefd12d3`; run `exec_194b231198454c7785f29589`

### KZ-0004: The agent container's capability limits are never stated to the agent

- **Status**: open
- **Combos**: `coder | anthropic:claude-opus-5 | build@v5` and `@v6`, `architect | anthropic:claude-opus-5 | 1`
- **Occurrences**: 3 entries, 2026-08-12 to 2026-08-13
- **What the grader says**: "state up front that no Docker daemon is available in the agent container. The block requires a Dockerfile deliverable, but neither the coder nor the reviewer can build it locally; both discovered this independently and reported it." Also "no Docker daemon socket and no `kubectl`", where "two consecutive rounds were spent on the Dockerfile being unbuilt and on the wording of that disclosure, which is pure overhead the agent cannot resolve", and separately "declare the execution sandbox's Node version, or align it with the block's target", after a Node 26 sandbox against a Node 22 target produced an `EBADENGINE` defect the reviewer then flagged.
- **Verdict against HEAD**: still reproduces, but not as the flat fact the recommendation words it as, and the difference decides the fix. Docker is not absent by construction: the harness's `standUpInfra` runs `docker compose -f <path> up -d --wait` in the checkout on the local-infra path, and its own comment reads "a missing Docker daemon or a compose failure is logged and surfaced to the agent (as a prompt note) rather than failing the job". So a runner image with a daemon is a supported shape, and a channel for telling the agent when there is none already exists on that path. Hard-coding "no Docker daemon is available" into the coder and architect prompts would therefore be false on some deployments and a duplicate of that note on others. What IS missing is that no coding or design kind is told anything about the daemon, `kubectl` or the image's Node version outside it: the fact reaches exactly one kind, `prompts/mock.ts` telling the `mocker` its WireMock runs "in the SAME container (no docker-compose, no Docker-in-Docker)", plus code comments in `frontend-infra.ts` and `job.ts`. The fix is to state the RESOLVED capability of the image the job runs on, which the harness knows and the prompt does not, rather than a constant. That the harness owns the fact at all is what separates this from the cluster and registry questions in the same gradings (see Handed to the workspace).
- **Evidence**: entries `kzn_2a576d2d3f9642c8aa876025`, `kzn_721d8df72c3e44edabe6311d`, `kzn_10df55de96b045c399919d66`; run `exec_194b231198454c7785f29589`

### KZ-0005: Ship a containerized-service deployment best-practice fragment

- **Status**: open
- **Combos**: `architect | anthropic:claude-opus-5 | 1`
- **Occurrences**: 2 entries, 2026-08-13
- **What the grader says**: "five of the seven reviewer findings are from one recurring class", listed as: a numeric UID being required when `runAsNonRoot` is set, `readOnlyRootFilesystem` needing an `emptyDir` at `/tmp`, registry pull-side auth (GHCR being private by default), `imagePullPolicy` with immutable SHA tags plus push/apply ordering, gating the image push on lint/typecheck/test, and the cross-file name and label contract between Deployment, Service and Ingress. "Encoding these as standing context would likely have made this revision round unnecessary", and "shipping these as standards would let round 1 land what round 2 had to be told".
- **Verdict against HEAD**: still reproduces, and the seam is ready for it. `@cat-factory/prompt-fragments` ships 12 built-in fragments across the six collections `src/index.ts` spreads by name: `node` (2), `react` (1), `acceptance` (3), `design` (1), `style` (2) and `migration` (3). There is no deployment, container or Kubernetes collection. `playwright.e2e` is a fragment id inside `acceptance`, not a collection of its own. Its index documents the pattern for adding one. This is the one item in the batch asking for new content rather than a fix, so it is also the one whose value depends on whether these findings recur outside the deploy-shaped tasks this deployment happens to be running.
- **Evidence**: entries `kzn_e97c831900ea43a29ace1414`, `kzn_5655ca16834c42bbb6f71e41`; run `exec_194b231198454c7785f29589`

### KZ-0006: A prior round that cleared its bar is rendered as "did not meet the bar"

- **Status**: open
- **Combos**: `reviewer | anthropic:claude-opus-5 | 1`
- **Occurrences**: 1 entry, 2026-08-12
- **What the grader says**: "the prompt states a bar of 0.80 and records round 1 as 'rated 0.86, did not meet the bar'. Either the comparison or the rendered bar is wrong."
- **Verdict against HEAD**: the comparison is right and the rendering is wrong, so half of this is real. `disposeCompanionVerdict` sends the FIRST batch raising anything beyond a nit back for a round "even from a producer that scored well", and holds on any open `blocker` whatever the rating; both are deliberate and documented. But `renderPriorReviewRounds` prints `round.passed ? 'met the bar' : 'did not meet the bar'`, which asserts a comparison that did not happen. HEAD already knows the flag is ambiguous: `companionVerdictSchema` notes that "`passed: false` on a round whose rating cleared `threshold` is only readable next to the `blocker` that held it", which is a fact the producer's prompt does not render. Naming the actual cause is the fix, per this repo's rule that causes needing different reactions must not render the same.
- **Evidence**: entry `kzn_e61eaeb40cae4b6ebae6e1ba`; run `exec_8609dc0eb3704159aea84147`

### KZ-0007: The `reviewer` companion re-derives a branch diff the `pr-reviewer` is handed

- **Status**: open
- **Combos**: `reviewer | anthropic:claude-opus-5 | 1`
- **Occurrences**: 1 entry, 2026-08-13
- **What the grader says**: "pass the branch diff (changed-file list, or the diff itself) into the prompt for review steps. The agent is told to diff against the base branch and read changed files in full; supplying that up front would remove a chunk of the ~40 exploratory calls without weakening the 'don't judge from the summary alone' rule."
- **Verdict against HEAD**: still reproduces, with a good citizen to copy. The `pr-reviewer` kind is given `.cat-context/pr-diff.md` and its prompt opens by telling it to read that first and build its review plan from it (`kinds/pr-reviewer.ts`). The `reviewer` companion gets no equivalent. Worth scoping before acting: the ~40 calls are a claim about one run, and the same entry reports that run was well cached, so the saving is call count rather than tokens.
- **Evidence**: entry `kzn_6ce4818f5d6b43aabefd12d3`; run `exec_194b231198454c7785f29589`

### KZ-0008: The companion's pass threshold is stated only in the trailing rework note

- **Status**: open
- **Combos**: `architect-companion | anthropic:claude-opus-5 | 1`
- **Occurrences**: 1 entry, 2026-08-13
- **What the grader says**: "state the numeric bar (0.80) inside the system prompt's anchored scale rather than only in the trailing rework note, so the 0..1 anchors and the pass threshold are defined in one place."
- **Verdict against HEAD**: plausible, and deliberately unverified in this sweep. The threshold is a per-step operator setting that `disposeCompanionVerdict` reads, so where it reaches the model is a prompt-assembly question rather than a fixed string; whoever picks this up should confirm the scale anchors and the bar really do arrive in two places before moving either. Filed as stated, which is to say as a readability claim with no defect behind it.
- **Evidence**: entry `kzn_7523cd8c5ff74f20b5608ce0`; run `exec_f261f28a352145a794141516`

### KZ-0009: Revision rounds pay cache writes for material that did not change

- **Status**: open
- **Combos**: `pr-reviewer | anthropic:claude-opus-5 | 1`, `architect-companion | anthropic:claude-opus-5 | 1`
- **Occurrences**: 2 entries, 2026-07-28 to 2026-08-13
- **What the grader says**: the earlier one reports "3,078,625 prompt tokens against 27,234 completion tokens over 40 calls" and asks to "cache the static system+context prefix on the orchestrator". The later one is narrower and is the actionable half: "62k cache-write tokens against 26k cache reads over 4 calls suggests the stable material is being re-written each turn. Order the context so the invariant parts (system prompt, block description, pipeline context) precede the volatile parts (current revision text, prior verdicts) to maximize prefix reuse across revision rounds."
- **Verdict against HEAD**: the blunt version is stale and the ordering claim is open. Caching is clearly working on the later runs, which report 2.49M cache reads against 72 fresh input tokens, and 113.8k of 138.5k input served from cache, so the 2026-07-28 reading of a 113:1 ratio is partly PR 1989's capture bug, and specifically the half of it that lost per-call OUTPUT tokens on every harness-served call: an under-counted denominator is what inflates a ratio. The same digest's input-class misreporting pushed the other way (see KZ-0010), so that reading measures neither side cleanly. What neither is evidence against is the ordering point: a revision round that puts changing text ahead of invariant text pays a fresh write for the whole prefix, and nothing in this sweep establishes which order the rework prompt is assembled in. Verify that before acting.
- **Evidence**: entries `kzn_f4ca74d3b3b147b1bc5d3ea8`, `kzn_febedd4f4a09484a88ce7dea`; run `exec_194b231198454c7785f29589`

<!-- Item shape, kept here so every sweep writes the same one:

### KZ-0001: <one line naming the change, not the symptom>

- **Status**: open
- **Combos**: `coder | anthropic:claude-... | build@v6`
- **Combo status**: still being graded (`verified: false`)
- **Occurrences**: 4 entries, 2026-08-02 to 2026-08-17
- **What the grader says**: "<quoted recommendation>" (and 3 more saying the same)
- **Verdict against HEAD**: still reproduces; `build@v6` is the shipping version and says nothing
  about <the thing>.
- **Evidence**: entries `kz_...`, `kz_...`; run `exec_...`
-->

## Landed

The fix is already in the tree. These stay rather than being deleted: the theme recurs, and a
recurrence needs an item saying "done, here is the PR" to match against, or the next sweep opens a
second one and argues the work out again.

### KZ-0010: Subscription-run token accounting and finish reasons were unreadable

- **Status**: done (PR 1989)
- **Combos**: `spec-writer | anthropic:claude-opus-4-8 | spec-writer@v1`, `architect | anthropic:claude-opus-4-8 | 1`, `pr-reviewer | anthropic:claude-opus-5 | 1`, `architect | anthropic:claude-opus-5 | 1`, `architect-companion | anthropic:claude-opus-5 | 1`, `coder | anthropic:claude-opus-5 | build@v5`, `reviewer | anthropic:claude-opus-5 | 1`
- **Occurrences**: 9 entries, 2026-07-06 to 2026-08-13
- **What the grader says**: the most repeated complaint in the backlog. "Prompt tokens summed to 8 across 8 calls, which is impossible"; "62 prompt and 198 completion tokens summed over 34 calls is impossible, and 34/34 finish reasons are `unknown`, which means truncation, output-limit hits and stop reasons are all undetectable here. Right now a truncated run would grade as clean." And on the reporting side: "with 85% of stop reasons unrecorded, the reported '0 truncated calls' is not trustworthy".
- **Verdict against HEAD**: already addressed, and the graders were right about the symptom and wrong about the layer for two of the three. PR 1989 (2026-08-13) fixed the real capture bug: per-call output tokens were lost on every harness-served call, because `attributeCumulativeUsage` guarded on whether ANY tokens had been reported and the input side always satisfied that. It also stopped recording an unreported finish reason as `stop`, and rewrote the digest that had been misleading the grader, which summed `promptTokens` alone (FRESH input by definition, so a handful of tokens on a cache-heavy run) and rendered a null finish reason as a value beside a flat zero truncation count. `digestCalls` now reports input as three classes and says outright that a finish reason nobody reported means truncation is UNKNOWN rather than none. The verdict rests on that code read, and the surrounding evidence is weaker than it looks. PR 1989 merged on 2026-08-13 and this item's window ends on 2026-08-13, so "all 9 entries predate the merge" is not checkable from a tracker that records dates only. The silence since is partly circular: the rewritten `digestCalls` now tells the grader outright not to report an unreported finish reason as a telemetry defect, so no later grading would raise that complaint whether or not the capture was fixed, and this sweep did not read whether these combos are still being graded at all. What does corroborate is the narrow half the prompt says nothing about, which is that the gradings after the merge read the three token classes correctly.
- **Evidence**: entries `kzn_b8aa5a13c2d347329529f4b3`, `kzn_46a04abf75114814acdee250`, `kzn_f4ca74d3b3b147b1bc5d3ea8`, `kzn_df3419ff44a2460a9f1d6431`, `kzn_292d57c4ec714ebbbc76030d`, `kzn_2a576d2d3f9642c8aa876025`, `kzn_e61eaeb40cae4b6ebae6e1ba`, `kzn_e97c831900ea43a29ace1414`, `kzn_26f4a6c4ae804b4c846d0f2e`; run `exec_8609dc0eb3704159aea84147`

### KZ-0011: A companion rework loop spun on materially identical revisions

- **Status**: done (PRs 1984, 1989, 2000)
- **Combos**: `architect | anthropic:claude-opus-5 | 1`, `architect-companion | anthropic:claude-opus-5 | 1`, `coder | anthropic:claude-opus-5 | build@v5`, `reviewer | anthropic:claude-opus-5 | 1`
- **Occurrences**: 4 entries, 2026-08-12
- **What the grader says**: all four entries of one run describe the same standstill from their own side. "It burned a full review cycle to re-emit an unchanged 0.76 on text the agent itself recognized as materially identical to three prior rounds"; "the step's final answer is identical to the 'Your previous proposal' text quoted back to it"; "the final answer here is a verbatim repeat of round 1, which is 13 calls of inspection spent to reproduce an existing string". The asks: "add a no-progress stop condition", "diff before dispatching", "cap the number of rounds per block and escalate to a human when a round yields no material change".
- **Verdict against HEAD**: already addressed. PR 1989 added exactly this rule: a companion rework loop now stops when the producer returns the text it was asked to revise and the rating does not move, taking the same iteration-cap exit. Its review pass then narrowed the rule to producers whose deliverable IS their reply, because a container-coding kind pushes commits and may legitimately answer with nothing, which had made two empty coder summaries look like a standstill; a human-requested rework is excluded, and the park states which of the two things happened. PR 1984 had already made a companion rework round actually re-run its producer, and PR 2000 holds a run while a must-fix is open, whatever the rating. The three gradings after PR 2000 show a loop that terminates on its own, which corroborates rather than proves: this sweep did not read whether these combos are still being graded, and a verified combo goes quiet for a reason that has nothing to do with the fix.
- **Evidence**: entries `kzn_df3419ff44a2460a9f1d6431`, `kzn_292d57c4ec714ebbbc76030d`, `kzn_2a576d2d3f9642c8aa876025`, `kzn_e61eaeb40cae4b6ebae6e1ba`; run `exec_8609dc0eb3704159aea84147`

### KZ-0012: Anchored companion findings reached the producer as "On this part: (empty)"

- **Status**: done
- **Combos**: `architect | anthropic:claude-opus-5 | 1`, `coder | anthropic:claude-opus-5 | build@v5`
- **Occurrences**: 2 entries, 2026-08-12
- **What the grader says**: "all six per-part comments render as 'On this part: (empty)', so location-specific feedback arrives with no location", and from the coder's side, eight discrete asks arrived "buried in a wall of quoted review text plus five 'On this part: (empty)' comments with no anchor".
- **Verdict against HEAD**: already addressed, and the fix names this exact failure in its own comment. `renderRevisionComments` now branches on what the point actually carries: a quoted span renders as `On this part:` with the quote, an anchor id renders as ``On item `<id>`:``, and a point with neither renders as `On your proposal overall:`. The code notes that the `(empty)` placeholder "was every companion finding, since a companion anchors by id and quotes nothing", which is why two entries of one run both hit it.
- **Evidence**: entries `kzn_df3419ff44a2460a9f1d6431`, `kzn_2a576d2d3f9642c8aa876025`; run `exec_8609dc0eb3704159aea84147`

### KZ-0013: The companion summary layout contradicted the per-point accounting it was asked for

- **Status**: done (PR 2000)
- **Combos**: `reviewer | anthropic:claude-opus-5 | 1`, `architect-companion | anthropic:claude-opus-5 | 1`
- **Occurrences**: 3 entries, 2026-08-12 to 2026-08-13
- **What the grader says**: "it commands 'Nothing else: no preamble, no closing paragraph, no group for what is already fine' with only `**Must fix**`/`**Should fix**`/`**Minor**` allowed, then the user prompt demands a per-earlier-point addressed/still-open status, which has nowhere legal to go". The consequence, from another entry: "the agent had to invent an unspecified second block and pack nine dispositions into one ~120-word sentence, violating the 'under four sentences' rule". Both propose a structured field, one spelling it `priorPoints: [{anchorId, status, evidence}]`.
- **Verdict against HEAD**: already addressed, and close to what was asked for. The quoted instruction is gone: it was present in PR 2000's parent commit and no longer exists anywhere in the tree. `REVIEW_FINDINGS_LAYOUT` now requires every point as its own graded `comments` entry carrying `severity` and an optional `anchorId`, with the summary reduced to a two or three sentence verdict that must NOT restate them. The accounting requirement was resolved from the other side too: `ACCOUNTING_REVIEW_DIRECTIVE` tells the companion to rate the WORK and never the accounting, "so a missing accounting is not a finding, the points it leaves open are". Two of these three entries were graded after that merge, which is the reason to hold the verdict on the code read rather than on the dates.
- **Evidence**: entries `kzn_e61eaeb40cae4b6ebae6e1ba`, `kzn_7523cd8c5ff74f20b5608ce0`, `kzn_febedd4f4a09484a88ce7dea`; run `exec_194b231198454c7785f29589`

### KZ-0014: Inline agent kinds recorded no context snapshot at all

- **Status**: done (PR 1989)
- **Combos**: `architect-companion | anthropic:claude-opus-5 | 1`
- **Occurrences**: 2 entries, 2026-08-12 to 2026-08-13
- **What the grader says**: "enable prompt/context recording for `architect-companion`: no provided-context snapshot was captured, so the quality of the system prompt and injected fragments could not be assessed at all", and "with no SYSTEM/USER prompt or injected-context snapshot, context gaps and prompt-driven detours are invisible to this review; grading is currently limited to counters".
- **Verdict against HEAD**: already addressed, and it was a platform gap rather than the deployment setting the grader assumed. PR 1989 found that `agent_context_snapshots` had exactly one producer, the container executor, so no inline kind ever recorded one; it added the inline recorder as a required dependency key, had it record the rework it answers, and read its per-workspace gate through the shared cache. This is NOT the same cause as the 34 `failed` gradings below, which are the deployment's own recording setting.
- **Evidence**: entries `kzn_292d57c4ec714ebbbc76030d`, `kzn_26f4a6c4ae804b4c846d0f2e`; run `exec_d793d361cd5146268674d886`

## Handed to the workspace

### KZ-0015: Facts about the target cluster, registry and repo conventions the block description never states

- **Status**: open (nothing in this repo changes)
- **Occurrences**: 5 entries, 2026-07-06 to 2026-08-13
- **What the grader says**: "state the platform's manifest-application semantics in the block prompt: whether the apply step supplies `-n {{namespace}}` or whether `metadata.namespace` is expected on each resource. The agent had to assert one and the reviewer's second must-fix exists solely because that fact was unavailable." Also "state where `{{image}}` resolves from and whether the target cluster is already authenticated to that registry", "state the target cluster's IngressClass", and "who owns pull credentials for whatever `{{image}}` resolves to". Two entries name a self-contradiction in the authored text: "the system blurb calls this 'a paginated product catalog' while the block mandates 'returns the whole catalog'. The agent had to spend a decision entry on the conflict in both rounds." A separate 2026-07-06 entry asks to "front-load the repo's HTTP conventions as an injected context fragment" and to "point the architect at the existing sibling CRUD modules (`grass`, `kenguroos`) by name".
- **Why it is not repo work**: every one of these is content the deployment authors. The `{{namespace}}` and `{{image}}` placeholders belong to that workspace's own block description, the cluster and registry are its infrastructure, and per-repo HTTP conventions and sibling module names are what the workspace standards catalog and the foundational-services tiers exist to carry. The platform seam for all of it already exists and is unpopulated on this deployment, which is the same fact the empty-catalog dismissal below records from the other side. Two of these consumed a design revision and at least two review rounds each, so they are worth someone's attention, just not a change here.
- **Evidence**: entries `kzn_46a04abf75114814acdee250`, `kzn_e97c831900ea43a29ace1414`, `kzn_721d8df72c3e44edabe6311d`, `kzn_5655ca16834c42bbb6f71e41`, `kzn_10df55de96b045c399919d66`; run `exec_f261f28a352145a794141516`

## Deployment-level failures

### KZ-0016: No telemetry captured, so the gradings had nothing to judge

- **Status**: open (deployment configuration, plus an unverified platform half)
- **Occurrences**: 34 entries, 2026-07-01 to 2026-08-14, across `reviewer`, `coder`, `architect`, `architect-companion`, `researcher`, `spec-companion`, `spec-writer`, `mocker` and `blueprints`
- **What the deployment reports**: "No telemetry was captured for this step (prompt recording may be off), so it cannot be graded".
- **Verdict against HEAD**: a deployment setting explains half of it, and the earlier reading of this item filed the whole thing as one. `KaizenService` settles `failed` only when there is NEITHER a context snapshot NOR any recorded call for the step (`if (!snapshot && stepCalls.length === 0)`), and those two halves have different causes. The snapshot is double-gated by design, on `LLM_RECORD_PROMPTS` AND the per-workspace `storeAgentContext`, so recording off accounts for its absence. It does not account for the missing calls: `LlmObservabilityService.record` drops prompt and response BODIES behind that same gate while stating in code that "numeric telemetry is always recorded regardless", so a `llm_call_metrics` row lands either way. Zero rows needs a separate cause, and for the inline kinds in the list above (`architect-companion`, `spec-companion`) the candidate is the one KZ-0014 names: an inline call reaches the store only through the `InlineLlmCallRecorder` port, which nothing wired before PR 1989, so this is NOT cleanly distinct from that item. It is still the LIVE failure cause, its window running to 2026-08-14, later than any other entry in this pull. But turning recording on may not settle it, so whoever picks it up should check, per affected kind, whether any `llm_call_metrics` row exists for the run before concluding the deployment is at fault.
- **Evidence**: entries `kzn_45335c05cacc47928a623228`, `kzn_a1694dceacd949dcad7f22b1`, `kzn_b4f9dbd5a0db4df5a4668bf5`, `kzn_a5140f5bdf424b0c8cd02b9b` (30 more in the ledger)

### KZ-0017: The grader model resolved to a provider this deployment has no credentials for

- **Status**: dismissed (working as designed; the message this recorded was replaced in PR 1027)
- **Occurrences**: 24 entries, 2026-06-29 to 2026-07-05, across `mocker`, `blueprints`, `coder`, `merger`, `conflicts` and `tester-api`
- **What the deployment reports**: "Unsupported model provider: qwen".
- **Verdict against HEAD**: working as designed, and the message has since been made actionable. `qwen` is a known provider throughout the platform (`providers/endpoints.ts`, `contracts/api-keys.ts`, `domain/model-catalog.ts`), but a provider is registered only when its credentials are configured, so resolving one that is not registered throws rather than failing deep in the SDK. The bare wording these entries recorded no longer exists: PR 1027 (2026-07-11, after the last of these) replaced it with `unsupportedModelProviderMessage`, which names the workspace AI provider key pool as the primary fix, the deployment-level env vars as the alternative, lists what IS registered, and links the model-support doc. Nothing to do beyond configuring a key on that deployment.
- **Evidence**: entries `kzn_371bb39ab34d495bb776018c`, `kzn_1177dc17b6044b129587f1b6`, `kzn_69ca9ae3f33e4961b8b490fc`, `kzn_3042d5b8b8a647dd9a3c481f` (20 more in the ledger)

### KZ-0018: A sealed credential failed to decrypt and the raw Web Crypto exception was recorded

- **Status**: done (PRs 598, 1035, 1934)
- **Occurrences**: 3 entries, all 2026-06-30, one run
- **What the deployment reports**: "The operation failed for an operation-specific reason".
- **Verdict against HEAD**: already addressed, three times over. That string is the opaque `DOMException` Web Crypto raises when AES-GCM authentication fails, which for a sealed credential almost always means the wrong key. These entries are from 2026-06-30, one day before PR 598 made credential-decrypt failures actionable and isolated; PR 1035 and PR 1934 elaborated the messages further. HEAD now rethrows a message naming the cause and the remedy while keeping the DOMException as `cause`, and the tests pin that the opaque string never reaches the surface message.
- **Evidence**: entries `kzn_fdbbd71f1a5e4874992fd2ef`, `kzn_511bc806c21245699084473d`, `kzn_840bd8e1d3aa4428baf6b532`

## Dismissed

### KZ-0019: Do not inject the foundational-services catalog when it is empty

- **Status**: dismissed
- **Occurrences**: 5 entries, 2026-08-12 to 2026-08-13
- **Dismissed because**: it asks for the failure mode this repo has a rule against. Two entries want the 106-char catalog file dropped when nothing is registered ("stop injecting `foundational-services/catalog.md`", "a 98-char 'none' file"). The file's own code states the opposite and gives the reason: an empty catalog renders as an explicit "none are registered" line "rather than nothing", because absent and empty are different facts and "none are registered" is one an architect may act on. That is CLAUDE.md's "absent and zero must never render the same" and ADR 0031's three-states rule, where a missing declaration, an empty one and an unknown id each need a different reaction. The agent reading it and saying it designed from scratch is the designed behaviour, not friction. The separable half of the same recommendation, shortening the static GUIDANCE that mandates preferring an existing service, is filed as KZ-0001 and is not dismissed.
- **Evidence**: entries `kzn_2a576d2d3f9642c8aa876025`, `kzn_e97c831900ea43a29ace1414`, `kzn_721d8df72c3e44edabe6311d`, `kzn_5655ca16834c42bbb6f71e41`, `kzn_10df55de96b045c399919d66`

### KZ-0020: Drop the "your deliverable is your final reply" clause from a JSON-only prompt

- **Status**: dismissed
- **Occurrences**: 1 entry, 2026-08-13
- **Dismissed because**: the two directives do different jobs and only one of them is about the channel. The recommendation reads them as redundant: "drop the duplicated 'Your deliverable is the text of your FINAL reply' harness clause when the prompt already mandates 'Respond with ONLY a JSON object'". But `FINAL_ANSWER_IN_REPLY` exists because some reasoning models emit the whole answer into their private reasoning channel and return an empty visible reply, which the harness reads as unusable and fails the run; "respond with only a JSON object" constrains the FORMAT and says nothing about which channel it lands in. CLAUDE.md requires the fragment on exactly this class of agent, and the companion is one.
- **Evidence**: entry `kzn_7523cd8c5ff74f20b5608ce0`

### KZ-0021: The `.cat-context` foundational-services path is inconsistent

- **Status**: dismissed
- **Occurrences**: 2 entries, both 2026-08-13
- **Dismissed because**: the inconsistency is in the agent's reply, not in the prompt. Two entries report "three variants" of the catalog path and ask the prompt to "quote the exact injected path". The prompt builds it from one constant: `FOUNDATIONAL_CATALOG_FILE` is `foundational-services/catalog.md` and the guidance interpolates it as `.cat-context/foundational-services/catalog.md`. The digest's `foundational-services/catalog.md` is the same path relative to the context directory. The third variant, `.cat-context/catalog.md`, appears only in the agent's own proposal. There is one canonical path and it is already quoted correctly.
- **Evidence**: entries `kzn_e97c831900ea43a29ace1414`, `kzn_5655ca16834c42bbb6f71e41`

### KZ-0022: Harden the spec-writer's JSON-only instruction against a prose preamble

- **Status**: dismissed
- **Occurrences**: 1 entry; this sweep did not record its date.
- **Dismissed because**: the platform already does the alternative the recommendation itself offered. The entry reports a two-sentence preamble before the JSON and warns "if downstream persistence parses strict JSON this leading prose will break it", proposing either a harder instruction ("the FIRST character of your reply MUST be `{`") or making "the platform tolerant of a leading-prose prefix". Kernel's `extractJson` is the tolerant branch and has been: it scans forward from each candidate bracket and skips any span that does not parse, with preamble prose named in its own doc comment as the case it handles. The parse did not break and could not have. Nothing to change, and the alternative fix would mean bumping `spec-writer@v1` for a defect that does not exist.
- **Evidence**: entry `kzn_b8aa5a13c2d347329529f4b3`

### KZ-0023: Do not spend a review round on work that already cleared the bar

- **Status**: dismissed
- **Occurrences**: 1 entry, 2026-08-12
- **Dismissed because**: it is the rule, deliberately. The entry reads "rated 0.86, did not meet the bar" against a stated 0.80 and concludes "as-is the platform burns full review rounds (13 model calls each) on work that already passed". `disposeCompanionVerdict` sends the FIRST batch raising anything beyond a nit back for one round "even from a producer that scored well", and its comment says that is "the whole reason a threshold governs the SECOND pass onward". A `minor`-only batch is explicitly not enough to spend a round. The half of this entry that is real, the prompt asserting a bar comparison that did not happen, is filed as KZ-0006.
- **Evidence**: entry `kzn_e61eaeb40cae4b6ebae6e1ba`

## Swept entry ledger

**The authoritative dedupe key.** Every entry id the sweep has READ is here, including the ones
that produced no finding, and an id in this list is never filed again. It has to hold the
no-finding entries too: without them, an entry the grader had nothing to say about would be
re-read, re-judged and re-argued on every sweep, and "we looked and there was nothing" would be
indistinguishable from "we never looked".

The ledger, not the sweep dates, is what makes a sweep incremental. Acknowledging entries on the
deployment (the sweep's optional closing step) shrinks the backlog the pull returns, but it is not
what prevents duplicates here: a tracker whose repo is restored from an older commit, or a
deployment whose acknowledgements were cleared, still dedupes correctly off this list.

**Watermark**: none. 76 entries swept, none compacted; the oldest id below is from 2026-06-29.

<!-- Compaction, for when this list grows past a few thousand ids:

Replace the ids created at or before a stamp with `**Watermark**: <ISO> (<epoch ms>), <n> entries
swept`, and pass `--since <epoch ms>` on the next pull. The stamp may only be a value strictly
BELOW the oldest entry any sweep has seen still being graded (`counts.oldestUnsettledCreatedAt` in
the pull's output), because an entry that was in flight when a sweep ran settles later while
keeping its original `createdAt`: a watermark above it would hide it forever. When no sweep has
seen an unsettled entry, the ceiling is the oldest `createdAt` in the current pull. -->

```text
kzn_f7a9c19b36244e7291789b6a
kzn_3b758f26f8204c6081681119
kzn_75258d205fb24e048b0451d6
kzn_dfdf3699eba44dc2896d30e8
kzn_3a20625fed7346c59e3af80a
kzn_840bd8e1d3aa4428baf6b532
kzn_511bc806c21245699084473d
kzn_fdbbd71f1a5e4874992fd2ef
kzn_78af08085444463fabccd6f1
kzn_16a68ef680fc4865af77866f
kzn_ed7b69f5bea44a5ba2373676
kzn_67b12e5761d74a008e66ee86
kzn_88b187b998f9498ba120f49e
kzn_d7ec972783dd4990a24650f1
kzn_cadd3f6329fb420eb6c6f57c
kzn_6764d52adaa64550936a2a3e
kzn_b2bf7bec7ad849e283a54be7
kzn_e8146a9cf1a947f5b8b6c782
kzn_7f81429bcea64f559abc18b8
kzn_b76176c204704da68c7a81a7
kzn_5dbb62bf70af4a8cbbdc8dc2
kzn_1e5d0373f5a844c59f859b82
kzn_e5df1938a59e447aa7c83f6d
kzn_a80785f523ac48e3a4df6e32
kzn_4bb10d7e27e44b0d99a1fb82
kzn_aa5bd196a911429ea58d8142
kzn_e1c28da9312240e5bd98397c
kzn_492ae1ca644a445f8537c164
kzn_30dc2b40589f4ce0847be3bc
kzn_4afc39aac5f84b50b3f6a3b5
kzn_58ab19bb29354553baeffd41
kzn_8c2c913f453f474b9c97a8b7
kzn_7e6754575005438ca9999c63
kzn_7f8bfb3cc1f64777998bca47
kzn_bfaf6d2ac041484f84d3d121
kzn_9e48af6c1bac4c4db12fa4a4
kzn_2147d1c8133f4463b1f01f09
kzn_cdc844a1fae74b2cab9cb77e
kzn_3042d5b8b8a647dd9a3c481f
kzn_1fee90d3022043fe83cfb07f
kzn_73450080b1bc4be78b2bf2b7
kzn_76e4a3ec95b4477e8f710108
kzn_69ca9ae3f33e4961b8b490fc
kzn_1177dc17b6044b129587f1b6
kzn_371bb39ab34d495bb776018c
kzn_03cc4d5c5a614e35adbfe891
kzn_0f21f4c4e88e4dbca00bca1b
kzn_47a39abd77414124ae2e3ee9
kzn_a076f2632daa4aac9c14c24f
kzn_f7b19d1eedcf4ec4957d4f73
kzn_4eff7febee91483c8241c3f4
kzn_b8aa5a13c2d347329529f4b3
kzn_f89f11e921bf49b0b419349f
kzn_46a04abf75114814acdee250
kzn_d7584c5459fd47b3bfa6fec6
kzn_255f7fa9f7694419a59f2e76
kzn_e403d155177a4094ac3f815b
kzn_0df4188f76514a0696138504
kzn_0facaca4719146aca9187810
kzn_f4ca74d3b3b147b1bc5d3ea8
kzn_df3419ff44a2460a9f1d6431
kzn_292d57c4ec714ebbbc76030d
kzn_2a576d2d3f9642c8aa876025
kzn_e61eaeb40cae4b6ebae6e1ba
kzn_e97c831900ea43a29ace1414
kzn_26f4a6c4ae804b4c846d0f2e
kzn_721d8df72c3e44edabe6311d
kzn_7523cd8c5ff74f20b5608ce0
kzn_5655ca16834c42bbb6f71e41
kzn_febedd4f4a09484a88ce7dea
kzn_10df55de96b045c399919d66
kzn_6ce4818f5d6b43aabefd12d3
kzn_a5140f5bdf424b0c8cd02b9b
kzn_b4f9dbd5a0db4df5a4668bf5
kzn_a1694dceacd949dcad7f22b1
kzn_45335c05cacc47928a623228
```
