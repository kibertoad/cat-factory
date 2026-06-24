---
"@cat-factory/contracts": minor
"@cat-factory/kernel": minor
"@cat-factory/orchestration": minor
"@cat-factory/agents": minor
"@cat-factory/server": minor
"@cat-factory/worker": minor
"@cat-factory/node-server": minor
"@cat-factory/app": minor
---

Replace per-agent-kind model defaults with named **model presets**.

A workspace now keeps a library of model presets instead of a single per-agent-kind
default map. A preset is one `baseModelId` applied to every agent kind plus optional
per-kind `overrides`, so "everything Kimi K2.7" is a base with no overrides. Two
built-ins are seeded for every workspace: **Kimi K2.7** (the default — every agent runs
on Kimi K2.7) and **GLM-5.2**. A task selects a preset via the new `Block.modelPresetId`
(the inspector's "Model preset" picker + the new-task form); changing it affects only
steps that haven't started yet. Resolution precedence is unchanged in spirit: a block's
pinned model wins, else the task's selected/default preset's mapping for the kind, else
the env routing.

- `@cat-factory/contracts`: new `model-presets.ts` (`ModelPreset`, create/update schemas);
  `Block.modelPresetId`; `addTask`/`updateBlock` accept `modelPresetId`; the snapshot
  carries `modelPresets` instead of `modelDefaults`. The `model-defaults` contract is removed.
- `@cat-factory/kernel`: new `ModelPresetRepository` port (replaces `ModelDefaultsRepository`),
  `DEFAULT_MODEL_PRESETS` seed + `modelForKindFromPreset` helper; `resolveWorkspaceModelDefault`
  resolvers gain an optional `modelPresetId` argument throughout.
- `@cat-factory/orchestration`: `ModelPresetService` (CRUD + lazy seeding, replaces
  `ModelDefaultsService`) and `resolvePresetModelForKind`; the execution engine threads the
  block's preset into model resolution, the personal-credential gate and the start guard.
- `@cat-factory/agents`: `StepModelInputs.modelPresetId` + the resolver signature.
- `@cat-factory/server`: `ModelPresetController` (`GET|POST|PATCH|DELETE
  /workspaces/:ws/model-presets`, replaces the model-defaults controller); the block mappers
  persist `model_preset_id`; the snapshot lists `modelPresets`.
- `@cat-factory/worker` / `@cat-factory/node-server`: the `model_presets` table (D1 migration
  `0006` ⇄ Drizzle) + `blocks.model_preset_id`, replacing `workspace_model_defaults`.

BREAKING (pre-1.0, no migration): the `workspace_model_defaults` table, the
`/model-defaults` endpoint, and the snapshot's `modelDefaults` field are removed. Existing
per-agent-kind default maps are dropped; workspaces fall back to the seeded built-in presets.
