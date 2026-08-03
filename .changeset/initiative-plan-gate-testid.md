---
'@cat-factory/app': patch
---

Publish the parked gate's id on the initiative plan-review rail (`data-approval-id`), so a
send-back can be observed by WHICH gate is on screen rather than by the rail briefly disappearing.
That absence was never guaranteed: the send-back's own workspace refresh races the re-plan, and a
fast planner parks again before the snapshot is taken, so the rail can go straight from one gate to
the next. The e2e spec that waited for the gap was intermittently red on that race.
