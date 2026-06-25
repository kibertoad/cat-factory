-- Squashed schema (final state of migrations 0001..0041 as of 2026-06-22).
-- Pre-1.0, no production data preserved; incremental history collapsed into one init.

PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE workspaces (
  id         TEXT    NOT NULL PRIMARY KEY,
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
, owner_user_id INTEGER, account_id TEXT, description TEXT);
CREATE TABLE blocks (
  workspace_id         TEXT    NOT NULL,
  id                   TEXT    NOT NULL,
  title                TEXT    NOT NULL,
  type                 TEXT    NOT NULL,
  description          TEXT    NOT NULL DEFAULT '',
  pos_x                REAL    NOT NULL DEFAULT 0,
  pos_y                REAL    NOT NULL DEFAULT 0,
  status               TEXT    NOT NULL,
  progress             REAL    NOT NULL DEFAULT 0,
  depends_on           TEXT    NOT NULL DEFAULT '[]',
  execution_id         TEXT,
  level                TEXT    NOT NULL DEFAULT 'frame',
  parent_id            TEXT,
  confidence           REAL,
  module_name          TEXT,
  fragment_ids TEXT, model_id TEXT, pull_request TEXT, merge_preset_id TEXT, pipeline_id TEXT, width REAL, height REAL, service_id TEXT, created_by INTEGER, agent_config TEXT, test_compose_path TEXT, no_infra_dependencies INTEGER, cloud_provider TEXT, instance_size TEXT, service_fragment_ids TEXT,
  -- The account member (a product role-holder) responsible for a task; notified when
  -- requirement review flags findings. Null when unassigned.
  responsible_product_user_id TEXT,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE pipelines (
  workspace_id TEXT NOT NULL,
  id           TEXT NOT NULL,
  name         TEXT NOT NULL,
  agent_kinds  TEXT NOT NULL DEFAULT '[]', gates TEXT, thresholds TEXT,
  -- enabled: nullable JSON array of per-step enable flags, parallel to agent_kinds; a
  --          step whose flag is false is kept in the pipeline but skipped at run start.
  -- builtin: 1 for the curated seedPipelines() catalog templates (read-only — clone to
  --          edit), NULL for user-created and cloned pipelines.
  enabled      TEXT,
  builtin      INTEGER,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE token_usage (
  id            TEXT    NOT NULL PRIMARY KEY,
  workspace_id  TEXT    NOT NULL,
  execution_id  TEXT,
  agent_kind    TEXT    NOT NULL,
  provider      TEXT    NOT NULL,
  model         TEXT    NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_estimate REAL    NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE TABLE github_installations (
  installation_id   INTEGER NOT NULL PRIMARY KEY,
  workspace_id      TEXT    NOT NULL,
  account_login     TEXT    NOT NULL,
  target_type       TEXT    NOT NULL,
  cached_token      TEXT,
  token_expires_at  INTEGER,
  created_at        INTEGER NOT NULL,
  deleted_at        INTEGER
, account_id TEXT, app_id TEXT);
CREATE TABLE github_repos (
  workspace_id     TEXT    NOT NULL,
  github_id        INTEGER NOT NULL,
  installation_id  INTEGER NOT NULL,
  owner            TEXT    NOT NULL,
  name             TEXT    NOT NULL,
  default_branch   TEXT,
  private          INTEGER NOT NULL DEFAULT 0,
  block_id         TEXT,
  -- A monorepo-flagged repo can back more than one board service, each pinned to its
  -- own subdirectory (see services.directory).
  is_monorepo      INTEGER NOT NULL DEFAULT 0,
  etag             TEXT,
  synced_at        INTEGER NOT NULL,
  deleted_at       INTEGER,
  PRIMARY KEY (workspace_id, github_id)
);
CREATE TABLE github_branches (
  workspace_id     TEXT    NOT NULL,
  repo_github_id   INTEGER NOT NULL,
  name             TEXT    NOT NULL,
  head_sha         TEXT    NOT NULL,
  protected        INTEGER NOT NULL DEFAULT 0,
  synced_at        INTEGER NOT NULL,
  deleted_at       INTEGER,
  PRIMARY KEY (workspace_id, repo_github_id, name)
);
CREATE TABLE github_pull_requests (
  workspace_id     TEXT    NOT NULL,
  repo_github_id   INTEGER NOT NULL,
  number           INTEGER NOT NULL,
  github_id        INTEGER NOT NULL,
  title            TEXT    NOT NULL,
  state            TEXT    NOT NULL,
  head_ref         TEXT,
  base_ref         TEXT,
  head_sha         TEXT,
  merged           INTEGER NOT NULL DEFAULT 0,
  author           TEXT,
  gh_updated_at    INTEGER,
  synced_at        INTEGER NOT NULL,
  deleted_at       INTEGER,
  PRIMARY KEY (workspace_id, repo_github_id, number)
);
CREATE TABLE github_issues (
  workspace_id     TEXT    NOT NULL,
  repo_github_id   INTEGER NOT NULL,
  number           INTEGER NOT NULL,
  github_id        INTEGER NOT NULL,
  title            TEXT    NOT NULL,
  state            TEXT    NOT NULL,
  author           TEXT,
  labels           TEXT    NOT NULL DEFAULT '[]',
  gh_updated_at    INTEGER,
  synced_at        INTEGER NOT NULL,
  deleted_at       INTEGER,
  PRIMARY KEY (workspace_id, repo_github_id, number)
);
CREATE TABLE github_commits (
  workspace_id     TEXT    NOT NULL,
  repo_github_id   INTEGER NOT NULL,
  sha              TEXT    NOT NULL,
  message          TEXT    NOT NULL,
  author           TEXT,
  authored_at      INTEGER,
  synced_at        INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, repo_github_id, sha)
);
CREATE TABLE github_check_runs (
  workspace_id     TEXT    NOT NULL,
  repo_github_id   INTEGER NOT NULL,
  github_id        INTEGER NOT NULL,
  head_sha         TEXT    NOT NULL,
  name             TEXT    NOT NULL,
  status           TEXT    NOT NULL,
  conclusion       TEXT,
  synced_at        INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, repo_github_id, github_id)
);
CREATE TABLE github_rate_limits (
  id               TEXT    NOT NULL PRIMARY KEY,
  installation_id  INTEGER NOT NULL,
  resource         TEXT    NOT NULL,
  limit_total      INTEGER,
  remaining        INTEGER,
  reset_at         INTEGER,
  observed_at      INTEGER NOT NULL
);
CREATE TABLE environment_connections (
  workspace_id    TEXT    NOT NULL,
  provider_id     TEXT    NOT NULL,
  label           TEXT    NOT NULL,
  base_url        TEXT    NOT NULL,
  manifest_json   TEXT    NOT NULL,
  secrets_cipher  TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  PRIMARY KEY (workspace_id, provider_id)
);
CREATE TABLE environments (
  id                       TEXT    NOT NULL PRIMARY KEY,
  workspace_id             TEXT    NOT NULL,
  block_id                 TEXT,
  execution_id             TEXT,
  provider_id              TEXT    NOT NULL,
  external_id              TEXT,
  url                      TEXT,
  status                   TEXT    NOT NULL,
  access_cipher            TEXT,
  provision_fields_cipher  TEXT,
  created_at               INTEGER NOT NULL,
  expires_at               INTEGER,
  last_error               TEXT,
  deleted_at               INTEGER
);
CREATE TABLE reference_architectures (
  id                   TEXT    NOT NULL PRIMARY KEY,
  workspace_id         TEXT    NOT NULL,
  name                 TEXT    NOT NULL,
  description          TEXT    NOT NULL DEFAULT '',
  repo_owner           TEXT    NOT NULL,
  repo_name            TEXT    NOT NULL,
  default_instructions TEXT    NOT NULL DEFAULT '',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  deleted_at           INTEGER
);
CREATE TABLE document_connections (
  workspace_id  TEXT    NOT NULL,
  source        TEXT    NOT NULL,
  credentials   TEXT    NOT NULL,
  label         TEXT    NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  PRIMARY KEY (workspace_id, source)
);
CREATE TABLE documents (
  workspace_id     TEXT    NOT NULL,
  source           TEXT    NOT NULL,
  external_id      TEXT    NOT NULL,
  title            TEXT    NOT NULL,
  url              TEXT    NOT NULL,
  excerpt          TEXT    NOT NULL DEFAULT '',
  body             TEXT    NOT NULL DEFAULT '',
  linked_block_id  TEXT,
  synced_at        INTEGER NOT NULL,
  deleted_at       INTEGER,
  PRIMARY KEY (workspace_id, source, external_id)
);
CREATE TABLE runner_pool_connections (
  workspace_id    TEXT    NOT NULL,
  provider_id     TEXT    NOT NULL,
  label           TEXT    NOT NULL,
  base_url        TEXT    NOT NULL,
  manifest_json   TEXT    NOT NULL,
  secrets_cipher  TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  PRIMARY KEY (workspace_id, provider_id)
);
CREATE TABLE task_connections (
  workspace_id  TEXT    NOT NULL,
  source        TEXT    NOT NULL,
  credentials   TEXT    NOT NULL,
  label         TEXT    NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  PRIMARY KEY (workspace_id, source)
);
CREATE TABLE tasks (
  workspace_id     TEXT    NOT NULL,
  source           TEXT    NOT NULL,
  external_id      TEXT    NOT NULL,  
  title            TEXT    NOT NULL,
  url              TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT '',
  type             TEXT    NOT NULL DEFAULT '',
  assignee         TEXT,
  priority         TEXT,
  labels           TEXT    NOT NULL DEFAULT '[]',  
  description      TEXT    NOT NULL DEFAULT '',
  comments         TEXT    NOT NULL DEFAULT '[]',  
  excerpt          TEXT    NOT NULL DEFAULT '',
  linked_block_id  TEXT,
  synced_at        INTEGER NOT NULL,
  deleted_at       INTEGER,
  PRIMARY KEY (workspace_id, source, external_id)
);
CREATE TABLE accounts (
  id                   TEXT    NOT NULL PRIMARY KEY,
  type                 TEXT    NOT NULL,            
  name                 TEXT    NOT NULL,
  github_account_login TEXT,                        
  created_at           INTEGER NOT NULL
, default_cloud_provider TEXT, owner_user_id TEXT);
CREATE TABLE memberships (
  account_id TEXT    NOT NULL,
  user_id    INTEGER NOT NULL,
  -- Combinable role set (admin / developer / product), CSV.
  roles      TEXT    NOT NULL DEFAULT 'developer',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, user_id)
);
CREATE TABLE agent_runs (
  workspace_id          TEXT    NOT NULL,
  id                    TEXT    NOT NULL,
  kind                  TEXT    NOT NULL,
  block_id              TEXT,
  status                TEXT    NOT NULL,
  detail                TEXT    NOT NULL DEFAULT '{}',
  subtasks              TEXT,
  error                 TEXT,
  failure               TEXT,
  workflow_instance_id  TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL, service_id TEXT,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE prompt_fragments (
  fragment_id  TEXT    NOT NULL,            
  owner_kind   TEXT    NOT NULL,            
  owner_id     TEXT    NOT NULL,            
  version      TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  category     TEXT,
  summary      TEXT    NOT NULL,            
  body         TEXT    NOT NULL,            
  applies_to   TEXT,                        
  tags         TEXT,                        
  source_id    TEXT,                        
  source_path  TEXT,                        
  source_sha   TEXT,                        
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,                     
  PRIMARY KEY (owner_kind, owner_id, fragment_id)
);
CREATE TABLE fragment_sources (
  id              TEXT    NOT NULL PRIMARY KEY,
  owner_kind      TEXT    NOT NULL,         
  owner_id        TEXT    NOT NULL,
  repo_owner      TEXT    NOT NULL,         
  repo_name       TEXT    NOT NULL,
  git_ref         TEXT    NOT NULL DEFAULT 'HEAD',
  dir_path        TEXT    NOT NULL DEFAULT '',
  last_synced_sha TEXT,                     
  last_synced_at  INTEGER,
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  UNIQUE (owner_kind, owner_id, repo_owner, repo_name, git_ref, dir_path)
);
CREATE TABLE requirement_reviews (
  workspace_id              TEXT    NOT NULL,
  id                        TEXT    NOT NULL,
  block_id                  TEXT    NOT NULL,
  status                    TEXT    NOT NULL,              
  items                     TEXT    NOT NULL DEFAULT '[]', 
  model                     TEXT,                          
  incorporated_requirements TEXT,                          
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  -- Reviewer-pass counter + its budget (the iterative requirements-review loop).
  iteration                 INTEGER NOT NULL DEFAULT 1,
  max_iterations            INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE live_containers (
  container_key TEXT    PRIMARY KEY,
  kind          TEXT    NOT NULL,
  workspace_id  TEXT,
  started_at    INTEGER NOT NULL
);
CREATE TABLE merge_threshold_presets (
  workspace_id    TEXT    NOT NULL,
  id              TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  max_complexity  REAL    NOT NULL,
  max_risk        REAL    NOT NULL,
  max_impact      REAL    NOT NULL,
  ci_max_attempts INTEGER NOT NULL,
  is_default      INTEGER NOT NULL DEFAULT 0,
  -- Per-task requirements-review loop knobs: reviewer passes before asking the human,
  -- and the finding severity tolerated without stopping.
  max_requirement_iterations      INTEGER NOT NULL DEFAULT 3,
  max_requirement_concern_allowed TEXT    NOT NULL DEFAULT 'none',
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE notifications (
  workspace_id  TEXT    NOT NULL,
  id            TEXT    NOT NULL,
  type          TEXT    NOT NULL,            
  status        TEXT    NOT NULL,            
  block_id      TEXT,
  execution_id  TEXT,
  title         TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  payload       TEXT,                        
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER,
  PRIMARY KEY (workspace_id, id)
);
-- llm_call_metrics + agent_context_snapshots now live in the dedicated TELEMETRY_DB
-- database (see telemetry-migrations/), not the main DB. Their write profile
-- (append-heavy, high-volume, short retention) is unlike the transactional domain.
CREATE TABLE workspace_model_defaults (
  workspace_id TEXT    NOT NULL,
  agent_kind   TEXT    NOT NULL,
  model_id     TEXT    NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_kind)
);
CREATE TABLE pipeline_schedules (
  workspace_id      TEXT    NOT NULL,
  id                TEXT    NOT NULL,
  block_id          TEXT    NOT NULL,          
  frame_id          TEXT    NOT NULL,          
  pipeline_id       TEXT    NOT NULL,
  template          TEXT    NOT NULL,          
  name              TEXT    NOT NULL,
  interval_hours    INTEGER NOT NULL,
  weekdays          TEXT    NOT NULL DEFAULT '[]',  
  window_start_hour INTEGER,                   
  window_end_hour   INTEGER,
  timezone          TEXT    NOT NULL DEFAULT 'UTC',
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_run_at       INTEGER,
  next_run_at       INTEGER NOT NULL,
  created_at        INTEGER NOT NULL, service_id TEXT,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE pipeline_schedule_runs (
  workspace_id  TEXT    NOT NULL,
  id            TEXT    NOT NULL,
  schedule_id   TEXT    NOT NULL,
  execution_id  TEXT,
  status        TEXT    NOT NULL,              
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  outcome       TEXT,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE tracker_settings (
  workspace_id     TEXT NOT NULL PRIMARY KEY,
  tracker          TEXT,                       
  jira_project_key TEXT,
  updated_at       INTEGER NOT NULL
);
CREATE TABLE services (
  id              TEXT    NOT NULL PRIMARY KEY,
  account_id      TEXT,                          
  frame_block_id  TEXT    NOT NULL,              
  installation_id INTEGER,                       
  repo_github_id  INTEGER,                       
  created_at      INTEGER NOT NULL
, directory TEXT);
CREATE TABLE workspace_services (
  workspace_id TEXT    NOT NULL,
  service_id   TEXT    NOT NULL,
  pos_x        REAL    NOT NULL DEFAULT 0,       
  pos_y        REAL    NOT NULL DEFAULT 0,
  width        REAL,                             
  height       REAL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, service_id)
);
CREATE TABLE github_sync_cursors (
  installation_id  INTEGER NOT NULL,
  repo_github_id   INTEGER NOT NULL,
  kind             TEXT    NOT NULL,
  etag             TEXT,
  last_synced_at   INTEGER,
  since_iso        TEXT,
  PRIMARY KEY (installation_id, repo_github_id, kind)
);
CREATE TABLE provider_subscription_tokens (
  id                TEXT    NOT NULL,
  workspace_id      TEXT    NOT NULL,
  vendor            TEXT    NOT NULL,            
  label             TEXT    NOT NULL,
  token_cipher      TEXT    NOT NULL,            
  created_at        INTEGER NOT NULL,
  last_used_at      INTEGER,                     
  window_started_at INTEGER,                     
  input_tokens      INTEGER NOT NULL DEFAULT 0,  
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  request_count     INTEGER NOT NULL DEFAULT 0,
  deleted_at        INTEGER,                     
  PRIMARY KEY (id)
);
CREATE TABLE slack_connections (
  account_id     TEXT    NOT NULL,
  team_id        TEXT    NOT NULL,
  team_name      TEXT    NOT NULL,
  team_icon_url  TEXT,
  bot_user_id    TEXT,
  scopes         TEXT,                 
  token_cipher   TEXT    NOT NULL,     
  created_at     INTEGER NOT NULL,
  deleted_at     INTEGER,
  PRIMARY KEY (account_id)
);
CREATE TABLE slack_settings (
  workspace_id     TEXT    NOT NULL,
  routes           TEXT    NOT NULL DEFAULT '{}',  
  mentions_enabled INTEGER NOT NULL DEFAULT 0,     
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (workspace_id)
);
CREATE TABLE slack_member_mappings (
  account_id  TEXT    NOT NULL,
  entries     TEXT    NOT NULL DEFAULT '[]',       
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id)
);
CREATE TABLE personal_subscriptions (
  id            TEXT    NOT NULL,
  user_id       INTEGER NOT NULL,            
  vendor        TEXT    NOT NULL,            
  label         TEXT    NOT NULL,
  token_cipher  TEXT    NOT NULL,            
  expires_at    INTEGER,                     
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_used_at  INTEGER,                     
  deleted_at    INTEGER,                     
  PRIMARY KEY (id)
);
CREATE TABLE subscription_activations (
  id            TEXT    NOT NULL,
  execution_id  TEXT    NOT NULL,            
  user_id       INTEGER NOT NULL,
  vendor        TEXT    NOT NULL,
  token_cipher  TEXT    NOT NULL,            
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,            
  PRIMARY KEY (id)
);
CREATE TABLE workspace_fragment_defaults (
  workspace_id TEXT    NOT NULL PRIMARY KEY,
  fragment_ids TEXT    NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE user_identities (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  secret TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE TABLE email_connections (
  account_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  from_address TEXT NOT NULL,
  api_key_cipher TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE account_invitations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  -- Combinable role set (admin / developer / product), CSV.
  roles TEXT NOT NULL DEFAULT 'developer'
);
-- Direct-provider API-key pool (account/workspace/user scope), leased with usage-aware
-- rotation by the LLM proxy + inline calls. Stored as an opaque SecretCipher envelope
-- (AES-256-GCM) — never plaintext.
CREATE TABLE provider_api_keys (
  id                TEXT    NOT NULL,
  scope             TEXT    NOT NULL,            -- 'account' | 'workspace' | 'user'
  scope_id          TEXT    NOT NULL,            -- account id | workspace id | usr_* id
  provider          TEXT    NOT NULL,            -- 'openai' | 'anthropic' | 'qwen' | 'deepseek' | 'moonshot'
  label             TEXT    NOT NULL,
  key_cipher        TEXT    NOT NULL,            -- SecretCipher envelope (no plaintext)
  created_at        INTEGER NOT NULL,
  last_used_at      INTEGER,                     -- null = never leased
  window_started_at INTEGER,                     -- start of the current usage window
  input_tokens      INTEGER NOT NULL DEFAULT 0,  -- tokens consumed this window
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  request_count     INTEGER NOT NULL DEFAULT 0,
  deleted_at        INTEGER,                     -- tombstone
  PRIMARY KEY (id)
);
CREATE INDEX idx_blocks_parent ON blocks (workspace_id, parent_id);
CREATE INDEX idx_token_usage_created ON token_usage (created_at);
CREATE UNIQUE INDEX idx_gh_install_workspace
  ON github_installations (workspace_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_gh_repos_install ON github_repos (installation_id);
CREATE INDEX idx_provider_api_keys_pool
  ON provider_api_keys (scope, scope_id, provider, deleted_at);
CREATE INDEX idx_gh_pr_state ON github_pull_requests (workspace_id, state);
CREATE INDEX idx_gh_checks_sha ON github_check_runs (workspace_id, repo_github_id, head_sha);
CREATE INDEX idx_gh_ratelimit_observed ON github_rate_limits (observed_at);
CREATE INDEX idx_gh_commits_authored ON github_commits (authored_at);
CREATE UNIQUE INDEX idx_environment_conn_workspace
  ON environment_connections (workspace_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_environments_block
  ON environments (workspace_id, block_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_environments_expiry
  ON environments (expires_at)
  WHERE deleted_at IS NULL AND expires_at IS NOT NULL;
CREATE INDEX idx_reference_architectures_workspace
  ON reference_architectures (workspace_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_block
  ON documents (workspace_id, linked_block_id);
CREATE UNIQUE INDEX idx_runner_pool_conn_workspace
  ON runner_pool_connections (workspace_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_block
  ON tasks (workspace_id, linked_block_id);
CREATE INDEX idx_workspaces_owner ON workspaces (owner_user_id);
CREATE INDEX idx_memberships_user ON memberships (user_id);
CREATE INDEX idx_workspaces_account ON workspaces (account_id);
CREATE INDEX idx_gh_install_account
  ON github_installations (account_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_agent_runs_workspace    ON agent_runs (workspace_id, created_at);
CREATE INDEX idx_agent_runs_status_lease ON agent_runs (status, updated_at);
CREATE INDEX idx_agent_runs_block        ON agent_runs (workspace_id, block_id);
CREATE INDEX idx_prompt_fragments_owner
  ON prompt_fragments (owner_kind, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_prompt_fragments_source
  ON prompt_fragments (source_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_fragment_sources_owner
  ON fragment_sources (owner_kind, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_requirement_reviews_block ON requirement_reviews (workspace_id, block_id);
CREATE INDEX idx_live_containers_started ON live_containers (started_at);
CREATE INDEX idx_merge_presets_default
  ON merge_threshold_presets (workspace_id, is_default);
CREATE INDEX idx_notifications_open ON notifications (workspace_id, status, created_at);
CREATE INDEX idx_notifications_block ON notifications (workspace_id, block_id, type, status);
CREATE INDEX idx_pipeline_schedules_due ON pipeline_schedules (enabled, next_run_at);
CREATE INDEX idx_pipeline_schedules_block ON pipeline_schedules (workspace_id, block_id);
CREATE INDEX idx_schedule_runs_schedule
  ON pipeline_schedule_runs (workspace_id, schedule_id, started_at);
CREATE INDEX idx_schedule_runs_started ON pipeline_schedule_runs (started_at);
CREATE INDEX idx_services_account ON services (account_id);
CREATE UNIQUE INDEX idx_services_frame ON services (account_id, frame_block_id);
CREATE INDEX idx_services_repo ON services (installation_id, repo_github_id);
CREATE INDEX idx_workspace_services_service ON workspace_services (service_id);
CREATE INDEX idx_blocks_service ON blocks (service_id);
CREATE INDEX idx_agent_runs_service ON agent_runs (service_id);
CREATE INDEX idx_pipeline_schedules_service ON pipeline_schedules (service_id);
CREATE INDEX idx_provider_subs_pool
  ON provider_subscription_tokens (workspace_id, vendor, deleted_at);
CREATE UNIQUE INDEX idx_slack_conn_team
  ON slack_connections (team_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_personal_subs_user_vendor
  ON personal_subscriptions (user_id, vendor)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_personal_subs_expiry
  ON personal_subscriptions (expires_at)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_sub_activations_run
  ON subscription_activations (execution_id, user_id, vendor);
CREATE INDEX idx_sub_activations_expiry
  ON subscription_activations (expires_at);
CREATE INDEX idx_services_frame_block ON services (frame_block_id);
CREATE INDEX idx_blocks_id ON blocks (id);
CREATE UNIQUE INDEX idx_users_email ON users (email) WHERE email IS NOT NULL;
CREATE INDEX idx_user_identities_user ON user_identities (user_id);
CREATE UNIQUE INDEX idx_accounts_personal
  ON accounts (owner_user_id)
  WHERE type = 'personal';
CREATE INDEX idx_account_invitations_account ON account_invitations (account_id);
CREATE UNIQUE INDEX idx_account_invitations_token ON account_invitations (token_hash);
