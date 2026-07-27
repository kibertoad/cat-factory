# Initiative: per-service acceptance-criteria store

Status: **in progress** · Owner: platform · Started: 2026-07-27

## Goal & rationale

The requirements-review loop produces a genuinely high-quality artifact — the **incorporated
requirements document** — and then loses it. It lives on the run's `requirement_reviews` row,
shapes exactly one spec-writer dispatch, and never outlives the task. Nothing at the SERVICE
level accumulates what the service is supposed to do, and three concrete capabilities suffer
for it:

- The **tester** and the **pre-PR validation loop** verify _generic health_ (suite green, build
  passes) rather than the specific behaviours the task was accepted against.
- The **PR verification report** cannot show "criterion → evidence", because no criterion list
  exists to anchor the evidence to.
- A human returning to a service six tasks later has no durable answer to "what is this
  supposed to do?" other than re-reading merged PRs.

The end state: a **persisted, per-service-frame acceptance-criteria store** that accretes from
settled requirements reviews (human-confirmed before it influences anything), threads into
dispatch prompts, gains a per-criterion verdict from the tester, and renders as a
criterion/evidence table on the PR verification report.

## The target pattern

The store copies the **frame-scoped config** shape the repo already uses three times over —
`validation_configs` (pre-PR validation) and `release_health_configs` / `test_secrets` are the
good citizens. Concretely:

| Concern             | Reference implementation                                             |
| ------------------- | -------------------------------------------------------------------- |
| Wire shapes         | `contracts/src/validation-checks.ts` + `routes/validation-checks.ts` |
| Kernel port         | `kernel/src/ports/validation-repositories.ts`                        |
| D1 repo             | `cloudflare/src/infrastructure/repositories/D1*Repository.ts`        |
| Drizzle repo        | `node/src/repositories/drizzle/connections.ts`                       |
| Service (CRUD)      | `integrations/src/modules/validation/ValidationConfigService.ts`     |
| Controller          | `server/src/modules/validation/ValidationConfigController.ts`        |
| Frame-chain resolve | `AgentContextBuilder.validationChecksFor` (reuses the ONE walk)      |
| Engine hook         | `PrVerificationReportController` (a hook on settlement, not a step)  |
| Inspector panel     | `inspectorPanels` slot + `ServiceValidationConfig.vue`               |
| Conformance         | `conformance/src/suites/validation-checks.ts`                        |

Two departures from that template, both deliberate:

1. **Rows, not a single blob.** A frame owns MANY criteria with independent lifecycles
   (`proposed` → `confirmed` / `retired`), so the table is one row per criterion with a stable
   id — not one JSON-blob row per frame. That makes the batch read
   `listByFrameBlocks(workspaceId, blockIds[])` (a chunked `IN`) the primary port method, per
   the repo's no-N+1 rule.
2. **Member-tier writes.** Criteria are product knowledge a member curates, not operator
   configuration, so the controller mounts **no** `requireWorkspacePermission` — the RBAC
   viewer write floor in `mountAuthGate` is the whole gate. (Contrast `validation-checks`,
   which is `settings.manage`.)

## Per-item status checklist

| #   | Slice                                                               | Status | PR  |
| --- | ------------------------------------------------------------------- | ------ | --- |
| 1   | Contracts: criterion/draft/resolved schemas + route contracts       | done   | —   |
| 2   | Kernel: `AcceptanceCriterionRepository` port + record type          | done   | —   |
| 3   | D1 table + repo (Cloudflare)                                        | done   | —   |
| 4   | Drizzle schema + table + repo (Node)                                | done   | —   |
| 5   | `AcceptanceCriteriaService` (CRUD, `resolveForFrame`, accretion)    | done   | —   |
| 6   | `AcceptanceCriteriaController` + app mount + RPC allow-list         | done   | —   |
| 7   | Facade wiring (Cloudflare / Node / local-by-inheritance)            | done   | —   |
| 8   | Accretion: extraction pass on requirements-review settlement        | done   | —   |
| 9   | Consumption: `AgentContextBuilder` + prompt sections                | done   | —   |
| 10  | Tester per-criterion verdicts (`TestReport.criteriaVerdicts`)       | done   | —   |
| 11  | PR report criterion/evidence section                                | done   | —   |
| 12  | Frontend: store, API composable, inspector panel, i18n (10 locales) | done   | —   |
| 13  | Conformance assertions (resolution / gating / unconfigured no-op)   | done   | —   |
| 14  | Docs sweep + changesets                                             | done   | —   |

Deferred (NOT in the committed scope — see Consequences):

- An `AppCaches` slice for the per-frame read. The resolve is ONE indexed read per dispatch and
  is invalidated by every CRUD write, so it is not yet hot enough to justify a slice; if it
  becomes so, add `acceptanceCriteria` to `AppCachesProfile` + both profiles and invalidate by
  workspace group on every write. **Do not hand-roll a `Map`.**
- Feeding criteria into the pre-PR **validation** loop (the harness-run commands). The criteria
  reach the tester and the prompts; turning a criterion into a runnable check is a separate
  design question (it needs an executable form, not prose).
- Criterion → PR-review-finding linkage.

## Conventions & gotchas carried between iterations

- **The third clause is `outcome`, not `then` — twice over.** At the SQL level, `when` is a
  reserved word in Postgres and `then` in both dialects, so the columns are `given_text` /
  `when_text` / `outcome_text` on BOTH runtimes. At the DOMAIN level the field is `outcome`
  because an object with a `then` member is treated as a THENABLE by the runtime — the same
  reason the in-repo spec's own `acceptanceCriterionSchema` (`contracts/src/spec.ts`) named it
  `outcome` years earlier. Follow the existing convention; do not "restore" `then`.
- **The wire type is `ServiceAcceptanceCriterion`, not `AcceptanceCriterion`.** The latter is
  already taken by the in-repo spec's per-requirement Gherkin seed (`contracts/src/spec.ts`),
  which is a different thing at a different scope. The two are easy to conflate — this one is
  service-scoped and persisted, that one is requirement-scoped and lives in `spec.json`.
- **Only `confirmed` criteria feed prompts.** `resolveForFrame` filters on status, so a
  hallucinated extraction can never steer an agent before a human has seen it. The conformance
  suite pins this (a `proposed` criterion must NOT reach `AgentRunContext`).
- **Accretion is best-effort and must never touch the run.** The extraction pass runs behind the
  review settlement, wrapped so that a model failure, an unwired provider, or a store outage
  leaves the run exactly as it was. Pass-through when no model is wired — the conformance
  harness has none, so every existing suite must keep passing untouched.
- **Dedupe by normalised title within a frame.** A re-run of the same task re-extracts near
  identical criteria; upserting by `(frame, normalised title)` keeps the store from growing a
  duplicate per run. A title that matches an existing `confirmed` or `retired` row is left
  ALONE — re-proposing something a human already retired would be a treadmill.
- **The frame walk happens ONCE.** `AgentContextBuilder.buildContext` resolves the service frame
  in its first wave and threads it into every frame-scoped resolver. Add this resolver to that
  wave (`acceptanceCriteriaFor(workspaceId, frame)`), never a second `resolveServiceFrame` call.
- **Keep the runtimes symmetric.** The D1 migration and the Drizzle migration land together, and
  the conformance suite runs the same assertions against both.
- **`hostMarkdown` discipline on the PR report.** Criterion text is model- or human-authored and
  goes onto a host-parsed surface: every hole is `cell` / `inline` / `prose`, and the list is
  capped through `cap()` so a truncation is logged in the report's own `truncations`.
