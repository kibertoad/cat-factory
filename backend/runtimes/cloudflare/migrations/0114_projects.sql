-- Projects: account-owned peers of services, mounted onto boards like a service. A mount names
-- the kind of subject it places; every existing mount is a service's.

ALTER TABLE workspace_mounts ADD COLUMN subject_kind TEXT NOT NULL DEFAULT 'service';

CREATE TABLE projects (
  id             TEXT    PRIMARY KEY,
  account_id     TEXT,
  kind           TEXT    NOT NULL,
  root_block_id  TEXT    NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_projects_account ON projects (account_id);
CREATE UNIQUE INDEX idx_projects_root ON projects (account_id, root_block_id);
CREATE INDEX idx_projects_root_block ON projects (root_block_id);

CREATE TABLE project_service_links (
  project_id  TEXT NOT NULL,
  service_id  TEXT NOT NULL,
  position    INTEGER NOT NULL,
  PRIMARY KEY (project_id, service_id)
);
CREATE INDEX idx_project_service_links_service ON project_service_links (service_id);
