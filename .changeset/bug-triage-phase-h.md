---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
---

Add the recurring `pl_bug_triage` pipeline (bug-triage initiative, phase H).

- **kernel**: seed the built-in `pl_bug_triage` pipeline (`availability: 'recurring'`,
  `bug-intake → bug-investigator → clarity-review → task-estimator → repro-test → coder →
reviewer → tester-api → conflicts → ci → merger`) and export `BUG_TRIAGE_PIPELINE_ID`.
- **contracts**: add the `'bug-triage'` `ScheduleTemplate` value so the recurring modal seeds a
  bug-triage block description.
- **orchestration**: seed the `'bug-triage'` template description; `RecurringPipelineService.create`
  now emits a best-effort `boardChanged('block-added')` when it materialises the reused block, so a
  schedule-created task appears live on every open board (parity with every other block creation).
- **app**: infer the `'bug-triage'` template from `pl_bug_triage` in the recurring modal, and add a
  `bug-intake` display-metadata entry to the agent catalog (the inbound dual of `tracker`).

Recurring-only enforcement: a `pl_bug_triage` run refuses a one-off manual start and is hidden from
the add-task picker, while remaining attachable to a recurring schedule.
