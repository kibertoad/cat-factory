-- Interactive document-interview sessions (WS5 of the document-task initiative). One live
-- session per document-authoring block: the `doc-interviewer` step converses with the human to
-- refine a document's scope/audience/structure, and this row holds the Q&A transcript + the
-- synthesized authoring brief the writer starts from. The service keeps at most one live session
-- per block (a re-run clears the prior one), so a read-by-block returns the latest. The Q&A live
-- as a JSON array in `qa`; `round`/`max_rounds` track the iterative loop.
CREATE TABLE doc_interview_sessions (
  workspace_id TEXT    NOT NULL,
  id           TEXT    NOT NULL,
  block_id     TEXT    NOT NULL,
  status       TEXT    NOT NULL,
  round        INTEGER NOT NULL DEFAULT 0,
  max_rounds   INTEGER NOT NULL DEFAULT 4,
  qa           TEXT    NOT NULL DEFAULT '[]',
  brief        TEXT,
  model        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX idx_doc_interview_sessions_block ON doc_interview_sessions (workspace_id, block_id);
