---
'@cat-factory/contracts': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/app': patch
---

Requesting Requirement-Writer recommendations is now asynchronous, like every other
requirements-review operation. The request returns at once with `pending` placeholder
recommendations and the user is handed back to the board; the Writer runs per finding in
the durable driver (signalled through the parked requirements gate, mirroring the
incorporate flow), filling each placeholder (`pending` → `ready`) with live progress and
raising a notification when the batch is ready. The review window shows "N / M ready" plus
per-finding "generating…" placeholders, and the board's "Recommending…" badge is now driven
by server state (a `pending` recommendation), so it survives closing the window. A finding's
typed answers are flushed before the request and preserved across the async cycle, so the
user's explicit answers are still there when they return to confirm recommendations.
Re-requesting a single recommendation rides the same async path; rejecting one now reopens
its source finding so it can be answered manually. No schema migration (recommendation
status lives in the existing JSON column) and no prompt/image change.
