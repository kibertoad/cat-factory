---
'@cat-factory/app': patch
---

Frontend performance pass on the real-time board hot path and initial bundle:

- **Indexed block queries** — `useBlockQueries` now builds a single `parentId → children`
  (and `epicId → members`) index per `blocks` change, so per-frame queries (`tasksOf`,
  `modulesOf`, `childrenOf`, `allTasksUnder`, `epicMembers`) are O(1) lookups instead of
  full-array scans. A streamed single-block upsert no longer costs O(frames × N).
- **Grouped gate lookups** — the execution store exposes `decisionsByBlock` /
  `approvalsByBlock` maps, and `BlockNode` resolves its badges via those instead of
  re-filtering the global open-decision/approval lists once per frame. `BlockNode` also
  computes its merged/PR task counts in a single pass.
- **In-place board reconcile** — `board.hydrate` reuses the existing object for any
  unchanged block, so a coarse full-refresh doesn't hand every frame/task a new reference
  and re-render the whole board.
- **Lazy panels** — the ~25 heavy, rarely-open settings/integration/provider/sandbox
  panels in the board page are now `defineAsyncComponent` + `v-if`-gated on their open
  flag, so they code-split out of the initial bundle and don't run setup/watchers while
  closed. Each such panel's load-on-open watcher (`watch(open|executionId, …)`) is now
  `{ immediate: true }` so it still fetches on first open — under `v-if` the panel mounts
  with its flag already true, so the `false→true` flip the watcher keyed on no longer
  fires within its lifetime.
- **Per-workspace cache cleanup** — the requirements, clarity, brainstorm, consensus and
  GitHub stores gained a `reset()` that runs on a workspace switch, so a switched-to board
  no longer shows the previous workspace's stale reviews/sessions/repos.
- Smaller cleanups: single-pass fixture/grade joins in the sandbox results table,
  `toRaw`-based manifest cloning, and dropped redundant `deep: true` settings watchers.
