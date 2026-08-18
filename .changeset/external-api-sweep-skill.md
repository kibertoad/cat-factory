---
---

Repo tooling only: an `external-api-sweep` skill that re-verifies every hand-written (non-SDK)
external API call against the vendor's live documentation, and a `check-external-api-inventory`
guard that makes the sweep's inventory checkable rather than re-derived by hand each run. The guard
requires every file making an outbound HTTP call to be classified as a vendor surface the sweep
covers or as one of our own, so an integration landing between sweeps fails its own pull request
instead of sitting unswept until the next one.
