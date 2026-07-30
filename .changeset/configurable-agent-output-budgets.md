---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/agents': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Make an agent kind's output-token ceiling configurable from the pipeline builder, at two tiers over
the deployment routing default: per pipeline step (`StepOptions.maxOutputTokens`) and per workspace
per agent kind (the new `workspace_agent_settings` store). The engine resolves the winner once per
dispatch onto `AgentRunContext.maxOutputTokens` — narrowest tier wins — so the container, inline and
consensus paths cannot disagree about the budget a step ran under.

Note the ceiling is advisory on the subscription-CLI inline path (the one-shot CLIs don't all honour
it), so it bites on the metered provider path.
