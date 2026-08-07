---
'@cat-factory/app': patch
---

Keep an inbox card a run raised while a snapshot refresh was in flight

The `pr-review` e2e spec failed in CI waiting 30s for `notifications-bell`, which never rendered.
The bell is gated on `notifications.count`, and the card was in the store: a full-snapshot
`refresh()` had already replaced it away.

Two delivery shapes meet at the moment a run parks. The card arrives as a targeted `notification`
event, and the park also fans out coarse `board` events whose debounced `workspace.refresh()` is
routinely mid-flight right then. That refresh READ its snapshot before the card existed, and the
notifications store's `hydrate` was a plain replace, so the card was overwritten by a list that
predates it. Nothing re-sends a notification, so there is no second delivery: the run stays parked
with no way for anyone to see it. This is the documented full-refresh clobber, on the one entity
that cannot re-derive its state, which is why it presents as a rare flake rather than a visible
bug.

The board store already guards its own half with a watermark, and that guard is why the same
refresh left the task card's `blocked` status intact while wiping the notification beside it. The
notifications store now takes the same shape: each live write is stamped with a monotonic
sequence, `refresh()` captures both stores' baselines before its fetch, and a hydrate keeps every
write newer than the baseline it was handed. The two baselines travel as one `LiveWriteBaselines`
object rather than a second positional argument, so a third store joining is an added field.

The guard tracks REMOVALS as well as inserts, which the board's does not need to. A notification
resolved live (acted on in another tab, cleared by the engine) is absent from the store but still
open in a snapshot read before it resolved, so an insert-only watermark would resurrect a card
offering an action the server has already taken. Both directions are pinned in
`stores/workspace.spec.ts`.

Widening the e2e assertion or retrying the spec was not on the table: a flaky e2e test is a real
product race and this one was reproducible on demand once the snapshot response was held open
across the park, which is exactly what CI latency does by accident. That repro fails before this
change and passes after; the pr-review and notifications specs then ran 48 consecutive green
passes.

Worth a reviewer's attention: the live-write map is pruned on every guarded hydrate (entries at or
below the committing baseline are reconciled and dropped), which relies on `refreshSeq` letting
only the latest-issued refresh commit, so baselines commit in non-decreasing order.
