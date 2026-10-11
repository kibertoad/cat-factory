---
'@cat-factory/webhooks': minor
'@cat-factory/directory-sync': minor
'@cat-factory/gatekeeper-worker': patch
---

Two new packages for integrators. `@cat-factory/webhooks` verifies a signed cat-factory webhook
delivery (`verifyDelivery`, plus `verifyRequest` for a Fetch API request), with Web Crypto only so
it runs on Node, in a browser or in a worker isolate. `@cat-factory/directory-sync` keeps a copy of
an account's directory in sync over a `DirectoryStore` you implement: snapshot bootstrap,
change-feed catch-up with a fallback to reconciliation on `cursor_expired`, verified webhook pushes,
and a full reconciliation that deletes what the source dropped. `@cat-factory/gatekeeper-worker`
now re-exports its delivery verifier from `@cat-factory/webhooks`; its public surface is unchanged.
