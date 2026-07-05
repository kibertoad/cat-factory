---
---

CI: collapse the sharded test lanes (`test-worker` / `test-db` / `test-e2e`) to a single
shard on push to `main`, keeping the full 3-way split on pull requests and manual
`workflow_dispatch` runs. Post-merge `main` runs are un-hurried, so trading wall-clock for
fewer runner-minutes there is worthwhile; PR feedback latency is unchanged.
