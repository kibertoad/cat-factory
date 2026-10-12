---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': patch
---

A directory `DirectoryUser` carries `accounts`: the GitHub and GitLab accounts the user signed in
with, as `{ provider, id, login }` where `id` is the host's numeric user id, so a system mirroring
the directory can match people on their host account instead of an email. Linking such an account
to a user, or moving it to another user, records a `user` change on the feed for each user
involved. Password, Google and OIDC logins are not published. OpenAPI 1.83.0.
