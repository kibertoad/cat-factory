---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Associate recurring pipeline schedules with their service (in-org sharing).

A recurring schedule hangs off a service frame and owns a reused on-board block. With a
shared service, that schedule and its block must show on every workspace that mounts the
service — and still fire once per org.

- `PipelineSchedule` gains `serviceId`; a new schedule (and its reused block) is stamped with
  the frame's service, so the block renders on every mounting board via the board composition.
- `PipelineScheduleRepository.listByService` (D1 + Drizzle) backs the snapshot, which now
  lists the workspace's own schedules UNION the schedules of every service it mounts.
- D1 migration `0033` + a Drizzle migration add `pipeline_schedules.service_id`.

A schedule is still a single row that fires once, so a shared service's scheduled pipeline
runs once per org (the result renders on all mounting boards), not once per workspace.
