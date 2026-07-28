---
'@cat-factory/executor-harness': patch
'@cat-factory/agents': patch
'@cat-factory/app': patch
---

Fix the PR deep-review's live slice list collapsing, and bound how many slice subagents run at once.

- **The plan and the subagent dispatches are MERGED, not picked between.** The harness derives slice progress from two views of the same slicing: the parent's task list (the inventory, and the only place a not-yet-dispatched slice is named) and the `Agent`/`Task` dispatches (the live status). `pickProgress` chose whichever looked further along, so the moment the first subagent returned the dispatch view won on `completed` and the rendered list collapsed to the slices dispatched so far — every queued slice vanished from the window and reappeared one at a time as it was picked up. `mergeProgress` folds the dispatch statuses ONTO the plan's inventory instead: paired by normalised slice name, then positionally into the leftover pending entries, with an unpairable dispatch appended rather than dropped. The list can only grow, and a status can only advance.
- **At most 5 slice subagents in flight.** The fan-out was unbounded, and a large PR slices into dozens: every one is a concurrent conversation on the same account, so a full-width wave buys rate-limiting rather than speed and lands all the findings in one burst at the end. This is a prompt-level budget (the CLI owns tool dispatch, so the harness can observe the in-flight count but cannot refuse a call). The reviewer is also told to mark a slice's task entry in progress on dispatch and completed on return, and to name the dispatch after the slice's task entry so the two views pair cleanly.
- **The "Reviewing now" callout stays mounted for the whole reviewing phase.** With a bounded window there are moments between two waves when nothing is in flight; dropping the callout there made the window look like it had lost one of its two lists.
