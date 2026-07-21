---
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/app': patch
---

fix(board): stop the board churning on inspector edits + widen the custom-manifest picker

Two Test Infrastructure inspector papercuts:

- **Board no longer jumps when a Provision Type is selected.** `updateBlock` echoed its
  coarse `board` event back to the acting tab, forcing a full board re-hydrate on every
  field edit (each provision-type click). It now forwards the acting tab's
  `X-Connection-Id` and the realtime transport suppresses that self-echo — the same
  contract `moveBlock`/`reparent` already follow. The tab still applies the change from its
  REST response; every other subscriber still refreshes.
- **The custom manifest-type picker renders full-width.** The `USelect` (and its path
  input) carried no width, so as an `inline-flex` control it and its dropdown rendered as a
  narrow box overlapping the hint text. Added `w-full` to match every other select.
