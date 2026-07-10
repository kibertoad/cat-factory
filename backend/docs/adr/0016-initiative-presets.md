# ADR 0016: Initiative presets — a registrable planning-shape extension for task-shaped initiatives

- **Status:** Accepted (implemented)
- **Date:** 2026-07-08
- **Context layer:** backend + frontend (`@cat-factory/contracts`, `@cat-factory/kernel`, `@cat-factory/orchestration`, `@cat-factory/agents`, `@cat-factory/server`, `@cat-factory/app`)

## Context

The Initiative feature (ADR 0013) plans a cross-cutting body of work through one fixed pipeline
(`pl_initiative`: interviewer → analyst → planner → committer, with human approval after the
planner). That shape fits open-ended refactors, where an interview is how the goal gets pinned
down. It does not fit **task-shaped** initiatives whose inputs are known up front and enumerable
as a form — "refresh this service's documentation," "sweep the dependency tree," "audit
licensing." For those, the interview is friction, the plan shape is predictable, and the run
should be unattended by default.

## Decision

Introduce **initiative presets**: a preset is more than a pipeline — it bundles (a) its own form
rendered generically by the SPA from a backend-supplied descriptor, (b) a planning-pipeline
binding (e.g. skip the interviewer — the form IS the interview), (c) code hooks (a deterministic
`detect` prefill probe over `RepoFiles`, a `seedPlan` post-processor of the planner's draft) and
data (per-agent-kind prompt steering, a `phaseTemplate` shape constraint, default prompt
fragments), and (d) per-item **spawn decoration** so tasks the loop spawns come out as typed tasks
(`taskType`/`targetPath`/`fragmentIds`/`agentConfig`/gate overrides) instead of bare description
blocks. Presets register through a public seam mirroring custom agent kinds. Human-review opt-in
is modelled as a **per-run gate-override engine seam** on `ExecutionService.start` (a full boolean
array parallel to the pipeline's own gates), not doubled gated/ungated pipeline pairs.

The pilot consumer is the **Documentation-refresh preset**: given a service/frontend, it audits
documentation against the implementation and drives it to a complete, current set. It adds exactly
one new agent kind (`code-commenter`, for in-place comment edits no existing kind could express)
and reuses `doc-writer` (README + Mermaid diagrams) and `business-documenter` (business rules) for
everything else. Custom presets are code-carrying deployment packages, trusted exactly like custom
agents; data-only (DB/UI-authored) presets are deferred until a non-code consumer needs them.

## Rationale

- A descriptor-driven form (checkbox-group/path/select/showWhen) lets the SPA render any preset's
  fields generically — zero frontend changes per preset.
- The per-run gate-override seam is cleaner long-term than doubling every preset's pipeline
  registrations just to toggle human review.
- Reusing `doc-writer`/`business-documenter` instead of adding a dedicated diagram-author kind
  keeps the new-kind surface to the single genuinely new capability (`code-commenter`); a Mermaid
  document is just Markdown a writer already produces.
- Separating plan **shape** (`phaseTemplate`, enforced generically at ingest) from per-item
  **decoration** (`seedPlan`) keeps the two concerns from entangling and lets a later preset reuse
  the same shape-enforcement machinery without hand-rolling it again.

## Alternatives considered

- **Doubling every preset's pipeline registrations** for a gated vs. ungated variant — rejected in
  favour of the single gate-override seam, which scales to any preset without registry growth.
- **A dedicated `diagram-author` kind + `pl_diagrams` pipeline** — rejected during design review:
  it would have been "a prompt wearing a pipeline costume," since a Mermaid diagram doc is just
  Markdown a `doc-writer` clone already produces.
- **A first-class templated/slotted pipeline** (one pipeline, one step swapped for a variant agent)
  to collapse the near-identical spawn pipelines — deferred as a separate, cross-cutting initiative
  in its own right; not worth building for a handful of doc pipelines when only the universal
  `conflicts → ci → merger` tail is actually shared.

## Consequences

- Recurring drift-watch (a periodic re-audit pipeline) is explicitly out of scope — the natural
  follow-up once one-shot refresh proved out.
- Data-only/DB-authored custom presets and public API preset exposure (`POST /api/v1/initiatives`
  accepting `presetId`) are not supported.
- Mermaid syntax validation is not implemented; a diagram document is accepted by `doc-quality`'s
  generic `other` template rather than a diagram-specific check.
- The preset registry itself was later migrated from a module-global free-function registry to an
  app-owned DI registry (mirroring ADR 0018's agent-kind-registry pattern) — a superseding
  implementation detail that does not change this decision's shape.
