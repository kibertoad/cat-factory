---
'@cat-factory/sandbox': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
---

Foundation for the **Sandbox** — a parallel, opt-in surface for the organized
testing of prompts and models. It answers "which model is best for this task?"
(one prompt, many models) and "does a better prompt help?" (one model, many
prompt versions).

This change lands the isolated foundation only (no runtime wiring yet):

- **`@cat-factory/sandbox`** (new, isolated package): the pure domain logic —
  the testable-agent-kind catalog with live baseline enumeration (read from
  `@cat-factory/agents`, never persisted), append-only prompt-version lineage
  (clone → versioned candidates + freeform labels), experiment-matrix expansion
  into run cells, and the judge rubrics (lifted from the benchmark harness) plus
  a deterministic objective-findings recall scorer. Nothing in the core product
  depends on this package, so the whole feature can be extracted later.
- **`@cat-factory/contracts`**: Valibot wire contracts for sandbox prompt
  versions, fixtures, experiments, runs, and grades (`sandbox.ts`).
- **`@cat-factory/kernel`**: the sandbox repository ports
  (`SandboxPromptVersionRepository`, `SandboxFixtureRepository`,
  `SandboxExperimentRepository`, `SandboxRunRepository`,
  `SandboxGradeRepository`) and the re-exported domain types.

Follow-ups (per the approved design): the server controller, the durable
fan-out run driver + judge/objective grading, D1 ⇄ Drizzle persistence with a
conformance assertion, the dedicated fixture repo + ephemeral-branch lifecycle,
and the lazy-loaded frontend section.
