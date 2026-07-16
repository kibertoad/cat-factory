---
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
---

perf(db): index `password_reset_tokens.expires_at` so the token-expiry sweep is index-driven instead of a full-table scan (performance initiative item 21). Lands symmetrically on both runtimes — a D1 migration and the mirrored Drizzle `idx_password_reset_tokens_expiry`.
