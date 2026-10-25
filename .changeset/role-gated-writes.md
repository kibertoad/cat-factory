---
'@cat-factory/app': patch
'@cat-factory/contracts': minor
'@cat-factory/kernel': patch
'@cat-factory/server': patch
---

The SPA no longer offers writes the backend refuses for the caller's role. In the follow-up window,
the follow-up's Dismiss is off for a board viewer, like its siblings. The add-task form refuses a
viewer whichever surface opened it, and the describe-work dialog turns More kinds and Attach context
off for a viewer, with the read-only reason as the title. The account Team tab hides Invite, Revoke,
and the email sender's Connect and Disconnect from anyone who is not an account admin, and titles
the invitation list "Invitations" for them. The MCP consent screen offers only the boards where the
person holds the permission an approval needs, and says so when there are none.

`WORKSPACE_ROLE_PERMISSIONS` and `permissionsForRole` move from `@cat-factory/kernel` to
`@cat-factory/contracts`, so the SPA reads a board's `viewerRole` with the same map the backend
enforces. Kernel re-exports both, so its imports do not change. Contracts also adds
`MCP_AUTHORIZATION_APPROVE_PERMISSION`, which the consent controller and the consent screen both
read.
