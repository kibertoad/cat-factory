-- Account-level endpoints that receive the directory change feed as signed pushes
-- (docs/initiatives/directory-sync.md, slice 4). `delivered_seq` is the feed position pushed
-- through; the delivery sweep advances it with a compare-and-swap before each push and moves it
-- back when the push fails, so a page is never sent twice concurrently and a failure is retried.
CREATE TABLE directory_webhooks (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  secret_sealed TEXT,
  delivered_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
);
