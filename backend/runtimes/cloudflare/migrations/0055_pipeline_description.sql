-- Optional prose description for a pipeline (initiative: pipeline-selection preview). Shown next
-- to the step list in the pipeline pickers (add-task modal, inspector run settings) and the
-- builder. Authored per built-in in `seedPipelines()` and editable on custom pipelines; NULL ⇒ no
-- description (the pickers fall back to the step list alone). Mirrored on Node by the `description`
-- column on the Drizzle `pipelines` table.
ALTER TABLE pipelines ADD COLUMN description TEXT;
