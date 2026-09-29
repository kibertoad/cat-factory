---
'@cat-factory/kernel': minor
'@cat-factory/orchestration': patch
'@cat-factory/agents': patch
'@cat-factory/server': patch
'@cat-factory/app': patch
---

Tool servers (MCP) now run on the Pi harness. `MCP_HARNESS_TRANSPORTS.pi` is `['stdio', 'http']`,
so a declared server no longer drops as `harness_unsupported` on a Pi run: it is wired into Pi's own
MCP client through the `mcp.json` the runner image (1.162.0 onward) writes. On Pi an `allowedTools`
list is enforced rather than advisory.

**Behaviour change for a deployment whose runner pool pins an older image.** Every earlier image
reported the `mcpServers` capability (for the subscription CLIs) while dropping a Pi run's servers,
so the handshake could not tell a Pi dispatch it was about to run blind. A Pi dispatch carrying tool
servers now requires the new `piMcpServers` body capability, and an image that reports a list
without it REFUSES the run at dispatch, naming the runner image as the fix. Move the pool to
`cat-factory-executor:1.162.0`, or narrow the affected servers' `harnesses` to `claude-code` /
`codex` until you do. `HarnessBodyCapability` gains the `piMcpServers` member.

Boot validation no longer warns that a server narrowed to `['pi']` can never apply, and the step
detail's `harness_unsupported` copy now names the causes that remain (a `harnesses` list that
excludes the CLI, or an ambient Codex login) in every locale.
