---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Public API: notification inbox (`/api/v1/notifications`).

The external `/api/v1` surface gains the notification inbox, completing the operational tail
of the task lifecycle so an external CI/bot can resolve the human-gated ends of a run:

- `GET /api/v1/notifications` (read) — list the workspace's open notifications.
- `POST /api/v1/notifications/:id/act` (admin) — run the notification's typed side-effect:
  merge the PR for real (`merge_review` / `pipeline_complete`) or retry the run
  (`ci_failed` / `test_failed`); informational cards are just marked read. It requires an
  `admin`-scoped key because it can perform a real GitHub merge. An `act` that would retry a
  run on an individual-usage model is refused (`409 individual_model_unsupported`), matching
  the task retry endpoint (a headless key has no personal-credential unlock).
- `POST /api/v1/notifications/:id/dismiss` (write) — dismiss a card without acting on it.

Every route is scoped to the key's workspace via the existing per-key scope ladder
(`read` ⊂ `write` ⊂ `admin`) and delegates to the same `NotificationService` the SPA inbox
uses — no new persistence or machinery, so it is runtime-symmetric by construction and
covered by the cross-runtime conformance suite. The merge/retry side-effect is now shared
between the SPA and public controllers. The OpenAPI spec (`docs/openapi.json`) is regenerated.
