-- Consensus orchestration (optional `@cat-factory/consensus` mechanism) + the core
-- task-estimator triage that gates it.
--
-- `blocks.estimate`     — the task-estimator's JSON triage (complexity/risk/impact),
--                         persisted on the task block for gating + UI. CORE.
-- `pipelines.consensus` — JSON array of per-step consensus configs, parallel to
--                         agent_kinds (set in the pipeline builder for eligible steps).
-- `consensus_sessions`  — one row per (execution, step) recording the multi-model
--                         transcript (participants, rounds/votes, synthesis) — the
--                         observability surface the dedicated window renders.

ALTER TABLE blocks ADD COLUMN estimate TEXT;
ALTER TABLE pipelines ADD COLUMN consensus TEXT;

CREATE TABLE consensus_sessions (
  workspace_id TEXT    NOT NULL,
  id           TEXT    NOT NULL,
  block_id     TEXT    NOT NULL,
  execution_id TEXT,
  step_index   INTEGER NOT NULL,
  agent_kind   TEXT    NOT NULL,
  strategy     TEXT    NOT NULL,
  status       TEXT    NOT NULL,
  participants TEXT    NOT NULL DEFAULT '[]',  -- JSON ConsensusParticipant[]
  rounds       TEXT    NOT NULL DEFAULT '[]',  -- JSON ConsensusRound[]
  synthesis    TEXT,                           -- the synthesized result (null until done)
  confidence   REAL,                           -- aggregate confidence 0..1 (ranked-voting)
  dissent      TEXT    NOT NULL DEFAULT '[]',  -- JSON string[]
  error        TEXT,                           -- failure detail when status='failed'
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX idx_consensus_sessions_step
  ON consensus_sessions (workspace_id, execution_id, step_index);
CREATE INDEX idx_consensus_sessions_block
  ON consensus_sessions (workspace_id, block_id, created_at);
