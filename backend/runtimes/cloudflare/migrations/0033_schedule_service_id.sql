-- Associate recurring pipeline schedules with the account-owned service they run on, so a
-- schedule on a SHARED service is visible on every workspace that mounts it (and its reused
-- on-board block renders there via the board composition). The schedule still fires once —
-- it is a single row — so a shared service's scheduled pipeline runs once per org, not once
-- per mounting workspace. Backfill the column from the schedule's frame's service.

ALTER TABLE pipeline_schedules ADD COLUMN service_id TEXT;

UPDATE pipeline_schedules SET service_id = (
  SELECT s.id FROM services s WHERE s.frame_block_id = pipeline_schedules.frame_id
);

CREATE INDEX idx_pipeline_schedules_service ON pipeline_schedules (service_id);
