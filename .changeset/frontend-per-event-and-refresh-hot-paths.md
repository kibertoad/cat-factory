---
'@cat-factory/app': patch
---

Cut the SPA's per-event and per-refresh hot paths: a per-block execution index, shared lane
derivations with structural sharing, and one funnel for every full-snapshot refresh.

Three items off the performance tracker's frontend list, grouped because they share the same two
hot paths. `execution.getByBlock` scanned the whole run list on every call, and its callers are a
computed on every mounted task card, the swimlane assembly of every mounted frame, and the board's
expansion measurement pass, so one execution event cost O(cards x runs). It reads a Map now, and the
task card's two workspace-wide gate scans read the per-block indexes that already existed for
exactly that. The swimlane assembly stopped re-deriving the workspace-wide review-debt map once per
frame, compares text through one cached collator, and hands back the previous lane objects when
nothing moved, so the common event that changes no card leaves the lane components diffing on
identity.

`workspace.refresh()` is now a funnel. It is deliberately not plain single-flight: a caller that
mutated and then refreshed is entitled to a snapshot read after its call, so a call arriving
mid-fetch joins one queued follow-up rather than the in-flight request. Any number of concurrent
callers therefore cost one extra fetch between them instead of one each, and because the funnel is
the function they already call, none of the roughly 35 direct call sites changed. The stream's
coarse-event debounce gained a max-wait cap, since trailing-only re-armed forever under a sustained
event stream and the board stopped resyncing exactly when the workspace was busiest, plus a coverage
check that drops a resync a mutation's own refresh already served.

Serializing every refresh behind one slot is what makes a stalled request everyone's problem, so
the slot is bounded: the funnel puts a deadline on its own snapshot read and aborts it, since the
API client sets no timeout and a hung fetch would otherwise stop every later refresh, the
coarse-event resync and the retry chain together. A queued follow-up is tagged with the board it was
queued for, so a board switch stands it down rather than fetching the new board on behalf of a caller
that asked about the old one.

Two things to watch. The coverage skip assumes the server emits a coarse `board` event only after
committing what it announces. And the refresh sequence guard is gone: with one fetch outstanding at
a time, two snapshots cannot resolve out of order, so the ordering it provided is now structural.
