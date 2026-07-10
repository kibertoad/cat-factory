# ADR 0014: Technological-migration initiative preset with a generic phase-template capability and an LLM-authored, human-revised confidence case

- **Status:** Accepted (implemented)
- **Date:** 2026-07-07
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/agents`, `@cat-factory/orchestration`)

## Context

A technological migration — swapping a database engine, upgrading a framework across a
major version, bumping a language runtime, replacing a load-bearing library — is one of
the highest-risk initiative shapes the product can run: the change is wide, mostly
mechanical, and catastrophic when observable behaviour drifts. What makes a migration
safe is not the code change itself but the discipline around it: know the blast zone
(including its transitive reach) before touching anything, pin observable behaviour with
tests before the swap, decide the degree of backwards compatibility deliberately, and
finish by actually removing the old path. That discipline is invariant across
migrations; only the from/to technologies and scope vary, and those are enumerable as a
form — which is exactly what an **initiative preset** can encode.

Estimating a migration's impact across an entire codebase by human eye is a
near-impossible task, but an exhaustive sweep is exactly what an agent is good at. The
product needed a way for a preset to (a) mandate a specific multi-phase methodology
rather than leaving plan shape to free-form planner judgment, and (b) invert the usual
"human performs the coverage review" gate into something a human can actually audit at
scale.

## Decision

Ship the **`preset_tech_migration`** initiative preset, built on one new generic SYSTEM
capability, **preset phase templates**:

- A preset descriptor may declare an optional `phaseTemplate` (`{ phases: [{ id, title,
  goal, required? }], allowAdditionalPhases? }`) as plain wire data. The planner's prompt
  fold renders the required phase ids/titles/goals verbatim when a template is present; a
  pure ingest-time normalizer reorders known phases into template order and rejects (via
  `ValidationError`) a missing required phase or a disallowed extra one. No preset id is
  ever branched on in the engine; `preset_generic` declares no template and stays
  byte-for-byte unchanged.
- `preset_tech_migration` uses that capability to mandate 5 required phases —
  blast-zone, coverage, transition-design, delivery, verify-decommission — each with a
  committed Markdown artifact under a preset-configured `migrationDocsDir`.
- The coverage-to-delivery control point is an **LLM-authored, human-revised confidence
  case**: a gated document item sweeps the codebase and produces a per-touchpoint
  coverage map (named covering tests, gaps/waivers, risk mitigations, safety nets). The
  human's job is to audit and challenge that argument — reject hand-waving, demand
  evidence — rather than perform the sweep themselves.
- The preset introduces **zero new agent kinds**: artifact phases reuse the existing
  document pipeline, coding phases reuse the existing coding pipelines selected by the
  policy's estimate rules. All migration-specific behaviour is descriptor data,
  `seedPlan` decoration, and prompt additions — never new capability.
- The validation pilot (a purpose-built synthetic MSSQL→PostgreSQL fixture repo run as a
  productized end-to-end trial) was **dropped**: the preset's platform validation is an
  in-CI, fake-driven end-to-end test extending the existing preset-baseline harness;
  confidence in the preset against real technology stacks comes from running it against
  real repositories manually/separately, outside this initiative and outside CI.

## Rationale

- **Phase structure as declarative data, not hand-rolled per preset.** A generic
  template + prompt fold + ingest normalizer means any future preset can shape its
  plan's phases the same way, instead of every preset owner reimplementing shape
  enforcement.
- **The LLM argues, the human audits the argument.** Manually reviewing coverage across
  an entire codebase does not scale and is not what a human is good at; producing an
  evidence-backed case and having a human challenge its grounding is a much higher-yield
  division of labour, and keeps the migration human-in-the-loop by design.
- **No new agent kinds keeps the surface small.** The preset's specialness lives
  entirely in plan shape, prompts, and fragments — capability the engine already has is
  reused, not duplicated.
- **A synthetic fixture pilot doesn't pay for itself as platform code.** A bespoke
  throwaway target application is project-specific, never runs in the product's own CI,
  and its only consumer would have been a one-time manual run — so real-repository
  validation was chosen over building and maintaining a synthetic acceptance fixture.

## Alternatives considered

- **A create-time repo-detection probe** to prefill the migration form. Rejected: a probe
  can only read the FROM-side stack, never the destination or migration intent, so its
  value shrinks to prefilling one field the user already knows, while the analyst
  rediscovers the whole blast zone far more thoroughly at planning time regardless.
- **A dedicated synthetic MSSQL fixture repo + productized pilot run**, to prove the
  preset against a repo exercising classic behaviour-preservation traps. Cut in favour of
  an in-CI, deterministic end-to-end test plus real-repository validation performed
  manually outside the initiative, since the fixture would be project-specific throwaway
  that never runs in the product's own CI.
- **Human-performed coverage review** instead of an LLM-authored confidence case.
  Rejected as a near-impossible task to do reliably by eye across an entire codebase;
  the chosen model has the LLM do the exhaustive sweep and the human audit the argument.

## Consequences

- A future preset gets phase-shape enforcement for free by declaring a `phaseTemplate` —
  no new engine capability needed.
- The migration preset ships with no synthetic acceptance fixture; there is no
  in-repo, automated proof that it survives the classic MSSQL→PostgreSQL behaviour traps
  (collation-dependent ordering, `datetime` rounding, identity leakage, etc.) — that
  confidence is obtained only by running the preset against real migrations, outside CI.
- Several design questions (waiver granularity under a "pragmatic" coverage bar, whether
  `compatPosture` should become a required field, per-phase concurrency defaults) are
  left open for future iteration rather than settled now.
- If a reusable acceptance fixture is wanted later, it is scoped as its own
  benchmark-class initiative, not folded back into this one.
