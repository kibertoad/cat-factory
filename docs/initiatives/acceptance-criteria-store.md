# Initiative: service acceptance criteria — verification & lifecycle

Status: **redirected** (the original design is withdrawn — see below) · Owner: platform ·
Started: 2026-07-27 · Redirected: 2026-07-27

## Goal

A service should accumulate a durable, checkable answer to "what is this supposed to do", and a
pull request should be able to show **criterion → evidence** rather than only "the suite went
green".

## What was built first, and why it is withdrawn

The first design (PR #1387) introduced a new `acceptance_criteria` table: per-service-frame rows
with a `proposed`/`confirmed`/`retired` lifecycle, accreted by an LLM extraction pass on
requirements-review settlement, injected into every dispatch prompt, ruled on by the tester, and
rendered on the PR verification report.

**It duplicated machinery the repo already has.** The review that surfaced this is worth recording
in full, because the duplication was not obvious from inside the feature:

- `contracts/src/spec.ts` already defines the **prescriptive, service-level, in-repo spec** under
  `spec/` — explicitly "aggregated across every task" — whose `acceptanceCriterionSchema` is the
  same three fields (`given` / `when` / `outcome`), with stable ids and `sourceBlockIds`
  provenance. The new table's contract even cited that schema as its naming precedent without
  treating it as prior art.
- The **`spec-writer` step already performs the extraction.** `agents/kinds/spec-blueprints.ts`
  instructs it to emit each requirement "with a MoSCoW priority (must/should/could) and structured
  Given/When/Then acceptance criteria", from the _same_ incorporated requirements document, one
  step after the accretion hook fires (`seed.ts`: `requirements-review` → `spec-writer`). The
  accretion pass was therefore a second, weaker implementation of an existing pipeline step —
  weaker because its output lands in a side table nobody reviews rather than in a PR diff, and it
  produces no Gherkin.
- The **tester is already pointed at those criteria** (`prompts/testing.ts`: "Start from … the
  Gherkin acceptance scenarios in `spec/features/*.feature`. Walk the scenarios … and confirm the
  running service actually behaves that way"), so `criteriaVerdictsSection` and
  `TestReport.criteriaVerdicts` re-asked for something the tester already does against a better
  source.
- The **preservation argument does not hold.** Criteria were keyed to the SERVICE FRAME, so an
  abandoned task never lost them; and short of deleting the block, the incorporated document
  already survives a retry (block + `requirement_reviews` intact), a stop-reset (explicitly kept
  "as a base to rework from"), and a failed run (block `blocked`, review intact). There was no
  loss to prevent.

The result was two sources of truth for the same service's behaviour, both interpolated into the
same build prompt, neither aware of the other — and an extraction pass that would re-propose,
forever, criteria already written into `spec/`, because it deduplicated only against itself.

## Decision

**`spec/` is the durable behaviour contract. There is no second store.** The remaining work is to
close the gaps in `spec/` that motivated the table in the first place — not to maintain a parallel
copy of it.

Rationale, in order of weight:

1. The producing step (`spec-writer`), the structured shape, the Gherkin render, the tester's
   consumption and a human review gate (the PR diff) all already exist and are already wired
   together. The table reproduced four of those five, worse.
2. A criterion that lives in the repo is reviewed as code, versioned with the code it describes,
   and visible to anyone who clones — none of which a row provides.
3. Backwards compatibility is a non-goal here and the table is unreleased, so withdrawing it is a
   delete rather than a migration. This is the cheapest moment it will ever be.

The one thing `spec/` genuinely lacks — and the reason a lifecycle looked necessary — is an
**implementation-state axis**: `requirementItemSchema` carries `kind`, `priority`,
`sourceBlockIds` and `acceptance`, but nothing saying whether the behaviour is _true yet_. Without
it, a requirement agreed but not built is indistinguishable from one the service actually honours,
so it enters every prompt as STANDING behaviour and draws a `not_met` from the tester on every
subsequent run. That is the real gap, and it is a two-field change to an existing artifact.

## How to proceed

Phases are ordered so each one is independently landable and the cheapest decisions come first.
**Do not start Phase 2 before Phase 0 reports**, because Phase 0 can cancel it.

### Phase 0 — Measure before building (half a day)

Three queries against either facade's schema; they decide how much of the rest is worth doing.

| Question                                                                         | Query                                                                                  | What it decides                                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| How often does a block run more than once (restart under the same requirements)? | count of executions grouped by `block_id`, distribution of the count                   | If high, the surviving `requirement_reviews` row is already doing the job           |
| How often is a block deleted while carrying a settled review?                    | blocks absent from `blocks` whose `requirement_reviews` row reached `incorporated`     | If near zero, no preservation mechanism is warranted at all                         |
| How often does a run reach `spec-writer` at all?                                 | steps with `agentKind = 'spec-writer'` that completed, over runs that settled a review | The share of settled reviews whose criteria never reach `spec/` — the true gap size |

Write the numbers into this document. If the third is close to 100%, Phases 2 and 3 are
unnecessary and the initiative ends at Phase 1.

### Phase 1 — Implementation state on the in-repo spec (the actual fix)

Add the missing axis to `contracts/src/spec.ts`'s `requirementItemSchema`:

- A field distinguishing **agreed-but-not-built** from **observed-true** (suggested:
  `state: 'aspirational' | 'established'`, defaulting to `aspirational` for a newly written
  requirement). Prefer a FIELD over a separate `spec/` sub-folder: a folder encodes the state in
  the path, so every promotion is a file move and the state cannot be queried without walking the
  tree. The markdown/Gherkin render can group by the field and read identically.
- Only `established` requirements render as STANDING behaviour in the build prompt.
  `aspirational` ones render in a clearly-labelled backlog section that says they are not yet
  true, so an agent neither implements them by accident nor treats their absence as a regression.
- The tester's existing verdicts are the promotion signal: a first observed pass moves
  `aspirational` → `established`. No human action, and it self-maintains across every path —
  including a later task that deliberately changes the behaviour, which no abandonment hook would
  catch.
- Update `spec-blueprints.ts` so the spec-writer emits the field, and the `.feature` render tags
  aspirational scenarios so a runner can skip them.

This is the whole of the drift problem, solved where the artifact lives.

### Phase 2 — Criterion → evidence on the PR report (only if Phase 0 justifies it)

The one genuinely new capability #1387 identified. Re-point it at `spec/`:

- `PrVerificationReportController` resolves the run's service `spec/` through the existing
  checkout-free `RepoFiles` port (`RequirementReviewService` already reads `spec/overview.md` this
  way, so the pattern exists), and joins the requirement ids to the tester's verdicts.
- Keep #1387's report discipline verbatim: `hostMarkdown.cell` on every hole, `cap()` with a
  `truncations` note, and `absent`-WITH-a-note distinguishing "no criteria recorded" from
  "criteria recorded, nobody checked them".
- The tester already reports against `spec/features/*.feature`; ask for the verdict keyed by the
  spec requirement id rather than inventing a second id space.

### Phase 3 — Only if Phase 0 shows a real gap

If a material share of settled reviews never reach `spec-writer` (parked-then-abandoned runs), the
cheapest fix is to make the spec-writer's ingest independent of the run: let a human promote a
settled review's document into `spec/` from the inspector, reusing the same agent. A staging table
is still not indicated — the review row already holds the document.

## What to do with PR #1387

**Close it without merging.** Do not partially revert it on the branch; the durable half is
entangled with the staging half, and the surviving ideas are cheaper to re-derive against `spec/`
than to extract from the diff.

Salvage as ideas, not code:

- The **criterion → evidence PR report section** (Phase 2) — the report composition, the
  `absent`-with-distinct-notes rule and the truncation discipline are all worth copying.
- The **per-criterion verdict vocabulary** `met` / `not_met` / **`not_covered`** — the insight that
  "we didn't check" and "it's broken" must never look the same is correct and should carry into
  Phase 2's tester contract.
- The **prompt framing** that a criteria list is STANDING behaviour, not a work list — an agent
  handed a list of behaviours otherwise assumes it was asked to build them. Phase 1's backlog
  section needs the same warning, inverted.

Do NOT carry over: the table and its migrations, the repositories and RPC allow-list entries, the
`AcceptanceCriteriaService`, the controller and routes, the frontend store and inspector panel, the
accretion hook and extraction prompt, `AgentRunContext.acceptanceCriteria` and its prompt section,
`TestReport.criteriaVerdicts`, and the `PR_VERIFICATION_REPORT_VERSION` bump.

One change made on that branch during review stands on its own and has been split out as
**PR #1394** (against `main`, without the acceptance-criteria arm):

- **`board/removal-cascade.ts`** — the block-delete side-table reclaims (service + mounts,
  initiative) extracted out of `BoardService.removeBlock`, which sat ~20 lines under its
  file-size budget. #1387 needed a third reclaim there and tripped the guard; the extraction is a
  straight improvement whether or not any of this initiative ships.

Nothing else on the branch is portable. In particular the `checkWorkspaceFieldListScope`
workspace-id deduplication is NOT cherry-pickable: that scope rule does not exist on `main` — it
was introduced by #1387 for the criteria table's `upsertMany`, so it leaves with it. The lesson it
taught survives in the gotchas below and is worth applying to the next batch-write scope rule.

## Conventions & gotchas carried forward

- **Check the in-repo artifacts before designing a store.** The repo keeps two durable per-service
  artifacts in the service's own repository — `blueprints/` (descriptive: what the code IS) and
  `spec/` (prescriptive: what must be TRUE) — and both are agent-maintained, human-reviewed via the
  PR diff, and already threaded into prompts. A new table for per-service knowledge needs to say
  what it does that those cannot.
- **The third clause is `outcome`, not `then` — twice over.** `when` is a reserved word in Postgres
  and `then` in both SQL dialects; and at the domain level an object with a `then` member is treated
  as a THENABLE by the runtime. `spec.ts` named it `outcome` years earlier for exactly that reason.
  Do not "restore" `then`.
- **Only human-accepted behaviour may steer an agent.** Whatever the mechanism, model-extracted
  behaviour statements must not reach a dispatch prompt before a human has seen them — a
  hallucinated "requirement" in the coder's prompt is strictly worse than having no record at all.
  In the `spec/` design that gate is the PR review of the spec diff.
- **A prompt section built from unbounded stored text needs a cap that STATES what it dropped.**
  Anything rendered into every standard phase is multiplied by every dispatch; a silently truncated
  behavioural contract reads exactly like a complete one.
- **A single-PK, workspace-owned table reachable over the mothership RPC must scope its upsert's
  conflict clause** (`WHERE …workspace_id = excluded.workspace_id` / Drizzle `setWhere`). The RPC's
  `workspaceFieldList` rule can only vouch for a record's own `workspaceId` field, so a caller who
  knows a row id could otherwise rewrite another tenant's row in place. This bit #1387 and will bite
  the next table shaped like it.
- **An engine hook that runs on review settlement replays.** Settlement happens inside the durable
  driver and off HTTP routes a client may retry. Any side effect there needs an idempotency answer,
  and it must be one the store can answer exactly (a marker row) rather than a wall-clock guess.
