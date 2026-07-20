# Initiative: persist + version + reseed best-practice fragment DEFINITIONS

## Goal & rationale

Best-practice prompt-fragment **selections** (a service's `serviceFragmentIds`, a task's
`fragmentIds`) are references into a fragment **definition** catalog. Today the built-in
definitions live only in code (`@cat-factory/prompt-fragments`) and are merged into the tenant
catalog at read time — they are **never persisted**, carry only a display-string `version`, and
have no reseed path. So a code update to a built-in silently changes what every existing task's
referenced fragment resolves to, with no stability and no explicit "pull the update" control.

This initiative gives fragment **definitions** the same **persist + version + reseed** lifecycle
that pipelines / risk-policies / model-presets already have: the built-in definitions are
persisted per workspace (stable snapshot of the body), and when a newer built-in ships in code the
UI surfaces the drift and offers a **reseed** that re-pulls the canonical definition.

This is deliberately separate from the **selection** behaviour (shipped alongside):

- **Selections** — a new task's `fragmentIds` is seeded from its service at creation; an existing
  task is never auto-updated and there are no prompts; a new fragment is picked up by adding it in
  the inspector by hand. The engine folds a task's OWN `fragmentIds` (no run-time re-union of the
  service's set). See `AgentContextBuilder.resolveFragments` + `BoardService.addTask`.
- **Definitions** (this tracker) — the catalog rows the selections reference: persisted, versioned,
  reseedable.

## Confirmed decisions

- **Owner scope: workspace tier.** Built-in definitions are persisted as `workspace`-tier
  `prompt_fragments` rows (the tier the run-time resolver already reads), mirroring how pipelines
  seed per workspace. No new `account` tier concept, no new `built-in` owner kind.
- **Drift surfaced + reseed action.** A workspace carries the code catalog versions; the SPA flags a
  persisted built-in whose code version has advanced as `outdated` and offers a reseed (mirrors the
  pipeline/preset health flow). This is distinct from the no-prompts rule for per-task _selections_.
- **A `builtin` marker column IS required (this was mis-scoped once — see gotcha).** The existing
  library treats `builtin` as a synthetic, code-only TIER, and tests assert it (`node.performance`
  resolves at tier `builtin`; a _shadowed_ built-in resolves at tier `workspace`). Persisting a
  built-in as a bare `workspace`-tier row would flip its tier to `workspace`, breaking that UX and
  those tests — and without a marker you cannot distinguish an _unmodified seed_ from an _outdated
  seed_ from a _user customization_ (the version/body heuristic fails on the outdated case, which
  looks identical to a hand-edit). So the clean shape mirrors the pipeline `builtin: true` flag:
  add a `builtin` boolean to `PromptFragmentRecord` + a `builtin` column on `prompt_fragments`
  (**D1 migration ⇄ Drizzle schema + generated migration**, per "Keep the runtimes symmetric") +
  mapper/repo read-write. `mergeCatalog` reports `tier: 'builtin'` when `record.builtin`, so a
  seeded/reseeded built-in stays `builtin` tier (even when outdated) while a genuine shadow
  (`builtin: false`) stays `workspace`.
- **Version signal = the fragment's authored `version` string.** Drift = code version ≠ persisted
  version (bump the built-in's `version` when you change its body — the reseed signal). No numeric
  monotonic counter is added.

## Target pattern (mirror of the pipeline reseed stack)

| Layer             | Pipeline reference                                                                             | Fragment analogue                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| catalog + version | `seedPipelines()` per-item `version` (kernel `domain/seed.ts`)                                 | `universalFragments()` per-item `version` string (`@cat-factory/prompt-fragments`)                                                 |
| persist           | `WorkspaceService.create` seed loop                                                            | `FragmentLibraryService.ensureSeeded(ws)` — lazy, on catalog load, seeds only MISSING built-in ids (respects tombstones)           |
| drift channel     | snapshot `pipelineCatalogVersions`                                                             | resolved-fragments response `catalogVersions` (`{id → version}`)                                                                   |
| reseed service    | `PipelineService.reseed` (resolve seed, reject custom/absent, preserve labels/archive, upsert) | `FragmentLibraryService.reseedBuiltin(ws, id)` (resolve code def, reject non-built-in, preserve `createdAt`, upsert workspace row) |
| reseed route      | `POST /pipelines/:id/reseed`                                                                   | `POST /fragments/:id/reseed` (no body, 200 → resolved fragment)                                                                    |
| health composable | `usePipelineHealth` (`outdated` = catalogVersion vs stored)                                    | `useFragmentHealth` (same, string inequality)                                                                                      |
| health UI         | `PipelineHealthModal`                                                                          | fragment-library "updates available" affordance                                                                                    |
| conformance       | `core.ts` pipeline versioning+reseed                                                           | fragment seed + reseed + drift assertions (both runtimes)                                                                          |

## Per-item status

| Item                                                                                                | Status | Notes                                                                         |
| --------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------- |
| `builtin` marker: `PromptFragmentRecord` + `prompt_fragments` column (D1 ⇄ Drizzle) + mappers/repos | todo   | **prerequisite** — without it, persistence conflates tiers                    |
| `mergeCatalog` reports `tier: 'builtin'` when `record.builtin`                                      | todo   | keeps tier badges/`builtinCount` correct                                      |
| `FragmentLibraryService.ensureSeeded` (lazy persist, `builtin: true`)                               | todo   | seed only missing built-in ids; skip tombstoned                               |
| `FragmentLibraryService.reseedBuiltin` + `catalogVersions()`                                        | todo   | resolve from `universalFragments()`; preserve `createdAt`                     |
| `reseedFragmentContract` + `fragmentCatalogVersionsContract` + controller routes                    | todo   | `POST /prompt-fragments/:id/reseed`, `GET /prompt-fragments/catalog-versions` |
| `useFragmentHealth` + store `catalogVersions`/`reseed` + api                                        | todo   | mirror `usePipelineHealth` / pipelines store                                  |
| health UI affordance (fragment library)                                                             | todo   | list outdated built-ins, reseed                                               |
| conformance (seed + reseed + drift, both runtimes)                                                  | todo   | mirror `core.ts` pipeline versioning                                          |
| i18n keys + locale parity                                                                           | todo   | reseed/updates strings                                                        |

Status: **not yet started.** A first exploration of the service/contract/controller layer surfaced
the tier-conflation gotcha below (the reason the `builtin` marker column is the prerequisite);
that finding is captured here so the next slice starts from the correct shape (marker column
first) rather than re-discovering it. The related task-authoritative _selection_ change shipped
separately.

## Conventions & gotchas

- **Tier conflation is the trap (why the marker column is non-negotiable).** `builtin` is a
  synthetic tier in `mergeCatalog` today: a built-in with no persisted row resolves at tier
  `builtin`; a workspace row with the same id (a user _shadow_) resolves at tier `workspace` and is
  how the UI shows "you customized this". Persisting every built-in as a bare workspace row erases
  that distinction (all built-ins would read as `workspace`, breaking `builtinCount`, the tier
  badges, and `fragment-library.spec.ts`). The `builtin` marker restores it: a seeded row carries
  `builtin: true` and merges back as tier `builtin`; only a genuinely tenant-authored row is
  `workspace`. Land the column FIRST.
- **Respect tombstones.** `ensureSeeded` must skip any built-in id that already has a workspace row
  (including a `deletedAt` tombstone) — re-seeding a tombstoned built-in would resurrect it.
- **Reseed overwrites (and un-tombstones)** the built-in's workspace row from code — it is the
  explicit "pull the update / restore the built-in" action. There is no `labels`/`archived`
  metadata to preserve (fragments have none); preserve `createdAt` if the row exists.
- **Keep the run-time resolver honest.** Once built-ins are persisted as workspace rows they OVERRIDE
  the code built-ins in `mergeCatalog` (workspace tier wins) — so a run reads the _persisted_ body
  until reseed. New (un-seeded) code built-ins still fold in from code.
- **Both runtimes** share `FragmentLibraryService` + one `prompt_fragments` table, so the change is
  runtime-symmetric by construction — add a conformance assertion so a facade that forgot to wire it
  fails a test.
