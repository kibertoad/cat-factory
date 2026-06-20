---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/agents': patch
'@cat-factory/app': patch
'@cat-factory/executor-harness': patch
---

Add a unified, persisted requirements structure stored in each service's GitHub
repo. A new `requirements-writer` container agent runs before the coder in
`pl_full` (and standalone via the new `pl_requirements` pipeline): it aggregates
the clarified requirements of every task under the service frame into one
PRESCRIPTIVE document, committed to the implementation branch
(`cat-factory/<blockId>`, created from base when absent) so the spec is present
before any code is written.

The harness deterministically renders the document into `requirements/`: the
canonical `requirements.json` (a `RequirementsDoc`), `overview.md`, `rules.md`
(cross-cutting domain rules / invariants), a `version.json` staleness manifest,
and Gherkin `features/*.feature` files (one `Scenario` per acceptance criterion).
Gherkin is generated two-pass — mechanical render in the harness, then the
`acceptance` agent polishes the `.feature` files and `playwright` turns each
scenario into a runnable test. Every container agent reads the requirements via a
new `REQUIREMENTS_GUIDANCE` block in its global `AGENTS.md`. The in-repo files are
the source of truth; the engine strictly validates the returned doc
(`parseRequirementsDoc`) at ingest. Mirrors the blueprint pattern; covered by the
cross-runtime conformance suite.
