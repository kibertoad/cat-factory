---
'@cat-factory/worker': patch
'@cat-factory/orchestration': patch
---

Agent execution now resolves the target GitHub repo by walking the running
block's ancestry up to its enclosing service frame (where repos are actually
linked), instead of matching the task block's own id — which never matched and
silently fell through to the workspace's first repo (alphabetically). That
fallback is removed entirely: a task under a service with no linked repo now
throws an actionable error rather than force-pushing into an unrelated
repository (e.g. a simple-service task targeting butter-spread).

`BoardScanService.spawnBlueprint` now links the spawned service frame to its
backing repo projection, so a scanned repo's tasks resolve to the right repo out
of the box instead of throwing for want of a link.

Also adds the `workflows: write` permission to the GitHub App manifest (both the
JSON and the in-repo HTML submitter) so agents may add or update
`.github/workflows/*` files; without it GitHub rejects pushes that touch workflow
files. Existing installations of both the default and privileged Apps must approve
the new permission in GitHub before this takes effect.
