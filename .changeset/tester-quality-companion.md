---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

feat(testing): test quality-control companion that loops the Tester on incomplete reports

The Tester gate concluded a step purely from `greenlight` + blocking concerns + failed
outcomes, so a report that claimed to exercise many areas (`tested`) but recorded a single
happy-path `outcome` could greenlight and "pass" — leaving most scenarios as "No discrete
check recorded" in the Test Report window while the step read as successfully completed.

Two changes address this:

- **Tester prompts now require one recorded `outcome` per `tested` area** (API + UI testers):
  every scenario listed as tested must have a matching outcome with a concrete detail, and
  describing results only in the prose `summary` does not count. Genuinely un-exercised areas
  are recorded as `skipped` with a reason rather than dropped.
- **A new test quality-control companion** (`tester-qc`) audits each Tester report for
  coverage/coherence BEFORE the greenlight/fixer decision. When the report is inadequate it
  loops the Tester for a focused additional pass (folding the prior report + the flagged gaps
  in, and carrying forward already-covered outcomes), bounded by a new merge-preset knob
  `maxTesterQualityIterations` (default 3). Enabled by default; a per-Tester-step toggle in
  the pipeline shape (`pipeline.testerQuality`) disables it or gates it on the task estimate.
  The companion is an inline reviewer (no container) that resolves its model like the other
  inline reviewers and is a pass-through when no model is wired.

Persistence: the merge preset gains a `max_tester_quality_iterations` column, mirrored across
the D1 and Drizzle stores (built-in preset seed `version` bumped 1 → 2). The QC loop state
lives on the execution step, so no new table is added.

The frontend pipeline-builder toggle + Test Report verdict surfacing land in a follow-up
(see `docs/initiatives/tester-quality-companion.md`).
