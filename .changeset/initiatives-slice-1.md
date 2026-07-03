---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
'@cat-factory/conformance': minor
---

Initiatives (slice 1 of 4): the long-running, multi-task counterpart to a task — see
`docs/initiatives/initiatives-feature.md` for the full multi-slice plan.

- **New `initiative` block level** — a container block under a service frame (created via the
  new "Create initiative" button in the frame header, next to add-task/import-task). Tasks a
  later slice's execution loop spawns link back via the new `blocks.initiative_id` membership
  column (epic-style). D1 migration `0035_initiatives.sql` ⇄ Drizzle schema, shared mapper.
- **New `initiatives` entity + store** — the DB row is the source of truth (phases, items with
  planner-authored estimates + dependencies, the execution policy with estimate→pipeline rules,
  decisions / deviations / follow-ups / caveats), guarded by a `rev` compare-and-swap so the
  loop has a single logical writer. Mirrored D1 ⇄ Drizzle repositories with a cross-runtime
  conformance suite (CRUD, doc round-trip, CAS conflict, `blocks.initiative_id`).
- **Initiative Planning pipeline skeleton (`pl_initiative`)** — `initiative-planner` (a
  read-only structured container explore that drafts the multi-phase plan, gated for human
  approval) + `initiative-committer` (a deterministic engine step that flips the entity to
  `executing` and commits the rendered tracker to `docs/initiatives/<slug>/` — canonical
  `initiative.json` + human `tracker.md` + `version.json`, hash-short-circuited and
  replay-safe, following the blueprint artifact pattern). A bidirectional guard in the
  engine's shared `assertRunnable` makes `pl_initiative` the ONLY pipeline runnable on an
  initiative block (and vice versa), across start/retry/restart.
- **API + snapshot + realtime** — `POST/GET /workspaces/:ws/initiatives` (+ by-block read),
  the snapshot's optional `initiatives` field, and a new `initiative` WorkspaceEvent pushed
  from both runtimes' publishers.
- **Frontend** — the Create Initiative modal + frame-header button, the initiative board card,
  an inspector body (run planning / open tracker) and the read-only Initiative Tracker window
  (`initiative-tracker` result view), with the `initiative.*` i18n namespace across all 8
  locales.

Later slices add the interactive planning interview, the execution loop (just-in-time task
spawning with estimate-gated pipeline selection), and follow-up/deviation harvesting.
