---
'@cat-factory/agents': minor
---

Add a per-`DocKind` document template registry (WS1 of the documentation-type task
initiative). Each document kind now carries a structured template — required and optional
sections with per-section authoring guidance — that is the single source of truth for the
kind's expected shape. The templates are woven into the `doc-outliner` prompt (the outline
must cover the required sections) and the `doc-writer` prompt (start from the rendered
skeleton), replacing the previous one-line structure hint. A deployment can override a
kind's template through the public `registerDocTemplate` seam (an import side effect,
mirroring `registerPromptFragment`).
