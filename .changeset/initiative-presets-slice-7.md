---
'@cat-factory/agents': minor
'@cat-factory/kernel': minor
---

Initiative presets — slice 7 (docs-refresh pilot): the in-source comment annotator + the lean
spawn pipelines the preset drives.

- **agents** (`agents/kinds/code-commenter.ts`): a new built-in `code-commenter` agent kind,
  pre-loaded by `defaultAgentKindRegistry()`. It adds and clarifies WHY-not-what comments in
  EXISTING source with **no behaviour change** — a container-coding kind that runs the generic
  work-branch → PR lifecycle (`buildRegisteredAgentBody`, no bespoke harness handler, no
  executor-harness image bump), `doc-aware` so the engine folds the block's writing-style
  fragments into its prompt. Its system prompt hard-forbids touching executable code (comments /
  docstrings only), and the pipeline's `ci` step is the backstop that proves the diff is
  behaviour-neutral. Being a side-effect kind (its product is a pushed commit) it deliberately does
  NOT carry `FINAL_ANSWER_IN_REPLY`.
- **kernel** (`domain/seed.ts`): two lean built-in spawn pipelines the docs-refresh preset stamps
  onto its spawned tasks (also pickable standalone) — `pl_code_comments`
  (`[code-commenter, conflicts, ci, merger]`) and `pl_business_docs`
  (`[business-documenter, conflicts, ci, merger]`, reusing the existing reverse-doc kind) — plus
  their exported ids (`CODE_COMMENTS_PIPELINE_ID` / `BUSINESS_DOCS_PIPELINE_ID`).
- Design note (see the tracker's slice-7 row + inter-phase follow-up): after review, this is the
  MINIMAL set — Mermaid diagrams and READMEs reuse `doc-writer` / `pl_document_quick` (a diagram
  doc is just Markdown a writer produces), so `code-commenter` is the only genuinely-new capability
  and no `diagram-author` kind / `pl_diagrams` pipeline are added.
