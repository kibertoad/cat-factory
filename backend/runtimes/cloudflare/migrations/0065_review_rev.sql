-- Optimistic concurrency for the iterative-review stores (race-condition audit 2.5).
--
-- A requirements / clarity / brainstorm review is ONE JSON blob holding every finding, and every
-- mutation used to load it, edit one item, and write the whole row back. Two writers in that
-- window (two people answering different findings, a dismissal racing the durable driver's
-- incorporation pass) left only the last writer's edit — and because incorporation refuses to run
-- while any finding is still `open`, a lost dismissal wedged the loop on a phantom open item.
--
-- `rev` is the monotonic token every read-modify-write now CASes on: the store writes only while
-- the row still carries the revision the caller loaded, so a lost race reloads and re-applies
-- instead of clobbering. Existing rows start at 0, which is exactly what an unset column reads as.
ALTER TABLE requirement_reviews ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clarity_reviews ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE brainstorm_sessions ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
