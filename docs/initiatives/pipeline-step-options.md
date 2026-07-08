# Pipeline per-step options — unify the parallel arrays into one `step_options` bag

## Goal & rationale

Per-step pipeline configuration grew as **one index-aligned array (and one persisted JSON
column) per capability**: `gates`, `thresholds`, `enabled`, `consensus`, `gating`,
`follow_ups`, `tester_quality`. Every new per-step knob therefore meant a new contract array,
a new column in **both** runtimes (D1 `ALTER TABLE` + Drizzle schema + a generated migration),
new mapper/repo lines, a new `draftX` array + toggle in the builder store, and a new copy line
in run-construction. That is not sustainable, and SQL gains nothing from the granularity — each
column just stores a JSON blob.

**End state:** a SINGLE nullable `step_options` JSON column on `pipelines`, holding an array
parallel to `agentKinds` where each entry is an open-ended `StepOptions` object. Every per-step
parameter becomes a **field on that object**, so a new knob needs no column and no migration —
just a field on `stepOptionsSchema` and the code that reads it.

## Target pattern (the pilot)

The `autoRecommend` parameter (requirements-review auto-recommendation toggle) is the reference
implementation — it lives entirely in the new seam and touches ZERO of the legacy arrays:

- **Contract:** `stepOptionsSchema` + `StepOptions` in `backend/packages/contracts/src/entities.ts`;
  `stepOptions?: (StepOptions | null)[]` on `pipelineSchema`; `stepOptions?: StepOptions | null`
  on `pipelineStepSchema`; both pipeline request schemas in `requests.ts`. Re-exported from
  kernel (`domain/types.ts`).
- **Persistence:** ONE column `pipelines.step_options` (D1 migration
  `0044_pipeline_step_options.sql` ⇄ Drizzle `step_options` + generated migration), mapped in
  `@cat-factory/server` `persistence/mappers.ts` (`rowToPipeline`) and both repos'
  insert/update.
- **Service:** `alignedStepOptions` in `PipelineService` — option-agnostic (persist an entry
  when it has ANY own key), so new fields need no change here.
- **Run construction:** one copy line in `ExecutionService` (`stepOptions` onto the runtime
  step), read by the engine (`ReviewGateController` consults `step.stepOptions?.autoRecommend`).
- **Builder:** `draftStepOptions` array in `stores/pipelines.ts` (kept aligned in
  insert/remove/move/reorder/clear/load/payload) + a per-field toggle
  (`toggleDraftAutoRecommend`) and a control in `PipelineBuilder.vue`.

**Convention:** store only DEVIATIONS from a step's defaults (e.g. `{ autoRecommend: false }`,
never `{ autoRecommend: true }`), so an all-default pipeline persists no `step_options` array at
all — exactly like the legacy aligners.

## Migration checklist — fold each legacy array into `stepOptions.<field>`

Each row: move the capability from its own array/column to a field on `StepOptions`, delete the
old array + column (backwards compatibility is a non-goal — no dual-read), and add a
cross-runtime conformance assertion. Do them one at a time, parity-gated.

| Legacy array                                               | New `StepOptions` field       | Status | PR      |
| ---------------------------------------------------------- | ----------------------------- | ------ | ------- |
| `stepOptions.autoRecommend` (pilot — new, not a migration) | `autoRecommend`               | done   | this PR |
| `gates`                                                    | `gate` (boolean)              | todo   | —       |
| `enabled`                                                  | `enabled` (boolean)           | todo   | —       |
| `thresholds`                                               | `companionThreshold` (number) | todo   | —       |
| `consensus`                                                | `consensus` (object)          | todo   | —       |
| `gating`                                                   | `gating` (object)             | todo   | —       |
| `followUps`                                                | `followUp` (boolean)          | todo   | —       |
| `testerQuality`                                            | `testerQuality` (object)      | todo   | —       |

## Conventions & gotchas carried between iterations

- **Keep the runtimes symmetric.** The single column lands for D1 (raw `ALTER TABLE`) AND
  Drizzle (schema + `pnpm db:generate`) together, and the cross-runtime conformance suite must
  assert the round-trip. Adding a _field_ to the JSON object needs no migration on either side.
- **Runtime steps ride the `detail` JSON** (`agent_runs.detail`), which is spread raw (not
  re-validated) in `rowToExecution` — so `step.stepOptions` survives with no mapper change; only
  the pipeline definition needs the column.
- **`enabled` is special** — it drives which steps become a run at all (the run is built from the
  enabled subset, re-indexed). Migrating it means teaching run-construction + `validatePipelineShape`
  - `pipelineHasEnabledBugIntake` to read `stepOptions[i].enabled` while still re-indexing by the
    original position. Do it last.
- **`gates` has a per-run override seam** (`gatesOverride` from initiative presets) that wins over
  the pipeline value in `ExecutionService`. Preserve that precedence when it moves.
- **Built-in seeds** (`definePipeline` / `SeedStep`) only express `gate`/`enabled` today. Extend
  `SeedStep` to emit `stepOptions` if a built-in ever needs a non-default field.
- **Validation stays option-agnostic where possible** — `alignedStepOptions` must not learn about
  specific fields; the client only writes non-defaults.
