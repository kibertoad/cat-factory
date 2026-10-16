-- Account-level endpoints that receive the directory change feed as signed pushes
-- (backend/docs/adr/0067-directory-sync.md). `delivered_seq` is the feed position pushed
-- through. A sweeper takes the lease (`lease_token`, held until `lease_until`) before a push and
-- moves `delivered_seq` only after the push succeeds, so two sweepers never push overlapping
-- pages, a failed push is retried, and a page whose sweeper died is offered again once the lease
-- expires.
CREATE TABLE directory_webhooks (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  secret_sealed TEXT,
  delivered_seq INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
);
