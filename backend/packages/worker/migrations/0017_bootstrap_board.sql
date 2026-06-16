-- Make a "bootstrap repo" run observable and board-integrated. Two new columns
-- on bootstrap_jobs (conventions per 0010): the board service frame the run
-- materialises, and the live subtask progress the bootstrapper agent reports
-- while the container works.
--
--   block_id  — the service frame this run creates up front (in `running` state)
--               so the bootstrap shows on the board immediately as a provisional
--               "bootstrapping…" card; on success the frame is linked to the new
--               repo and becomes a normal, droppable service. NULL for older rows
--               recorded before this column existed.
--   subtasks  — JSON {completed,inProgress,total} mirrored from the agent's todo
--               list, surfaced as an "N/M done" progress bar. NULL until the agent
--               first reports (or for older rows).

ALTER TABLE bootstrap_jobs ADD COLUMN block_id TEXT;
ALTER TABLE bootstrap_jobs ADD COLUMN subtasks TEXT;
