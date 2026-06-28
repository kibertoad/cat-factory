---
---

CI-only: shard the Playwright e2e suite across 2 jobs via `playwright test --shard`, with a follow-on job that merges the per-shard blob reports into one HTML report. No package code changes.
