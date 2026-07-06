---
"@cat-factory/app": patch
"@cat-factory/node-server": patch
"@cat-factory/conformance": patch
"@cat-factory/example-custom-agent": patch
---

Initiative presets slice 9: the E2E baseline + a worked-example deployment preset.

- `@cat-factory/conformance`: `FakeAgentExecutor` gains an `initiativePlan` option so a
  fake-driven initiative-planner step returns a plan draft (the planner otherwise faults a
  planning run) — the seam an e2e/integration test uses to drive create-with-preset → auto-plan
  → spawn.
- `@cat-factory/node-server`: the initiative-loop sweep interval is now overridable via
  `INITIATIVE_LOOP_INTERVAL_MS` (default 60s unchanged).
- `@cat-factory/app`: `TaskCard` exposes a behaviour-neutral `data-task-type` attribute (the e2e
  asserts a spawned document task carries its preset decoration).
- `@cat-factory/example-custom-agent`: adds `preset_org_audit`, a worked-example initiative preset
  registered through the public `registerInitiativePreset` seam.
