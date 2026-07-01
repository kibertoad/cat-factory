---
---

CI-only: gate the release (publish) and deploy workflows so a docs-only merge no
longer triggers them. Publishing skips when the only changes are non-README docs
(README ships in the npm tarball, so it still republishes; changesets still drive
releases). Deployment skips for any docs-only merge, README included.
