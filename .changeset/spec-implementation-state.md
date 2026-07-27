---
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': patch
---

Add an implementation-state axis to the in-repo `spec/`, and a requirement → evidence section on the PR verification report.

**Implementation state.** `requirementItemSchema` gains `state: 'aspirational' | 'established'`
(default `aspirational`). Until now `spec/` could say what must be TRUE but not what is true
YET, so an agreed-but-unbuilt requirement entered every build prompt as standing behaviour and
drew a spurious `not_met` from the tester on unrelated runs. The group markdown now renders the
two halves under headings that say what each means, and the Gherkin render tags aspirational
scenarios `@aspirational` so a runner can skip them.

**Promotion is mechanical.** A tester's first OBSERVED pass flips a requirement to
`established`, via a deterministic post-op over the checkout-free `RepoFiles` port — not a model
decision and not a side table. It is idempotent by content, so a replayed durable step commits
nothing, and it only ever rewrites a group shard that round-tripped byte-for-byte: promotion
flips a field, it never restructures the tree or drops a requirement the salvaging read could
not reproduce. It lands on the run's PR branch, or on the base branch when the pipeline opens no
PR.

**Requirement → evidence.** The tester now reports `requirementVerdicts` keyed by the SPEC's own
requirement ids (surfaced as a `# requirement: <id>` comment on each scenario), and the PR
verification report joins them back to `spec/` to render a per-requirement table. Verdicts are
three-valued — `met` / `not_met` / `not_covered` — so "we didn't check" and "it's broken" never
read the same. The join reads EVERY tester step, matching what promotion does.

BREAKING (wire): `PR_VERIFICATION_REPORT_VERSION` is bumped to `2` — the report JSON gains a
required `requirements` section. Per the repo's pre-1.0 policy there is no compatibility shim; an
external consumer of the machine-readable block should re-read the schema.

Also moves `readServiceSpec` from `@cat-factory/server` to `@cat-factory/agents` (it is now read
by three layers, and server sits above two of them) and brings the `spec-writer` system prompt
under `PROMPT_VERSIONS`; the `build` prompt is bumped to v5.
