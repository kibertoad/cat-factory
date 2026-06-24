---
'@cat-factory/sandbox-fixtures': minor
'@cat-factory/sandbox': minor
'@cat-factory/contracts': minor
---

Add **`@cat-factory/sandbox-fixtures`** — a published package of hand-authored,
standardized, **graded** no-repo fixtures for the Sandbox, plus the asymmetric
grading model that scores them.

- **`@cat-factory/sandbox-fixtures`** (new): inline (text-only) agent inputs that
  need NO repository checkout — `requirements-review`, `clarity-review`, `reviewer`
  (code review), and architecture-proposal review (`architect-companion`) — each
  spanning a simple → complex range. Every fixture declares the genuine findings a
  strong answer should surface, each rated by **trickiness** (how hard to spot —
  catching it is a "wow") and **impact** (how bad to miss). The standardized
  `SandboxFixtureDefinition` projects to the wire `SandboxFixture` via
  `toSandboxFixture`. Depends only on `@cat-factory/contracts` so the published
  `@cat-factory/sandbox` can load it via `workspace:*`.
- **`@cat-factory/contracts`** (breaking, pre-1.0): the `findings` fixture objective
  now carries graded `expectations` (`{ id, summary, trickiness, impact, matchHints }`)
  instead of a flat `expectedFindings: string[]`; the objective result records the
  asymmetric breakdown (`impactRecall`, `wowBonus`, `caught`/`total`,
  `missedHighImpact`). New `clarity` inline fixture kind.
- **`@cat-factory/sandbox`**: loads the workspace builtin fixtures by default
  (`listBuiltinFixtures`, re-exporting `@cat-factory/sandbox-fixtures`); replaces the
  flat `scoreExpectedFindings` recall with `scoreExpectations` (impact-weighted miss
  penalty so missing something impactful hurts most, plus a trickiness-weighted "wow"
  bonus for catching the subtle items) and `renderExpectationBrief` for the judge;
  adds the `architecture-review` (`architect-companion`) catalog entry and a
  `suggestExperiment` helper that maps selected models × prompts × fixtures to a
  ready-to-create experiment for a selected agent.

No CI cache list change is needed: the new package sits under
`backend/packages/*`, already covered by the workflow's `node_modules` cache glob;
it is added to the `backend/tsconfig.build.json` composite build graph (the
incremental `.tsbuildinfo` cache) so it builds before its `@cat-factory/sandbox`
consumer.
