---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
'@cat-factory/conformance': patch
'@cat-factory/acceptance': patch
---

Tracker writeback is ON by default, and `/api/v1` can now read and change it:
`GET /api/v1/tracker/writeback` reports what a task's linked tracker issue hears as its pull request
progresses, and `PATCH /api/v1/tracker/writeback` changes one action without moving the others.
Surface version 1.45.0, additive.

**BEHAVIOUR CHANGE, and worth reading before upgrading.** All three writeback actions (comment when
the pull request opens, comment and CLOSE the issue when it merges, post a headless run's parked
review findings) now default to ON for a workspace that has never configured them. All three were
off. Nothing published said what the defaults were, so this is not an `/api/v1` break, but it IS a
change a deployment notices: a board that never opened the issue-tracker settings panel now closes a
linked ticket when its task's pull request merges, and comments on it twice on the way. A deployment
that wants the old behaviour turns it off with one call to the new PATCH (or in the app), and a single
task can still opt out through its own per-task override.

The reasoning for the flip is that these actions only ever touch an issue a task is LINKED to, and
nothing links one by accident: a link arrives because somebody imported the issue, the recurring
intake picked it up, or a headless caller filed a task with `ticket`. Every one of those is a request
to work the issue where it was filed, so the half-closed loop was the common outcome and the wrong
one: a merged pull request beside an issue still sitting open with nothing on it saying the work was
done. The default now lives in ONE place (`DEFAULT_TRACKER_WRITEBACK` in `@cat-factory/contracts`),
read by the settings service, the writeback service and the SPA's panel, which previously spelled it
three times.

The public pair closes the last gap in the ticket-driven loop. A caller could file a task FROM a
ticket and the platform would write back to that issue, but WHETHER it did was workspace
configuration reachable only from the app, so the deployment shape that most needs the loop closed
(nobody in the SPA at all) could neither read the disposition nor change it, and could not tell "this
deployment leaves tickets open" from "the writeback is broken". Three things about the shape: it
publishes the WRITEBACK half of `tracker_settings` and not the filing selection, which is a separate
decision the writeback does not key off; the write MERGES rather than replacing, so a caller acting on
one action cannot silently reset the other two; and `updatedAt` is null when nobody has ever chosen,
which is how a caller knows it is reading defaults rather than somebody's decision.

The acceptance suite gains a fifth spec built on all of it: an issue filed on the backend repository
by an OUTSIDE reporter (its own provider credential, since an issue the platform created and closed
proves only that the credential works), a task filed FROM that issue over `/api/v1`, delivery through
`pl_build`, and then the pair of claims that the platform CLOSED the issue and commented on it at both
edges of the pull request's life. The pair matters because a provider closes an issue by itself when a
merged pull request's text carries `Closes #12`, and that path posts no comment: a closed issue alone
cannot tell the writeback from the host noticing a word an agent wrote. Two new prerequisites refuse
before any of it spends anything, and `run configure` opens the token page prefilled.
