# ADR 0017: Documentation-type tasks as a first-class authoring experience

- **Status:** Accepted (implemented)
- **Date:** 2026-07-09
- **Context layer:** backend (`@cat-factory/agents`, `@cat-factory/gates`, `@cat-factory/orchestration`, `@cat-factory/contracts`), frontend (`@cat-factory/app`)

## Context

Documentation-type tasks (PRD, RFC, ADR, design doc, runbook, research report, …) were treated
as "a coder task that happens to write Markdown," with only a thin `DocKind` picklist and a
one-line structure hint. The desired end state was for such tasks to be a first-class authoring
experience: per-type templates and good-example documents, universal style guidance, per-type
form fields, an interactive review loop with the user, and a programmatic quality gate before a
document ships. A forward document-authoring track already existed (`pl_document` /
`pl_document_quick`, the `doc-*` agent kinds, repo-committing PR lifecycle), so most of this
initiative was gap-closing on top of that track rather than a green-field build.

## Decision

Land five workstreams, each extending an existing seam rather than adding a parallel mechanism:

- **WS1 — Templates & exemplars**: a per-`DocKind` Markdown template registry
  (`docTemplateFor`, built-in fallback + a `registerDocTemplate` override), with a
  workspace-linked override: a `role` (`template`/`exemplar`) tag on the existing
  workspace/`DocKind`-scoped document link, reusing the `documents` integration's existing
  provider/link/read path (GitHub, Confluence, Notion, …) with no new fetch machinery. The
  template's required sections are the single source of truth for both the authoring prompts and
  the WS4 quality gate.
- **WS2 — Universal style fragments**: two new fragments (`style.anti-llmisms`,
  `style.concise-actionable`), folded into doc prompts via a new `doc-aware` trait that extends
  the existing `code-aware` fragment-folding mechanism rather than adding a parallel path;
  default-on for document tasks; the `doc-reviewer` companion receives the same fragment bodies
  as review criteria.
- **WS3 — Per-type fields**: a single `DOC_KIND_FIELDS` descriptor drives both the task-creation
  form's conditional inputs and the authoring-prompt brief fold, as sparse optional fields on
  the existing `taskTypeFields` bag (no migration).
- **WS4 — Quality gate**: a `doc-quality` gate, authored through the public `registerGate` seam,
  running deterministic checkout-free checks via `RepoFiles` (target file exists, required
  sections present, links resolve, heading hierarchy sane, no leftover template placeholders),
  inserted into `pl_document`/`pl_document_quick` before the merge tail.
- **WS5 — Interactive review**: a dedicated `doc-interviewer` step, mirroring the initiative
  interviewer's parked decision-wait loop (ask → human answers → iterate → proceed, capped at 4
  rounds), replacing the outline step's binary approve/revise human gate in `pl_document`. Its
  transcript lives in a new `doc_interview_sessions` table; the converged brief feeds
  `doc-writer`/`doc-finalizer`.

## Rationale

- **Extend, don't duplicate, existing seams.** Templates and exemplars are one linking
  primitive (a `role`-tagged document link) reusing the `documents` integration end to end;
  style guidance extends the same trait-gated fragment-folding mechanism already used for code;
  quality checks are authored as a normal registered gate, not a bespoke evaluator.
- **Single source of truth for required sections.** Both the authoring prompts and the quality
  gate read the same resolved template, so they can never check against different section lists.
- **The dedicated interview step was chosen over overloading the existing gates** because the
  initiative-interviewer pattern (ask/answer/iterate/proceed) is the closer structural match for
  a conversational loop than the requirements-review findings model, and reusing it needed no
  new durable-driver machinery.
- **Don't rebuild what exists.** Markdown-on-repo storage via a committing PR was already fully
  implemented and was left untouched; this initiative closed only the identified gaps.

## Consequences

- `doc_interview_sessions` is a new table, mirrored D1 ⇄ Drizzle with a conformance assertion;
  `pl_document`'s step indices shifted (version bump, reseed-offer signal) to insert the
  interviewer and the quality gate.
- The `doc-aware` trait and the `role`-tagged document link are now reusable primitives for any
  future doc-authoring extension.
- Deliberately out of scope: LLM-graded style scoring inside the quality gate (the deterministic
  gate ships first; AI quality already has the `doc-reviewer` loop), migrating the built-in doc
  kinds' rendering into the manifest pre/post-op model (tracked as separate custom-agents
  strangler work), and reverse documentation (`documenter`/`business-documenter`/`blueprints`,
  a separate track).
