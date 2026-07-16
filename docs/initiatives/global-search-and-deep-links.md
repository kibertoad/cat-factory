# Initiative: global search & deep-linkable routing

**Status:** planned (tracker only — no slices landed) · **Owner:** core · **Started:** 2026-07-16

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

The SPA is a dense single-canvas app with exactly **two pages** (`pages/index.vue`,
`reset-password.vue`); all navigation is UI-store state (`stores/ui.ts`). Two consequences:

- **No global search.** Every "search" today is a local picker/filter (repo picker, issue
  picker, task-add). There is no way to find a task, service, run, document, or
  notification across the board(s) by text — on a board with hundreds of blocks this is a
  daily-use gap.
- **No URL identity for anything.** A task, run, or board position cannot be linked,
  bookmarked, or shared. Slack/in-app notifications (and future email — see the
  `email-notification-channel` initiative) cannot deep-link back to the thing they are
  about; "look at this run" means describing where to click.

End state: a **Cmd-K command palette** backed by a cross-entity search endpoint, and
**shareable URLs** that restore workspace + selected block/run + open window, used by
notifications and the palette alike.

## Target pattern

1. **Search endpoint**: `GET /workspaces/:ws/search?q=` in `@cat-factory/server`, backed by
   a `SearchRepository`-shaped kernel port — one SQL query per entity class (blocks,
   executions/agent runs, notifications, documents) using `LIKE`/prefix matching first
   (D1 and Postgres both handle this without extensions; FTS5 / `tsvector` are a later
   optimisation slice, not the pilot). Results are small typed projections
   `{ type, id, workspaceId, title, snippet, status }` — never raw entities. Both runtimes
   implement it + conformance assertion.
2. **Command palette**: a `SearchPalette.vue` opened via Cmd-K / a toolbar affordance,
   debounced query → grouped results → selecting one dispatches through the existing
   `stores/ui.ts` step/window dispatch (`dispatchStepView` / `openStepDetail` are the
   seams) and pans the board to the block.
3. **Deep links**: encode the *navigational* UI state in the URL — `?ws=<id>&block=<id>&run=<id>&view=<resultViewId>`
   (query params on the single page; no new pages, no SSR implications with `ssr: false`).
   On boot, after the workspace snapshot + WS `connected` gate settles, replay the params
   through the same ui-store dispatch. State→URL sync is one watcher (`router.replace`, no
   history spam).
4. **Producers**: notification rows and the notifications inbox render deep links;
   `SlackNotificationChannel` message blocks carry the URL (needs the deployment's public
   frontend base URL — a config value, not a hardcoded host).

## Prioritized checklist

| # | Slice | Status | PR |
| - | ----- | ------ | -- |
| 1 | Search port + D1 ⇄ Drizzle impls (blocks + executions first) + conformance | ⬜ todo | |
| 2 | `GET /workspaces/:ws/search` controller + contracts (typed result projections) | ⬜ todo | |
| 3 | `SearchPalette.vue` + Cmd-K binding + ui-store dispatch on select (+ i18n, all locales) | ⬜ todo | |
| 4 | Deep-link query params: parse-on-boot (after `connected` gate) + state→URL sync | ⬜ todo | |
| 5 | Extend search to notifications + documents | ⬜ todo | |
| 6 | Deep links in notification payloads (in-app inbox + Slack blocks; frontend base-URL config) | ⬜ todo | |
| 7 | e2e: palette search → select → board pans + inspector opens, live (no reload) | ⬜ todo | |
| 8 | (Optional, perf-gated) FTS upgrade: SQLite FTS5 ⇄ Postgres `tsvector` behind the same port | ⬜ todo | |

## Conventions & gotchas

- **Deep-link replay must respect the real-time readiness ordering** (see CLAUDE.md
  "Real-time store coherence"): apply the params only after the on-connect resync settles
  (`data-connected`), or a stale hydrate can clobber the opened view.
- **Search is workspace-scoped and authz-checked** like every other `/workspaces/:ws/*`
  read; when the `workspace-rbac` initiative lands, results must flow through the same
  effective-role resolution (a `viewer` sees what the board shows them, nothing more).
- **No N+1 assembly**: each entity class is ONE query; do not enrich results with per-row
  point-reads — the projection carries what the palette renders.
- **Palette copy is i18n'd** (result-type labels are enum-keyed — use the exhaustive
  `Record` tier-2 guard for type→label lookups).
- URL params are *navigational* state only — never auth material, never raw entity data.
