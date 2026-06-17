# Frontend architecture — state & data flow

How the SPA stays in sync with the backend. The app is a **thin client**: it holds
no business logic, calls the Worker for every mutation, and hydrates its stores
from server snapshots plus pushed events. For the high-level tour see
[`../README.md`](../README.md).

## The three paths

```
REST (useApi)  ─────────────▶  Worker  ─────────────▶  D1
   ▲                                                    │
   │ mutations                                          │ persisted transition
stores (Pinia)  ◀── patch ──  useWorkspaceStream  ◀── WebSocket push (events hub)
```

- **Read path** — the `workspace` store loads the full snapshot and fans it into
  `board`, `pipelines`, `execution`, `spend`, etc.
- **Write path** — components call `useApi` → Worker; the response (or a pushed
  event) patches the relevant store. No optimistic business logic.
- **Live path** — `useWorkspaceStream` opens one WebSocket to
  `GET /workspaces/:ws/events?token=…`, patches `execution` / `agentRuns` /
  `board` as events arrive, and refreshes on reconnect to reconcile anything
  missed.

## Stores

One Pinia store per feature domain: `workspace`, `accounts`, `auth`, `board`,
`ui`, `pipelines`, `agents`, `execution`, `agentRuns`, `models`, `github`,
`bootstrap`, `documents`, `tasks`, `requirements`, `scenarios`, `fragments`
(built-in catalog), `fragmentLibrary` (tenant tiers + sources), and `spend`.
