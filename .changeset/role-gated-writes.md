---
'@cat-factory/app': patch
'@cat-factory/contracts': minor
'@cat-factory/kernel': patch
---

The SPA no longer offers four writes the backend refuses for the caller's role. In the follow-up
window, the follow-up's Dismiss is off for a board viewer, like its siblings. The describe-work
dialog hides More kinds and Attach context from a viewer, because both open the full add-task form.
The account Team tab hides Invite, Revoke, and the email sender's Connect and Disconnect from anyone
who is not an account admin. The MCP consent screen offers only the boards where the person holds
`secrets.manage`, and says so when there are none.

`WORKSPACE_ROLE_PERMISSIONS` and `permissionsForRole` move from `@cat-factory/kernel` to
`@cat-factory/contracts`, so the SPA reads a board's `viewerRole` with the same map the backend
enforces. Kernel re-exports both, so its imports do not change.
