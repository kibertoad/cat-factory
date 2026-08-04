---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/executor-harness': minor
'@cat-factory/local-server': patch
---

MCP maturation slice 1: every declared tool server is either served or STATED.

A dispatch now checks the running harness's MCP TRANSPORTS, not just whether it speaks MCP, so an
`http` server on a Codex run (whose client is stdio-only) is dropped under a new
`transport_unsupported` reason instead of being advertised in the prompt and then silently skipped by
the harness's TOML writer. Boot validation and the capability-credential checklist now enumerate
`AgentKindRegistry.kindsWithCapabilities()` (registered kinds plus every kind named by
`assignSkills` / `assignToolServers`), so a server attached to a built-in such as `coder` reaches the
same refusals and the same operator checklist as a registered kind's own. New checks: a
transport/harness combination no run could serve, an `allowedTools` entry that is not a single tool
name (the harness joins the list with commas), and a per-dispatch server budget whose excess is
dropped under `over_budget`. The harness exempts `mcp__*` calls from the no-edit progress bound and
bounds them with their own `JOB_MAX_CONSECUTIVE_MCP_CALLS` streak instead.

INTERNAL BREAK: `UnavailableToolServer['reason']` gains `transport_unsupported` and `over_budget`, so
a deployment rendering that union exhaustively must map them. Runner image bumped to 1.89.0.
