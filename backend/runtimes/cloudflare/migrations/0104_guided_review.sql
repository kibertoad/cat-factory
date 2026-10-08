-- Guided PR review (docs/initiatives/guided-pr-review.md): a per-user exploration session over one
-- pull request. One row per thread, message and draft, so concurrent threads write disjoint rows.
CREATE TABLE guided_review_sessions (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  provider TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  pr_title TEXT NOT NULL,
  reviewed_head_sha TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  created_by TEXT NOT NULL,
  overview_status TEXT NOT NULL,
  overview_generation INTEGER NOT NULL,
  overview_content TEXT,
  overview_error TEXT,
  overview_model TEXT,
  overview_claimed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
-- One session per creator per PR: two concurrent opens converge on the row that won.
CREATE UNIQUE INDEX idx_guided_review_sessions_pr
  ON guided_review_sessions (workspace_id, repo_id, pr_number, created_by);
CREATE INDEX idx_guided_review_sessions_stale
  ON guided_review_sessions (overview_status, updated_at);

CREATE TABLE guided_review_threads (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_guided_review_threads_session
  ON guided_review_threads (workspace_id, session_id);

CREATE TABLE guided_review_messages (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  depth TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  citations TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  model TEXT,
  claimed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE UNIQUE INDEX idx_guided_review_messages_seq
  ON guided_review_messages (workspace_id, thread_id, seq);
-- A thread waits on at most one answer at a time; a second question is refused as thread_busy.
CREATE UNIQUE INDEX idx_guided_review_messages_live
  ON guided_review_messages (workspace_id, thread_id)
  WHERE role = 'assistant' AND status IN ('pending', 'running');
CREATE INDEX idx_guided_review_messages_stale
  ON guided_review_messages (status, updated_at);

CREATE TABLE guided_review_comment_drafts (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  start_line INTEGER,
  side TEXT NOT NULL,
  body TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL,
  post_error TEXT,
  posted_url TEXT,
  rev INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_guided_review_comment_drafts_session
  ON guided_review_comment_drafts (workspace_id, session_id);
