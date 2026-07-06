# Initiative: Technological-migration preset & the MSSQL→PostgreSQL pilot

**Status:** in progress (T1–T5 done — preset phase templates + ingest normalization + full-interview qa seeding + `migration.*` fragment pack + methodology prompt pack & interviewer promptAddition seam) · **Owner:** orchestration · **Started:** 2026-07-06

> Durable source of truth for a multi-PR initiative. Read this first before picking up the
> next slice; update the checklist at the end of each PR.
>
> **Refuse-to-advance rule.** A slice whose "Blocked by" column is non-empty MUST NOT be
> started until every listed blocker shows ✅ done **with a merged PR number** — parent
> blockers (S6–S9) in
> [`initiative-presets-and-docs-refresh.md`](./initiative-presets-and-docs-refresh.md),
> local blockers (T-numbers) in this file. Before starting a slice, open the referenced
> tracker(s) and verify each blocker row. If any blocker is still ⬜: **STOP. Do not
> implement a workaround, a stub, a partial version, or the blocker itself inside this
> initiative.** Record the blockage here and pick an unblocked slice instead. Parent
> SYSTEM slices are never re-implemented from this tracker.

## Goal & rationale

A **technological migration** — swapping a database engine, upgrading a framework across
a major version, bumping a language runtime, replacing a load-bearing library — is the
highest-risk initiative shape the product can run: the change is wide, mostly mechanical,
and catastrophic when observable behaviour drifts. What makes a migration safe is not the
code change itself but the **discipline around it**: know the blast zone (including its
transitive reach) before touching anything, pin observable behaviour with tests BEFORE
the swap, decide the degree of backwards compatibility deliberately, and only then
deliver — finishing by actually removing the old path. That discipline is invariant
across migrations; only the from/to technologies and scope vary, and those are enumerable
as a form. This is exactly what an **initiative preset** can encode: the user tells the
form WHICH migration, the preset mandates HOW the plan is shaped.

This initiative delivers the **`preset_tech_migration`** preset — the second consumer of
the initiative-preset primitives (parent:
[`initiative-presets-and-docs-refresh.md`](./initiative-presets-and-docs-refresh.md)).
Where docs-refresh proves "preset as form + typed spawned tasks", this preset proves
"preset as **mandated multi-phase methodology**". It also contributes one genuinely new
generic SYSTEM capability the parent roadmap doesn't carry: **preset phase templates** —
a preset declaratively shapes its plan's phase structure, and generic machinery (planner
prompt fold + ingest validation) enforces it. Any future preset can shape its phases the
same way; `preset_generic` declares no template and stays byte-for-byte today's
free-form behaviour.

The division of labour is deliberately inverted from a naive "human signs off on
coverage" gate: estimating a migration's impact across an entire codebase by raw eye is
a near-impossible human task, but an exhaustive sweep is exactly what an agent is good
at. So **the LLM performs the whole-codebase impact/coverage assessment and submits an
evidence-backed confidence case** — why confidence in coverage is high, what the
expected blast zone is, what was done to mitigate the migration risk, what the safety
nets and safeguards are — and **the human's job is to revise that proof**: challenge the
grounding, reject hand-waving, then approve. Migrations stay human-in-the-loop by design
(`interview: 'full'`, `humanReviewDefault: true`, human-gated confidence-case and
transition-design items), but the human audits arguments rather than re-deriving them.

The validation pilot is an **MSSQL → PostgreSQL** migration whose centrepiece is
replacing stored procedures with explicit app code + SQL while observable behaviour
stays unchanged — run as a REAL initiative through the product (picker → form → probe →
interview → plan → approval → loop) against a **purpose-built synthetic MSSQL fixture
repo** (locked decision: not a real internal codebase) that deliberately exercises the
classic behaviour-preservation traps.

**Locked decisions** (made with the product owner at design time):

- **"Migration", not "pivot".** A major framework upgrade is a migration but not
  necessarily a pivot; the preset id, phase ids, and fragments all use the `migration`
  vocabulary.
- **Phase structure is a generic, declarative preset capability** ("make initiative
  structure flexible enough so that different presets can shape them differently") —
  built here as SYSTEM slices T1/T2, not hand-rolled inside this preset's `seedPlan`.
- **Full interview + form.** The form captures the enumerable facts; the interviewer
  digs into the fuzzy ones (downtime tolerance, data-migration constraints, compat
  posture). Requires extending create-time qa seeding to full-interview presets (T3).
- **The coverage/impact assessment is LLM-authored and human-revised** (the
  confidence-case model above), not a human-performed review.
- **The pilot targets a purpose-built sample repo**, so the preset is validated safely
  before being pointed at any real codebase.

## Hard dependencies on the parent roadmap (STOP conditions)

| Parent slice ([`initiative-presets-and-docs-refresh.md`](./initiative-presets-and-docs-refresh.md))                                                                                   | Status at authoring                    | Blocks (this tracker)          | Why                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1–S5: contracts + registry, gate-override seam, create/planning integration, SPA picker/renderer, loop/ingest glue (`seedPlan` at ingest + full `spawn` decoration incl. `taskType`) | ✅ done (#812, #880, #883, #886, #890) | —                              | Satisfied preconditions, recorded so a reader knows what this design already assumes. S5's ingest hook + spawn decoration is what T2/T7/T8 build on.                                                                                                                            |
| **S8** `preset_docs_refresh` registration (the FIRST real preset)                                                                                                                     | ⬜ todo                                | **T8** (transitively T10, T11) | S8 pioneers the registration pattern (descriptor + hooks + review mapping, incl. the full-gate-array rule from the parent's [S2] gotcha). Two presets pioneering that pattern in parallel is exactly the overlap this tracker exists to avoid; T8 **copies** S8's landed shape. |
| **S9** E2E baseline (create-with-preset → auto-plan → spawn-with-decoration) + `backend/docs/initiative-presets.md`                                                                   | ⬜ todo                                | **T10** (transitively T11)     | The migration E2E must extend S9's baseline fixture, never fork a parallel harness.                                                                                                                                                                                             |

Unblocked today (parallel-safe with the parent roadmap): T6, T7, T9 (T1–T5
now done). Critical path: T1 → T2 → T3 → (+ parent S8) T8 → (+ parent S9) T10 → T11 — the next
critical-path slice T8 is still blocked on **parent S8** (and T7).

## Target architecture

### A. Preset phase templates (generic SYSTEM — new capability)

1. **Contract** — extend `InitiativePresetDescriptor`
   (`backend/packages/contracts/src/initiative-preset.ts`) with an optional declarative
   template:
   `phaseTemplate?: { phases: Array<{ id, title, goal, required? }>, allowAdditionalPhases? }`.
   `goal` reuses the existing `initiativePhaseSchema.goal` clamp (short prose — the
   phase's charter, shown on the tracker and fed to the planner). The template lives **on
   the wire descriptor**: it is pure serialisable data, exactly like `policyDefaults`,
   which lets the SPA preview "this preset runs these N phases" at create time with zero
   per-preset frontend work (the preview itself is out of scope here — the placement just
   enables it). The parent's off-the-wire rule stays intact: deep per-phase methodology
   (what a blast-zone report must contain, item granularity) remains code-side in
   `promptAdditions`, never on the descriptor.
2. **Planner prompt fold** — `AgentContextBuilder` (the parent-S3 fold point) renders a
   generic "required plan shape" section into the planning kinds' prompts when the
   resolved preset declares a template: phase ids VERBATIM, titles, goals, order, and
   whether extra phases are allowed. Generic code — it never branches on a preset id; no
   template ⇒ prompt byte-for-byte unchanged (the same invariant style as the parent's
   [S3] promptAdditions gotcha).
3. **Ingest validation/normalization** — a pure function (e.g.
   `normalizeDraftAgainstPhaseTemplate(template, draft)`) invoked inside the landed S5
   ingest path (`InitiativeService.seedPlanDraft`), running **before** the preset's own
   `seedPlan`: known template phases are matched by id and **reordered** into template
   order (normalize, don't reject, for ordering); a missing `required` phase, or an
   unknown extra phase when `allowAdditionalPhases` is false, throws `ValidationError` —
   the landed ingest pattern (`assertPipelinesExist` / the strict re-parse), surfacing as
   a planner retry / human fix at the plan-approval gate. Conformance on both runtimes in
   the same slice. This does NOT change S5's landed semantics — it adds one
   template-aware step beside the hook.
4. **Strangler invariant** — `preset_generic` declares no template; the loop never
   branches on a preset id; a template only ever shapes planning + ingest.

### B. The `preset_tech_migration` preset

5. **Descriptor** — `id: 'preset_tech_migration'`, label "Technological migration",
   description "Swap a load-bearing technology (database, framework major, runtime)
   behind a behaviour-preservation safety net: blast zone → coverage → transition design
   → delivery → decommission." `interview: 'full'`, `humanReviewDefault: true`,
   `planningPipelineId: 'pl_initiative'` — the migration needs exactly
   interviewer → analyst → planner(gate) → committer, so **no new planning pipeline is
   registered**; all deviation is data + hooks. `defaultFragmentIds` = the new
   `migration.*` fragments (T4). Conservative `policyDefaults`:
   `{ maxConcurrent: 2, defaultPipelineId: 'pl_quick', rules: [{ pipelineId: 'pl_full',
minRisk: 0.6, minComplexity: 0.6 }], onMissingEstimate: 'strongest' }` — low
   concurrency (migration PRs collide), risky items escalate to the full pipeline,
   unestimated items fail safe to thoroughness (final tuning in T8).
6. **Form** (field types from the landed S1 vocabulary; `showWhen` single-condition):

   | Field               | Type     | Required | Default                 | Notes                                                                                                |
   | ------------------- | -------- | -------- | ----------------------- | ---------------------------------------------------------------------------------------------------- |
   | `migrationKind`     | select   | yes      | —                       | `database` / `framework-major` / `runtime` / `library-swap` / `other` — "which migration"            |
   | `fromTech`          | text     | yes      | —                       | e.g. "MSSQL 2019 + stored procedures"; probe-prefilled                                               |
   | `toTech`            | text     | yes      | —                       | e.g. "PostgreSQL 16"                                                                                 |
   | `migrationDetail`   | textarea | no       | —                       | scope + specific concerns; the interviewer digs here                                                 |
   | `storedProcPolicy`  | select   | no       | `replace-with-app-code` | `showWhen: migrationKind equals 'database'`; also `port-to-target` / `decide-per-object`             |
   | `compatPosture`     | select   | no       | (unset)                 | `big-bang` / `dual-run` / `adapter-layer`; unset ⇒ phase 3 recommends                                |
   | `behaviourContract` | textarea | no       | —                       | observable behaviour that must not change                                                            |
   | `migrationDocsDir`  | path     | yes      | `docs/migration`        | where phase artifacts are committed (`isSafeDocPath`-guarded via the spawn re-parse)                 |
   | `coverageBar`       | select   | yes      | `strict`                | `strict` (every touchpoint has named covering tests) / `pragmatic` (waivers allowed, each justified) |
   | `humanReview`       | checkbox | no       | **true**                | maps to the parent-S2 gate-override seam                                                             |
   | `scopeHint`         | textarea | no       | —                       | services/areas steer for the analyst                                                                 |

7. **Phase template** — 5 phases, all `required`, `allowAdditionalPhases: false`. The
   ids are ONE exported constant shared by the template, promptAdditions,
   `seedMigrationPlan`, and the E2E — never retyped:
   1. `migration-blast-zone` — "Blast zone": enumerate every directly and transitively
      affected touchpoint; commit the inventory.
   2. `migration-coverage` — "Coverage hardening": pin observable behaviour over the
      blast zone with e2e/integration tests at a seam above the swapped layer.
   3. `migration-transition-design` — "Compatibility & transition design": decide the
      backwards-compatibility degree and design the migration/cutover path.
   4. `migration-delivery` — "Delivery": execute the swap per the approved design,
      behaviour suite green throughout.
   5. `migration-verify-decommission` — "Verify & decommission": prove behaviour parity
      on the new target, flip defaults/CI, remove the old path per the compat posture.
8. **`detect` hook** (`migration-detect.logic.ts`; prior art
   `provision-detect.logic.ts` and the parent's S6 pattern): bounded (~6–8
   `listDirectory`/root-manifest reads), never throws, `{}` on any failure. Reads root
   manifests + compose files for database/driver markers (`mssql`/`tedious`/`pg`, EF/
   Dapper/knex/prisma providers, `mcr.microsoft.com/mssql` vs `postgres:` images) →
   prefills `migrationKind: 'database'` + `fromTech`; framework manifests with
   major-version pins → `framework-major` hints. Prefill only; user overrides win;
   everything freezes at create.
9. **`seedPlan` hook** (`seedMigrationPlan` — pure, total, unit-tested on draft
   fixtures): does **no shape enforcement** (that is T2's generic normalizer).
   Responsibilities: (a) stamp `spawn` decoration — artifact items (phase 1/3/5 reports)
   get `taskType: 'document'` + `taskTypeFields.{docKind, targetPath}` with every
   `targetPath` a `.md` under the frozen `migrationDocsDir` (path safety rides the landed
   S5 strict re-parse); all items get the `migration.*` `fragmentIds`; (b) wire the
   **confidence-case item**: ensure phase 2's last item is the confidence case (inject
   it if the planner omitted it), `dependsOn` every other phase-2 item, human-gated via
   a FULL `spawn.gates` array (the parent's [S2] gotcha) — and gate the phase-3 design
   item the same way; (c) apply granularity caps (phase 2 ≤ ~8 coverage items, phase-4
   delivery batches per design area); (d) honour the `humanReview` input → gate arrays
   on spawned pipelines.
10. **`promptAdditions`** (data, code-side): `initiative-interviewer` — probe migration
    unknowns (downtime tolerance, data-migration constraints, compat posture when
    unset); never re-ask seeded form answers. `initiative-analyst` — the blast-zone
    methodology: enumerate direct touchpoints, then chase TRANSITIVE ones
    (callers-of-callers, config, ops tooling, CI, scheduled jobs); classify each with
    risk and "covered by which tests today"; produce the provisional inventory in the
    analysis. `initiative-planner` — per-phase item briefs (what the blast-zone report
    item commits, coverage items per provisional-inventory area at a seam above the
    swapped layer, the confidence-case item and its obligations, the design item,
    delivery batches derived from the design, decommission checks) and the
    coverage-before-delivery discipline.
11. **Zero new agent kinds.** Phase-1/3/5 artifacts are existing document tasks
    (`doc-writer` via `pl_document_quick`, `targetPath` overridden); phase-2 coverage
    and phase-4/5 delivery are ordinary coding pipelines (`pl_quick`/`pl_full` via the
    estimate rules) — tests are code, and the coder→reviewer→ci tail is exactly the
    safety net a migration wants. The preset's specialness lives in the plan shape
    (template), prompts, and fragments — data, not capability. No dependency on parent
    S7.

### C. The confidence case (the coverage → delivery control point)

The exit control between "coverage hardening" and "delivery" is an **LLM-authored,
human-revised proof** — not a human-performed coverage assessment:

- The phase-2 closing **confidence-case item** (an agent task) sweeps the codebase and
  commits `<migrationDocsDir>/confidence-case.md` (single writer), containing: (1) the
  expected blast zone — recap + deltas vs `blast-zone.md`; (2) the **coverage
  grounding** — a per-touchpoint map of inventory row → named covering tests + WHAT
  observable behaviour each pins (evidence, not assertion); (3) gaps and waivers with
  explicit justification, bounded by the `coverageBar` input; (4) risk mitigations
  taken; (5) safety nets and safeguards (the dual-target harness, CI legs,
  rollback/compat posture, gated delivery batches).
- The item parks on its human gate. **The human's job is to revise the proof**:
  challenge the grounding, reject hand-waving, demand evidence — then approve, or send
  it back (a rejected case ⇒ follow-ups/item curation spawn more phase-2 coverage work
  and the case is re-run). Approval is recorded on the entity as a `decision`
  referencing the case version.
- Phase 3's transition-design item **appends** the cutover-specific mitigations and
  safeguards section to the same case (behind its own human gate), so by delivery time
  `confidence-case.md` is the complete, versioned safety argument for the migration.

### D. Phase model (goals, artifacts, exit criteria)

| Phase                             | Goal                                               | Typical items                                                                                     | Committed artifact                                                                                                       | Exit criterion                                                                                      |
| --------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 1 `migration-blast-zone`          | Complete direct + transitive touchpoint inventory  | 1 report item (single writer)                                                                     | `<migrationDocsDir>/blast-zone.md` — touchpoint, kind, direct/transitive, risk, covering-tests (blank), strategy (blank) | Report merged; gaps vs the plan raised as follow-ups and human-triaged                              |
| 2 `migration-coverage`            | Pin observable behaviour over every inventory row  | several coverage PRs (per area) + the final **confidence-case** item (dependsOn all, human-gated) | `<migrationDocsDir>/confidence-case.md` (per §C, single writer)                                                          | Confidence case approved at its gate; recorded as a `decision` (waivers itemized under `pragmatic`) |
| 3 `migration-transition-design`   | Decide compat degree; design the migration/cutover | 1–2 design items (human-gated)                                                                    | `<migrationDocsDir>/transition-design.md` + confidence-case appendix                                                     | Design approved at the gate; compat posture recorded as a `decision`                                |
| 4 `migration-delivery`            | Execute the swap per the approved design           | per-design batches, `dependsOn` the enabling schema/infra items                                   | code PRs (design doc updated only on deviation)                                                                          | All items merged; behaviour suite green on the new target                                           |
| 5 `migration-verify-decommission` | Prove parity, flip defaults, remove the old path   | parity-verification item, CI flip, old-dep removal per posture                                    | closing section appended to `transition-design.md`                                                                       | Suite green with the new target primary; old path removed or retention recorded as a `decision`     |

**How phase-1 output feeds phase-2 items** (no new engine seam): the analyst — steered
by the promptAdditions — performs the provisional blast-zone analysis at PLANNING time,
so the planner authors phase-1's report item AND provisional phase-2 coverage items from
that provisional inventory (the template machinery guarantees the shape). At run time
the phase-1 task verifies/deepens the inventory against the actual code, commits
`blast-zone.md`, and raises **follow-ups** for inventory rows with no corresponding
phase-2 item — the loop already harvests step follow-ups from settling child runs
(`initiative.logic.ts`), and a human promotes them into phase 2 via the existing item
curation. Honest limitation: there is NO automatic replan — if phase 1 invalidates
provisional phase-2 items, a human edits/skips them with the existing curation surfaces
(re-plan-at-phase-boundary is Out of scope, the natural follow-up if pilots show bad
divergence). Artifacts live under `migrationDocsDir`, never `docs/initiatives/<slug>/`
— the tracker mirror owns that folder, and the slug isn't known to the form or
`seedPlan`.

## Gap analysis

| #   | Gap (vs what the parent already provides)                                                                           | Covered by                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| G1  | Plan shape is pure planner judgment — no declarative per-preset phase structure, prompt fold, or ingest enforcement | T1, T2                                                            |
| G2  | Create-time qa seeding exists only for `interview: 'skip'` — a full-interview preset's interviewer re-asks the form | T3                                                                |
| G3  | No migration methodology: blast-zone/coverage/transition prompt steering, behaviour-preservation fragments          | T4, T5                                                            |
| G4  | No migration repo probe (db/driver/framework marker detection)                                                      | T6                                                                |
| G5  | No migration plan post-processor (spawn decoration, confidence-case wiring, granularity)                            | T7                                                                |
| G6  | No second real preset registration; the registration pattern lands only with parent S8                              | T8                                                                |
| G7  | No confidence-case control point between coverage and delivery                                                      | §C design (data-only: gated item + `decision`), enforced by T7/T8 |
| G8  | No MSSQL fixture repo exercising the behaviour-preservation traps                                                   | T9                                                                |
| G9  | No migration E2E; the baseline harness lands only with parent S9                                                    | T10                                                               |

Parent-owned, NOT ours (listed to prevent scope creep): the registration-pattern pilot
(S8), the E2E baseline + `backend/docs/initiative-presets.md` developer doc (S9). The
loop/ingest glue (S5) is already landed and is consumed, never modified, here.

## Per-slice status checklist

| #   | Slice                                                                                                                                                                                                                                         | Scope     | Blocked by                    | Status  | PR     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------- | ------- | ------ |
| 0   | This tracker                                                                                                                                                                                                                                  | —         | —                             | ✅ done | (this) |
| T1  | `phaseTemplate` contracts (wire descriptor) + generic planner prompt fold in `AgentContextBuilder`; `preset_generic` byte-for-byte                                                                                                            | SYSTEM    | —                             | ✅ done | #895   |
| T2  | Phase-template ingest normalization/validation in the landed `seedPlanDraft` path, before `seedPlan` (reorder known phases; `ValidationError` on missing-required/disallowed-extra); conformance both runtimes                                | SYSTEM    | T1                            | ✅ done | #900   |
| T3  | Full-interview qa seeding: extend `seedPresetInterviewQa` to `interview: 'full'` presets + a generic interviewer "build on seeded answers, don't re-ask" prompt line                                                                          | SYSTEM    | —                             | ✅ done | #904   |
| T4  | `migration.*` prompt-fragment collection (behaviour-preservation, migration-discipline, confidence-case authoring standard) + tests                                                                                                           | MIGRATION | —                             | ✅ done | #909   |
| T5  | Methodology prompt pack: promptAdditions for interviewer/analyst/planner (transitive blast-zone method, per-phase item briefs, confidence-case/design gating expectations) as exported constants + tests                                      | MIGRATION | —                             | ✅ done | #913   |
| T6  | `migration-detect.logic.ts` bounded probe + unit tests (db/driver/compose markers → `migrationKind`/`fromTech` prefill; never throws)                                                                                                         | MIGRATION | —                             | ⬜ todo |        |
| T7  | `seedMigrationPlan` pure post-processor + unit tests over draft fixtures (spawn stamping under `migrationDocsDir`, confidence-case injection/gating/dependsOn, granularity caps, `humanReview` gate arrays) — lands unwired, dormant until T8 | MIGRATION | —                             | ⬜ todo |        |
| T8  | `preset_tech_migration` registration: descriptor (form, `phaseTemplate`, `policyDefaults`, review mapping, `planningPipelineId: 'pl_initiative'`) wiring T4–T7                                                                                | MIGRATION | **parent S8**, T1, T2, T3, T7 | ⬜ todo |        |
| T9  | Synthetic MSSQL fixture repo (schema + procs/triggers/views + app code + dual-target-ready integration tests + CI) exercising the behaviour traps (see Pilot)                                                                                 | PILOT     | —                             | ⬜ todo |        |
| T10 | Migration E2E extending the S9 baseline: create-with-preset → full interview with seeded qa → template-shaped plan → spawn decoration → confidence-case gate                                                                                  | BOTH      | **parent S9**, T8             | ⬜ todo |        |
| T11 | Pilot run + validation: real MSSQL→PG initiative through the product against T9's repo; validation checklist (see Pilot); learnings folded back into this tracker                                                                             | PILOT     | T8, T9, T10                   | ⬜ todo |        |

Ordering: T1–T5 are done; T6, T7 and T9 are unblocked and parallel-safe with the parent
roadmap. Critical path: T1 → T2 → T3 → (+ parent S8) T8 → (+ parent S9) T10 → T11 (T8 now waits
only on parent S8 + T7).

## Pilot: MSSQL → PostgreSQL

**Pilot form values:** `migrationKind: database`, `fromTech: "MSSQL (stored procedures,
SQL Agent jobs)"`, `toTech: "PostgreSQL 16"`, `storedProcPolicy: replace-with-app-code`,
`compatPosture:` unset (phase 3 recommends), `coverageBar: strict`, `humanReview: true`,
`migrationDocsDir: docs/migration`.

**Fixture repo (T9) must contain** — so the pilot exercises the traps, not a toy: a
small service (API + a scheduled job) over MSSQL with stored procs including at least
one **set-based** proc (the app-side-N+1 hazard), one multi-statement transactional
proc, one using a temp table/TVP, and one using `MERGE`; a trigger with observable side
effects; a view the app queries; `RAISERROR`/`THROW` error numbers the app branches on;
case-insensitive-collation-dependent ordering/comparison (incl. trailing-space
equality); `datetime` (3.33 ms rounding) alongside `datetime2` columns; identity columns
whose values leak into responses; `TOP`/`OFFSET-FETCH` pagination; NULL vs empty-string
distinctions; an isolation-sensitive read path; runnable integration tests + CI with an
MSSQL service container.

**Phase-1 inventory enumerates:** stored procedures (name, callers, side effects,
transactionality), triggers, views/indexed views, user-defined functions, SQL Agent
jobs, inline/ad-hoc SQL query sites, ORM/driver usage, connection
strings/pooling/timeout config, isolation hints (`NOLOCK`, snapshot), identity usage,
dialect-sensitive datatypes (`datetime`/`money`/`uniqueidentifier`/`nvarchar` +
collation), pagination idioms, error-code contracts, bulk ops (`BULK INSERT`/TVP/
`MERGE`), ops tooling (backup/migration/monitoring scripts), CI db provisioning — plus
the transitive tail: consumers of proc result-shapes, report queries, anything parsing
db errors.

**Phase-2 behaviour pinning:** characterization tests at a seam **above** the DB
(API/service/repository) so they survive the swap, pinning result ordering under
collation differences (case-insensitive MSSQL default vs PG), trailing-space comparison
semantics, NULL vs empty-string, datetime precision/rounding, identity/sequence value
exposure, transaction/isolation **outcomes** (not mechanisms — MVCC vs lock-based),
app-level error mapping (never raw vendor error codes), pagination stability,
`MERGE`/upsert outcomes, TVP-fed proc results. **Dual-target harness:** the suite is
parameterized over the connection target with CI matrix legs for MSSQL (the baseline —
must be green before any migration code lands) and later PG. The harness is itself
phase-2 work performed BY the initiative, and is what makes phase 5's parity claim
mechanical. Phase 2 closes with the confidence-case item (§C).

**Phase-3 maps per DB object:** replacement strategy per proc — inline parameterized
SQL / multi-query app transaction / PG function (exception path, needs a justifying
`decision`) / delete (dead); transaction-boundary ownership moving to app code;
temp-table/TVP → CTE/arrays/`unnest`; the error-contract mapping table; a performance
note per set-based proc (**must not become an app-side loop**); schema translation
(types, collation choice, identity → sequences seeded from current values);
data-migration path + rehearsal; the recommended compat posture (a dual-run repository
seam is cheap given the dual-target harness; big-bang is acceptable for the fixture).

**Phase-4 items:** schema-migration scripts; driver/ORM swap; per-proc replacement
batches grouped by domain area (each `dependsOn` the schema item); config/pooling; SQL
Agent jobs → app scheduler; the PG CI leg flips from advisory to required;
data-migration rehearsal. **Phase-5:** parity verification (both legs green, PG
primary), MSSQL leg/deps removal per posture, decommission `decision` recorded.

**Validation checklist (what T11 must observe to call the preset proven):**

- Created via picker → form; the probe prefill is observed; the full interview builds on
  the seeded qa without re-asking form answers.
- The approved plan has exactly the 5 template phase ids in order (T2 normalization
  observed); items carry `spawn` bags (verified on the entity + the in-repo tracker
  mirror).
- Phases sequence correctly (no phase-2 spawn before phase 1 settles); `blast-zone.md` /
  `confidence-case.md` / `transition-design.md` committed under `docs/migration/`.
- ≥1 follow-up raised by phase 1 and human-promoted into phase 2 (exercises the
  phase-1→phase-2 feed).
- The confidence-case item parks at its human gate with a grounded, evidence-backed case
  (named tests per touchpoint, mitigations, safety nets); approval recorded as a
  `decision`.
- The behaviour suite is green on BOTH engines before cutover; zero remaining
  stored-proc call sites after phase 4 (grep check); the suite is green with PG primary
  after phase 5.

## Conventions & gotchas (carry between iterations)

Carried forward from the parent (they bind here too):

- **The loop never branches on a preset id** — all migration deviation is descriptor
  data + create/ingest hooks.
- **Keep the runtimes symmetric**: T2's ingest behaviour gets conformance assertions on
  both runtimes in the SAME slice.
- **`detect` is bounded, never throws, degrades to `{}`** — no N+1, prefill never blocks
  create.
- **Inputs freeze after create**; the analyst records deviations as `decisions`, never
  rewrites `presetInputs`.
- **Gate overrides are FULL boolean arrays** computed from the pipeline's own gate
  positions (the parent's [S2] gotcha) — `seedMigrationPlan` emits whole arrays.
- **Descriptor labels are backend-supplied English**; `showWhen` stays single-condition;
  changesets per touched package.

New, migration-specific:

- **Canonical phase ids are a contract** shared by the template, promptAdditions,
  `seedMigrationPlan`, and the E2E — one exported constant, never retyped.
- **Template ≠ prompt steering.** Short ids/titles/goals ride the wire descriptor; deep
  methodology lives only in code-side `promptAdditions` (preserves the parent's
  off-the-wire rule).
- **T2 does shape, T7 does decoration — never entangle them.** `seedMigrationPlan` must
  not re-validate phase structure; that is the generic normalizer's job (the parent's
  S2/S5 separation precedent).
- **There is no engine phase-gate and we don't invent one.** The current phase is
  derived; the only inter-phase human control is a human-gated item (`spawn.gates`) —
  the confidence-case and transition-design items.
- **The LLM argues, the human audits the argument.** The confidence case must be
  evidence-backed (named tests, named touchpoints); a case without grounding is grounds
  for rejection at the gate — never for a human doing the sweep themselves.
- **Single writer per artifact file.** Only the confidence-case item writes
  `confidence-case.md`; phase 1 defaults to one report item. Parallel items must never
  target the same `.md`.
- **Artifacts live under `migrationDocsDir`, never `docs/initiatives/<slug>/`** — the
  tracker mirror owns that folder; every artifact `targetPath` ends `.md`.
- **Phase-1 divergence flows through follow-ups + item curation**, never a silent
  replan; the human is the promoter.
- **Behaviour tests pin outcomes at an app seam**, not SQL internals: no asserting raw
  vendor error codes, implicit ordering, or lock mechanics.
- **Set-based proc → app-code N+1 hazard:** every `replace-with-app-code` mapping needs
  an explicit set-based-SQL note in `transition-design.md`.
- **T2 rejects by throwing `ValidationError` at ingest** — the landed S5 pattern
  (`assertPipelinesExist` / the strict re-parse), never a silent draft mutation for a
  missing required phase.
- **[T5] The interviewer consumes its promptAddition through a SEPARATE seam from the
  analyst/planner.** The analyst/planner fold `promptAdditions[kind]` via
  `AgentContextBuilder` → `initiativeContextLines` (they run through the engine); the
  interviewer is the INLINE `InitiativeInterviewService`, which builds its own prompt and
  never passes through the context builder. T5 completed that half — the service now folds
  `promptAdditions[INITIATIVE_INTERVIEWER_AGENT_KIND]` under the same
  `## Initiative preset: <label>` heading. This seam existed for the analyst/planner since
  T1/parent-S3 but not the interviewer, because docs-refresh is `interview: 'skip'`; the
  migration preset is the first FULL-interview preset to steer its interviewer. It never
  branches on a preset id, so generic/preset-less interviews are byte-for-byte unchanged.
- **[T5] Canonical phase ids live in `agents/src/presets/tech-migration/phases.ts`**
  (`MIGRATION_PHASE_IDS` + `MIGRATION_PHASE_ID_ORDER`); the prompt pack is
  `prompt-additions.ts` (`MIGRATION_PROMPT_ADDITIONS`, keyed by the kernel initiative kind
  constants). T7's `seedMigrationPlan`, T8's descriptor `phaseTemplate`, and T10's E2E all
  import the ids from `phases.ts` — do NOT retype a phase id anywhere else.

## Out of scope

- **Re-plan-at-phase-boundary engine seam** — follow-ups + human curation suffice for
  v1; revisit if pilots show plan-time provisional items diverge badly (that would be
  parent-roadmap-shaped generic work).
- **SPA phase-template preview at create time** — enabled by the wire placement, not
  built here.
- **Automated coverage-metric gating** (line/branch thresholds as a hard gate) — the
  confidence case may CITE metrics as evidence, but the gate is the human-revised
  argument.
- **Zero-downtime / online-replication cutover** (Debezium-style) — the pilot allows a
  window; data-migration tooling productization likewise.
- **Multi-repo migrations** — single target repo in v1.
- **SQL transpilers / automated proc conversion** — replacement is agent-authored,
  test-pinned code.
- **Public API preset exposure** — the parent's exclusion stands.

## Open questions

- Fixture repo stack (language/ORM) — pick whatever the workspace's agents handle best;
  decide in T9.
- Where CI gets MSSQL + PG service containers for the dual-target harness.
- Waiver granularity under `coverageBar: pragmatic` — one `decision` per waived
  touchpoint, or one batch decision?
- PG target version/collation choice — a deployment concern; recommend recording it as a
  phase-3 `decision`.
- Should `compatPosture` become required once a few migrations establish a sensible
  default?
- Per-phase `maxConcurrent` defaults in the phase template — deferred until a preset
  needs it.
- Does the confidence case eventually warrant a first-class structured result view
  (today it is a committed `.md` reviewed at a gate)?
