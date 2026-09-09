---
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Read one notification row where the engine was reading the whole inbox, and write one review key where the SPA was cloning the record

Five paths on the run loop answered a one-row question by pulling every open notification in the
workspace and filtering in JS: does a card already point at this parked run, is the workspace-wide
`budget_paused` card open, and the two "ready for review/testing" clears. Each decoded every open
card's `body` and `payload` JSON, and each ran per park and per gate pass, so the cost grew with
whatever humans had not yet actioned rather than with the thing being asked about. They read
narrowly now, through `NotificationService.findOpenByType` / `clearByType` / the new
`clearOnBlock` (one find-then-settle for every "the run settled this card itself" path, replacing
two copies of it in the controllers and the loop inside `clearWaitingDecision`), and through a new
`NotificationRepository.listOpenByBlock(workspaceId, blockId)` for the park check, served by the
existing `(workspace_id, block_id, type, status)` index on its leading columns. That one
deliberately takes no `type`: the caller asks whether ANY card points at the block, so narrowing to
one would raise a duplicate beside a card of another type.

Two behaviour notes, neither of them cosmetic:

- **`clearByType` settles EVERY open block-less card of its type, not just the newest**, in one
  `UPDATE … RETURNING` (`NotificationRepository.dismissOpenByType`). A block-less card is exempt
  from the partial unique index behind the block-scoped raise, because NULLs are distinct in a
  unique index, so `raise` still de-dupes it with a read-before-write and two writers landing in
  one tick can leave two open rows. The inbox scan this PR removed was healing that on every
  clear; a point-read would have left the second card open forever, escalated red for a condition
  that had since cleared. It returns `Notification[]` (newest first) instead of
  `Notification | null`, which the platform-health and key-drift sweeps read.
- **`NotificationRepository` gains two required members** (`listOpenByBlock`, `dismissOpenByType`),
  so an out-of-tree implementation of the kernel port stops compiling until it adds them. Both are
  mirrored D1 ⇄ Drizzle with conformance assertions and allow-listed `remote` for mothership mode.

On the SPA side the review-family stores (requirements, clarity, brainstorm, consensus, doc
interview, initiative) wrote a key by replacing the whole record. That record is a deep reactive
ref, so the replace is a write to the ref itself, a dependency every reader shares: one review
event woke every card on the board, not just the one whose review changed. They assign the key
now, and `requirements.backgroundStage` (the getter every card actually calls) answers the
pending-recommendation half off the block's own review object rather than a `computed` over the
record, which tracked every key and kept the fan-out alive on its own.
`notifications.byBlock` was deleted rather than fixed, its per-block badge having moved to
`reviewDebtByBlock` some time ago with nothing left consuming it.

The wire shapes, the inbox contents and the rendered UI are unchanged.
