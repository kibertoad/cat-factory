---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/conformance': patch
'@cat-factory/app': patch
---

Post a parked requirements review's questions to the ticket for webhook-dispatched runs too.

A run started by a per-ticket issue-intake schedule recorded no intake origin, so it read back as
UI-started and the clarification writeback refused it: the review parked, and the person who filed
the ticket was never told. The answer channel was already open (ticket-comment replies are ungated
by intake), but the finding ids an answer has to name are only ever rendered by the question
comment, so a ticket-driven run could park and stay parked with nothing pointing at the cause.

Such a run now carries `intakeOrigin: 'tracker'`, a new member of the intake vocabulary beside `ui`
and `public-api`, and the writeback gate asks the classification (`isHeadlessIntake`) rather than
comparing against the one origin that shipped first. `ui` is a positive claim that a human is
watching in the app, so an unattended start path states its origin instead of defaulting into it.

No change to runs started in the app or through `/api/v1`. The workspace opt-in
(`writebackQuestionsOnPark`, off by default) and its per-task override still gate every post; their
copy now says "outside the app" rather than "through the API".
