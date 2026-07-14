---
'@cat-factory/app': patch
---

Frontend startup optimizations (app-startup initiative, items 1/8/12):

- **Cold-open instrumentation** — `performance.mark`/`measure` at the cold-open milestones
  (auth-ready → workspaces-listed → snapshot-hydrated → stream-connected) so the SPA's
  launch-to-live-board waterfall is visible in traces.
- **Waterfall flatten (item 8)** — on a cold open with a persisted board, `workspace.init()` now
  fetches that board's snapshot speculatively in parallel with the workspace list instead of after
  it, shaving one sequential round trip off the critical path (membership is validated; a stale
  persisted id falls back cleanly, and the happy path still pays exactly one snapshot fetch).
- **Single-flight probes (item 12)** — integration probes (github / documents / tasks / slack /
  fragment library) gain `ensureProbed()` single-flight-per-board semantics, so the board-open
  fan-out from the page and the SideBar collapses to one request per board instead of duplicating;
  `probe()` stays the explicit post-connect refresh.
