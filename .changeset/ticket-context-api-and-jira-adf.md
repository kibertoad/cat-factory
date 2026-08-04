---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/app': patch
---

Ticket context is a first-class input to public task creation, and Jira ADF replies are read.

`POST /api/v1/services/:serviceId/tasks` takes an optional `ticket` (`{ source, ref }`, where
`ref` is a canonical issue key or a full issue URL). The platform imports that issue and ATTACHES
it to the new task, the same linkage the app's own create-from-issue produces: each agent step
re-reads the live issue as context, the writeback path posts a run's clarification questions onto
it, a reply typed on the ticket resolves against the parked run, and the intake sweep treats the
issue as taken. Before this a headless intake could only paste the issue into `description`, which
kept the words and lost all of that.

Additive on the wire (OpenAPI surface `1.0.0` → `1.1.0`; regenerated in all four SDKs). Two
refusals are worth knowing about: the ticket is resolved BEFORE the task is created, so an unknown
source or an issue the tracker will not serve leaves the board untouched rather than producing an
unlinked task; and a ticket already linked to another task is a `409` carrying
`details.reason: 'ticket_already_linked'` plus `details.taskId`, which is what lets a redelivering
integration follow the existing task instead of filing a duplicate. That reason is now also
emitted by the app's create-from-issue, which previously refused the same condition in prose only.

One task per ticket now holds under CONCURRENCY, which is what redelivery actually produces. The
read that refuses has already returned by the time a task is created, so `TaskRepository` gains
`claimBlockLink` (a conditional write on `linked_block_id`, mirrored D1 and Drizzle with a
concurrent conformance assertion) and both filing paths go through it. Previously two simultaneous
filings of one issue both succeeded, and the second silently re-pointed the link, stripping the
first task of the context it was created with. The headless filing additionally rolls its task
back off the board when it loses, so retrying on the `409` cannot accumulate duplicates.

Jira's ADF renderer is also bounded now. A comment body is external structure rather than something
the vendor's editor produced, and a recursive walk over it was an unbounded stack and, on the
Worker, an unbounded request budget. It renders under a node and depth budget far above any real
document and states it when either is hit, rather than stopping where a reader would read the cut
as the end of the text.

Separately, Jira Cloud comment webhooks are read as Atlassian Document Format. Jira v3 sends
comment bodies as an ADF document rather than a string, so every rich-text reply was dropped
before it reached the review-reply grammar, and silently: an unparsed delivery is acked, so a
reporter who answered a clarification question in Jira's own editor got nothing recorded and no
acknowledgement saying so. The bodies now go through the import path's own `adfToMarkdown`, which
gained the leaf nodes that carry their text in `attrs` (mention, emoji, status, smart link) so a
name, a state or a link no longer vanishes out of the middle of a sentence.
