# @cat-factory/directory-sync

## 0.2.1

### Patch Changes

- 5d586fc: The SDK packages no longer pin each other to an exact version. A dependency on a sibling publishes as a caret range, so a consumer a patch ahead on `@cat-factory/sdk` keeps one copy of it. `@cat-factory/directory-sync` takes `@cat-factory/sdk` as a peer (`>=0.57.0 <1.0.0`): the client it drives is the integrator's own, so it now uses their copy of the SDK and installs none of its own. Add `@cat-factory/sdk` to your dependencies if you did not already have it.

## 0.2.0

### Minor Changes

- d0a7cb9: Two new packages for integrators. `@cat-factory/webhooks` verifies a signed cat-factory webhook
  delivery (`verifyDelivery`, plus `verifyRequest` for a Fetch API request), with Web Crypto only so
  it runs on Node, in a browser or in a worker isolate. `@cat-factory/directory-sync` keeps a copy of
  an account's directory in sync over a `DirectoryStore` you implement: snapshot bootstrap,
  change-feed catch-up with a fallback to reconciliation on `cursor_expired`, verified webhook pushes,
  and a full reconciliation that deletes what the source dropped. `@cat-factory/gatekeeper-worker`
  now re-exports its delivery verifier from `@cat-factory/webhooks`; its public surface is unchanged.

### Patch Changes

- Updated dependencies [04c1587]
- Updated dependencies [f1b6c9a]
- Updated dependencies [d0a7cb9]
- Updated dependencies [20d4f01]
  - @cat-factory/sdk@0.57.0
  - @cat-factory/webhooks@0.2.0
