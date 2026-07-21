---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/app': minor
'@cat-factory/executor-harness': patch
---

Review adherence reports + per-agent effort self-assessment, surfaced in run details.

- **Best-practice fragments are now fed granularly.** Each selected best-practice standard is
  folded into an agent's system prompt as its OWN delimited, labelled block (carrying a stable
  id and its human title) instead of one `\n\n`-joined blob, so an agent can tell the standards
  apart and cite one by title. Fragment titles are threaded end-to-end (resolver → resolved
  fragments → prompt composer).
- **Code + PR review agents report best-practice adherence.** The `reviewer` companion and the
  `pr-reviewer` now return a `fragmentAdherence` list — per standard, a 1..10 rating of how well
  the reviewed change/PR adheres plus the issues that standard surfaced — recorded on the step
  (`PipelineStep.fragmentAdherence`) and surfaced in run details + the PR-review window. When no
  best-practice standards were reachable, the reviewer states so explicitly.
- **Every container agent reports effort.** Each container agent is asked to write a short effort
  self-assessment (how hard the work was, what reduced its effectiveness, the key obstacles) to a
  sentinel file the harness lifts onto the result; the engine records it (`PipelineStep.effortReport`)
  and it is shown in run details. Flows through both runtimes (verbatim on Cloudflare/local, coerced
  on the self-hosted runner pool). Requires the bumped executor-harness image.
- **Fragment management UI.** The fragment editor gains an "auto-generate title" button (an inline
  LLM call) and inline editing of a hand-authored fragment's title / summary / body / tags.
