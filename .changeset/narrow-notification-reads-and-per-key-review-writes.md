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
whatever humans had not yet actioned rather than with the thing being asked about. Three of them
now go through seams that already existed (`findOpenByBlock`, `findOpenByType`, `clearByType`,
exposed on `NotificationService`); the park check goes through a new
`NotificationRepository.listOpenByBlock(workspaceId, blockId)`, mirrored D1 and Drizzle with a
conformance assertion and served by the existing `(workspace_id, block_id, type, status)` index on
its leading columns. It deliberately takes no `type`: the caller asks whether ANY card points at the
block, so narrowing to one would raise a duplicate beside a card of another type.

On the SPA side the review-family stores (requirements, clarity, brainstorm, consensus, doc
interview, initiative) wrote a key by replacing the whole record. That record is a deep reactive
ref, so the replace is a write to the ref itself, a dependency every reader shares: one review event
woke every card on the board, not just the one whose review changed. They assign the key now.
`notifications.byBlock` was deleted rather than fixed, its per-block badge having moved to
`reviewDebtByBlock` some time ago with nothing left consuming it.

Nothing about the wire shapes, the inbox contents or what a human sees changes.
