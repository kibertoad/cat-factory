# Initiative: service acceptance criteria — verification & lifecycle

Status: **planning** (the first implementation was withdrawn; Phase 0 is the next action) ·
Owner: platform · Started: 2026-07-27

## Goal & rationale

Two capabilities the platform does not have today:

1. A pull request cannot show **criterion → evidence**. The verification report says CI passed and
   the tester greenlit; it cannot say _which required behaviours were checked, and what was
   observed_.
2. A requirement that has been **agreed but not built** is indistinguishable from one the service
   actually honours. `spec/` is prescriptive ("what must be TRUE"), but
   `requirementItemSchema` carries `kind`, `priority`, `sourceBlockIds` and `acceptance` — and
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
  `spec/` — explicitly "aggregated across every task" — whose `acceptanceCriterionSchema` is the
  same three fields (`given` / `when` / `outcome`), with stable ids and `sourceBlockIds`
  provenance.
- **`spec-writer` already performs the extraction.** `agents/kinds/spec-blueprints.ts` instructs it
  to emit each requirement "with a MoSCoW priority (must/should/could) and structured
  Given/When/Then acceptance criteria" — from the _same_ incorporated requirements document, one
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
into the same build prompt, neither aware of the other — and an extraction pass that re-proposed,
forever, criteria already written into `spec/`, because it deduplicated only against itself.

## Decision

**`spec/` is the durable behaviour contract. There is no second store.** The work is to close the
gaps in `spec/` that motivated the table — not to maintain a parallel copy of it.

Rationale, in order of weight:

1. The producing step (`spec-writer`), the structured shape, the Gherkin render, the tester's
   consumption and a human review gate (the PR diff) already exist and are already wired together.
2. A criterion in the repo is reviewed as code, versioned with the code it describes, and visible
   to anyone who clones — none of which a row provides.
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

| #   | Slice                                                        | Status       | PR    |
| --- | ------------------------------------------------------------ | ------------ | ----- |
| 0   | Measure: restart rate, review-loss rate, `spec-writer` reach | todo         | —     |
| 1   | Implementation-state axis on `requirementItemSchema`         | todo         | —     |
| 2   | Criterion → evidence section on the PR verification report   | blocked on 0 | —     |
| 3   | Off-run promotion of a settled review into `spec/`           | blocked on 0 | —     |
| —   | Withdrawn: per-service acceptance-criteria store             | closed       | #1387 |
| —   | Salvaged: `BoardService` removal-cascade extraction          | done         | #1394 |

## How to proceed

### Phase 0 — Measure before building (half a day)

Three queries against either facade's schema. They decide how much of the rest is worth doing, so
run them first and write the numbers into this document.

| Question                                                                         | Query sketch                                                                       | What it decides                                                                     |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| How often does a block run more than once (restart under the same requirements)? | executions grouped by `block_id`; distribution of the count                        | If high, the surviving `requirement_reviews` row already does the preservation job  |
| How often is a block deleted while carrying a settled review?                    | blocks absent from `blocks` whose `requirement_reviews` row reached `incorporated` | If near zero, no preservation mechanism is warranted at all                         |
| How often does a run reach `spec-writer` at all?                                 | completed steps with `agentKind = 'spec-writer'`, over runs that settled a review  | The share of settled reviews whose criteria never reach `spec/` — the true gap size |

**If the third is close to 100%, Phase 3 is unnecessary and the initiative ends at Phase 1–2.**

### Phase 1 — Implementation state on the in-repo spec (the actual fix)

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
- **The tester's existing verdicts are the promotion signal** — a first observed pass moves
  `aspirational` → `established`. No human action, and it self-maintains across every path,
  including a later task that deliberately changes the behaviour, which no abandonment hook would
  catch.
- Update `spec-blueprints.ts` so the spec-writer emits the field, and tag aspirational scenarios in
  the `.feature` render so a runner can skip them.

### Phase 2 — Criterion → evidence on the PR report (only if Phase 0 justifies it)

The one genuinely new capability #1387 identified, re-pointed at `spec/`:

- `PrVerificationReportController` resolves the run's service `spec/` through the existing
  checkout-free `RepoFiles` port (`RequirementReviewService` already reads `spec/overview.md` that
  way) and joins the requirement ids to the tester's verdicts.
- Ask the tester for a verdict keyed by the **spec requirement id** — do not invent a second id
  space.
- Carry over #1387's report discipline verbatim: `hostMarkdown.cell` on every hole, `cap()` with a
  `truncations` note, and `absent`-WITH-a-note distinguishing "no criteria recorded" from "criteria
  recorded, nobody checked them". Keep `not_covered` as a first-class verdict beside `met` /
  `not_met`: "we didn't check" and "it's broken" must never look the same, which is the whole point
  of keeping a list.

### Phase 3 — Only if Phase 0 shows a real gap

If a material share of settled reviews never reach `spec-writer` (parked-then-abandoned runs), make
the spec-writer's ingest independent of the run: let a human promote a settled review's document
into `spec/` from the inspector, reusing the same agent. **A staging table is still not indicated**
— the `requirement_reviews` row already holds the document.

## Conventions & gotchas carried between iterations

- **Check the in-repo artifacts before designing a store.** The repo keeps two durable per-service
  artifacts in the service's own repository — `blueprints/` (descriptive: what the code IS) and
  `spec/` (prescriptive: what must be TRUE) — both agent-maintained, human-reviewed via the PR
  diff, and already threaded into prompts. A new table for per-service knowledge must say what it
  does that those cannot.
- **The third clause is `outcome`, not `then` — twice over.** `when` is a reserved word in Postgres
  and `then` in both SQL dialects; and at the domain level an object with a `then` member is
  treated as a THENABLE by the runtime. `spec.ts` named it `outcome` for exactly that reason. Do
  not "restore" `then`.
- **`ServiceAcceptanceCriterion` vs `AcceptanceCriterion`.** The latter is taken by `spec.ts`'s
  per-requirement Gherkin seed. If a new wire type is ever needed, it is not that name.
- **Only human-accepted behaviour may steer an agent.** Model-extracted behaviour statements must
  not reach a dispatch prompt before a human has seen them — a hallucinated "requirement" in the
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
