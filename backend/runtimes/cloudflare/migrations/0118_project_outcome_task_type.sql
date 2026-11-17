-- The task type whose handler wrote each project outcome and decodes its body. A project kind may
-- offer several task types, each writing a body of its own shape, so a reader picks the decoder
-- from the row rather than from the project's kind. Existing rows take their task's type; a row
-- whose task is gone stays NULL and is served as stored.

ALTER TABLE project_outcomes ADD COLUMN task_type TEXT;

UPDATE project_outcomes
SET task_type = (SELECT task_type FROM blocks WHERE blocks.id = project_outcomes.task_id)
WHERE task_id IS NOT NULL;
