-- Projects linked to tasks as read-only context: a task's agents read the linked project's
-- current result (a research project's findings) at dispatch.

CREATE TABLE task_project_links (
  workspace_id  TEXT    NOT NULL,
  block_id      TEXT    NOT NULL,
  project_id    TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, block_id, project_id)
);
CREATE INDEX idx_task_project_links_project ON task_project_links (project_id);
