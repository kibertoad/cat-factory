---
---

CI-only: drop the non-blocking `test-e2e (merged report)` job and the per-shard blob-report
upload. Each e2e shard already fails loudly on its own, and the per-shard `test-results/`
trace + video artifact remains the diagnosis material, so the combined HTML report the merge
job produced is no longer generated.
