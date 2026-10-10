-- Optimistic-concurrency revision for the capability-credential row (0077). The row is ONE
-- sealed blob holding the whole set, and the per-key writes (the checklist UI's save / delete)
-- are read-modify-write over it, so they ride a rev-guarded compareAndSwap rather than a blind
-- upsert, or two operators saving DIFFERENT keys would silently destroy each other's. Existing
-- rows start at 0; every write bumps it.
ALTER TABLE capability_credentials ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
