---
---

Add cross-runtime conformance coverage validating that the `merger` step honours a task's
configured merge-threshold preset end-to-end: a task pinned to the "Manual review only"
(human-review-only) preset never auto-merges even on a maximally-mergeable assessment, and a
task pinned to a strict custom preset routes to human review with the correct exceeded axes.
Test-only; no runtime behaviour change.
