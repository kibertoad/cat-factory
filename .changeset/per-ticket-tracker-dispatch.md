---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
---

Let a tracker webhook dispatch a ticket as its own run.

A schedule's issue-intake config gains `dispatch`: the existing `queue` mode (a matching event
fires the schedule, whose `bug-intake` step drains the board oldest-first) or the new `per-ticket`
mode, which imports the pushed ticket, materialises it as its own task under the schedule's frame,
and starts the pipeline on it. Absent means `queue`, so existing schedules are unchanged.

`per-ticket` requires an on-demand schedule and refuses a `bug-intake` pipeline, because a cadence
tick has no triggering ticket and an intake step would pick a different one. The SPA derives the
mode from the pipeline rather than offering it, so the refused combination cannot be expressed.
