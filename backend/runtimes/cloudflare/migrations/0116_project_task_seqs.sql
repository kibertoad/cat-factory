-- The outcome sequence number each project task claimed when it first started, so a replayed or
-- retried start keeps its place in the fold.

CREATE TABLE project_task_seqs (
  task_id     TEXT    PRIMARY KEY,
  project_id  TEXT    NOT NULL,
  seq         INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_project_task_seqs_seq ON project_task_seqs (project_id, seq);
