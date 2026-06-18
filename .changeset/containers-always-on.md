---
'@cat-factory/worker': patch
---

Make container-based implementation always-on and remove the
`CONTAINER_IMPL_ENABLED` flag. The repo-operating agent kinds (`coder`, `mocker`,
`playwright`, `blueprints`, `business-documenter`) require a real sandbox, so the
container executor is now built unconditionally: `selectAgentExecutor` always
constructs it and **throws at startup** when its prerequisites are missing (a
configured GitHub App, `WORKER_PUBLIC_URL`, `AUTH_SESSION_SECRET`, and a runner
backend — the `EXEC_CONTAINER` binding or a registered runner pool). This replaces
the prior opt-in `[vars]` flag with a hard requirement, so a misconfigured
deployment fails loudly instead of silently degrading repo-operating steps to
useless one-shot LLM calls. The `CONTAINER_IMPL_ENABLED` env var, the
`AgentsConfig.containerImpl` field, and the deploy-config `[vars]` entry are gone;
`RUNNERS_ENABLED` is unchanged (a registered pool can serve as the runner backend).
