---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/observability-otel': minor
'@cat-factory/conformance': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Finish the in-app-tutorial initiative (now [ADR 0033](backend/docs/adr/0033-in-app-tutorials.md)):
make the walkthroughs reach the user who needs one, and measure whether they do.

The catalogue already made every tour REACHABLE; nothing brought one up. Starting any tour saves the
launch-prompt answer, which is what stops that prompt returning, so after a user's first tour the
product never mentioned the tutorial again unless they went looking, and the two tours whose windows
are transient (answer a parked run, review and merge) were the least likely to be found while they
applied. So: the finish card now hands off to the one walkthrough the user's own last action
unlocked, and a contextual offer catches a tour's declared requirements flipping from blocked to
ready. Four new tours ship with it, the first of which closes the biggest hole in the arc: reading a
FAILED run (the state a first run reaches most often, and the only one that had no walkthrough),
plus where runs execute, review-by-panel, and the shared-services catalog.

Progress now follows the USER rather than the browser, through a new per-user `tutorial_progress`
table on both facades (`remote` in mothership mode, self-scoped). The browser-persisted store stays
what the SPA reads and stays fully functional with no accounts, no store wired, or offline; the
server row is a best-effort mirror. Both id lists are grow-only sets, UNIONED on both sides, because
two browsers signed in as one person each hold a full copy and each write it back: a
last-writer-wins replace on either side silently drops what the other learned. "Reset progress" is
therefore a DELETE.

Three new operational counters (`tutorial.tour_started` / `_completed` / `_abandoned`, dimensioned
by tour) answer the question the initiative could not answer about itself. They ride the existing
`OperationalMetrics` port because there is deliberately only one counter seam; the tour dimension is
bounded twice, by the wire schema's shape rule and by a per-process distinct-value cap that folds
the rest onto a visible `other` bucket, since a dimension whose values come from a browser is
otherwise an unbounded-cardinality hole in an operator's metrics backend.

New internal routes (not `/api/v1`, so no SDK surface): `GET|PUT|DELETE /tutorial/progress` and
`POST /tutorial/events`, root-mounted beside `/user-settings`. Root-mounted specifically so they sit
outside the workspace-RBAC viewer write floor, which a read-only viewer taking a walkthrough would
otherwise trip. The workspace snapshot gains an optional `tutorialProgress`, and `NavGates` gains
`boardHasFailedRun`; a deployment that builds its own gates object must add that field.
