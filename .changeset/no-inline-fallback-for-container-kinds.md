---
'@cat-factory/worker': patch
---

Remove the silent inline fallback for repo-operating agent kinds. A one-shot LLM
call cannot clone a repo, edit files, commit and open a PR, so routing `coder` /
`mocker` / `playwright` / `blueprints` / `business-documenter` to the inline
executor produced plausible-but-useless output. Now `CompositeAgentExecutor`
throws for those kinds when no sandbox is wired, and `selectAgentExecutor` throws
at startup when container implementation (or a runner pool) is enabled but its
prerequisites are missing — failing loudly instead of degrading silently.

Also fixes a latent reclaim gap: `CompositeAgentExecutor` now forwards `stopJob`
to the container executor, so the engine's Layer-2 container reclaim
(`ExecutionService.stopRunContainer`) actually fires through the composite instead
of silently no-opping and leaking a warm instance.
