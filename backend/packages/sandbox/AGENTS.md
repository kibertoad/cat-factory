# `@cat-factory/sandbox` — parallel prompt/model testing surface

Versioned prompt candidates, experiment matrices, and judge + objective grading — deliberately
isolated from the core product so it can be extracted. Pairs with `@cat-factory/sandbox-fixtures`
(the graded no-repo fixtures it grades against).

**Entry:** `src/index.ts`. Logic in `matrix.logic.ts`, `promptVersions.logic.ts`, `rubrics.ts`,
`baselines.ts`, `fixtures.ts`.
