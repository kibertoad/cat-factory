---
'@cat-factory/app': patch
---

Deflake the e2e live-run specs and surface flaky e2e shards as red.

- Frontend: the board page now renders a hidden `data-testid="workspace-stream"` marker reflecting the real-time WebSocket's connected state. Behaviour-neutral (inert, hidden); it lets the e2e suite wait for a live channel before driving a run.
- e2e: `openBoard` now waits for that marker before returning, so a run's first `in_progress`/`blocked` events can't be broadcast to a not-yet-subscribed browser and missed (the source of the intermittent 30s timeouts in `notifications`/`reset-run`).
- CI/test-only: the Playwright config sets `failOnFlakyTests`, so a test that fails then passes on retry turns the `Test e2e` shard red instead of green. The job stays out of the aggregated `Test` gate's `needs`, so a flaky shard reports red without blocking the merge.
