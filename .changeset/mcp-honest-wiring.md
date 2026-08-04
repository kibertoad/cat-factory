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
`AgentKindRegistry.kindsWithCapabilities()` (every kind declaring a capability on its own
registration, plus every kind named by `assignSkills` / `assignToolServers`), so a server attached to
a built-in such as `coder` reaches the same refusals and the same operator checklist as a registered
kind's own. New checks: a transport/harness combination no run could serve, an `allowedTools` entry
that is not a single tool name (the harness joins the list with commas), and a per-dispatch server
budget, both dimensions of which warn at boot and drop the excess under `over_budget` at dispatch.
The harness exempts `mcp__*` calls from the no-edit progress bound and bounds them with their own
`JOB_MAX_CONSECUTIVE_MCP_CALLS` streak, plus a `JOB_MAX_CONSECUTIVE_NON_ACTION_CALLS` backstop shared
by every no-edit-exempt family (each per-family streak resets on a call outside its family, so
interleaving two of them was bounded only by the job's wall-clock ceiling).

OPERATORS UPGRADING: capabilities attached by `assignSkills` / `assignToolServers` were previously
not boot-validated at all, so a declaration that is now an ERROR (a cleartext off-loopback endpoint,
a reserved credential key, an unregistered id, a malformed server id or tool name) turns a
deployment that used to start into one that refuses to. That is the intent of the change, and each
message names the kind and the declaration to fix.

INTERNAL BREAK: `UnavailableToolServer['reason']` gains `transport_unsupported` and `over_budget`, so
a deployment rendering that union exhaustively must map them. Runner image bumped to 1.89.0.
