---
'@cat-factory/orchestration': minor
'@cat-factory/contracts': minor
'@cat-factory/conformance': patch
---

Initiative presets — slice 5: loop/ingest glue (spawn decoration + `seedPlan` at ingest).

- **contracts** (`initiativeItemSpawnSchema`): the spawn bag now carries an optional `taskType`, so
  a preset's `seedPlan` can declare a spawned item's kind (`document`/`bug`/`spike`/…) exactly as
  the create-task form does.
- **orchestration** (`InitiativeLoopService.buildTaskBlock`): a spawned item's preset-authored
  `spawn` bag is now folded onto the task block, so a planned item comes out as a first-class
  TYPED task rather than a bare description block — its `taskType` (so a doc task classifies as
  `document`, not the default `feature` — `taskType`-keyed per-type task limits and the SPA's
  document affordances now apply), the doc task's `taskTypeFields` (`docKind`/`targetPath`/…),
  best-practice `fragmentIds`, and per-agent `agentConfig`. Each is additive + sparse (an empty bag
  is omitted), mirroring `BoardService.addTask`, so a decoration-less item (the generic / no-preset
  case) spawns a block byte-identical to before. A `document`-typed spawn with no explicit
  `fragmentIds` inherits the default writing-style fragments, exactly as `BoardService.addTask`
  seeds them for a board-created document task. The per-run gate override (`spawn.gates`, slice 2)
  is unchanged.
- **orchestration** (`applyPlanDraft`): the draft item's `spawn` decoration is now carried onto the
  persisted item (it follows the draft like the other content fields), so `buildTaskBlock` can read
  it. A re-plan refreshing an already-materialised item is harmless — its block was decorated when
  it spawned.
- **orchestration** (`InitiativeService.ingestPlan`): runs the resolved initiative preset's
  `seedPlan` post-processor over the parsed draft BEFORE `applyPlanDraft`. The preset is resolved
  from the entity's FROZEN `presetId`/`presetInputs`, so reading it outside the CAS `mutate` is
  race-free and (being pure) replay-safe. The hook's output is RE-PARSED through the strict schema:
  a `seedPlan` bug can't persist a malformed draft, and an unsafe spawn `targetPath` (from a hook OR
  the planner) is rejected by `taskTypeFieldsSchema`'s `isSafeDocPath` check — it can never escape
  the repo. Absent preset / no `seedPlan` ⇒ the draft is applied unchanged (byte-for-byte the
  pre-slice-5 path).
- **conformance**: asserts a preset-authored item `spawn` bag (task type, typed-task fields,
  fragments, agent config, gate override) round-trips through the initiative store intact on both
  runtimes — a store that dropped it would silently spawn a bare block instead of a first-class doc
  task.
