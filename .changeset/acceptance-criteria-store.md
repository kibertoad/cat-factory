---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
'@cat-factory/conformance': patch
---

Per-service acceptance-criteria store: a durable behaviour contract that accretes from settled
requirements reviews, steers agent prompts, earns per-criterion tester verdicts, and renders as a
criterion → evidence table on the PR verification report.

The requirements-review loop produced a high-quality incorporated requirements document and then
lost it: it lived on the run's review row, shaped one spec-writer dispatch, and never outlived the
task. Nothing at the SERVICE level accumulated what the service was supposed to do, so the tester
and the pre-PR validation loop could only verify generic health (suite green, build passes) rather
than the specific behaviours a task was accepted against, and the PR report had no criterion list
to anchor evidence to.

A new `acceptance_criteria` table (full D1 ⇄ Drizzle parity) holds one row per criterion, keyed to
a **service frame** and resolved up the frame chain — the `validation_configs` /
`release_health_configs` shape, with one deliberate departure: rows rather than a per-frame JSON
blob, because each criterion carries its own lifecycle (`proposed` → `confirmed` / `retired`) and a
stable id that the tester verdicts and the PR report join on. The primary read is therefore the
batched `listByFrameBlocks` (a chunked `IN`), never a point-read per frame.

- **Accretion is an engine HOOK on review settlement, not a pipeline step** — the PR-verification-report
  shape, and for the same reason: a step would need inserting into all fifteen built-in pipelines,
  would never exist in a deployment-authored one, and would be skipped by exactly the runs whose
  requirements were hardest-won. Every path where a requirements review reaches `incorporated`
  funnels through one settlement helper, which runs a single cheap extraction call over the
  incorporated document and files the results as `proposed`. It is entirely best-effort and runs
  BEHIND the settlement: no model wired, a prose answer, a truncated response or a store outage all
  leave the run exactly as they found it.
- **Only `confirmed` criteria ever leave the store.** A `proposed` criterion is a model's reading
  of a document that no human has looked at, so it never reaches a prompt — a hallucinated
  "requirement" steering the coder would be strictly worse than having no store. The conformance
  suite pins this on both runtimes alongside the frame-chain resolution and the unconfigured no-op.
- **Consumption reuses the existing single frame walk**: `AgentContextBuilder` already resolves the
  service frame once per dispatch and threads it into every frame-scoped resolver, so this adds a
  resolver to that wave rather than a second walk. Resolved criteria render into the spec-writer,
  coder, reviewer and tester prompts, stated explicitly as STANDING behaviour rather than this
  task's work.
- **Writes are MEMBER-tier.** Unlike every neighbouring frame-scoped controller (validation checks,
  release health, test secrets), the criteria controller mounts no `requireWorkspacePermission`:
  criteria are product knowledge, the class of thing any member curates, so the RBAC viewer write
  floor is the whole authorization story.
- **Unconfigured ⇒ byte-for-byte the previous behaviour**: a service with no confirmed criteria
  produces no context field, no prompt section and no changed dispatch.

`TestReport` gains an optional `criteriaVerdicts` array (`criterionId` → `met` / `not_met` /
`not_covered` + evidence). `not_covered` is a first-class verdict distinct from `not_met` because
"we did not check" and "it is broken" must never look the same — that distinction is the whole
reason to keep a criterion list.

**BREAKING (wire shape):** `PR_VERIFICATION_REPORT_VERSION` bumps to `2` and
`PrVerificationReport` gains a required `acceptanceCriteria` section. Per the pre-1.0 policy there
is no compatibility shim; an external consumer parsing the report's machine-readable JSON block
must account for the new section. Its two empty cases carry DIFFERENT notes — "this service has no
recorded contract" and "it has one but no tester checked it" are different facts about a pull
request, and a criterion with no verdict is listed with a null one rather than dropped.

A new `workspaceFieldList` persistence RPC scope rule binds a BATCH record write on every record's
`workspaceId`, refusing the whole call on one out-of-scope row so a batch can never smuggle a
foreign record through behind legitimate ones.
