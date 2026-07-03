---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

feat(recurring): on-demand (manual-only) recurring tasks that can use individual-usage subscriptions

A recurring pipeline can now be flagged **on-demand**: it has no cadence and is never
fired by the sweeper — it runs ONLY when a person triggers it via "run now". Because a
human is present at every fire, an on-demand schedule's block MAY target an individual-usage
subscription model (Claude / Codex / GLM), unlocked per run-now with the initiator's personal
password exactly like a manual task start. A cadence schedule still refuses individual-usage
models (no one is present to unlock them unattended).

- New `onDemand` flag on `PipelineSchedule` + `createScheduleSchema` (recurrence is now
  optional — an on-demand schedule needs none). Persisted as an `on_demand` column on both
  runtimes (D1 migration `0037` ⇄ Drizzle), with `listDue` filtering `on_demand = 0` so the
  sweeper skips them. Cross-runtime conformance asserts the flag round-trips and run-now fires.
- `RecurringPipelineService.fire` exempts on-demand schedules from the individual-usage
  refusal and threads the run-now initiator + credential-activation closure into the run;
  the run-now controller resolves the personal-credential gate (428 when a password is needed).
- Frontend: an "on-demand" toggle in the add-recurring modal (hides the cadence editor), an
  on-demand inspector view (no cadence/pause, just run-now), and run-now now rides the cached
  personal password through the credential modal. i18n in all 8 locales.
