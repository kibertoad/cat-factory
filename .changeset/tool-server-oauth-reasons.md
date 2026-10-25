---
'@cat-factory/contracts': minor
'@cat-factory/server': patch
'@cat-factory/integrations': patch
---

Completing a tool-server OAuth grant now refuses a bad `state` with a 422 (`details.reason: oauth_state_invalid`) and a grant started by someone else with a 403 (`oauth_started_by_other_user`), where both were a 401. The SPA signs out on every 401, so an expired link used to drop a valid session and, after sign-in, replay the same dead `state`. `TOOL_SERVER_OAUTH_REASONS` in contracts names every reason this flow refuses with, so the SPA can give each one translated copy. Internal route, not part of `/api/v1`.
