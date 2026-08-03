# Initiative: service acceptance criteria (verification & lifecycle)

Status: **Phases 0–2 + 4–5 delivered; Phase 3 deliberately not pursued** (the first implementation
was withdrawn; see below) · Owner: platform · Started: 2026-07-27

> **Next action for an operator:** run the three Phase 0 queries below against a real deployment
> and fill in the results table. Nothing in Phases 1–2 depends on the answer; it only decides
> whether Phase 3 is ever worth revisiting.

> **Conversion note:** the committed scope is complete, so per `CLAUDE.md` this tracker is due to
> be converted into a numbered ADR under `backend/docs/adr/` and deleted. It is deliberately kept
> for now because Phase 0's results table is still blank: the tracker is still doing work no ADR
> would. Convert it once the numbers land (or once Phase 3 is formally closed out).

## Goal & rationale

Two capabilities the platform does not have today:

1. A pull request cannot show **criterion → evidence**. The verification report says CI passed and
   the tester greenlit; it cannot say _which required behaviours were checked, and what was
   observed_.
2. A requirement that has been **agreed but not built** is indistinguishable from one the service
   actually honours. `spec/` is prescriptive ("what must be TRUE"), but
   `requirementItemSchema` carries `kind`, `priority`, `sourceBlockIds` and `acceptance`, but
   nothing about whether the behaviour is true _yet_. So an agreed-not-built requirement enters
   every build prompt as standing behaviour and draws a `not_met` from the tester on every
   subsequent run, on unrelated PRs, until it ships.

The second is the load-bearing one: it is what makes a durable behaviour contract safe to write
down before it is honoured.

## Background: the approach that was tried and withdrawn

PR **#1387** ("per-service acceptance-criteria store") proposed a new `acceptance_criteria` table:
per-service-frame rows with a `proposed`/`confirmed`/`retired` lifecycle, accreted by an LLM
extraction pass on requirements-review settlement, injected into every dispatch prompt, ruled on by
the tester, and rendered on the PR report. It was **closed without merging** on review. The
reasoning is recorded here because it is not obvious from inside the feature and would otherwise be
rediscovered:

- `contracts/src/spec.ts` already defines the prescriptive, service-level, in-repo spec under
  `spec/` (explicitly "aggregated across every task"), whose `acceptanceCriterionSchema` is the
  same three fields (`given` / `when` / `outcome`), with stable ids and `sourceBlockIds`
  provenance.
- **`spec-writer` already performs the extraction.** `agents/kinds/spec-blueprints.ts` instructs it
  to emit each requirement "with a MoSCoW priority (must/should/could) and structured
  Given/When/Then acceptance criteria", from the _same_ incorporated requirements document, one
  step after the proposed accretion hook would have fired (`seed.ts`: `requirements-review` →
  `spec-writer`). The accretion pass was a second, weaker implementation of an existing pipeline
  step: its output landed in a side table nobody reviews rather than in a PR diff, and it produced
  no Gherkin.
- The **tester is already pointed at those criteria** (`prompts/testing.ts`: "Start from … the
  Gherkin acceptance scenarios in `spec/features/*.feature`"), so a second per-criterion verdict
  contract re-asked for something it already does against a better source.
- The **preservation argument did not hold.** The proposed rows were keyed to the SERVICE FRAME, so
  an abandoned task never lost them; and short of deleting the block, the incorporated document
  already survives a retry (block + `requirement_reviews` intact), a stop-reset (explicitly kept
  "as a base to rework from") and a failed run (block `blocked`, review intact).

The net effect would have been two sources of truth for one service's behaviour, both interpolated
into the same build prompt, neither aware of the other, and an extraction pass that re-proposed,
forever, criteria already written into `spec/`, because it deduplicated only against itself.

## Decision

**`spec/` is the durable behaviour contract. There is no second store.** The work is to close the
gaps in `spec/` that motivated the table, not to maintain a parallel copy of it.

Rationale, in order of weight:

1. The producing step (`spec-writer`), the structured shape, the Gherkin render, the tester's
   consumption and a human review gate (the PR diff) already exist and are already wired together.
2. A criterion in the repo is reviewed as code, versioned with the code it describes, and visible
   to anyone who clones, none of which a row provides.
3. Nothing shipped, so this costs a decision rather than a migration.

## The target pattern

Each phase extends an artifact or a hook that already exists; none introduces a new persistence
layer or a new engine seam.

| Concern                     | Reference implementation                                                        |
| --------------------------- | ------------------------------------------------------------------------------- |
| The artifact being extended | `contracts/src/spec.ts` (`requirementItemSchema` / `acceptanceCriterionSchema`) |
| Its producing agent         | `agents/kinds/spec-blueprints.ts` (the `spec-writer` prompt + JSON shape)       |
| Its consumers               | `prompts/standard.ts` (build), `prompts/testing.ts` (tester + Gherkin)          |
| Checkout-free repo reads    | `RequirementReviewService`'s `spec/overview.md` read via `RepoFiles`            |
| Report composition          | `execution/prReport.logic.ts` + `PrVerificationReportController`                |

## Per-item status checklist

| #   | Slice                                                        | Status                  | PR    |
| --- | ------------------------------------------------------------ | ----------------------- | ----- |
| 0   | Measure: restart rate, review-loss rate, `spec-writer` reach | done (numbers pending)  | -     |
| 1   | Implementation-state axis on `requirementItemSchema`         | done                    | -     |
| 2   | Criterion → evidence section on the PR verification report   | done                    | -     |
| 3   | Off-run promotion of a settled review into `spec/`           | not pursued (see below) | -     |
| 4   | Implementation state + requirement evidence in the SPA       | done                    | -     |
| 5   | Regression signal on the PR verification report              | done                    | -     |
| -   | Withdrawn: per-service acceptance-criteria store             | closed                  | #1387 |
| -   | Salvaged: `BoardService` removal-cascade extraction          | done                    | #1394 |

**Slice 0** produced validated queries + a structural bound rather than numbers: no deployment
data was reachable. See the Phase 0 section for the SQL and what an operator still needs to run.

**Slice 1** landed as: `state: 'aspirational' | 'established'` on `requirementItemSchema`
(defaulting to `aspirational`, and coerced to it from any absent/garbled value so a model can
never self-promote); a group-markdown render split under headings that state what each half
MEANS; `@aspirational` + `# requirement: <id>` on the Gherkin scenarios; the matching rules in the
build and tester prompts; and `specPromotionPostOp`, which promotes off the tester's verdicts.

**Slice 2** landed as: `requirementVerdicts` on the test report (keyed by the spec's OWN
requirement ids; no second id space), a `requirements` section on `prVerificationReportSchema`
(`PR_VERIFICATION_REPORT_VERSION` → 2), and the join in `prReport.logic.ts`, reading `spec/`
through the existing `resolveRunRepoContext` seam, gated on a tester having reported and
memoised per execution, so the settlements before the tester cost zero repo reads.

**Slice 4** landed as the human half of Slice 1: an implementation-state badge on every
requirement in the service-spec window, a per-group rollup with a three-way state filter, a
service-wide rollup on the overview pane, and the tester's `requirementVerdicts` rendered on the
tester step: the in-app twin of the PR report's requirement → evidence section. See the Phase 4
section.

**Slice 5** landed the one DERIVED fact the axis makes possible and that nothing computed:
`requirements.regressions` on the PR verification report (`PR_VERIFICATION_REPORT_VERSION` → 3),
counting the `established` requirements the tester observed to FAIL, rendered as a leading
call-out plus a distinct row marker, and a regression-preserving cap on the requirement table.
See the Phase 5 section.

**Slice 3 was not pursued**, on the tracker's own stated condition: `spec-writer` sits 0–1 steps
behind the human gate in every built-in pipeline that pairs them, so Q3 is structurally
near-100% and Phase 3 buys nothing. Reconsider only if an operator runs Q3 and it comes back
materially below ~90%.

## How to proceed

### Phase 0: Measure before building (half a day). **RUN; numbers pending an operator**

**Outcome: no deployment data was reachable, so the empirical numbers are still blank. What the
phase produced instead is (a) the three queries, written and VALIDATED against the real Node
(Postgres) schema, and (b) a structural bound on Q3 read off the pipeline definitions.** Both are
recorded below so an operator with database access can finish the measurement in minutes rather
than re-deriving the SQL.

Why blank: the initiative ran in a source checkout with no `DATABASE_URL`, no Cloudflare
credentials and no D1 binding. The queries were therefore validated by applying the full
`backend/runtimes/node/drizzle/` migration lineage to a throwaway Postgres, running them against
the real schema, and seeding synthetic rows to confirm each one DISCRIMINATES (Q1 reported the
per-block run distribution; Q2 isolated exactly the one settled review whose block was gone; Q3
counted only `spec-writer` steps in state `done`, excluding a `running` one and a `coder`-only
run). They return correct, non-vacuous results; they simply have nothing to count here.

#### The queries (Postgres / Node facade; validated)

Run against the app schema (`DB_SCHEMA`, default `public`). On the Cloudflare/D1 facade the shape
is identical but the JSON accessors differ: `json_extract(detail, '$.steps')` with `json_each(...)`
in place of `detail::jsonb` / `jsonb_array_elements`.

```sql
-- Q1 - restart rate: distribution of execution runs per block.
WITH runs AS (
  SELECT workspace_id, block_id, COUNT(*) AS run_count
  FROM agent_runs
  WHERE kind = 'execution' AND block_id IS NOT NULL
  GROUP BY workspace_id, block_id
)
SELECT run_count, COUNT(*) AS blocks,
       ROUND(100.0 * COUNT(*) / NULLIF(SUM(COUNT(*)) OVER (), 0), 1) AS pct_of_blocks
FROM runs GROUP BY run_count ORDER BY run_count;

-- Q2 - review-loss rate: settled reviews whose block no longer exists.
SELECT COUNT(*)                             AS settled_reviews,
       COUNT(*) FILTER (WHERE b.id IS NULL) AS orphaned_by_block_delete,
       ROUND(100.0 * COUNT(*) FILTER (WHERE b.id IS NULL)
             / NULLIF(COUNT(*), 0), 2)      AS pct_orphaned
FROM requirement_reviews r
LEFT JOIN blocks b ON b.workspace_id = r.workspace_id AND b.id = r.block_id
WHERE r.status = 'incorporated';

-- Q3 - spec-writer reach, per BLOCK carrying a settled review (the true gap size).
WITH settled AS (
  SELECT DISTINCT workspace_id, block_id
  FROM requirement_reviews WHERE status = 'incorporated'
),
per_block AS (
  SELECT s.workspace_id, s.block_id,
         BOOL_OR(EXISTS (
           SELECT 1 FROM jsonb_array_elements(
             COALESCE(r.detail::jsonb -> 'steps', '[]'::jsonb)) AS st
           WHERE st ->> 'agentKind' = 'spec-writer' AND st ->> 'state' = 'done'
         )) AS reached
  FROM settled s
  LEFT JOIN agent_runs r
         ON r.workspace_id = s.workspace_id AND r.block_id = s.block_id
        AND r.kind = 'execution'
  GROUP BY s.workspace_id, s.block_id
)
SELECT COUNT(*)                        AS blocks_with_settled_review,
       COUNT(*) FILTER (WHERE reached) AS reached_spec_writer,
       ROUND(100.0 * COUNT(*) FILTER (WHERE reached) / NULLIF(COUNT(*), 0), 1) AS pct
FROM per_block;
```

#### Results

| Question               | Result    | Recorded |
| ---------------------- | --------- | -------- |
| Q1 restart rate        | _not run_ | -        |
| Q2 review-loss rate    | _not run_ | -        |
| Q3 `spec-writer` reach | _not run_ | -        |

#### The structural bound on Q3 (what DID get established)

Q3 is the query that gates the rest, and its upper bound is readable from the pipeline
definitions in `kernel/src/domain/seed.ts` without any data. In **every** built-in pipeline that
pairs a human requirements/clarity gate with a `spec-writer`, the writer is 0–1 steps behind the
gate:

| Pipeline       | Gate                         | Steps between gate and `spec-writer` |
| -------------- | ---------------------------- | ------------------------------------ |
| `pl_full`      | `requirements-review` (gate) | 0 (`spec-writer` is the next step)   |
| `pl_fullstack` | `requirements-review` (gate) | 1 (`researcher`)                     |
| `pl_bugfix`    | `clarity-review` (gate)      | 0 (`spec-writer` is the next step)   |

> **As of the catalog collapse this table is a historical record, not a description of the current
> catalog.** `pl_fullstack` is retired and `pl_full` no longer carries `requirements-review` or
> `spec-writer` at all, so `pl_bugfix` is the only surviving row. It is kept as written because it is
> the EVIDENCE the decision below was made on; restating it against today's catalog would make the
> conclusion look like it was reached from facts nobody had at the time. The conclusion still holds:
> no surviving pipeline puts more than one step between a settled requirements gate and its
> `spec-writer`.

So the only way a settled review fails to reach `spec-writer` is a run abandoned or failed inside
a 0–1 step window. **That makes Q3 structurally near-100%, which is the tracker's own stated
condition for "Phase 3 is unnecessary and the initiative ends at Phase 1–2".** Phases 1 and 2 were
therefore built; Phase 3 was not.

This is a bound, not a measurement: it caps how much ground Phase 3 could ever recover, but the
actual abandonment rate in that window still needs Q3 run against real data. If an operator runs
it and the number comes back materially below ~90%, Phase 3 becomes worth reconsidering; nothing
in Phases 1–2 has to change either way, since both extend `spec/` rather than depend on how it
got populated.

The original three queries and what they decide:

| Question                                                                         | Query sketch                                                                       | What it decides                                                                     |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| How often does a block run more than once (restart under the same requirements)? | executions grouped by `block_id`; distribution of the count                        | If high, the surviving `requirement_reviews` row already does the preservation job  |
| How often is a block deleted while carrying a settled review?                    | blocks absent from `blocks` whose `requirement_reviews` row reached `incorporated` | If near zero, no preservation mechanism is warranted at all                         |
| How often does a run reach `spec-writer` at all?                                 | completed steps with `agentKind = 'spec-writer'`, over runs that settled a review  | The share of settled reviews whose criteria never reach `spec/` (the true gap size) |

**If the third is close to 100%, Phase 3 is unnecessary and the initiative ends at Phase 1–2.**

### Phase 1: Implementation state on the in-repo spec (the actual fix)

The one gap `spec/` genuinely has. Add to `requirementItemSchema`:

- A field distinguishing **agreed-but-not-built** from **observed-true** (suggested:
  `state: 'aspirational' | 'established'`, defaulting to `aspirational` for a newly written
  requirement).
  **Prefer a FIELD over a separate `spec/` sub-folder**: a folder encodes the state in the path, so
  every promotion becomes a file move and the state cannot be read without walking the tree. The
  markdown / Gherkin render can group by the field and read identically.
- Only `established` requirements render as STANDING behaviour in the build prompt. `aspirational`
  ones render in a clearly-labelled backlog section stating they are not yet true, so an agent
  neither implements them by accident nor treats their absence as a regression. (#1387's inverse
  lesson applies: an agent handed a list of behaviours assumes it was asked to build them unless
  told otherwise.)
- **The tester's existing verdicts are the promotion signal**: a first observed pass moves
  `aspirational` → `established`. No human action, and it self-maintains across every path,
  including a later task that deliberately changes the behaviour, which no abandonment hook would
  catch.
- Update `spec-blueprints.ts` so the spec-writer emits the field, and tag aspirational scenarios in
  the `.feature` render so a runner can skip them.

### Phase 2: Criterion → evidence on the PR report (only if Phase 0 justifies it)

The one genuinely new capability #1387 identified, re-pointed at `spec/`:

- `PrVerificationReportController` resolves the run's service `spec/` through the existing
  checkout-free `RepoFiles` port (`RequirementReviewService` already reads `spec/overview.md` that
  way) and joins the requirement ids to the tester's verdicts.
- Ask the tester for a verdict keyed by the **spec requirement id**; do not invent a second id
  space.
- Carry over #1387's report discipline verbatim: `hostMarkdown.cell` on every hole, `cap()` with a
  `truncations` note, and `absent`-WITH-a-note distinguishing "no criteria recorded" from "criteria
  recorded, nobody checked them". Keep `not_covered` as a first-class verdict beside `met` /
  `not_met`: "we didn't check" and "it's broken" must never look the same, which is the whole point
  of keeping a list.

### Phase 3: Only if Phase 0 shows a real gap

If a material share of settled reviews never reach `spec-writer` (parked-then-abandoned runs), make
the spec-writer's ingest independent of the run: let a human promote a settled review's document
into `spec/` from the inspector, reusing the same agent. **A staging table is still not
indicated**: the `requirement_reviews` row already holds the document.

### Phase 4: The human surface for the implementation state. **DONE**

Phase 1 put the `aspirational` / `established` axis in front of every AGENT consumer: the group
markdown splits the two halves under headings that say what each means, the Gherkin render tags an
aspirational scenario, the build and tester prompts carry the matching rules, and
`specPromotionPostOp` maintains the field off the tester's verdicts. Phase 2 put the join in front
of a PR REVIEWER. Nobody had put either in front of the platform's own reader: the service-spec
window ("View Requirements") listed each requirement's priority and kind and could not say which of
them the service is actually known to honour, which is the exact distinction the axis exists to
draw and the one a person opening the window is there to ask about.

What landed, all in `@cat-factory/app`:

- **A state badge on every requirement** in `ServiceSpecWindow.vue`, beside the existing priority
  and kind chips, plus a **per-group rollup** (`Established: n/total`) and a **three-way filter**
  (all / established / aspirational) over the group's requirements, and a **service-wide rollup**
  on the overview pane so the headline answer is visible before drilling in.
- **The tester's `requirementVerdicts` rendered on the tester step** (`StepTestReport.vue`), three-
  valued exactly as the PR report renders them, so the evidence is readable in-app during the run
  rather than only on the PR once the report publishes.
- The counting/filtering is pure and lives in `ServiceSpecWindow.logic.ts` with its own
  `.logic.spec.ts`, matching the `AppOverlayHost.logic.ts` pattern (the SFC-adjacent unit-testable
  seam), since mounting Nuxt for a count is not the deal.

**Frontend-only by construction, and that is the point.** `ServiceSpecView` already carries
`state` (the backend reassembles the tree through the same `requirementItemSchema`, so the default
is applied at the read boundary) and the verdicts already ride `step.testReport`. The axis had
reached every wire shape it needed; only the last consumer was missing. No new endpoint, no new
field, no backend change, so there is no facade-parity surface here either.

Gotchas worth carrying:

- **Read the state defensively.** `requirementState()` maps anything that is not literally
  `established` to `aspirational`. That is not paranoia about the schema, it is the same answer the
  domain gives: a requirement nobody has observed to hold is not standing behaviour, so an absent
  or unrecognised value must land on the cautious side rather than claim the service honours it.
- **Both lookups are enum-keyed, so both need the exhaustive `Record` guard** (i18n drift guard
  tier 2): `Record<RequirementState, …>` in the window and
  `Record<RequirementVerdictStatus, …>` in the tester panel, built from literal `t()` keys. A new
  state or verdict then fails the typecheck instead of rendering a raw enum value at a reader.
- **The two lookups' FALLBACKS answer differently, and each is right for its axis.** The state
  coerces to the cautious value (`aspirational`); the verdict does NOT coerce, because there is no
  cautious verdict: it renders the raw code in a colour (`UNKNOWN_VERDICT_COLOR`) distinct from
  all three known ones. An unknown status is version skew, not a fourth state, and lending it
  `not_covered`'s grey would make "we have no idea" read as "we didn't check", collapsing exactly
  the distinction the three-valued verdict exists to draw. `StepTestReport.logic.spec.ts` pins the
  colours disjoint, so a later palette edit can't silently re-collide them.
- **A filter that empties a non-empty group must say so, AND offer the way back.** Rendering
  nothing would read exactly like "this group has no requirements", which is the same class of
  mistake as a silently missing report section. The filter is deliberately STICKY across groups
  ("what has this service actually proven" is a question about the service, so re-answering it on
  every group click would defeat it), and stickiness is what makes the reset affordance
  load-bearing rather than decorative: the reader may have set the filter several groups ago.
- **The filter chips REUSE the badge labels** rather than carrying their own catalog keys. A chip
  that reads differently from the badge it filters for is a translation bug waiting to happen, and
  one key per state cannot drift from itself; only `all` needs a key of its own.

### Phase 5: The regression signal, making the axis computable rather than just describable. **DONE**

Phases 1–4 put the `aspirational` / `established` axis in front of every consumer: the build
prompt's two headings, the tester prompt's rule, the `@aspirational` Gherkin tag, the PR report's
state column, the SPA's badges. But every one of those STATES the distinction (mostly to a model)
and none of them DERIVES anything from it. The one fact worth deriving was left for a reader to
work out:

> **A `not_met` against an `established` requirement is a regression. A `not_met` against an
> `aspirational` one is work that is not finished yet.**

That sentence was already written into `prompts/testing.ts`, `prompts/standard.ts`,
`repo-ops/render.ts` and `CLAUDE.md`: four places, all prose, none of them computed. On the PR
report both readings arrived as the same `❌ not met` cell and were pooled into the same `notMet`
tally, so telling them apart meant cross-referencing two columns of a table that may be capped.
This is precisely the collapse `not_covered` was kept separate from `not_met` to prevent, one axis
over: keeping a distinction only in prose is the same as not keeping it.

What landed, all in the report's existing seams:

- **`requirements.regressions`** on `prReportRequirementsSchema`, counted over the whole spec
  before any cap; `PR_VERIFICATION_REPORT_VERSION` → 3.
- **A leading call-out** on the rendered section when it is non-zero, plus a distinct
  `🔴 **regression**` row marker so the call-out points at identifiable rows, and a legend line.
- **A severity-first cap** (`selectRequirementEntries`), replacing the generic prefix `cap()` for
  this one list: regressions are selected ahead of every other row, and the note says how many of
  them fit.

Gotchas worth carrying:

- **A SUBSET, never a fourth tally.** `regressions` counts a subset of `notMet`, so it is rendered
  as its own line ABOVE the tallies rather than as a fourth term beside them. A four-term tally
  that does not add up to `total` reads as an arithmetic bug and costs the reader trust in every
  other number in the report.
- **A prefix cap is not a safe cap for a severity-bearing list.** `hostMarkdown.capList` keeps the
  first N, and requirement rows are emitted in spec order (module → group → requirement), so on a
  spec past the cap the single row a reviewer must not miss is dropped purely by where its feature
  happens to sort: a table that looks clean because of alphabetical luck. Regressions are selected
  first, the rest fill the remaining budget in spec order, and the selection is then RESTORED to
  spec order: severity decides what survives, the taxonomy still decides how it reads.
- **A non-prefix cap has to SAY it is not a prefix.** The truncation note carries
  `(not the first N: every regression kept)`, because a reader who assumes the standard prefix
  would conclude the requirements after the cut-off were never ruled on, the exact false reading
  `truncations` exists to prevent. With no regressions to prioritise the selection IS the plain
  prefix, so the clause is omitted rather than describing a reordering that did not happen.
- **Priority is not a guarantee, and the note must not claim it is.** A broken build can fail
  every established requirement at once, so `regressions` can exceed the row budget; the note then
  reads `only N of M regressions fit` and the call-out adds that the table shows fewer than it
  counts. The first draft asserted `(every regression kept)` unconditionally; a note that
  overstates what survived is the same false reassurance as no note at all, one level in.
- **Evidence, not policy.** The report counts and marks a regression; it does not gate the merge,
  fail the run, or bounce a step. The report is the engine's evidence surface (`CLAUDE.md` → PR
  verification report) and gating belongs to the gate/judge registries, which have their own
  attempt budgets and park semantics. A regression IS actionable (the tester already files an
  established break as a concern for the fixer), so the report's job is to make sure a human
  cannot miss it, not to add a second, weaker enforcement path beside the first.
- **The SPA cannot show this, and should not try.** `StepTestReport.vue` renders the tester's
  verdicts but has no spec state to join against, and the fix must NOT be to have the tester echo
  the state back: the spec is the source of truth for `state`, and a model that reports state is a
  model that can promote by assertion, the thing `coerceRequirement` and the spec-writer prompt
  both exist to prevent. The join lives where both halves already are, which is the report.

## Conventions & gotchas carried between iterations

- **Check the in-repo artifacts before designing a store.** The repo keeps two durable per-service
  artifacts in the service's own repository, `blueprints/` (descriptive: what the code IS) and
  `spec/` (prescriptive: what must be TRUE), both agent-maintained, human-reviewed via the PR
  diff, and already threaded into prompts. A new table for per-service knowledge must say what it
  does that those cannot.
- **The third clause is `outcome`, not `then`, twice over.** `when` is a reserved word in Postgres
  and `then` in both SQL dialects; and at the domain level an object with a `then` member is
  treated as a THENABLE by the runtime. `spec.ts` named it `outcome` for exactly that reason. Do
  not "restore" `then`.
- **`ServiceAcceptanceCriterion` vs `AcceptanceCriterion`.** The latter is taken by `spec.ts`'s
  per-requirement Gherkin seed. If a new wire type is ever needed, it is not that name.
- **Only human-accepted behaviour may steer an agent.** Model-extracted behaviour statements must
  not reach a dispatch prompt before a human has seen them: a hallucinated "requirement" in the
  coder's prompt is strictly worse than having no record at all. In the `spec/` design that gate is
  the PR review of the spec diff.
- **A prompt section built from unbounded stored text needs a cap that STATES what it dropped.**
  Anything rendered into every standard phase is multiplied by every dispatch; a silently truncated
  behavioural contract reads exactly like a complete one.
- **A single-PK, workspace-owned table reachable over the mothership persistence RPC must scope its
  upsert's conflict clause** (`WHERE …workspace_id = excluded.workspace_id` / Drizzle `setWhere`).
  The RPC's record-field scope rules can only vouch for a record's OWN `workspaceId`, so a caller
  who knows a row id could otherwise rewrite another tenant's row in place. This bit #1387 and will
  bite the next table shaped like it.
- **An engine hook that runs on review settlement replays.** Settlement happens inside the durable
  driver and off HTTP routes a client may retry. Any side effect there needs an idempotency answer,
  and it must be one the store can answer exactly (a marker row) rather than a wall-clock guess.
- **A batch scope check must deduplicate its keys.** Resolving an owning account per record turns a
  batch write's authorization check into an N+1 on the batch size.
