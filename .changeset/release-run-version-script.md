---
---

ci(release): run the root `version` npm script from the changesets action so the runner-image pin auto-sync executes on every Release PR (prevents the "Guard runner image tag" drift that red-failed the release).
