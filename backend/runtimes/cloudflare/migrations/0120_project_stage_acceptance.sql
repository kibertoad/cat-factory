-- How a stage task's result meets its stage's acceptance criteria: the report an assessment wrote
-- once the task recorded its outcome, shown at the stage's checkpoint. NULL until assessed.

ALTER TABLE project_stage_tasks ADD COLUMN acceptance TEXT;
