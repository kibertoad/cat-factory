-- Task-level TECHNICAL label: 1 ⇒ technical task (refactor / non-functional / internal
-- change with no externally-observable behaviour), 0 ⇒ business task, NULL ⇒ not yet
-- determined (the engine may infer it from the spec phase). A human-set value is
-- authoritative and never overridden. Only meaningful on `task`-level blocks.
ALTER TABLE blocks ADD COLUMN technical INTEGER;
