# `@cat-factory/sandbox`: parallel prompt/model testing surface

Versioned prompt candidates, experiment matrices, and judge + objective grading: deliberately
isolated from the core product so it can be extracted. Pairs with `@cat-factory/sandbox-fixtures`
(the graded no-repo fixtures it grades against).

**Entry:** `src/index.ts`. Logic in `matrix.logic.ts`, `promptVersions.logic.ts`, `rubrics.ts`,
`baselines.ts`, `fixtures.ts`, `workspacePrompts.ts`.

A stored `systemText` is the **BASE (track) prompt** (the same unit a per-workspace agent prompt
override holds) and `SandboxRunService` composes the platform's directives on top at RUN time via
`systemPromptFor(kind, registry, text)`, exactly as production dispatch composes an override. That
is what lets a graded candidate be PROMOTED to the live prompt unchanged; storing the composed text
would double the trait guidance on promotion. `workspacePrompts.ts` projects the workspace's own
revision log into read-only `origin: 'workspace'` versions so an experiment can measure against the
prompt that is actually running, not only against what the product ships.

Container-bucket kinds are refused (`SandboxRunService`); when they land, note that their dispatch
goes through `dispatchSystemPromptFor` and would pick up the workspace override: an experiment
must run its SELECTED candidate, so that path needs the override suppressed explicitly.
