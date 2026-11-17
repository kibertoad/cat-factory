---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
---

The Infrastructure window now tells a board's own runner pool from the one it inherits from its
account. An inherited pool carries an "Account pool" badge and has no remove button, and the
connect form under it registers a pool of the board's own instead of editing the account's. When
the account has a pool, the window also offers to stop using it (advanced mode), to use it again
after an opt-out (every mode), and, before a board's own pool is removed, to fall back to it.

`GET /workspaces/:ws/runner-pool/connection` gains `connection.source` (`workspace` or `account`)
and `accountPool`, the account's pool as safe metadata whether or not the board uses it. This is an
SPA route, not `/api/v1`. `DELETE /runner-pool/connection?fallBackToAccount=true` now also turns
`inheritAccountRunnerPool` back on, so the fall-back holds for a board that had opted out before it
registered its own pool; before, it left the marker as it was.
