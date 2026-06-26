---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/gates': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/app': patch
---

Improve the ergonomics of authoring custom agent kinds and gates:

- **Typed provider registry** (`defineProviderToken`/`wireProvider`/`requireProvider`, kernel),
  surfaced through `GateContext.getProvider`/`requireProvider`. A custom gate reaches its data
  source through the context instead of a hand-authored module global + unsafe `!`. The built-in
  `@cat-factory/gates` suite dogfoods it (public `wireX` signatures unchanged).
  **Breaking:** `GateContext` gains required `getProvider`/`requireProvider` (use `stubGateContext`).
- **Schema-driven structured output** (`defineStructuredOutput`, agents): one valibot schema
  derives both the `agent.output` spec and a typed `parse`/`safeParse`, replacing the hand-written
  `shapeHint` string + lenient coercer. `registerAgentKind` auto-fills `agent.output` from a
  `structuredOutput` schema.
- **Boot-time registration validation** (`validateRegistrations`/`validateRegistrationsOnce`,
  orchestration): a facade validates registered gates/kinds/pipelines at startup (gate `helperKind`
  resolves, `resultView` is known) and fails loudly instead of mid-run. Wired into both runtimes.
- **Prompt + resultView wiring** (agents/contracts): `FINAL_ANSWER_IN_REPLY` + the read-only
  guardrail are applied to registered kinds from their `agent.surface` (fixing a registered
  `container-explore` kind missing the guardrail); `resultView` is now a typed picklist of
  `RESULT_VIEW_IDS` (unknown ids fail validation instead of silently falling back to prose).
