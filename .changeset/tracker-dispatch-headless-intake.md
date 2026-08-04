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

Such a run now carries `intakeOrigin: 'tracker'`, and the writeback gate asks the classification
(`isHeadlessIntake`) rather than comparing against the one origin that shipped first.

The vocabulary also gains `schedule` for cadence fires and the queue-drain push, so `ui` stops
being a catch-all for "nothing said" and becomes a positive claim that a human is watching in the
app. Every unattended start path now names itself; only the in-app start takes the default. The
field must stay optional for that one caller, so the rule is held by a coverage spec that
classifies each start path rather than by a typecheck.

`schedule` is classified NOT headless even though it is unattended. A fire works the schedule's
reused block, and queue-mode intake replace-links each pick onto it, so a question posted there
loses its reply channel on the next fire. The classification asks whether the run has a stable
place to hold a conversation, not whether a human was present.

No change to runs started in the app or through `/api/v1`. The workspace opt-in
(`writebackQuestionsOnPark`, off by default) and its per-task override still gate every post; their
copy now says "outside the app" rather than "through the API".
