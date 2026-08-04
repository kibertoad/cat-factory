---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/conformance': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
---

Attach spec-sized requirements documents when creating a task over the public API.

`/api/v1` had no way to give a run a specification. `description` caps at 2,000 characters because
it is a task's own framing, echoed into every prompt; the 50,000-character `POST /jobs` brief drives
inline pipelines that never touch a repository; and the app's own attach-a-document flow is
session-authed. A headless caller holding a PRD could only paste a truncated version of it into a
field and hope. `POST /api/v1/services/:serviceId/tasks` now takes an ordered `documents` list, each
entry either NAMING a page in a connected document source (imported and attached, as `ticket`
already does for a tracker issue) or CARRYING the text itself. The full body reaches agents exactly
as a document a human attached does: materialised under `.cat-context/` for a container agent,
folded into the prompt for an inline one.

Carrying the text needed a document with no source behind it, so `DocumentOrigin` (`DocumentSourceKind`
plus `upload`) is now what a stored row and its block/role links are keyed by, while everything a
provider does stays typed against the narrow union. That keeps the missing `upload` provider a
compile error rather than an `undefined` at whichever call site reaches for it first. An uploaded
document has no origin URL, and every reader now renders that absence as nothing rather than as
`Title ()` or a bare `Source:` line.

One fix rode along, found by the cross-runtime assertion for the new origin rather than by
reasoning: `urlMatchCandidates` used to hand back `['', '/']` for an empty needle, so `getByUrl`
would match every row whose stored `url` is empty. Nothing produced such a row before uploads, and
no caller passes an empty URL today, but "a lookup for nothing resolves to an arbitrary uploaded
document, which the caller then hands an agent as the page a description pointed at" is not a trap
to leave armed. It now returns null, and the four repositories that call it answer "no match".

A document is now attached to at most ONE block, enforced where the link is written rather than at
the new endpoint. `linkedBlockId` is a single column, so attaching a document another task already
holds MOVED the link instead of copying it: the earlier task silently lost a document it was created
with, and nothing in its next run reported the absence. That was reachable from the app's own
picker too, which offers already-attached documents for re-use. `linkToBlock` now refuses with
`document_already_linked` and the holder's id, the same rule and shape as one-task-per-ticket, with
translated SPA copy. Two things keep it from wedging anything: a link naming a DELETED block is not
a holder (so the guard heals rows left by past deletes), and `removeBlock` now detaches a doomed
block's documents through the removal cascade, so new ones are not made. Only the link goes; the
document survives its task.

Attaching a list is one unit of work rather than a loop: `linkManyToBlock` asserts the block once,
resolves the whole list through a new batched `DocumentRepository.listByRefs` and writes the links
through a new `linkBlockMany` (both mirrored D1 ⇄ Drizzle, with cross-runtime assertions, plus
`detachBlocks` for the cascade). The point method in a loop was three round-trips per document, ten
of which re-read the same block.

Worth watching in review: the creation is all-or-nothing. Everything refusable (an unconfigured
source, an unparseable ref, a page the provider will not serve, an upload that renders to no
readable text, a document another task holds) is refused before the board changes, and an
attachment that fails after the task exists takes the task back off the board, because a task
silently missing part of its spec is the failure this whole surface exists to prevent. Two ordering
details carry that: uploads are written only after the whole list resolves (an import is idempotent
on its ref, but every upload mints an id, so an eager write would leave one orphan per retry), and
the rollback detaches by BLOCK rather than by the refs it resolved (a rollback can be running
because one of those refs belongs to another task, and clearing it by ref would commit the very
loss the guard just refused). The attach runs before the ticket claim so that rollback can never
orphan a claimed ticket. Naming `documents` does not work in mothership mode yet, for the same
reason `ticket` does not: the document write surface is still `pending` on the persistence
allow-list, which the new `linkBlockMany`/`detachBlocks` join rather than widen.
