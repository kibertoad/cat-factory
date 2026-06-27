---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/workspaces': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Add "forgot my password" self-service reset for password-based logins.

A user can request a reset link by email (`POST /auth/forgot-password`) and set a new
password via a one-time, expiring token (`POST /auth/reset-password`). Tokens are stored
hashed (SHA-256), single-use, and mirror the invitation flow; the reset email is sent
through a new deployment-level **system** email sender configured via
`EMAIL_SYSTEM_PROVIDER` / `EMAIL_SYSTEM_FROM` / `EMAIL_SYSTEM_API_KEY` (when unset, the
link is logged for local/dev). The request endpoint never reveals whether an email is
registered.

Schema addition (both runtimes): a new `password_reset_tokens` table (D1 migration
`0017_password_reset_tokens.sql` ⇄ a Drizzle Postgres migration). No data migration is
needed — the table starts empty.
