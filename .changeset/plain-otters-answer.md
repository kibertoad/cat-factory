---
'@cat-factory/integrations': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Stop the parked-review question comment promising answer channels that do not work.

Both faults are in the one line the whole comment exists to deliver, and both were invisible to the
reader who would follow it: the bug REPORTER, who came in through the ticket and has no other
surface.

- **The API path it printed was a 404.** The comment said
  `POST …/decisions/requirements/items/<id>/reply`; the surface serves `…/findings/:itemId/reply`.
  The path now comes from the route contract's own `pathResolver`
  (`replyPublicRunFindingContract` / `replyPublicRunClarityFindingContract`), so the comment and the
  router cannot disagree again. The assertion that should have caught this had copied the same
  mistake, so it is now derived from the contract too.
- **It offered a ticket reply where one cannot arrive.** The inbound path fails closed without a
  minted per-connection webhook secret, so a workspace that connected a tracker and imported tickets
  without ever minting one got a comment telling its reporter to type `@cat-factory answer …` at
  nothing. `IssueWritebackService` now establishes the fact from `taskConnectionRepository` (once per
  DISTINCT source across the block's linked issues, so several issues on one tracker cost one read)
  and the renderer offers only channels that work. Absent or unreadable counts as UNWIRED, because
  guessing the other way is the failure itself; the drop is logged once per claimed post with the
  operator's remedy.

Two smaller corrections in the same area:

- **A finding id from the OTHER review on the ticket is named as that**, not as a finding that does
  not exist. One ticket now carries both reviews' question comments, so answering both sets in one
  comment is the ordinary mistake; `no finding X` told a reporter an id printed on their own ticket
  was not real, where the true reason has a remedy. A typo still reads as a typo.
- **`TrackerWebhookService.resolveReview` drops its single-candidate short-circuit.** The general
  tie-break chain already answers the one-review case, so the fast path only created a second route
  that could answer differently from the first.

Also: `check:openapi` now distinguishes an ABSENT artifact from an unreadable one, since
`pnpm gen:openapi` fixes the first and does nothing for the second.

Breaks (both unreleased): `renderReviewQuestionsComment` takes a required `ReviewQuestionChannels`,
and `IssueWritebackServiceDependencies` gains an optional `taskConnectionRepository`. Both facades
pass it inside the block they already gate on that repository, so the wiring stays symmetric.
