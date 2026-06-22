---
'@cat-factory/agents': patch
'@cat-factory/app': minor
---

Sharpen the `mocker` and `tester` agent prompts so they do real work instead of
restating the implementer and resolving.

- **Mocker.** Leads with the concrete goal — make the service runnable locally with
  just `docker-compose up`, every external SERVICE answered by a WireMock mock — and
  is now explicit that this is a hands-on build step: it must read the existing
  mappings, add/extend the stubs + fixtures + docker-compose wiring and COMMIT them.
  A prose-only "already covered" write-up with no committed mock files is called out
  as a failure of the step. The prose output is reframed as a summary of the mocks it
  committed (which services/operations are now mocked, and what was deliberately left
  unmocked).
- **Tester.** Reframed as exploratory testing that actually runs the software:
  greenlights must be backed by observed runtime behaviour, not by reading the diff.
  It now starts from the earlier steps' artifacts — the `spec/` document and its
  Gherkin acceptance scenarios for the new functionality, and the WireMock mocks the
  mocker stood up on localhost via docker-compose — then probes edge/error cases and
  does a reasonable amount of regression testing of the blast radius. Sub-blocking
  issues go in `concerns` at low/medium severity without necessarily withholding the
  greenlight (the engine still skips the fixer when the report is greenlit).

The existing tester gate already dispatches the `fixer` companion on a withheld
greenlight and skips it when the tests pass — no wiring, pipeline or harness-image
change for the prompts.

**Frontend (`@cat-factory/app`).**

- **Dedicated test-report window.** The `tester` archetype now declares a `resultView`,
  so opening a tester step opens a structured window (the universal result-view seam,
  like the requirements review) instead of the generic prose panel. It renders the
  report as a hierarchical tree — the scenarios the Tester exercised (its `tested`
  areas) → the per-area outcomes (passed / failed / skipped) → the concerns grouped
  under them — plus the greenlight verdict, outcome counts and the fixer-attempt state.
  The service spec is not yet exposed to the SPA, so spec-element linkage is derived
  from the report itself (a future spec endpoint can make it explicit).
- **Companion visualization.** Companion steps (`reviewer` / `architect-companion` /
  `spec-companion` / `fixer`) are now visually tagged as companions in the pipeline
  views, and a gate step's conditionally-run companion — today the Tester's `fixer` —
  renders as a distinct sub-node marked **possible / running / completed / skipped**
  (in both `PipelineProgress` and the inspector's `TaskExecution`). `fixer` is added to
  the agent catalog + the `AgentKind` union.
