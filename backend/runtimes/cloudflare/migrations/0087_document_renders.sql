-- Design-document renders: the pixels an import retains beside the text.
--
-- A design source describes a screen twice over, as the structure/styling an agent reads and as the
-- picture a person recognises. The second half now lands in the binary-artifact store as a
-- `reference` artifact, which is the same shelf the visual-confirmation gate already reads from,
-- so a design frame and a hand-uploaded reference image are the same kind of thing to every reader
-- downstream. Two columns are needed to make that work.

-- What became of the renders at the import that wrote the stored body: `stored` / `partial` /
-- `none` / `failed` / `storage_unavailable`. Deliberately nullable, and NULL is a distinct fourth
-- state rather than a default: it means the question does not apply (a prose source, an `upload`,
-- or a row written before renders existed), where every non-null value means renders WERE in scope
-- and says how they went. Each of those failures renders as the same absence of images and asks for
-- a different fix (configure image storage, retry a rate-limited source, or nothing at all), which
-- is the whole reason this is a vocabulary and not a boolean.
ALTER TABLE documents ADD COLUMN render_status TEXT;

-- Which imported document an artifact was rendered FROM, or NULL for one a person uploaded.
--
-- The document's own SOURCE identity (`documents` is keyed by `(workspace_id, source, external_id)`)
-- rather than the block it happens to be attached to: an import runs before the document is
-- attached to anything, the attachment can move later, and only artifacts that came from a document
-- may be replaced wholesale when it is re-imported. Keyed on the pair so the reclaim is one indexed
-- range delete rather than a scan.
ALTER TABLE binary_artifacts ADD COLUMN document_source TEXT;
ALTER TABLE binary_artifacts ADD COLUMN document_external_id TEXT;
CREATE INDEX idx_binary_artifacts_document
  ON binary_artifacts (workspace_id, document_source, document_external_id);
