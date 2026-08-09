---
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/mcp-server': patch
---

Findings of the 2026-08-09 MCP audit, the low-hanging half (the rest lands in the
`mcp-maturation.md` tracker as slice 9 and its new inventory rows).

Boot validation gains `unusable_credential_header`, an error: a `header` credential on a `stdio`
tool server has no request to carry it, and the dispatch's env projection skips a header-bearing
key, so the resolved value reached nothing and the server started unauthenticated while the prompt
advertised it. FLAGGED BREAK: a deployment carrying that (previously silently broken) declaration
now fails boot naming it; declare an `envName` instead.

The rest is doc truth: the `@cat-factory/mcp-server` README's mounting example imports from
`./http` (the root drags the stdio boot into a Worker bundle) and its group table lists all sixteen
groups; three docs stop claiming two omitted operations where the omission list has three; the
hosted endpoint's JSON-RPC batch acceptance is stated as transport compatibility rather than a
protocol promise (the 2025-06-18 revision removed batching); `security-model.md` gains the
serving-side subsection; and the `MCP_OAUTH_CALLBACK_PATH` docstring stops claiming consumers that
did not exist.
