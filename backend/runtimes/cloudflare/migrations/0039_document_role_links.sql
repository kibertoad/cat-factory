-- Workspace+DocKind template / exemplar document links (doc-task initiative WS1 items 2–4).
-- A `role` ('template' | 'exemplar') + `doc_kind` tag on the existing `documents` projection,
-- sitting ALONGSIDE the block-scoped `linked_block_id` anchor — the same projection + read path
-- serves a block-context link and a workspace-scoped template/exemplar link. Both nullable: a
-- plain imported / block-linked document carries neither. A partial index over the tagged rows
-- keeps the per-kind template lookup + exemplar list cheap.
ALTER TABLE documents ADD COLUMN role TEXT;
ALTER TABLE documents ADD COLUMN doc_kind TEXT;

CREATE INDEX idx_documents_role ON documents (workspace_id, role, doc_kind);
