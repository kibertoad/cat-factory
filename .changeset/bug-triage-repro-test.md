---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/executor-harness': patch
'@cat-factory/local-server': patch
---

Bug-triage pipeline (phase G): the `repro-test` Reproduction Test Automation agent. A new
structured `container-coding` agent kind writes one or more tests that fail for the reported
reason and commits them onto the run's shared work branch (seeding it for the coder, which opens
the one PR containing both the reproduction test and the fix) — or concedes `not_reproducible`
without failing the run. Conceding and reproduced outcomes both advance to the coder; a
post-completion resolver folds the `{ outcome, testPaths, notes }` assessment into the step
output so the coder reads it, and a `BUG_FIX_GUIDANCE` prompt fragment reframes the coder's
objective around the pre-existing failing test (fix the issue, don't merely make the test pass).

Enabling changes: `AgentStepSpec` gains `opensPr` / `noChangesTolerated` (container-coding) so a
kind can seed the work branch without opening a PR and tolerate a no-op; the executor-harness
coding path now parses a structured JSON outcome (`custom`) alongside the pushed commit; the
harness image is bumped to `1.34.9`. The runtime-neutral `@cat-factory/server` package keeps its
Web-standard `src` surface (no `@types/node`) while typing the one cross-runtime Node built-in it
uses (`AsyncLocalStorage`) via a local ambient shim, with node-using tests typechecked under a
separate project.
