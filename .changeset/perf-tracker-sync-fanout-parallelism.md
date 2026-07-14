---
'@cat-factory/integrations': patch
'@cat-factory/server': patch
---

Parallelize the real-time fan-out publisher and the GitHub sync fan-out (performance
optimizations tracker items 12 & 14).

Two hot paths forwarded independent work serially. Both now run their independent forwards
concurrently; no behaviour or wire-shape change.

- **Item 14 — `FanOutEventPublisher`:** a live change to a service mounted on N boards
  re-published the event to each mounting workspace with a `for (…) await inner.x(ws)` chain
  (N serial Durable Object round-trips per state transition on the Worker). Each method now
  `Promise.all`s the per-target forwards, so a shared service pays one round-trip's latency,
  not N. The forwards were already independent and best-effort.
- **Item 12 — `GitHubSyncService`:** `syncRepo` fetched its branches / PRs / issues / commits
  serially and fanned each projection out to the linking workspaces one-at-a-time. The four
  independent cursor resources (each on its own installation-scoped cursor, no cross-kind
  ordering) now fetch+upsert in one concurrent wave (checks still waits on the branch head it
  needs), and each resource's per-workspace projection writes fan out via `Promise.all` — so a
  repo shared by N workspaces costs one write's latency per resource, not N. The data-scaled
  `resyncWorkspace` (per repo) and `backfillInstallation` (per workspace) loops move from
  serial to **bounded** concurrency via `p-map`, deliberately capped (4 repos / 3 workspaces in
  flight) so a large installation backfills in parallel without an unbounded burst of concurrent
  GitHub reads tripping the provider's secondary rate limits.

Also standardizes bounded-concurrency fan-out on `p-map` instead of hand-rolled limiters: the
existing in-tree `mapLimit` in `readServiceSpec` (`@cat-factory/server`) is replaced with `p-map`
too, so there's one blessed helper. The `@cat-factory/agents` `Semaphore` stays (it is a shared
FIFO permit/mutex, not a bounded map — `p-map` doesn't cover that shape); only its comment is
corrected.

Pure orchestration changes in the shared packages (used identically by both runtime facades);
no persistence or conformance surface. Pinned by new unit tests for the concurrent forwards and
the concurrent resource wave / workspace fan-out / bounded loops.
