---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': patch
---

Public API (`/api/v1`) Tier 2: a new `GET /jobs` list, and bounded keyset pagination + filters on
the service-task list.

- **`GET /api/v1/jobs`** (new, `read`-scoped) lists the workspace's headless initiative jobs,
  newest first, with `?limit=` / `?cursor=` / `?status=` / `?since=`. It closes the gap where an
  integration that lost its stored job ids — a restart, a redeploy — could never re-discover its
  own in-flight runs, since `GET /jobs/:id` needs an id it no longer has. Scoped exactly like the
  single-job read: the `internal`-anchor predicate is applied **in SQL** (a join to the anchor
  block), so an external key can never enumerate the workspace's ordinary board runs.
- **`GET /api/v1/services/:serviceId/tasks`** gains `?limit=` / `?cursor=` / `?status=`. It was
  previously unbounded: it read the ENTIRE board and filtered the service subtree in JS, so a
  large service returned every task in one response and paid a full board read per request. The
  bound, the subtree and the status filter now all live in SQL.

**Breaking wire change:** `GET /api/v1/services/:serviceId/tasks` now returns **at most 50 tasks
per response** (previously: all of them) and carries a new required `nextCursor` field. A caller
that relied on one response containing every task must now page until `nextCursor` is null.
`GET /api/v1/jobs`'s default page is 25; both accept `?limit=` up to a hard ceiling of 100.

Pagination is **keyset, not offset** — an external caller polls, so an offset page shifts under
concurrent inserts and a row created between two pages either repeats or is skipped and never
seen again. The cursor is opaque on the wire and carries the `(sortKey, id)` composite, so a burst
of runs sharing a millisecond pages correctly instead of losing the ties. A malformed cursor is a
`400 invalid_cursor`, never a silent re-serve of page 1.

Job ordering is chronological (`created_at DESC`). **Task ordering is by the stable block id, not
chronological**, and there is deliberately no `since` filter on the task list: the `blocks` table
carries no creation timestamp, so a time filter would have to be faked. See
`docs/initiatives/public-api-expansion.md` for what adding one would cost.

Backed by two new repository port methods — `ExecutionRepository.listInternal` and
`BlockRepository.listServiceTasks` — implemented on **both** the D1 and Drizzle stores and pinned
by new cross-runtime conformance assertions, so a store that ordered differently, dropped the
`internal` join, or mishandled the keyset fails a test rather than silently mis-serving an
integration. Each resolves its scope in ONE query (the `internal` anchor join; the frame's modules
as a subquery rather than a bound id list, which D1's 100-parameter ceiling would reject on a
service with ~96 modules).

Two adjacent fixes the lists depend on:

- `ExecutionInstance.createdAt` is now projected from the `agent_runs.created_at` COLUMN instead of
  the run's `detail` JSON, and an insert adopts the instance's own stamp. The two used to be
  separate `clock.now()` calls milliseconds apart, so a keyset cursor minted from the entity named
  a position slightly ahead of the row it pointed at — silently skipping any run inserted in that
  window whenever two starts landed in the same millisecond. The redundant `detail.createdAt` is
  gone (stale copies on existing rows are simply ignored, then dropped on the next write).
- `BoardService.addTask` now enforces the same containment rule `canReparent` applies on a move: a
  task may only be created under a service frame or a module. A task parented to an `epic` /
  `initiative` grouping node was structurally orphaned — invisible to any reader that resolves a
  service subtree, including this task list.

The `human-test` / `visual-confirmation` gate step-state schemas moved out of
`contracts/src/execution.ts` into their own `human-verdict-gates.ts` module (re-exported from the
package root, so no import path changes): merging `main` pushed `execution.ts` past the file-size
budget, and the two human-verdict gates are the cohesive seam — they share a `rounds` history and a
transient `pendingAction` that the polling gates' `GateStepState` does not have.
